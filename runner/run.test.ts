import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { ConfigError, envConfig, loadFeature, loadProject, REPO_ROOT, type EnvConfig, type Feature } from './config.js';
import { buildFingerprint, fingerprintChanged } from './fingerprint.js';
import { acquireEnvLock, GuardrailError, readSmokeLedger, type ResolvedProfile } from './guardrails.js';
import { countScriptErrors, ignoredK6Variables, k6Environment, k6RunVariables, k6Version } from './k6.js';
import { renderRunReport, verifyRunReport } from './report/build.js';
import { BREAKING_LIMITS, FLAG_LIMITS } from './report/model.js';
import {
  abortLimitNotes,
  abortReasonFor,
  accountSecrets,
  checkRunWindow,
  databaseAccess,
  effectiveAbort,
  k6RpsOption,
  newRunDir,
  runFeature,
  runSmokeKey,
  smokeFiles,
  stepsPerIteration,
  sweepStaleSecrets,
  type RunResult,
} from './run.js';
import { startMockServer, type MockServer } from './selftest/server.js';

const CLI = join(REPO_ROOT, 'runner', 'cli.ts');
const RUN_FILES = ['summary.json', 'timeseries.json', 'k6-dashboard.html', 'k6-config.json', 'meta.json', 'k6.log', 'points.json.gz', 'report.html', 'report.md'];

// The env adapter of the selftest project reads these; the k6 runs go against the mock.
const AUTH_ENV = {
  PERF_TOKEN_CLIENT_ID: 'perf',
  PERF_SCOPE: 'openid perf offline_access',
  PERF_USER_LOGIN: 'perf',
  PERF_USER_PASSWORD: 'perf',
};
const TOUCHED_ENV = [...Object.keys(AUTH_ENV), 'PERF_SELFTEST_URL', 'PERF_TOKEN_URL', 'PERF_RESULTS_DIR', 'K6_WEB_DASHBOARD_PORT', 'TMPDIR'];

let mock: MockServer;
let root: string;
const savedEnv: Record<string, string | undefined> = {};
const tempDirs: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

before(async () => {
  for (const key of TOUCHED_ENV) savedEnv[key] = process.env[key];
  mock = await startMockServer();
  Object.assign(process.env, AUTH_ENV, {
    PERF_SELFTEST_URL: mock.url,
    PERF_TOKEN_URL: `${mock.url}/oauth/token`,
    // No live dashboard server in tests: parallel k6 runs would fight over port 5665. The export still works.
    K6_WEB_DASHBOARD_PORT: '-1',
  });
});

beforeEach(async () => {
  // A fresh results root per test: its own smoke ledger, lock files and run folders.
  root = await tempDir('perf-results-');
  process.env.PERF_RESULTS_DIR = root;
});

afterEach(() => {
  process.env.PERF_USER_PASSWORD = AUTH_ENV.PERF_USER_PASSWORD;
});

after(async () => {
  await mock.stop();
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));

/** Run folders under the results root (ledger and lock files start with a dot). */
async function runDirs(): Promise<string[]> {
  return (await readdir(root)).filter((name) => !name.startsWith('.')).sort();
}

/** Whether the repo is a git checkout (a zip download is not), so a run can record its commit. */
function insideGit(): boolean {
  try {
    return execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() === 'true';
  } catch {
    return false;
  }
}

/** The pid of a process that has already exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => child.on('exit', resolve));
  return child.pid!;
}

/** The selftest feature with a short load profile, so a full load run takes seconds. */
async function quickFeature(): Promise<Feature> {
  const project = await loadProject('selftest');
  const feature = structuredClone(await loadFeature(project, 'items'));
  feature.workload.profiles.load = { users: 2, rampSec: 1, holdSec: 3, rampDownSec: 1 };
  return feature;
}

// ---------------------------------------------------------------------------------------------------------------
// pure parts
// ---------------------------------------------------------------------------------------------------------------

test('stepsPerIteration sums the optional shares of a journey', async () => {
  const project = await loadProject('selftest');
  const feature = await loadFeature(project, 'items');
  assert.equal(stepsPerIteration(feature.journeys[0]!), 2.05);
});

test('databaseAccess: connected when the load can be read, unavailable when the database failed, none without one', () => {
  type Phase = Parameters<typeof databaseAccess>[0];
  assert.equal(databaseAccess(null), 'none');
  assert.equal(databaseAccess(undefined), 'none');
  assert.equal(databaseAccess({ readsLoad: true, hasEvidence: true } as Phase), 'connected');
  assert.equal(databaseAccess({ readsLoad: false, hasEvidence: true } as Phase), 'unavailable');
  assert.equal(databaseAccess({ readsLoad: false, hasEvidence: false } as Phase), 'none', 'a phase that only counts rows reads no database');
});

test('newRunDir names the folder by UTC minute, project, feature and profile, and suffixes collisions', () => {
  const now = new Date('2026-10-22T07:05:59Z');
  const first = newRunDir('selftest', 'items', 'smoke', now);
  const second = newRunDir('selftest', 'items', 'smoke', now);
  const third = newRunDir('selftest', 'items', 'smoke', now);
  assert.equal(first, join(root, '2026-10-22_0705_selftest_items_smoke'));
  assert.equal(second, `${first}_2`);
  assert.equal(third, `${first}_3`);
  assert.ok(existsSync(first) && existsSync(second) && existsSync(third));
});

test('the smoke key covers the feature fixtures: editing, adding or removing one asks for a fresh smoke', async () => {
  const project = await loadProject('selftest');
  const original = await loadFeature(project, 'items');
  const dir = await tempDir('perf-feature-');
  for (const name of ['journey.yaml', 'workload.yaml', 'items.js']) await copyFile(join(original.dir, name), join(dir, name));
  const feature: Feature = { ...original, dir, script: join(dir, 'items.js') };
  const keyOf = (): Promise<string> => runSmokeKey(project, feature, 'local');

  const bare = await keyOf();
  assert.equal(await keyOf(), bare, 'the key is stable');
  assert.ok(!(await smokeFiles(project, feature)).some((f) => f.includes('fixtures')), 'no fixtures folder: nothing to hash');

  await mkdir(join(dir, 'fixtures', 'nested'), { recursive: true });
  const body = join(dir, 'fixtures', 'search.json');
  await writeFile(body, '{"page":1}');
  const withFixture = await keyOf();
  assert.notEqual(withFixture, bare, 'adding a fixture changes the key');
  assert.ok((await smokeFiles(project, feature)).includes(body));

  await writeFile(body, '{"page":2}');
  const edited = await keyOf();
  assert.notEqual(edited, withFixture, 'editing a fixture changes the key');

  await writeFile(join(dir, 'fixtures', 'nested', 'deep.json'), '{}');
  const nested = await keyOf();
  assert.notEqual(nested, edited, 'a fixture in a sub-folder counts too');

  await writeFile(body, '{"page":1}');
  await rm(join(dir, 'fixtures', 'nested'), { recursive: true });
  assert.equal(await keyOf(), withFixture, 'back to the same files: back to the same key');
});

