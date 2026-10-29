import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import type { EnvConfig, Project, Workload } from './config.js';
import { ConfigError } from './config.js';
import {
  acquireEnvLock,
  checkBusy,
  checkEnv,
  checkWindow,
  dbAbortDecision,
  GuardrailError,
  readSmokeLedger,
  recordSmoke,
  resolveProfile,
  resultsRoot,
  smokeKey,
  type ResourceSample,
} from './guardrails.js';

// The staging values: caps 20 users / 30 req/s, defaults 10 / 15, 30 minutes, load window weekdays 17:00-06:00 UTC.
const STAGING: EnvConfig = {
  apiUrl: 'https://api-staging.acme.example/api',
  caps: { maxVus: 20, maxRps: 30, maxDurationSec: 30 * 60 },
  defaults: { vus: 10, rps: 15 },
  windowUtc: { weekdays: '17:00-06:00', weekends: 'all-day' },
};

const PROJECT: Project = {
  name: 'acme',
  dir: '/nowhere',
  envs: { staging: STAGING },
  auth: { type: 'ropc' },
  abort: { errorRate: 0.1, p95Ms: 15000, dbCpuOrIoPct: 95 },
  readOnlyPostRoutes: [],
};

function workload(profiles: Workload['profiles']): Workload {
  return {
    businessUnit: 'analysts',
    businessAction: 'open the forms grid',
    mix: { only: 100 },
    thinkTime: { min: 1, max: 2 },
    profiles,
    targets: 'baseline',
  };
}

const hold = (users: number | undefined, rampSec = 60, holdSec = 300, rampDownSec = 30) => ({
  ...(users === undefined ? {} : { users }),
  rampSec,
  holdSec,
  rampDownSec,
});

/** Runs fn and returns the GuardrailError it throws (fails the test if it throws anything else or nothing). */
function guardrailCode(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GuardrailError, `expected a GuardrailError, got ${String(err)}`);
    return err.code;
  }
  assert.fail('expected a GuardrailError, nothing was thrown');
}

// ---------------------------------------------------------------------------------------------------------------
// env allowlist
// ---------------------------------------------------------------------------------------------------------------

test('checkEnv returns the env config of an env the project lists', () => {
  assert.equal(checkEnv(PROJECT, 'staging'), STAGING);
});

test('checkEnv throws ENV_NOT_ALLOWED for an env the project does not list, and names the allowed ones', () => {
  assert.equal(
    guardrailCode(() => checkEnv(PROJECT, 'prod')),
    'ENV_NOT_ALLOWED',
  );
  assert.throws(() => checkEnv(PROJECT, 'prod'), /prod.*staging/s);
  // names that exist on Object.prototype are not envs
  assert.equal(
    guardrailCode(() => checkEnv(PROJECT, 'constructor')),
    'ENV_NOT_ALLOWED',
  );
});

// ---------------------------------------------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------------------------------------------

test('smoke needs no profile and runs no timeline', () => {
  assert.deepEqual(resolveProfile('smoke', workload({}), STAGING, { allowMax: false }), { type: 'smoke', totalSec: 0 });
});

test('load 10 users passes', () => {
  const p = resolveProfile('load', workload({ load: hold(10) }), STAGING, { allowMax: false });
  assert.equal(p.type, 'load');
  assert.equal(p.users, 10);
});

test('load without users in the workload uses the env default', () => {
  const p = resolveProfile('load', workload({ load: hold(undefined) }), STAGING, { allowMax: false });
  assert.equal(p.users, 10);
});

test('load 15 users throws ABOVE_DEFAULTS', () => {
  assert.equal(
    guardrailCode(() => resolveProfile('load', workload({ load: hold(15) }), STAGING, { allowMax: false })),
    'ABOVE_DEFAULTS',
  );
});

test('the ABOVE_DEFAULTS message names the flag that lifts it', () => {
  assert.throws(() => resolveProfile('load', workload({ load: hold(15) }), STAGING, { allowMax: false }), /--allow-max/);
});

test('load 15 users passes with allowMax', () => {
  const p = resolveProfile('load', workload({ load: hold(15) }), STAGING, { allowMax: true });
  assert.equal(p.users, 15);
});

