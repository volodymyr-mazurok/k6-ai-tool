import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main, verdictLine } from './cli.js';
import { loadFeature, loadProject } from './config.js';
import { runSmokeKey } from './run.js';

const FIXTURES = fileURLToPath(new URL('../tests/fixtures/report', import.meta.url));
const TOUCHED_ENV = ['PATH', 'PERF_RESULTS_DIR', 'TMPDIR', 'K6_VUS'];

const saved: Record<string, string | undefined> = {};
const scratch: string[] = [];

before(() => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
});

after(async () => {
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

interface Cli {
  code: number;
  out: string;
  err: string;
}

/** Run the command line in this process and collect what it prints. */
async function cli(...argv: string[]): Promise<Cli> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...parts: unknown[]) => void out.push(parts.join(' '));
  console.error = (...parts: unknown[]) => void err.push(parts.join(' '));
  try {
    const code = await main(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// R35: every command the CLI has, each added by the task that built it.
const COMMANDS = ['doctor', 'setup', 'teardown', 'run', 'check', 'har-summary', 'report', 'baseline accept', 'compare', 'selftest'];

test('--help lists every command', async () => {
  for (const flag of ['--help', '-h', 'help']) {
    const { code, out } = await cli(flag);
    assert.equal(code, 0, flag);
    for (const command of COMMANDS) {
      assert.match(out, new RegExp(`^  ${command}(?: |$)`, 'm'), `${flag} lists "${command}" as a command line`);
    }
  }
  assert.match((await cli('--help')).out, /--dry-run/, 'run documents --dry-run');
});

test('setup takes generic --set key=value flags, not any project\'s own', async () => {
  const help = (await cli('--help')).out;
  assert.match(help, /setup <project> --env <env> \[--set <key>=<value> \.\.\.\]/);
  assert.ok(!/forms-per-client|--clients|--form-type/.test(help), 'help names no project-specific flag');
  // the self-test project has no standing data: the refusal is about that, not about the flag
  const set = await cli('setup', 'selftest', '--env', 'local', '--set', 'widgets=3', '--set', 'colour=red');
  assert.notEqual(set.code, 0);
  assert.match(set.err, /no standing data to set up/);
  const old = await cli('setup', 'selftest', '--env', 'local', '--clients', '3');
  assert.equal(old.code, 2, 'the old project-specific flags are gone');
});

test('no command prints the usage and exits 2; an unknown command or a bare baseline exits 2', async () => {
  const none = await cli();
  assert.equal(none.code, 2);
  assert.match(none.out, /baseline accept/);
  const unknown = await cli('frobnicate');
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown command frobnicate/);
  const noSub = await cli('baseline');
  assert.equal(noSub.code, 2);
  assert.match(noSub.err, /baseline needs a subcommand/);
});

test('run --dry-run prints users, req/s and the k6 command without running k6', async () => {
  // No k6 on PATH, an empty results folder and a private TMPDIR: starting k6, taking the lock, writing a ledger or a secrets
  // file would each fail the run or show up below.
  const emptyBin = await tempDir('perf-nobin-');
  const results = await tempDir('perf-dry-results-');
  const tmp = await tempDir('perf-dry-tmp-');
  process.env.PATH = emptyBin;
  process.env.PERF_RESULTS_DIR = results;
  process.env.TMPDIR = tmp;
  process.env.K6_VUS = '4242';

  const { code, out, err } = await cli('run', 'selftest', 'items', '--profile', 'load', '--env', 'local', '--dry-run');
  assert.equal(code, 0, `${out}\n${err}`);
  assert.equal(err, '', 'nothing on stderr');

  assert.match(out, /dry run/i);
  assert.match(out, /^profile: +load\b/m);
  assert.match(out, /^users: +4\b/m, "the workload's 4 users");
  assert.match(out, /^req\/s: +at most 15 req\/s \(k6's rps option, set to the env's defaults\.rps of 15; --allow-max raises it to max_rps 30\)/m, 'a load is held at the env default rate');
  assert.match(out, /^duration: +1 min 25 s\b/m, 'ramp 15 s + hold 60 s + ramp down 10 s');
  assert.match(out, /k6 run --out json=<runDir>\/points\.json\.gz \S*items\.js$/m, 'the exact command line');
  assert.match(out, /PERF_CONFIG_FILE=<runDir>\/k6-config\.json/);
  assert.match(out, /PERF_SECRETS_FILE=<secrets-file>/);
  assert.match(out, /K6_VUS/, 'an inherited K6_* option that k6 would not get is named');
  assert.doesNotMatch(out, /4242/, 'its value is not printed');
  assert.match(out, /^smoke: +runs first/m, 'no passing smoke is on the ledger');

  assert.deepEqual(await readdir(results), [], 'no results folder, lock or ledger was written');
  assert.deepEqual(await readdir(tmp), [], 'no secrets file was written');
});

test('run --dry-run says when a passing smoke is on the ledger, and shows the stress levels', async () => {
  const results = await tempDir('perf-dry-ledger-');
  process.env.PERF_RESULTS_DIR = results;
  const project = await loadProject('selftest');
  const key = await runSmokeKey(project, await loadFeature(project, 'items'), 'local');
  await writeFile(
    join(results, '.smoke-ledger.json'),
    JSON.stringify({ [key]: { runId: '2026-10-22_1200_selftest_items_smoke', at: '2026-10-22T12:00:05.000Z' } }),
    'utf8',
  );

  const { code, out } = await cli('run', 'selftest', 'items', '--profile', 'stress', '--env', 'local', '--allow-max', '--dry-run');
  assert.equal(code, 0, out);
  assert.match(out, /^smoke: +passed already \(2026-10-22_1200_selftest_items_smoke\)/m);
  assert.match(out, /^req\/s: +2, 4, 6, .*, 30 req\/s/m, 'the stress levels: start 2, step 2, up to 30');
  assert.match(out, /^users: .*up to 20\b/m, "a stress run has the env's max_vus to spend");
  assert.deepEqual((await readdir(results)).sort(), ['.smoke-ledger.json'], 'the ledger was only read');
});

test('run --dry-run of a smoke has no rate to size and no smoke before it', async () => {
  process.env.PERF_RESULTS_DIR = await tempDir('perf-dry-smoke-');
  const { code, out } = await cli('run', 'selftest', 'items', '--profile', 'smoke', '--env', 'local', '--dry-run');
  assert.equal(code, 0, out);
  assert.match(out, /^profile: +smoke\b/m);
  assert.match(out, /^users: +1 per journey/m);
  assert.doesNotMatch(out, /^smoke: /m);
});

test('run --dry-run applies the guardrails of a real run: they still refuse, and print no command', async () => {
  process.env.PERF_RESULTS_DIR = await tempDir('perf-dry-refuse-');
  const wrongEnv = await cli('run', 'selftest', 'items', '--profile', 'load', '--env', 'prod', '--dry-run');
  assert.equal(wrongEnv.code, 2);
  assert.match(wrongEnv.err, /refused \(ENV_NOT_ALLOWED\)/);
  assert.doesNotMatch(wrongEnv.out, /k6 run/);

  // above the env default of 15 req/s: the workload's stress runs to 30 and needs --allow-max
  const aboveDefault = await cli('run', 'selftest', 'items', '--profile', 'stress', '--env', 'local', '--dry-run');
  assert.equal(aboveDefault.code, 2);
  assert.match(aboveDefault.err, /refused \(ABOVE_DEFAULTS\)/);
  assert.match(aboveDefault.err, /--allow-max/);

  const noProfile = await cli('run', 'selftest', 'items', '--profile', 'soak', '--env', 'local', '--dry-run');
  assert.equal(noProfile.code, 2);
  assert.match(noProfile.err, /profiles\.soak is not defined/);
});

test('run --dry-run still needs its arguments', async () => {
  assert.equal((await cli('run', 'selftest', '--dry-run')).code, 2);
  assert.equal((await cli('run', 'selftest', 'items', '--dry-run', '--env', 'local')).code, 2);
});

test('compare prints the table and needs two run folders; baseline accept needs one', async () => {
  const root = await tempDir('perf-cli-baseline-');
  const runDir = join(root, 'run');
  await cp(join(FIXTURES, 'load'), runDir, { recursive: true });

  const notRun = await cli('baseline', 'accept', join(root, 'missing'));
  assert.equal(notRun.code, 2);
  assert.match(notRun.err, /is not a run folder/);
  assert.equal((await cli('baseline', 'accept')).code, 2);
  assert.equal((await cli('compare', runDir)).code, 2);

  const compared = await cli('compare', runDir, runDir);
  assert.equal(compared.code, 0, compared.err);
  assert.match(compared.out, /\| step \| p95 A \| p95 B \| Δ% \|/);
  assert.match(compared.out, /\| analyst\.grid_open \| 1,010 ms \| 1,010 ms \| 0\.0% \|/);
});

test('baseline accept refuses a FAIL run with exit 2 and names the verdict', async () => {
  const root = await tempDir('perf-cli-refuse-');
  const runDir = join(root, 'run');
  await cp(join(FIXTURES, 'load'), runDir, { recursive: true });
  const metaFile = join(runDir, 'meta.json');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  meta.k6.exitCode = 99;
  await writeFile(metaFile, JSON.stringify(meta), 'utf8');

  const { code, err } = await cli('baseline', 'accept', runDir);
  assert.equal(code, 2);
  assert.match(err, /cannot accept a FAIL run as baseline/);
});

test('har-summary with 0 API calls warns that --api is likely wrong and exits 1', async () => {
  const dir = await tempDir('perf-har-cli-');
  const har = fileURLToPath(new URL('../tests/fixtures/mini.har', import.meta.url));
  const out = join(dir, 'summary.json');
  const none = await cli('har-summary', har, '--api', 'https://elsewhere.example.test/api', '--out', out);
  assert.equal(none.code, 1);
  assert.match(none.out, /0 API calls summarised/);
  assert.match(none.err, /WARNING: no request in the HAR is under --api https:\/\/elsewhere\.example\.test\/api/);
  const some = await cli('har-summary', har, '--api', 'https://api.example.test/api', '--out', out);
  assert.equal(some.code, 0, some.err);
  assert.match(some.out, /1 API call summarised/);
});

test('baseline accept help: a re-render keeps the baseline the run was judged against', async () => {
  const { out } = await cli('--help');
  const help = out.slice(out.indexOf('baseline accept'), out.indexOf('compare <runDirA>'));
  assert.match(help, /a re-render with `report` keeps the baseline the\s+run was judged against/);
  assert.match(help, /Refuses a smoke, FAIL or\s+INVALID run/);
});

test('perf run ends with the verdict line: the word and its reasons, or why there is none', () => {
  assert.equal(verdictLine({ verdict: 'FAIL', reasons: ['k6 exited with code 99', 'row counts changed'] }), 'perf: verdict FAIL — k6 exited with code 99; row counts changed');
  assert.equal(verdictLine({ verdict: 'PASS', reasons: ['no automatic flags; within the baseline limits'] }), 'perf: verdict PASS — no automatic flags; within the baseline limits');
  assert.equal(verdictLine(undefined), 'perf: verdict unknown — the report could not be built (see meta.json)');
});