test('the smoke key covers project.yaml, adapter.ts and every script file of the project and the feature, not tests', async () => {
  const base = await loadProject('selftest');
  const projectDir = await tempDir('perf-project-');
  const featureDir = join(projectDir, 'features', 'items');
  await mkdir(join(projectDir, 'lib'), { recursive: true });
  await mkdir(featureDir, { recursive: true });
  await copyFile(join(base.dir, 'project.yaml'), join(projectDir, 'project.yaml'));
  const original = await loadFeature(base, 'items');
  for (const name of ['journey.yaml', 'workload.yaml', 'items.js']) await copyFile(join(original.dir, name), join(featureDir, name));
  const project = { ...base, dir: projectDir };
  const feature: Feature = { ...original, dir: featureDir, script: join(featureDir, 'items.js') };
  const keyOf = (): Promise<string> => runSmokeKey(project, feature, 'local');

  let key = await keyOf();
  const changes: [string, string][] = [
    [join(projectDir, 'project.yaml'), 'project.yaml'],
    [join(projectDir, 'adapter.ts'), 'adapter.ts (added)'],
    [join(projectDir, 'adapter.ts'), 'adapter.ts (edited)'],
    [join(projectDir, 'lib', 'helpers.js'), 'a project-level helper .js'],
    [join(featureDir, 'bodies.js'), 'a second .js in the feature folder'],
  ];
  for (const [file, what] of changes) {
    await writeFile(file, `${existsSync(file) ? await readFile(file, 'utf8') : ''}// ${what}\n`);
    const next = await keyOf();
    assert.notEqual(next, key, `changing ${what} asks for a fresh smoke`);
    key = next;
  }
  for (const test of [join(projectDir, 'lib', 'helpers.test.js'), join(featureDir, 'items.test.ts')]) {
    await writeFile(test, '// a test\n');
    assert.equal(await keyOf(), key, `a test file (${basename(test)}) does not count`);
  }
  assert.ok((await smokeFiles(project, feature)).includes(join(projectDir, 'lib', 'helpers.js')));
});

test('k6RpsOption: load and soak are held at the env default rate unless --allow-max; smoke and stress get the cap', async () => {
  const env = envConfig(await loadProject('selftest'), 'local'); // caps 30 req/s, defaults 15 req/s
  assert.equal(k6RpsOption('load', env, false), 15);
  assert.equal(k6RpsOption('soak', env, false), 15);
  assert.equal(k6RpsOption('load', env, true), 30);
  assert.equal(k6RpsOption('soak', env, true), 30);
  for (const type of ['smoke', 'stress'] as const) {
    assert.equal(k6RpsOption(type, env, false), 30, type);
    assert.equal(k6RpsOption(type, env, true), 30, type);
  }
});

test('accountSecrets: the passwords are known secrets for the scan, except one that a public setting of the run holds', () => {
  const auth = { tokenUrl: 'https://login.example.test/token', clientId: 'perf', scope: 'openid perf offline_access' };
  const accounts = { User: { login: 'analyst@example.test', password: 'Sup3r-secret!' }, Admin: { login: 'admin', password: 'perf' } };
  assert.deepEqual(accountSecrets(accounts, auth, 'https://api.example.test/api'), ['Sup3r-secret!']);
  assert.deepEqual(
    accountSecrets({ User: { login: 'staging-user', password: 'staging' } }, auth, 'https://api.staging.example.test'),
    [],
    'a password inside the api url would redact the url itself: it cannot be told apart, so it is not looked for',
  );
});

test('abortReasonFor maps k6 exits and runner stops', () => {
  assert.equal(abortReasonFor('load', 0), undefined);
  assert.equal(abortReasonFor('load', 99), 'thresholds');
  assert.equal(abortReasonFor('stress', 99), 'thresholds');
  assert.equal(abortReasonFor('smoke', 99), undefined); // a smoke that fails thresholds simply failed
  assert.equal(abortReasonFor('load', 108), undefined);
  assert.equal(abortReasonFor('load', 105, 'interrupted'), 'interrupted');
  assert.equal(abortReasonFor('load', 99, 'db'), 'db');
});

test('checkRunWindow refuses a run that would end outside the window, unless overridden', () => {
  const window: EnvConfig['windowUtc'] = { weekdays: '17:00-06:00', weekends: 'all-day' };
  const load = (totalSec: number): ResolvedProfile => ({ type: 'load', users: 10, totalSec });
  const thu = (hhmm: string) => new Date(`2026-10-22T${hhmm}:00Z`); // a Thursday

  assert.deepEqual(checkRunWindow(thu('05:00'), window, load(1800), false), { overridden: false });
  assert.throws(
    () => checkRunWindow(thu('05:50'), window, load(1800), false),
    (err: unknown) => err instanceof GuardrailError && err.code === 'OUTSIDE_WINDOW',
  );
  assert.throws(
    () => checkRunWindow(thu('12:00'), window, load(60), false),
    (err: unknown) => err instanceof GuardrailError && err.code === 'OUTSIDE_WINDOW',
  );
  assert.deepEqual(checkRunWindow(thu('05:50'), window, load(1800), true), { overridden: true });
  assert.deepEqual(checkRunWindow(thu('12:00'), window, { type: 'smoke', totalSec: 0 }, false), { overridden: false });
});

test('countScriptErrors counts the script exceptions k6 logs', () => {
  const log = [
    'time="2026-10-22T15:08:34+03:00" level=error msg="Error: boom\\n\\tat itemsGrid (file:///x/items.js:5:9(8))\\n" executor=per-vu-iterations hint="script exception" scenario=items_grid source=stacktrace',
    'time="2026-10-22T15:08:35+03:00" level=error msg="Error: boom again" executor=per-vu-iterations hint="script exception" scenario=items_grid source=stacktrace',
    'time="2026-10-22T15:08:36+03:00" level=error msg="thresholds on metrics \'checks\' have been crossed"',
    'time="2026-10-22T15:08:36+03:00" level=error msg="test run was aborted because k6 received a \'interrupt\' signal"',
    'running (0m01.0s), 1/1 VUs, 0 complete and 0 interrupted iterations',
  ].join('\n');
  assert.equal(countScriptErrors(log), 2);
  assert.equal(countScriptErrors(''), 0);
});

test('the live dashboard listens on 127.0.0.1 unless the user set K6_WEB_DASHBOARD_HOST', () => {
  const files = { runDir: '/run', configFile: '/run/k6-config.json', secretsFile: '/tmp/s.json', env: {} };
  assert.equal(k6RunVariables(files, {}).K6_WEB_DASHBOARD_HOST, '127.0.0.1');
  const own = { K6_WEB_DASHBOARD_HOST: '0.0.0.0' };
  assert.equal(k6RunVariables(files, own).K6_WEB_DASHBOARD_HOST, undefined, 'the runner does not set it over the user');
  assert.equal(k6Environment(own, k6RunVariables(files, own)).K6_WEB_DASHBOARD_HOST, '0.0.0.0', "k6 gets the user's own");
});