test('load 20 users (exactly the cap) passes with allowMax', () => {
  assert.equal(resolveProfile('load', workload({ load: hold(20) }), STAGING, { allowMax: true }).users, 20);
});

test('load 21 users throws CAPS_EXCEEDED even with allowMax', () => {
  for (const allowMax of [false, true]) {
    assert.equal(
      guardrailCode(() => resolveProfile('load', workload({ load: hold(21) }), STAGING, { allowMax })),
      'CAPS_EXCEEDED',
    );
  }
});

test('load, a hold that makes the run 40 minutes throws CAPS_EXCEEDED', () => {
  // 60 s ramp + 2310 s hold + 30 s ramp down = 2400 s = 40 min
  assert.equal(
    guardrailCode(() => resolveProfile('load', workload({ load: hold(10, 60, 2310, 30) }), STAGING, { allowMax: true })),
    'CAPS_EXCEEDED',
  );
});

test('a run of exactly the max duration passes', () => {
  const p = resolveProfile('load', workload({ load: hold(10, 60, 1710, 30) }), STAGING, { allowMax: false });
  assert.equal(p.totalSec, 30 * 60);
});

test('load holdWindow is rampSec..rampSec+holdSec and totalSec is the sum of the phases', () => {
  const p = resolveProfile('load', workload({ load: hold(10, 60, 300, 30) }), STAGING, { allowMax: false });
  assert.deepEqual(p, {
    type: 'load',
    users: 10,
    rampSec: 60,
    holdSec: 300,
    rampDownSec: 30,
    totalSec: 390,
    holdWindow: { fromSec: 60, toSec: 360 },
  });
});

test('soak resolves like load from the soak profile', () => {
  const p = resolveProfile('soak', workload({ load: hold(5), soak: hold(8, 30, 600, 30) }), STAGING, { allowMax: false });
  assert.deepEqual(p, {
    type: 'soak',
    users: 8,
    rampSec: 30,
    holdSec: 600,
    rampDownSec: 30,
    totalSec: 660,
    holdWindow: { fromSec: 30, toSec: 630 },
  });
});

test('a profile the workload does not define is a ConfigError, not a guardrail', () => {
  for (const type of ['load', 'stress', 'soak'] as const) {
    assert.throws(
      () => resolveProfile(type, workload({}), STAGING, { allowMax: false }),
      (err: unknown) => err instanceof ConfigError && err.message.includes(`profiles.${type}`),
    );
  }
});

test('stress 16 req/s throws ABOVE_DEFAULTS', () => {
  const stress = { startRps: 1, maxRps: 16, stepRps: 3, stepEverySec: 60 };
  assert.equal(
    guardrailCode(() => resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false })),
    'ABOVE_DEFAULTS',
  );
});

test('stress 31 req/s throws CAPS_EXCEEDED even with allowMax', () => {
  const stress = { startRps: 1, maxRps: 31, stepRps: 3, stepEverySec: 60 };
  for (const allowMax of [false, true]) {
    assert.equal(
      guardrailCode(() => resolveProfile('stress', workload({ stress }), STAGING, { allowMax })),
      'CAPS_EXCEEDED',
    );
  }
});

test('stress 30 req/s (exactly the cap) passes with allowMax', () => {
  const stress = { startRps: 10, maxRps: 30, stepRps: 10, stepEverySec: 60 };
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: true });
  assert.deepEqual(
    p.stages?.map((s) => s.rps),
    [10, 20, 30],
  );
});

test('stress 1 to 15 step 2 every 120 s gives stages 1,3,...,15 at 0,120,...,840 s', () => {
  const stress = { startRps: 1, maxRps: 15, stepRps: 2, stepEverySec: 120 };
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false });
  assert.equal(p.type, 'stress');
  assert.deepEqual(
    p.stages,
    [1, 3, 5, 7, 9, 11, 13, 15].map((rps, i) => ({ fromSec: i * 120, rps })),
  );
  assert.deepEqual(p.stages?.map((s) => s.fromSec), [0, 120, 240, 360, 480, 600, 720, 840]);
  assert.equal(p.totalSec, 960);
  assert.equal(p.holdWindow, undefined);
});

test('stress without maxRps tops out at the env default rate', () => {
  const stress = { startRps: 5, stepRps: 5, stepEverySec: 60 };
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false });
  assert.deepEqual(
    p.stages?.map((s) => s.rps),
    [5, 10, 15],
  );
});