test('k6Environment keeps no inherited K6_* option and no PERF_* secret', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/x',
    K6_VUS: '15',
    K6_DURATION: '40m',
    K6_RPS: '1000',
    K6_NO_THRESHOLDS: 'true',
    K6_HTTP_DEBUG: 'full',
    K6_OUT: 'csv=x.csv',
    K6_LOG_FORMAT: 'json',
    k6_iterations: '99',
    K6_WEB_DASHBOARD_PORT: '-1',
    K6_WEB_DASHBOARD_HOST: '127.0.0.1',
    PERF_USER_PASSWORD: 'secret',
    PERF_RESULTS_DIR: '/tmp/r',
  };

  const env = k6Environment(source, { PERF_RUN_DIR: '/run', K6_WEB_DASHBOARD: 'true' });

  assert.deepEqual(env, {
    PATH: '/usr/bin',
    HOME: '/home/x',
    K6_WEB_DASHBOARD_PORT: '-1',
    K6_WEB_DASHBOARD_HOST: '127.0.0.1',
    PERF_RUN_DIR: '/run',
    K6_WEB_DASHBOARD: 'true',
  });
  assert.deepEqual(ignoredK6Variables(source), [
    'K6_DURATION',
    'K6_HTTP_DEBUG',
    'K6_LOG_FORMAT',
    'K6_NO_THRESHOLDS',
    'K6_OUT',
    'K6_RPS',
    'K6_VUS',
    'k6_iterations',
  ]);
});

test('sweepStaleSecrets removes secrets files of dead or ancient runs and keeps live ones', async () => {
  const dir = await tempDir('perf-sweep-');
  const name = (pid: number | null) => (pid === null ? `perf-secrets-${randomUUID()}.json` : `perf-secrets-${pid}-${randomUUID()}.json`);
  const dead = name(await deadPid());
  const live = name(process.pid);
  const ancientLive = name(process.pid); // an alive pid but 7 h old: the pid was reused
  const unknownOwner = name(null);
  const ancientUnknown = name(null);
  for (const file of [dead, live, ancientLive, unknownOwner, ancientUnknown, 'other.json']) {
    await writeFile(join(dir, file), '{}', { mode: 0o600 });
  }
  const sevenHoursAgo = new Date(Date.now() - 7 * 3600 * 1000);
  await utimes(join(dir, ancientLive), sevenHoursAgo, sevenHoursAgo);
  await utimes(join(dir, ancientUnknown), sevenHoursAgo, sevenHoursAgo);

  const removed = await sweepStaleSecrets(dir);

  assert.deepEqual(removed.sort(), [dead, ancientLive, ancientUnknown].sort());
  assert.deepEqual((await readdir(dir)).sort(), [live, unknownOwner, 'other.json'].sort());
  assert.deepEqual(await sweepStaleSecrets(join(dir, 'missing')), []);
});

// ---------------------------------------------------------------------------------------------------------------
// k6 and the mock
// ---------------------------------------------------------------------------------------------------------------

test('fingerprint reads swagger hash and main bundle name from the mock', async () => {
  const project = await loadProject('selftest');
  const env = envConfig(project, 'local');
  const swagger = Buffer.from(await (await fetch(`${mock.url}/swagger/v1/swagger.json`)).arrayBuffer());

  const fp = await buildFingerprint(env);

  assert.equal(fp.swaggerSha256, createHash('sha256').update(swagger).digest('hex'));
  assert.equal(fp.appMain, 'main-SELFTEST.js');

  const nowhere = await buildFingerprint({ ...env, appUrl: 'http://127.0.0.1:9/', swaggerUrl: 'http://127.0.0.1:9/swagger.json' });
  assert.deepEqual(nowhere, {});

  assert.equal(fingerprintChanged(fp, { ...fp }), false);
  assert.equal(fingerprintChanged(fp, { ...fp, appMain: 'main-NEW.js' }), true);
  assert.equal(fingerprintChanged(fp, { ...fp, swaggerSha256: 'f'.repeat(64) }), true);
  assert.equal(fingerprintChanged(fp, {}), false); // a fingerprint we could not read is not a deploy
});

// ---------------------------------------------------------------------------------------------------------------
// abort limits: project, feature (workload.yaml `abort:`), run option
// ---------------------------------------------------------------------------------------------------------------

/**
 * The selftest items feature copied to a temp folder with `abortYaml` appended to its workload.yaml, so the limits go
 * through the real config loader. The script stays the original (its imports are relative to the repo).
 */
async function featureWithAbort(abortYaml: string): Promise<Feature> {
  const project = await loadProject('selftest');
  const original = await loadFeature(project, 'items');
  const dir = await tempDir('perf-abort-');
  const featureDir = join(dir, 'features', 'items');
  await mkdir(featureDir, { recursive: true });
  await copyFile(join(original.dir, 'journey.yaml'), join(featureDir, 'journey.yaml'));
  await writeFile(join(featureDir, 'workload.yaml'), `${await readFile(join(original.dir, 'workload.yaml'), 'utf8')}${abortYaml}\n`);
  const copy = await loadFeature({ ...project, dir }, 'items');
  return { ...copy, script: original.script };
}

const PROJECT_DEFAULT = { errorRate: 0.1, p95Ms: 15000, dbCpuOrIoPct: 95 };

test('effectiveAbort: the project limits, the feature over them key by key, the run option over both', async () => {
  const project = await loadProject('selftest');
  const feature = structuredClone(await loadFeature(project, 'items'));
  const fromProject = { errorRate: 'project', p95Ms: 'project', dbCpuOrIoPct: 'project' };

  assert.deepEqual(effectiveAbort(project, feature), { ...PROJECT_DEFAULT, source: fromProject, projectDefault: PROJECT_DEFAULT });
  assert.deepEqual(effectiveAbort(project, feature, {}), effectiveAbort(project, feature), 'an empty override changes nothing');

  feature.workload.abort = { p95Ms: 45000 };
  assert.deepEqual(effectiveAbort(project, feature), {
    errorRate: 0.1,
    p95Ms: 45000,
    dbCpuOrIoPct: 95,
    source: { ...fromProject, p95Ms: 'feature' },
    projectDefault: PROJECT_DEFAULT,
  });

  feature.workload.abort = { p95Ms: 45000, errorRate: 0.05 };
  assert.deepEqual(effectiveAbort(project, feature, { p95Ms: 20000, dbCpuOrIoPct: 80 }), {
    errorRate: 0.05,
    p95Ms: 20000,
    dbCpuOrIoPct: 80,
    source: { errorRate: 'feature', p95Ms: 'override', dbCpuOrIoPct: 'override' },
    projectDefault: PROJECT_DEFAULT,
  }, 'the override wins over the feature and the project; a key it leaves out keeps the lower layer; the project default is always recorded');

  assert.deepEqual(project.abort, PROJECT_DEFAULT, 'the project is not changed');
  assert.deepEqual(feature.workload.abort, { p95Ms: 45000, errorRate: 0.05 }, 'the feature is not changed');
});

// R34: error rate and DB CPU/IO may only be tightened, by a feature or a run option; p95 may be raised.
test('effectiveAbort: error_rate and DB CPU/IO are tighten-only, for the feature and for the run option; equal to the project is fine', async () => {
  const project = await loadProject('selftest');
  const feature = structuredClone(await loadFeature(project, 'items'));
  const workloadFile = join(feature.dir, 'workload.yaml');

  // allowed: equal to the project, tighter than it, and a raised p95
  feature.workload.abort = { errorRate: 0.1, dbCpuOrIoPct: 95 };
  assert.deepEqual(effectiveAbort(project, feature, { errorRate: 0.1, dbCpuOrIoPct: 95, p95Ms: 600000 }).p95Ms, 600000, 'a raised p95 is allowed');
  feature.workload.abort = { errorRate: 0.02, dbCpuOrIoPct: 50 };
  assert.deepEqual(effectiveAbort(project, feature, { errorRate: 0.01, dbCpuOrIoPct: 40 }).source, { errorRate: 'override', p95Ms: 'project', dbCpuOrIoPct: 'override' });

  // the feature loosens: a ConfigError naming workload.yaml and the path
  for (const [abort, path, max] of [
    [{ errorRate: 0.11 }, 'abort.error_rate', '0.1'],
    [{ dbCpuOrIoPct: 99 }, 'abort.db_cpu_or_io_pct', '95'],
    [{ dbCpuOrIoPct: 100 }, 'abort.db_cpu_or_io_pct', '95'],
  ] as const) {
    feature.workload.abort = { ...abort };
    assert.throws(
      () => effectiveAbort(project, feature),
      (err: unknown) => err instanceof ConfigError && err.message.startsWith(`${workloadFile}: ${path} must be at most ${max}`),
      JSON.stringify(abort),
    );
  }

  // the run option loosens: a refusal (GuardrailError ABORT_LOOSENED) that names the option and the project's limit
  feature.workload.abort = {};
  for (const [override, name, max] of [
    [{ errorRate: 0.5 }, 'errorRate', '0.1'],
    [{ errorRate: 1 }, 'errorRate', '0.1'],
    [{ dbCpuOrIoPct: 96 }, 'dbCpuOrIoPct', '95'],
    [{ dbCpuOrIoPct: 100 }, 'dbCpuOrIoPct', '95'],
  ] as const) {
    assert.throws(
      () => effectiveAbort(project, feature, override),
      (err: unknown) =>
        err instanceof GuardrailError &&
        err.code === 'ABORT_LOOSENED' &&
        err.message.includes(`abortOverride.${name} ${Object.values(override)[0]} is above the project's ${max}`) &&
        /may only tighten errorRate and dbCpuOrIoPct/.test(err.message),
      JSON.stringify(override),
    );
  }
});

test('abortLimitNotes: a database limit set only by the feature or a run option says the project default is none', async () => {
  const project = structuredClone(await loadProject('selftest'));
  delete project.abort.dbCpuOrIoPct; // R45: optional in project.yaml
  const feature = structuredClone(await loadFeature(project, 'items'));
  feature.workload.abort = { dbCpuOrIoPct: 90 };
  assert.deepEqual(abortLimitNotes(effectiveAbort(project, feature), 'items'), [
    'abort limit database CPU/IO 90% from feature items (project default none)',
  ]);
  delete feature.workload.abort;
  assert.deepEqual(abortLimitNotes(effectiveAbort(project, feature, { dbCpuOrIoPct: 80 }), 'items'), [
    'abort limit database CPU/IO 80% from run option (project default none)',
  ]);
});

test('abortLimitNotes: one line per limit that does not come from the project, none when all do', async () => {
  const project = await loadProject('selftest');
  const feature = structuredClone(await loadFeature(project, 'items'));
  assert.deepEqual(abortLimitNotes(effectiveAbort(project, feature), 'items'), []);

  feature.workload.abort = { p95Ms: 45000, errorRate: 0.05 };
  assert.deepEqual(abortLimitNotes(effectiveAbort(project, feature), 'items'), [
    'abort limit error rate 0.05 from feature items (project default 0.1)',
    'abort limit p95 45000 ms from feature items (project default 15000 ms)',
  ]);

  assert.deepEqual(abortLimitNotes(effectiveAbort(project, feature, { p95Ms: 9000, dbCpuOrIoPct: 80 }), 'items'), [
    'abort limit error rate 0.05 from feature items (project default 0.1)',
    'abort limit p95 9000 ms from run option (project default 15000 ms)',
    'abort limit database CPU/IO 80% from run option (project default 95%)',
  ]);
});

test('runFeature logs the abort limits that do not come from the project at run start', { timeout: 120_000 }, async () => {
  const feature = await featureWithAbort('abort: { p95_ms: 45000 }');
  const logs: string[] = [];

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', quiet: true, log: (m) => logs.push(m), abortOverride: { dbCpuOrIoPct: 90 } });

  assert.equal(result.ok, true);
  const notes = logs.filter((l) => l.startsWith('abort limit'));
  assert.deepEqual(notes, [
    'abort limit p95 45000 ms from feature items (project default 15000 ms)',
    'abort limit database CPU/IO 90% from run option (project default 95%)',
  ]);
  assert.ok(logs.indexOf(notes[0]!) < logs.findIndex((l) => /^smoke run: /.test(l)), 'logged before the k6 run starts');

  const plain: string[] = [];
  await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true, log: (m) => plain.push(m) });
  assert.deepEqual(plain.filter((l) => l.startsWith('abort limit')), [], 'limits that all come from the project are not mentioned');
});

test('effectiveAbort rejects an override that is not a finite number in range, or not a limit', async () => {
  const project = await loadProject('selftest');
  const feature = await loadFeature(project, 'items');
  const bad: Array<[Record<string, number>, RegExp]> = [
    [{ p95Ms: 0 }, /abortOverride\.p95Ms must be at least 1/],
    [{ p95Ms: Number.NaN }, /abortOverride\.p95Ms must be a number/],
    [{ p95Ms: Number.POSITIVE_INFINITY }, /abortOverride\.p95Ms must be a number/],
    [{ errorRate: 0 }, /abortOverride\.errorRate must be above 0 and at most 1/],
    [{ errorRate: 2 }, /abortOverride\.errorRate must be above 0 and at most 1/],
    [{ dbCpuOrIoPct: 101 }, /abortOverride\.dbCpuOrIoPct must be above 0 and at most 100/],
    [{ dbCpuPct: 90 }, /abortOverride has unknown key dbCpuPct/],
  ];
  for (const [override, expected] of bad) {
    assert.throws(() => effectiveAbort(project, feature, override), (err: unknown) => err instanceof ConfigError && expected.test(err.message), JSON.stringify(override));
  }
});

test('a bad abortOverride refuses the run before anything starts', async () => {
  await assert.rejects(
    runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true, abortOverride: { p95Ms: -1 } }),
    (err: unknown) => err instanceof ConfigError && /abortOverride\.p95Ms/.test(err.message),
  );
  assert.deepEqual(await runDirs(), [], 'no run folder, nothing sent');
});