test('stress whose step does not land on the top rate ends with a final level at the top rate', () => {
  const stress = { startRps: 1, maxRps: 14, stepRps: 5, stepEverySec: 60 };
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false });
  assert.deepEqual(
    p.stages?.map((s) => s.rps),
    [1, 6, 11, 14],
  );
  assert.equal(p.totalSec, 240);
});

test('stress with decimal steps does not drift past the top rate', () => {
  const stress = { startRps: 0.1, maxRps: 0.7, stepRps: 0.2, stepEverySec: 30 };
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false });
  assert.deepEqual(
    p.stages?.map((s) => s.rps),
    [0.1, 0.3, 0.5, 0.7],
  );
});

test('stress starting above the top rate is judged on the rate it really runs at', () => {
  // no maxRps -> top is the default 15, but the first level is already 20
  const stress = { startRps: 20, stepRps: 5, stepEverySec: 60 };
  assert.equal(
    guardrailCode(() => resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false })),
    'ABOVE_DEFAULTS',
  );
  const p = resolveProfile('stress', workload({ stress }), STAGING, { allowMax: true });
  assert.deepEqual(p.stages, [{ fromSec: 0, rps: 20 }]);
});

test('stress running longer than the max duration throws CAPS_EXCEEDED', () => {
  // 1,3,...,15 is 8 levels; 8 x 300 s = 40 min
  const stress = { startRps: 1, maxRps: 15, stepRps: 2, stepEverySec: 300 };
  assert.equal(
    guardrailCode(() => resolveProfile('stress', workload({ stress }), STAGING, { allowMax: true })),
    'CAPS_EXCEEDED',
  );
});

test('stress with a zero step is refused instead of looping forever', () => {
  const stress = { startRps: 1, maxRps: 15, stepRps: 0, stepEverySec: 60 };
  assert.throws(() => resolveProfile('stress', workload({ stress }), STAGING, { allowMax: false }), ConfigError);
});

// ---------------------------------------------------------------------------------------------------------------
// load window (UTC). 2026-10-20 is a Tuesday, 10-23 Friday, 10-24 Saturday, 10-25 Sunday, 10-26 Monday.
// ---------------------------------------------------------------------------------------------------------------

const at = (day: string, hhmm: string) => new Date(`2026-10-${day}T${hhmm}:00Z`);
const WINDOW = STAGING.windowUtc;

test('window: Tue 18:00 and Tue 05:59 are inside', () => {
  assert.deepEqual(checkWindow(at('20', '18:00'), WINDOW, 'load', false), { overridden: false });
  assert.deepEqual(checkWindow(at('20', '05:59'), WINDOW, 'load', false), { overridden: false });
  assert.deepEqual(checkWindow(at('20', '17:00'), WINDOW, 'stress', false), { overridden: false });
});

test('window: Tue 06:00 and Tue 12:00 are OUTSIDE_WINDOW', () => {
  for (const t of [at('20', '06:00'), at('20', '12:00'), at('20', '16:59')]) {
    assert.equal(
      guardrailCode(() => checkWindow(t, WINDOW, 'load', false)),
      'OUTSIDE_WINDOW',
    );
  }
});

test('window: the message names the window and the override flag', () => {
  assert.throws(() => checkWindow(at('20', '12:00'), WINDOW, 'soak', false), /17:00-06:00.*--override-window/s);
});

test('window: Sat 12:00 and Sun 23:00 are inside (weekends all day)', () => {
  assert.deepEqual(checkWindow(at('24', '12:00'), WINDOW, 'load', false), { overridden: false });
  assert.deepEqual(checkWindow(at('25', '23:00'), WINDOW, 'load', false), { overridden: false });
});

test('window: the weekend runs into Monday morning up to 06:00', () => {
  assert.deepEqual(checkWindow(at('26', '05:59'), WINDOW, 'load', false), { overridden: false });
  assert.equal(
    guardrailCode(() => checkWindow(at('26', '06:00'), WINDOW, 'load', false)),
    'OUTSIDE_WINDOW',
  );
});