test('a feature abort reaches k6-config.json and meta.abort; the rest comes from the project', { timeout: 120_000 }, async () => {
  const feature = await featureWithAbort('abort: { p95_ms: 45000 }');

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', quiet: true });

  assert.equal(result.ok, true);
  const cfg = await readJson(join(result.runDir, 'k6-config.json'));
  assert.deepEqual(cfg.abort, { errorRate: 0.1, p95Ms: 45000 }, 'the k6 thresholds are built from these');
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.deepEqual(meta.abort, {
    errorRate: 0.1,
    p95Ms: 45000,
    dbCpuOrIoPct: 95,
    source: { errorRate: 'project', p95Ms: 'feature', dbCpuOrIoPct: 'project' },
    projectDefault: PROJECT_DEFAULT,
  });
});

test('a run option wins over the feature and the project, and meta.abort says so', { timeout: 120_000 }, async () => {
  const feature = await featureWithAbort('abort: { p95_ms: 45000, db_cpu_or_io_pct: 90 }');

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', quiet: true, abortOverride: { p95Ms: 9000 } });

  assert.equal(result.ok, true);
  const cfg = await readJson(join(result.runDir, 'k6-config.json'));
  assert.deepEqual(cfg.abort, { errorRate: 0.1, p95Ms: 9000 });
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.deepEqual(meta.abort, {
    errorRate: 0.1,
    p95Ms: 9000,
    dbCpuOrIoPct: 90,
    source: { errorRate: 'project', p95Ms: 'override', dbCpuOrIoPct: 'feature' },
    projectDefault: PROJECT_DEFAULT,
  });
});

test('smoke writes summary, timeseries, dashboard, config and meta', async () => {
  const result = await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true });

  assert.equal(result.exitCode, 0);
  assert.equal(result.ok, true);
  assert.equal(result.runDir, join(root, (await runDirs())[0]!));
  assert.match(basename(result.runDir), /^\d{4}-\d{2}-\d{2}_\d{4}_selftest_items_smoke$/);
  for (const file of RUN_FILES) assert.ok(existsSync(join(result.runDir, file)), `${file} exists`);

  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.k6.exitCode, 0);
  assert.equal(meta.k6.signal, null);
  assert.equal(meta.k6.scriptErrors, 0);
  assert.equal(meta.k6.abortReason, undefined);
  assert.equal(meta.interrupted, false);
  assert.equal(meta.runId, basename(result.runDir));
  assert.equal(meta.project, 'selftest');
  assert.equal(meta.feature, 'items');
  assert.equal(meta.env, 'local');
  assert.deepEqual(meta.profile, { type: 'smoke', totalSec: 0 });
  assert.match(meta.k6Version, /^\d+\.\d+\.\d+/);
  if (insideGit()) {
    assert.match(meta.git.commit, /^[0-9a-f]{40}$/);
    assert.equal(typeof meta.git.dirty, 'boolean');
  } else {
    assert.deepEqual(meta.git, { commit: null, dirty: null }, 'outside a git checkout (a zip download) there is no commit to record');
  }
  assert.equal(typeof meta.loadMachine.host, 'string');
  assert.equal(typeof meta.loadMachine.platform, 'string');
  assert.equal(meta.fingerprint.before.appMain, 'main-SELFTEST.js');
  assert.deepEqual(meta.fingerprint.after, meta.fingerprint.before);
  assert.equal(meta.fingerprint.changed, false);
  assert.deepEqual(meta.guardrails, { allowMax: false, windowOverride: false, busyOverride: false });
  assert.ok(Date.parse(meta.startedAt) <= Date.parse(meta.endedAt));
  assert.equal(meta.cleanup, undefined);
  assert.equal(meta.database, 'none', 'the selftest project reads no database, and meta.json says so');
  assert.deepEqual(meta.secretScan, { ok: true });
  assert.deepEqual(result.meta.secretScan, { ok: true });
  assert.deepEqual(meta.report, { ok: true }, 'the report was written and meta.json says so');
  assert.equal(result.verdict?.verdict, 'NO BASELINE', "the result carries the report's verdict");
  assert.ok(result.verdict!.reasons.length > 0);
  assert.deepEqual(result.meta.report, { ok: true });
  assert.deepEqual(meta.targets, 'baseline');
  assert.equal(meta.baseline, null, 'the baseline slot the report used is recorded in meta.json (none here)');
  assert.deepEqual(meta.rules, { flags: FLAG_LIMITS, breaking: BREAKING_LIMITS }, 'so are the limits that produced its flags and verdict');
  assert.deepEqual(
    meta.workload,
    {
      businessUnit: 'users working',
      businessAction: 'item actions',
      thinkTime: { min: 0.5, max: 1 },
      readOnly: true,
      requests: { 'items.search': 'POST /items/search', 'items.slow_search': 'POST /items/slow-search', 'items.export': 'POST /items/export' },
    },
    'and the workload terms the report words the load with',
  );
  assert.deepEqual(
    meta.abort,
    { ...PROJECT_DEFAULT, source: { errorRate: 'project', p95Ms: 'project', dbCpuOrIoPct: 'project' }, projectDefault: PROJECT_DEFAULT },
    'meta.abort: the limits that applied, all from the project here, with the project default beside them',
  );
  assert.deepEqual(result.meta.abort, meta.abort);
  const report = await readFile(join(result.runDir, 'report.html'), 'utf8');
  assert.match(report, /<section id="verdict"><h2>Verdict<\/h2>/);
  assert.match(report, /smoke check: each journey once/);
  assert.match(report, /Item actions per minute \(whole run\)/, 'the label is the recorded business action, not a hard-coded one');
  assert.ok(!/grid actions/i.test(report));
  assert.ok(!report.includes('setup_data') && !/eyJ/.test(report), 'no token reaches the report');

  const cfg = await readJson(join(result.runDir, 'k6-config.json'));
  assert.equal(cfg.runId, meta.runId);
  assert.equal(cfg.apiUrl, `${mock.url}/api`);
  assert.deepEqual(cfg.caps, { maxVus: 20, maxRps: 30 });
  assert.equal(cfg.rps, 30, 'a smoke keeps the cap as its rps option');
  assert.deepEqual(cfg.stepsPerIteration, { items_grid: 2.05 });
  assert.deepEqual(cfg.journeys[0].steps, [
    { name: 'search', optionalShare: 100 },
    { name: 'slow_search', optionalShare: 100 },
    { name: 'export', optionalShare: 5 },
  ]);
  assert.deepEqual(cfg.auth, { type: 'ropc', tokenUrl: `${mock.url}/oauth/token`, clientId: 'perf', scope: 'openid perf offline_access' });
  assert.deepEqual(cfg.abort, { errorRate: 0.1, p95Ms: 15000 });

  const summary = await readJson(join(result.runDir, 'summary.json'));
  assert.equal(summary.metrics['http_req_duration{name:items.export}'].values.count, 1);
  assert.ok(!('setup_data' in summary), 'k6 setup_data (the tokens) is not written to summary.json');

  const ts = await readJson(join(result.runDir, 'timeseries.json'));
  assert.equal(ts.bucketSec, 15);
  const reqs = ts.buckets.reduce((sum: number, b: { reqs: number }) => sum + b.reqs, 0);
  assert.equal(reqs, 4); // one token request and the three steps

  const ledger = await readSmokeLedger();
  assert.deepEqual(
    Object.values(ledger).map((e) => e.runId),
    [meta.runId],
  );
});

test('a report that cannot be built is recorded in meta.json and does not fail the run', async () => {
  const original = await loadFeature(await loadProject('selftest'), 'items');
  const dir = await tempDir('perf-feature-');
  for (const name of ['journey.yaml', 'workload.yaml']) await copyFile(join(original.dir, name), join(dir, name));
  await writeFile(join(dir, 'baseline.json'), '{ not json', 'utf8');
  const feature: Feature = { ...original, dir }; // the script stays where its imports of core/ resolve

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', quiet: true });
  assert.equal(result.ok, true, 'k6 and the smoke checks passed; the report is not part of that');
  assert.equal(result.meta.report?.ok, false);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.report.ok, false);
  assert.match(meta.report.error, /baseline\.json is not valid JSON/);
  assert.equal(meta.k6.exitCode, 0, 'the rest of meta.json is intact');
  assert.deepEqual(meta.secretScan, { ok: true });
  assert.ok(!existsSync(join(result.runDir, 'report.html')));
  assert.ok(existsSync(join(result.runDir, 'summary.json')));
});

test('the baseline slot is copied into meta.json when a run finishes; changing baseline.json afterwards does not touch the run\'s report', async () => {
  const original = await loadFeature(await loadProject('selftest'), 'items');
  const dir = await tempDir('perf-feature-');
  for (const name of ['journey.yaml', 'workload.yaml']) await copyFile(join(original.dir, name), join(dir, name));
  const step = { p50: 1000, p95: 2000, p99: 3000, errorRate: 0, rps: 1 };
  const slot = {
    runId: '2026-10-01_2010_selftest_items_smoke',
    acceptedAt: '2026-10-01T21:00:00.000Z',
    steps: { 'items.search': step, 'items.slow_search': step, 'items.export': step },
  };
  await writeFile(join(dir, 'baseline.json'), JSON.stringify({ local: { smoke: slot } }), 'utf8');
  const feature: Feature = { ...original, dir };

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', quiet: true });
  assert.equal(result.meta.report?.ok, true);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.deepEqual(meta.baseline, { env: 'local', profile: 'smoke', ...slot });
  const first = await readFile(join(result.runDir, 'report.html'), 'utf8');
  assert.match(first, /2026-10-01_2010_selftest_items_smoke/, 'the report names the run the baseline came from');

  // a later `baseline accept` replaces the slot, or the file goes away: the run's report stays what it was
  await writeFile(join(dir, 'baseline.json'), JSON.stringify({ local: { smoke: { ...slot, runId: 'a-newer-run', steps: { 'items.search': { ...step, p95: 1 } } } } }), 'utf8');
  assert.deepEqual(await renderRunReport(result.runDir, { feature }), { ok: true });
  assert.equal(await readFile(join(result.runDir, 'report.html'), 'utf8'), first);
  await rm(join(dir, 'baseline.json'));
  assert.deepEqual((await verifyRunReport(result.runDir, { feature })).mismatches, []);
});

test('k6-config.json never contains a password', async () => {
  const password = 'Zq81-not-the-real-password!';
  process.env.PERF_USER_PASSWORD = password; // the mock refuses it, so k6 fails in setup after the files are written

  const result = await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true });

  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
  const cfgText = await readFile(join(result.runDir, 'k6-config.json'), 'utf8');
  assert.doesNotMatch(cfgText, /password/i);
  assert.ok(!cfgText.includes(password));
  for (const file of await readdir(result.runDir)) {
    const raw = await readFile(join(result.runDir, file));
    const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    assert.ok(!text.includes(password), `${file} does not contain the password`);
  }
  assert.equal(Object.keys(await readSmokeLedger()).length, 0, 'a failed smoke is not recorded');
});