test('window: Friday evening runs into Saturday morning', () => {
  assert.deepEqual(checkWindow(at('23', '20:00'), WINDOW, 'load', false), { overridden: false });
  assert.deepEqual(checkWindow(at('24', '02:00'), WINDOW, 'load', false), { overridden: false });
});

test('window: Tue 12:00 with the override is allowed and reported as overridden', () => {
  assert.deepEqual(checkWindow(at('20', '12:00'), WINDOW, 'load', true), { overridden: true });
});

test('window: the override inside the window overrides nothing', () => {
  assert.deepEqual(checkWindow(at('20', '18:00'), WINDOW, 'load', true), { overridden: false });
});

test('window: smoke runs any time', () => {
  assert.deepEqual(checkWindow(at('20', '12:00'), WINDOW, 'smoke', false), { overridden: false });
});

test('window: an env without a window has no restriction', () => {
  assert.deepEqual(checkWindow(at('20', '12:00'), undefined, 'load', false), { overridden: false });
});

test('window: weekends none closes the weekend, including the night that starts on Saturday or Sunday', () => {
  const closed = { weekdays: '17:00-06:00', weekends: 'none' as const };
  assert.deepEqual(checkWindow(at('23', '20:00'), closed, 'load', false), { overridden: false }); // Fri evening
  assert.deepEqual(checkWindow(at('24', '02:00'), closed, 'load', false), { overridden: false }); // tail of Friday's night
  for (const t of [at('24', '12:00'), at('24', '20:00'), at('25', '02:00'), at('25', '20:00'), at('26', '02:00')]) {
    assert.equal(
      guardrailCode(() => checkWindow(t, closed, 'load', false)),
      'OUTSIDE_WINDOW',
      t.toISOString(),
    );
  }
  assert.deepEqual(checkWindow(at('26', '17:00'), closed, 'load', false), { overridden: false }); // Mon evening
});

test('window: a window inside one day (09:00-12:00)', () => {
  const day = { weekdays: '09:00-12:00', weekends: 'all-day' as const };
  assert.deepEqual(checkWindow(at('20', '09:00'), day, 'load', false), { overridden: false });
  assert.deepEqual(checkWindow(at('20', '11:59'), day, 'load', false), { overridden: false });
  for (const hhmm of ['08:59', '12:00', '23:00']) {
    assert.equal(
      guardrailCode(() => checkWindow(at('20', hhmm), day, 'load', false)),
      'OUTSIDE_WINDOW',
    );
  }
});

// ---------------------------------------------------------------------------------------------------------------
// busy env and DB abort
// ---------------------------------------------------------------------------------------------------------------

const sample = (cpu: number, dataIo: number, i = 0, logWrite = 0): ResourceSample => ({
  endTime: new Date(Date.UTC(2026, 9, 20, 18, 0, 15 * i)),
  cpu,
  dataIo,
  logWrite,
});

test('busy when avg cpu 25', () => {
  const r = checkBusy([sample(20, 5, 0), sample(30, 5, 1)]);
  assert.equal(r.busy, true);
  assert.equal(r.avgCpu, 25);
  assert.equal(r.avgIo, 5);
});

test('busy when avg io 21', () => {
  const r = checkBusy([sample(5, 21, 0), sample(5, 21, 1)]);
  assert.equal(r.busy, true);
  assert.equal(r.avgIo, 21);
});

test('not busy at 10/10', () => {
  const r = checkBusy([sample(10, 10, 0), sample(10, 10, 1)]);
  assert.deepEqual(r, { busy: false, avgCpu: 10, avgIo: 10 });
});

test('exactly the limit is not busy, and a custom limit applies', () => {
  assert.equal(checkBusy([sample(20, 20)]).busy, false);
  assert.equal(checkBusy([sample(10, 10)], 5).busy, true);
});

test('busy check without samples reports an idle DB with zero averages', () => {
  assert.deepEqual(checkBusy([]), { busy: false, avgCpu: 0, avgIo: 0 });
});

test('dbAbortDecision [96,96,96,96] true; [96,96,96,50] false; three samples false', () => {
  assert.equal(dbAbortDecision([96, 96, 96, 96].map((v, i) => sample(v, 0, i)), 95), true);
  assert.equal(dbAbortDecision([96, 96, 96, 50].map((v, i) => sample(v, 0, i)), 95), false);
  assert.equal(dbAbortDecision([96, 96, 96].map((v, i) => sample(v, 0, i)), 95), false);
});