test('a static_header project: no login, the header reaches k6 only through the secrets file', async () => {
  const project = structuredClone(await loadProject('selftest'));
  project.auth = { type: 'static_header', header: 'Authorization', value: 'Bearer ${env:PERF_TEST_STATIC} ${random:8}' };
  const scriptDir = await tempDir('perf-static-');
  const core = (file: string) => pathToFileURL(join(REPO_ROOT, 'core', file)).href;
  const script = join(scriptDir, 'items.js');
  const call = (id: string, route: string) =>
    `  step('${id}', { method: 'POST', url: cfg.apiUrl + '${route}', body: {}, headers: AUTH, checks: { 'has items': (res) => res.body.includes('items') } });`;
  await writeFile(
    script,
    [
      `import { loadRunConfig, loadSecrets, buildOptions } from '${core('config.js')}';`,
      `import { staticHeaders } from '${core('auth/static.js')}';`,
      `import { step } from '${core('request.js')}';`,
      `export { handleSummary } from '${core('summary.js')}';`,
      'const cfg = loadRunConfig();',
      'const AUTH = staticHeaders(loadSecrets());',
      'export const options = buildOptions(cfg);',
      'export function itemsGrid() {',
      call('items.search', '/items/search'),
      call('items.slow_search', '/items/slow-search'),
      "  step('items.export', { method: 'POST', url: cfg.apiUrl + '/items/export', body: {}, headers: AUTH, checks: { 'body': (res) => res.body.length > 0 } });",
      '}',
    ].join('\n'),
  );
  const feature: Feature = { ...(await quickFeature()), script, readOnly: false, writes: [{ method: 'POST', route: '/items/search', cleanup: 'app' }] };
  // No token endpoint and no accounts: a static_header project needs neither, so the env adapter is not asked for them.
  const saved = { url: process.env.PERF_TOKEN_URL, login: process.env.PERF_USER_LOGIN };
  delete process.env.PERF_TOKEN_URL;
  delete process.env.PERF_USER_LOGIN;
  process.env.PERF_TEST_STATIC = 'static-secret-4711';
  let result: RunResult;
  try {
    result = await runFeature({ project, feature, env: 'local', profile: 'smoke', quiet: true });
  } finally {
    for (const [key, value] of [['PERF_TOKEN_URL', saved.url], ['PERF_USER_LOGIN', saved.login]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete process.env.PERF_TEST_STATIC;
  }
  assert.equal(result.ok, true, JSON.stringify(result.meta.k6));
  const cfg = await readJson(join(result.runDir, 'k6-config.json'));
  assert.deepEqual(cfg.auth, { type: 'static_header', header: 'Authorization' }, 'the run config names the header, never its value');
  assert.deepEqual(result.meta.workload!.writes, [{ request: 'POST /items/search', cleanup: 'app' }], 'the declared writes are recorded for the report');
  assert.match(await readFile(join(result.runDir, 'report.md'), 'utf8'), /the app prunes these rows; nothing for the runner to clean up/);
  const summary = await readJson(join(result.runDir, 'summary.json'));
  assert.ok(
    !Object.keys(summary.metrics).some((key) => key.includes('auth_token')),
    'no token request and no auth_token threshold, so summary.json has no auth_token metric at all',
  );
  for (const file of await readdir(result.runDir)) {
    const raw = await readFile(join(result.runDir, file));
    const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    assert.ok(!text.includes('static-secret-4711'), `${file} does not contain the header value`);
  }
});

test('a script that leaks the static header key (console.log, its own handleSummary) gets it redacted, and the scan says so', async () => {
  const project = structuredClone(await loadProject('selftest'));
  project.auth = { type: 'static_header', header: 'Authorization', value: 'Bearer ${env:PERF_TEST_LEAK}' };
  const scriptDir = await tempDir('perf-leak-');
  const core = (file: string) => pathToFileURL(join(REPO_ROOT, 'core', file)).href;
  const script = join(scriptDir, 'items.js');
  const call = (id: string, route: string) =>
    `  step('${id}', { method: 'POST', url: cfg.apiUrl + '${route}', body: {}, headers: AUTH, checks: { 'has items': (res) => res.body.includes('items') } });`;
  await writeFile(
    script,
    [
      `import { loadRunConfig, loadSecrets, buildOptions } from '${core('config.js')}';`,
      `import { staticHeaders } from '${core('auth/static.js')}';`,
      `import { step } from '${core('request.js')}';`,
      'const cfg = loadRunConfig();',
      'const AUTH = staticHeaders(loadSecrets());',
      'export const options = buildOptions(cfg);',
      'export function itemsGrid() {',
      '  console.log("leaking " + AUTH.Authorization);',
      call('items.search', '/items/search'),
      call('items.slow_search', '/items/slow-search'),
      call('items.export', '/items/export'),
      '}',
      'export function handleSummary(data) {',
      "  return { [__ENV.PERF_RUN_DIR + '/summary.json']: JSON.stringify(Object.assign({}, data, { leaked: AUTH.Authorization })), [__ENV.PERF_RUN_DIR + '/extra.txt']: AUTH.Authorization };",
      '}',
    ].join('\n'),
  );
  const feature: Feature = { ...(await quickFeature()), script };
  process.env.PERF_TEST_LEAK = 'leak-me-not-8813';
  let result: RunResult;
  try {
    result = await runFeature({ project, feature, env: 'local', profile: 'smoke', quiet: true });
  } finally {
    delete process.env.PERF_TEST_LEAK;
  }
  assert.equal(result.meta.secretScan!.ok, false);
  const scanned = (result.meta.secretScan as { files: string[] }).files;
  for (const name of ['summary.json', 'k6.log', 'extra.txt']) assert.ok(scanned.includes(name), `${name} is named in the scan (${scanned.join(', ')})`);
  for (const file of await readdir(result.runDir)) {
    const raw = await readFile(join(result.runDir, file));
    const text = (file.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8');
    assert.ok(!text.includes('leak-me-not-8813'), `${file} does not hold the key`);
  }
  assert.match(await readFile(join(result.runDir, 'extra.txt'), 'utf8'), /\[redacted\]/);
  assert.match(await readFile(join(result.runDir, 'k6.log'), 'utf8'), /leaking Bearer \[redacted\]/);
  assert.equal((await readJson(join(result.runDir, 'meta.json'))).secretScan.ok, false);
});

test('a static_header project whose ${env:NAME} is not set is refused before k6 starts, naming the variable', async () => {
  const project = structuredClone(await loadProject('selftest'));
  project.auth = { type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_TEST_UNSET_KEY}' };
  delete process.env.PERF_TEST_UNSET_KEY;
  await assert.rejects(runFeature({ project, feature: await quickFeature(), env: 'local', profile: 'smoke', quiet: true }), /PERF_TEST_UNSET_KEY is not set/);
  assert.deepEqual(await runDirs(), [], 'no run folder: nothing was sent');
});

test('secrets temp file is gone after the run', async () => {
  const secretsTmp = await tempDir('perf-tmp-');
  // Left behind by a run that died (SIGKILL, crash): the next run sweeps it.
  const leftover = `perf-secrets-${await deadPid()}-${randomUUID()}.json`;
  await writeFile(join(secretsTmp, leftover), '{}', { mode: 0o600 });
  process.env.TMPDIR = secretsTmp;
  const seen = new Map<string, number>(); // file -> mode
  const poll = setInterval(() => {
    void readdir(secretsTmp)
      .then(async (names) => {
        for (const name of names.filter((n) => n.startsWith('perf-secrets-') && n !== leftover)) {
          const st = await stat(join(secretsTmp, name)).catch(() => null);
          if (st) seen.set(name, st.mode & 0o777);
        }
      })
      .catch(() => {});
  }, 20);
  try {
    const result = await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true });
    assert.equal(result.ok, true);
  } finally {
    clearInterval(poll);
    process.env.TMPDIR = savedEnv.TMPDIR;
    if (savedEnv.TMPDIR === undefined) delete process.env.TMPDIR;
  }
  assert.equal(seen.size, 1, 'one secrets file existed while k6 ran');
  assert.match([...seen.keys()][0]!, new RegExp(`^perf-secrets-${process.pid}-`), 'its name carries the owning pid');
  assert.deepEqual([...seen.values()], [0o600]);
  assert.deepEqual(
    (await readdir(secretsTmp)).filter((n) => n.startsWith('perf-secrets-')),
    [],
    'neither this run nor the dead run left a secrets file',
  );
});

test('inherited K6_* variables cannot override the profile, thresholds or log format', { timeout: 120_000 }, async () => {
  // A short duration keeps a regression quick to see: 15 users for 5 s instead of the smoke's single iteration.
  const injected = { K6_VUS: '15', K6_DURATION: '5s', K6_RPS: '1000', K6_NO_THRESHOLDS: 'true', K6_LOG_FORMAT: 'json' };
  Object.assign(process.env, injected);
  let result: RunResult;
  try {
    result = await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true });
  } finally {
    for (const key of Object.keys(injected)) delete process.env[key];
  }

  assert.equal(result.ok, true);
  const summary = await readJson(join(result.runDir, 'summary.json'));
  assert.equal(summary.metrics.iterations.values.count, 1, 'the smoke ran one iteration, not 15 users for 40m');
  assert.equal(summary.metrics.http_reqs.values.count, 4, 'one token request and the three steps');
  assert.ok(summary.metrics.checks.thresholds?.['rate==1'], 'the smoke thresholds were evaluated');
  const log = await readFile(join(result.runDir, 'k6.log'), 'utf8');
  assert.match(log, /level=warning/, 'k6 logged in its text format');
  assert.doesNotMatch(log, /"level":/);
});

test('a passing smoke on one env does not unlock a load on another', async () => {
  const project = structuredClone(await loadProject('selftest'));
  project.envs.local_b = structuredClone(project.envs.local!);
  const feature = await quickFeature();
  const now = () => new Date('2026-10-24T12:00:00Z');

  const smoke = await runFeature({ project, feature, env: 'local', profile: 'smoke', now, quiet: true });
  assert.equal(smoke.ok, true);
  const load = await runFeature({ project, feature, env: 'local_b', profile: 'load', now, quiet: true });

  assert.equal(load.ok, true);
  assert.deepEqual(await runDirs(), [
    '2026-10-24_1200_selftest_items_load',
    '2026-10-24_1200_selftest_items_smoke',
    '2026-10-24_1200_selftest_items_smoke_2', // the smoke local_b needed first
  ]);
  const secondSmoke = await readJson(join(root, '2026-10-24_1200_selftest_items_smoke_2', 'meta.json'));
  assert.equal(secondSmoke.env, 'local_b');
  const ledger = await readSmokeLedger();
  assert.deepEqual(Object.values(ledger).map((e) => e.runId).sort(), [
    '2026-10-24_1200_selftest_items_smoke',
    '2026-10-24_1200_selftest_items_smoke_2',
  ]);
});

test('load without a prior smoke runs smoke first', async () => {
  const feature = await quickFeature();
  const now = () => new Date('2026-10-24T12:00:00Z');

  const first = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now, quiet: true });

  assert.equal(first.exitCode, 0);
  assert.equal(first.ok, true);
  assert.deepEqual(await runDirs(), ['2026-10-24_1200_selftest_items_load', '2026-10-24_1200_selftest_items_smoke']);
  const smokeMeta = await readJson(join(root, '2026-10-24_1200_selftest_items_smoke', 'meta.json'));
  const loadMeta = await readJson(join(first.runDir, 'meta.json'));
  assert.equal(smokeMeta.k6.exitCode, 0);
  assert.equal(loadMeta.k6.exitCode, 0);
  assert.equal(loadMeta.profile.type, 'load');
  assert.equal(loadMeta.profile.users, 2);
  assert.deepEqual(loadMeta.profile.holdWindow, { fromSec: 1, toSec: 4 });
  assert.equal((await readJson(join(first.runDir, 'k6-config.json'))).rps, 15, 'the load is held at the env default rate');
  assert.equal((await readJson(join(root, '2026-10-24_1200_selftest_items_smoke', 'k6-config.json'))).rps, 30);
  assert.deepEqual(
    Object.values(await readSmokeLedger()).map((e) => e.runId),
    ['2026-10-24_1200_selftest_items_smoke'],
  );
  const ts = await readJson(join(first.runDir, 'timeseries.json'));
  assert.ok(Math.max(...ts.buckets.map((b: { vus: number }) => b.vus)) <= 2);

  // The ledger now holds the smoke, so the next load runs straight away.
  const second = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now, quiet: true });
  assert.equal(second.ok, true);
  assert.deepEqual(await runDirs(), [
    '2026-10-24_1200_selftest_items_load',
    '2026-10-24_1200_selftest_items_load_2',
    '2026-10-24_1200_selftest_items_smoke',
  ]);
});

test('a script exception fails the smoke, so the load is refused with SMOKE_REQUIRED', async () => {
  const scriptDir = await tempDir('perf-script-');
  const core = (file: string) => pathToFileURL(join(REPO_ROOT, 'core', file)).href;
  const script = join(scriptDir, 'items.js');
  await writeFile(
    script,
    [
      `import { loadRunConfig, loadSecrets, buildOptions } from '${core('config.js')}';`,
      `import { fetchTokens, bearer } from '${core('auth/ropc.js')}';`,
      `import { step } from '${core('request.js')}';`,
      `export { handleSummary } from '${core('summary.js')}';`,
      'const cfg = loadRunConfig();',
      'const secrets = loadSecrets();',
      'export const options = buildOptions(cfg);',
      'export function setup() { return { tokens: fetchTokens(cfg.auth, secrets.accounts) }; }',
      'export function itemsGrid(data) {',
      "  step('items.search', { method: 'POST', url: cfg.apiUrl + '/items/search', body: {}, token: bearer(data.tokens, 'User'),",
      "    checks: { 'has items': (res) => res.body.includes('items') } });",
      "  throw new Error('planted script error');",
      '}',
    ].join('\n'),
  );
  const feature = { ...(await quickFeature()), script };

  await assert.rejects(
    runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', quiet: true }),
    (err: unknown) => err instanceof GuardrailError && err.code === 'SMOKE_REQUIRED' && err.message.includes('_smoke'),
  );

  const dirs = await runDirs();
  assert.equal(dirs.length, 1);
  assert.match(dirs[0]!, /_selftest_items_smoke$/);
  const meta = await readJson(join(root, dirs[0]!, 'meta.json'));
  assert.equal(meta.k6.exitCode, 0, 'k6 itself exits 0 when an iteration throws');
  assert.ok(meta.k6.scriptErrors >= 1);
  assert.equal(Object.keys(await readSmokeLedger()).length, 0);
});

test('missing k6 gives the install hint', async () => {
  const emptyBin = await tempDir('perf-nok6-');
  const savedPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    await assert.rejects(k6Version(), /k6 not found — install with: brew install k6/);
    await assert.rejects(
      runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true }),
      /brew install k6/,
    );
  } finally {
    process.env.PATH = savedPath;
  }
  assert.deepEqual(await runDirs(), []);
  const release = await acquireEnvLock('local'); // the failed run let go of the env lock
  await release();
});

/** Start `perf run selftest items --profile load` as a child, send `signal` once its load k6 runs, check the leftovers. */
async function interruptCliLoad(signal: NodeJS.Signals): Promise<void> {
  const secretsTmp = await tempDir('perf-tmp-');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', CLI, 'run', 'selftest', 'items', '--profile', 'load', '--env', 'local'],
    { cwd: REPO_ROOT, env: { ...process.env, PERF_RESULTS_DIR: root, TMPDIR: secretsTmp }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));

  // Wait until the load run's k6 is executing (the CLI runs the smoke first), then send the signal.
  let loadDir: string | undefined;
  let sawSecrets = false;
  let code: number | null;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      loadDir = (await runDirs()).find((d) => d.endsWith('_load'));
      if ((await readdir(secretsTmp)).some((n) => n.startsWith('perf-secrets-')) && loadDir) sawSecrets = true;
      const log = loadDir ? await readFile(join(root, loadDir, 'k6.log'), 'utf8').catch(() => '') : '';
      if (/running \(0?0m0[2-9]/.test(log)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.ok(loadDir, `the load run started; output:\n${output}`);
    child.kill(signal);
    code = await exited;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); // its k6 dies on the closed pipe
  }

  assert.equal(code, 130, output);
  assert.ok(sawSecrets, 'the secrets file existed while k6 ran');
  const meta = await readJson(join(root, loadDir!, 'meta.json'));
  assert.equal(meta.interrupted, true);
  assert.equal(meta.k6.abortReason, 'interrupted');
  assert.equal(meta.k6.exitCode, 105); // k6's "stopped by a signal" exit, after a graceful stop
  assert.ok(existsSync(join(root, loadDir!, 'summary.json')), 'k6 still wrote its summary');
  assert.ok(existsSync(join(root, loadDir!, 'timeseries.json')));
  assert.deepEqual(
    (await readdir(secretsTmp)).filter((n) => n.startsWith('perf-secrets-')),
    [],
  );
}

test('Ctrl+C mid-run marks meta interrupted and deletes secrets', async () => {
  await interruptCliLoad('SIGINT');
});

test('closing the terminal (SIGHUP) mid-run stops k6 the same way and deletes secrets', async () => {
  await interruptCliLoad('SIGHUP');
});