test('dbAbortDecision: 95 itself counts, 94 does not', () => {
  assert.equal(dbAbortDecision([95, 95, 95, 95].map((v, i) => sample(v, 0, i)), 95), true);
  assert.equal(dbAbortDecision([95, 95, 94, 95].map((v, i) => sample(v, 0, i)), 95), false);
});

test('dbAbortDecision: data IO alone trips it, and so does a mix of CPU and IO samples', () => {
  assert.equal(dbAbortDecision([96, 96, 96, 96].map((v, i) => sample(0, v, i)), 95), true);
  assert.equal(dbAbortDecision([sample(96, 0, 0), sample(0, 96, 1), sample(96, 0, 2), sample(0, 96, 3)], 95), true);
});

test('dbAbortDecision: the hot samples must be consecutive', () => {
  const values = [96, 96, 50, 96, 96, 96];
  assert.equal(dbAbortDecision(values.map((v, i) => sample(v, 0, i)), 95), false);
  assert.equal(dbAbortDecision([...values, 96].map((v, i) => sample(v, 0, i)), 95), true);
});

test('dbAbortDecision orders samples by endTime, so a newest-first list works too', () => {
  const hotThenCool = [96, 96, 96, 50].map((v, i) => sample(v, 0, i));
  assert.equal(dbAbortDecision([...hotThenCool].reverse(), 95), false);
  const coolThenHot = [50, 96, 96, 96, 96].map((v, i) => sample(v, 0, i));
  assert.equal(dbAbortDecision([...coolThenHot].reverse(), 95), true);
});

test('dbAbortDecision honours custom threshold and run length', () => {
  const samples = [80, 80].map((v, i) => sample(v, 0, i));
  assert.equal(dbAbortDecision(samples, 80, 2), true);
  assert.equal(dbAbortDecision(samples, 81, 2), false);
});

// ---------------------------------------------------------------------------------------------------------------
// file-backed helpers: smoke ledger and env lock (results root points at a temp dir)
// ---------------------------------------------------------------------------------------------------------------

const roots: string[] = [];
let root: string;
let savedRoot: string | undefined;

beforeEach(async () => {
  savedRoot = process.env.PERF_RESULTS_DIR;
  root = await mkdtemp(join(tmpdir(), 'perf-guardrails-'));
  roots.push(root);
  process.env.PERF_RESULTS_DIR = root;
});

afterEach(() => {
  if (savedRoot === undefined) delete process.env.PERF_RESULTS_DIR;
  else process.env.PERF_RESULTS_DIR = savedRoot;
});

after(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

test('resultsRoot follows PERF_RESULTS_DIR and falls back to <repo>/results', () => {
  assert.equal(resultsRoot(), root);
  delete process.env.PERF_RESULTS_DIR;
  assert.match(resultsRoot(), /[\\/]results$/);
  process.env.PERF_RESULTS_DIR = '';
  assert.match(resultsRoot(), /[\\/]results$/);
});

test('smokeKey changes when any listed file changes', async () => {
  const a = join(root, 'a.js');
  const b = join(root, 'b.yaml');
  await writeFile(a, 'one', 'utf8');
  await writeFile(b, 'two', 'utf8');
  const before = await smokeKey([a, b]);
  assert.match(before, /^[0-9a-f]{64}$/);
  assert.equal(await smokeKey([a, b]), before, 'same files, same key');

  await writeFile(b, 'two!', 'utf8');
  const afterB = await smokeKey([a, b]);
  assert.notEqual(afterB, before);

  await writeFile(a, 'one!', 'utf8');
  assert.notEqual(await smokeKey([a, b]), afterB);
});

test('smokeKey does not depend on the order the files are listed in', async () => {
  const a = join(root, 'a.js');
  const b = join(root, 'b.yaml');
  await writeFile(a, 'one', 'utf8');
  await writeFile(b, 'two', 'utf8');
  assert.equal(await smokeKey([a, b]), await smokeKey([b, a]));
});

test('smokeKey tells apart content moved from one file to another', async () => {
  const a = join(root, 'a.txt');
  const b = join(root, 'b.txt');
  await writeFile(a, 'x', 'utf8');
  await writeFile(b, 'y', 'utf8');
  const before = await smokeKey([a, b]);
  await writeFile(a, 'y', 'utf8');
  await writeFile(b, 'x', 'utf8');
  assert.notEqual(await smokeKey([a, b]), before);
});

test('smoke ledger: empty when the file is missing, then remembers recorded keys', async () => {
  assert.deepEqual(await readSmokeLedger(), {});
  await recordSmoke('key-one', 'run-1');
  await recordSmoke('key-two', 'run-2');
  const ledger = await readSmokeLedger();
  assert.deepEqual(Object.keys(ledger).sort(), ['key-one', 'key-two']);
  assert.equal(ledger['key-one']?.runId, 'run-1');
  assert.ok(!Number.isNaN(Date.parse(ledger['key-one']!.at)), 'at is an ISO time');
  const onDisk = JSON.parse(await readFile(join(root, '.smoke-ledger.json'), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(Object.keys(onDisk).sort(), ['key-one', 'key-two']);
});

test('smoke ledger: recording a key again replaces its run id', async () => {
  await recordSmoke('k', 'run-1');
  await recordSmoke('k', 'run-2');
  assert.equal((await readSmokeLedger())['k']?.runId, 'run-2');
});

test('smoke ledger: an unreadable file counts as empty (a fresh smoke is the safe outcome)', async () => {
  await writeFile(join(root, '.smoke-ledger.json'), '{ not json', 'utf8');
  assert.deepEqual(await readSmokeLedger(), {});
  await recordSmoke('k', 'run-1');
  assert.equal((await readSmokeLedger())['k']?.runId, 'run-1');
});

test('second lock acquire throws RUN_IN_PROGRESS with the pid', async () => {
  const release = await acquireEnvLock('staging');
  try {
    await assert.rejects(acquireEnvLock('staging'), (err: unknown) => {
      assert.ok(err instanceof GuardrailError);
      assert.equal(err.code, 'RUN_IN_PROGRESS');
      assert.equal(
        err.message,
        `another run is in progress on staging (pid ${process.pid}); if no run is going on this machine, delete ${join(resultsRoot(), '.lock-staging')}`,
      );
      return true;
    });
  } finally {
    await release();
  }
});

test('the lock file holds the pid of this process', async () => {
  const release = await acquireEnvLock('staging');
  try {
    assert.equal((await readFile(join(root, '.lock-staging'), 'utf8')).trim(), String(process.pid));
  } finally {
    await release();
  }
});

test('locks are per env', async () => {
  const one = await acquireEnvLock('staging');
  const two = await acquireEnvLock('debug2');
  await one();
  await two();
});

test('stale pid 999999 lock is removed', async () => {
  await writeFile(join(root, '.lock-staging'), '999999\n', 'utf8');
  const release = await acquireEnvLock('staging');
  try {
    assert.equal((await readFile(join(root, '.lock-staging'), 'utf8')).trim(), String(process.pid));
  } finally {
    await release();
  }
});

test('a lock file with garbage in it is stale', async () => {
  await writeFile(join(root, '.lock-staging'), 'not a pid', 'utf8');
  const release = await acquireEnvLock('staging');
  await release();
});

test('release then acquire works', async () => {
  const release = await acquireEnvLock('staging');
  await release();
  await assert.rejects(readFile(join(root, '.lock-staging'), 'utf8'), { code: 'ENOENT' });
  const again = await acquireEnvLock('staging');
  await again();
});

test('release twice is harmless, and it never deletes a lock another process took over', async () => {
  const release = await acquireEnvLock('staging');
  await release();
  await release();

  const second = await acquireEnvLock('staging');
  await writeFile(join(root, '.lock-staging'), `${process.ppid}\n`, 'utf8'); // someone else now holds it
  await second();
  assert.equal((await readFile(join(root, '.lock-staging'), 'utf8')).trim(), String(process.ppid));
});

test('acquireEnvLock refuses an env name that is not a plain name', async () => {
  await assert.rejects(acquireEnvLock('../evil'), /env name/);
});

test('acquiring leaves no temp files behind', async () => {
  const { readdir } = await import('node:fs/promises');
  const release = await acquireEnvLock('staging');
  await release();
  assert.deepEqual(await readdir(root), []);
});
