import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { main } from './cli.js';
import { ConfigError } from './config.js';
import type { HarEntrySummary } from './har.js';
import { authPath, browserUnavailable, parseActions, record } from './record.js';
import { startMockServer, type MockServer } from './selftest/server.js';

// The browser tests need Chromium. When it cannot start they are skipped LOUDLY (never silently); PERF_SKIP_BROWSER=1 skips them on purpose.
const unavailable = await browserUnavailable();
if (unavailable) console.error(`record.test: browser tests SKIPPED: ${unavailable}`);
const browser = { skip: unavailable ?? false };

let mock: MockServer;
let work: string;
let savedUrl: string | undefined;

before(async () => {
  savedUrl = process.env.PERF_SELFTEST_URL;
  mock = await startMockServer();
  process.env.PERF_SELFTEST_URL = mock.url;
  work = await mkdtemp(join(tmpdir(), 'perf-record-test-'));
});

after(async () => {
  await mock.stop();
  if (savedUrl === undefined) delete process.env.PERF_SELFTEST_URL;
  else process.env.PERF_SELFTEST_URL = savedUrl;
  await rm(work, { recursive: true, force: true });
});

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
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

/** A fresh empty folder for one test's HAR temp files and outputs. */
async function scratch(): Promise<{ dir: string; tmp: string; out: string }> {
  const dir = await mkdtemp(join(work, 't-'));
  const tmp = join(dir, 'tmp');
  await (await import('node:fs/promises')).mkdir(tmp);
  return { dir, tmp, out: join(dir, 'rec', 'search.json') };
}

const readJson = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;

// ---------------------------------------------------------------------------------------------------------------
// the action list (no browser)
// ---------------------------------------------------------------------------------------------------------------

const START = 'http://app.example.test/app';
const refused = (json: unknown, pattern: RegExp): void =>
  assert.throws(() => parseActions(json, START), (err: unknown) => err instanceof ConfigError && pattern.test(err.message));

test('parseActions accepts the four actions and resolves goto against the start url', () => {
  const actions = parseActions(
    [{ goto: '/orders?x=1' }, { goto: 'http://app.example.test/other' }, { click: 'text=Go' }, { fill: ['#q', 'widgets'] }, { wait: 250 }],
    START,
  );
  assert.deepEqual(actions, [
    { goto: 'http://app.example.test/orders?x=1' },
    { goto: 'http://app.example.test/other' },
    { click: 'text=Go' },
    { fill: ['#q', 'widgets'] },
    { wait: 250 },
  ]);
});

test('parseActions refuses unknown keys, wrong shapes and a goto that leaves the start origin', () => {
  refused({ goto: '/' }, /JSON array/);
  refused([], /empty/);
  refused(['goto'], /actions\[0\].*object/);
  refused([{ goto: '/' }, { press: 'Enter' }], /actions\[1\]: unknown key "press" \(allowed: goto, click, fill, wait\)/);
  refused([{ goto: '/', click: '#x' }], /exactly one key/);
  refused([{ goto: '' }], /goto.*non-empty/);
  refused([{ goto: 'https://elsewhere.example.test/' }], /leaves the start url's origin http:\/\/app\.example\.test/);
  refused([{ goto: '//elsewhere.example.test/x' }], /leaves the start url's origin/);
  refused([{ goto: 'http://app.example.test:8080/' }], /leaves the start url's origin/);
  refused([{ goto: 'file:///etc/passwd' }], /leaves the start url's origin/);
  refused([{ goto: 'javascript:alert(1)' }], /leaves the start url's origin/);
  refused([{ click: 3 }], /click.*selector/);
  refused([{ fill: ['#q'] }], /fill.*\["<selector>", "<text>"\]/);
  refused([{ fill: ['#q', 5] }], /fill/);
  refused([{ wait: -1 }], /wait.*0\.\.30000/);
  refused([{ wait: 1.5 }], /wait/);
  refused([{ wait: 600_000 }], /wait/);
  refused(Array.from({ length: 201 }, () => ({ wait: 1 })), /201 actions/);
});

test('parseActions errors never quote a fill text', () => {
  try {
    parseActions([{ fill: ['#q', 'hunter2-secret'] }, { nope: 1 }], START);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!(err as Error).message.includes('hunter2'));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// record: library
// ---------------------------------------------------------------------------------------------------------------

test('record (headless, drive) writes the scrubbed recording and the auth summary, and leaves no .har', browser, async () => {
  const { tmp, out } = await scratch();
  const result = await record({
    startUrl: `${mock.url}/app`,
    apiUrl: `${mock.url}/api`,
    out,
    headless: true,
    tmpDir: tmp,
    drive: async (page) => {
      await page.fill('#q', 'widgets');
      await page.click('#go');
      await page.waitForFunction(() => document.getElementById('out')?.textContent === 'status 200');
      await page.waitForLoadState('networkidle');
    },
  });

  assert.ok(result.calls >= 2, `the load search and the pressed one (got ${result.calls})`);
  assert.equal(result.auth.scheme, 'bearer');
  assert.equal(result.auth.valueShape, 'JWT');
  assert.equal(result.auth.tokenRequests, 1);

  const recording = await readJson<HarEntrySummary[]>(out);
  assert.equal(recording.length, result.calls);
  const searches = recording.filter((e) => e.method === 'POST' && e.path === '/items/search');
  assert.ok(searches.length >= 2);
  assert.equal(searches.every((e) => e.status === 200), true);
  assert.ok(searches.some((e) => (e.requestBody as { query?: string }).query === 'widgets'));
  assert.deepEqual(searches[0]!.responseKeys, ['items', 'totalCount']);

  const authFile = authPath(out);
  assert.equal(authFile, join(out.replace(/search\.json$/, ''), 'search.auth.json'));
  assert.deepEqual(await readJson(authFile), result.auth);

  // no token, header or password in either file, and nothing from the temp folder is left
  const text = `${await readFile(out, 'utf8')}\n${await readFile(authFile, 'utf8')}`;
  assert.ok(!/eyJ|Bearer |grant_type|password/i.test(text), 'no credential-looking text in the output');
  assert.ok(!text.includes('perf&') && !text.includes('mock-refresh'), 'no login or refresh token');
  assert.deepEqual(readdirSync(tmp), [], 'the temp folder is empty: the HAR is deleted');
});

test('record with no API call writes nothing and leaves no .har', browser, async () => {
  const { tmp, out } = await scratch();
  const result = await record({ startUrl: `${mock.url}/`, apiUrl: `${mock.url}/api`, out, headless: true, tmpDir: tmp, drive: async () => {} });
  assert.equal(result.calls, 0);
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(authPath(out)), false);
  assert.equal(existsSync(join(out, '..')), false, 'not even the output folder');
  assert.deepEqual(readdirSync(tmp), []);
});

test('record removes the HAR when the drive function throws', browser, async () => {
  const { tmp, out } = await scratch();
  await assert.rejects(
    record({
      startUrl: `${mock.url}/app`,
      apiUrl: `${mock.url}/api`,
      out,
      headless: true,
      tmpDir: tmp,
      drive: async () => {
        throw new Error('driver broke');
      },
    }),
    /driver broke/,
  );
  assert.equal(existsSync(out), false);
  assert.deepEqual(readdirSync(tmp), []);
});

test('record refuses a headless session without a drive function (nobody could close the window)', async () => {
  await assert.rejects(record({ startUrl: START, apiUrl: 'http://x.test/api', out: 'x.json', headless: true }), /needs a drive function/);
});

// ---------------------------------------------------------------------------------------------------------------
// perf record: CLI
// ---------------------------------------------------------------------------------------------------------------

async function actionsFile(dir: string, actions: unknown): Promise<string> {
  const file = join(dir, 'actions.json');
  await writeFile(file, JSON.stringify(actions));
  return file;
}

test('perf record --actions: fill, click and wait headless, then the recording and the auth summary', browser, async () => {
  const { dir, out } = await scratch();
  const actions = await actionsFile(dir, [{ goto: '/app' }, { fill: ['#q', 'gadgets'] }, { click: '#go' }, { wait: 300 }]);
  const run = await cli('record', 'selftest', '--env', 'local', '--start', `${mock.url}/app`, '--out', out, '--actions', actions);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /API calls? recorded/);
  assert.match(run.out, /auth: bearer \(Authorization\), JWT, \d+ token requests?/);

  const recording = await readJson<HarEntrySummary[]>(out);
  assert.ok(recording.some((e) => e.path === '/items/search' && (e.requestBody as { query?: string }).query === 'gadgets'));
  assert.equal((await readJson<{ scheme: string }>(authPath(out))).scheme, 'bearer');
  assert.ok(!/eyJ|Bearer /.test(run.out + run.err + (await readFile(out, 'utf8'))));
});

test('perf record exits 1 with the wrong-api-url message when no call reached the API, and writes nothing', browser, async () => {
  const { dir, out } = await scratch();
  const actions = await actionsFile(dir, [{ wait: 50 }]);
  const run = await cli('record', 'selftest', '--env', 'local', '--start', `${mock.url}/`, '--out', out, '--actions', actions);
  assert.equal(run.code, 1);
  assert.match(run.err, new RegExp(`no API calls under ${mock.url}/api were recorded — wrong --env api url, or the flow never reached the API`));
  assert.equal(existsSync(out), false);
  assert.equal(existsSync(authPath(out)), false);
});

test('perf record --actions refuses to fill a password field (exit 2) and leaves nothing', browser, async () => {
  const { dir, out } = await scratch();
  const actions = await actionsFile(dir, [{ fill: ['#pw', 'hunter2-secret'] }]);
  const run = await cli('record', 'selftest', '--env', 'local', '--start', `${mock.url}/app`, '--out', out, '--actions', actions);
  assert.equal(run.code, 2);
  assert.match(run.err, /password field/);
  assert.ok(!(run.out + run.err).includes('hunter2'));
  assert.equal(existsSync(out), false);
});

test('perf record validates before any browser starts: bad action files, off-origin goto, foreign start url, misuse (exit 2)', async () => {
  const { dir, out } = await scratch();
  const base = ['record', 'selftest', '--env', 'local', '--start', `${mock.url}/app`, '--out', out];

  const unknownKey = await cli(...base, '--actions', await actionsFile(dir, [{ goto: '/app' }, { press: 'Enter' }]));
  assert.equal(unknownKey.code, 2);
  assert.match(unknownKey.err, /actions\[1\]: unknown key "press"/);

  const offOrigin = await cli(...base, '--actions', await actionsFile(dir, [{ goto: 'https://elsewhere.example.test/' }]));
  assert.equal(offOrigin.code, 2);
  assert.match(offOrigin.err, /leaves the start url's origin/);

  const notJson = join(dir, 'broken.json');
  await writeFile(notJson, '{nope');
  assert.equal((await cli(...base, '--actions', notJson)).code, 2);
  assert.equal((await cli(...base, '--actions', join(dir, 'missing.json'))).code, 2);

  const foreign = await cli('record', 'selftest', '--env', 'local', '--start', 'https://elsewhere.example.test/app', '--out', out, '--actions', await actionsFile(dir, [{ wait: 1 }]));
  assert.equal(foreign.code, 2);
  assert.match(foreign.err, /app_url|env/);

  assert.equal((await cli('record', 'selftest', '--start', `${mock.url}/app`, '--out', out)).code, 2, '--env is required');
  assert.equal((await cli('record', 'selftest', '--env', 'local', '--out', out)).code, 2, '--start is required');
  assert.equal((await cli('record', 'selftest', '--env', 'local', '--start', `${mock.url}/app`)).code, 2, '--out is required');
  assert.equal((await cli('record', '--env', 'local', '--start', `${mock.url}/app`, '--out', out)).code, 2, 'a project is required');
  assert.equal((await cli('record', 'selftest', '--env', 'prod', '--start', `${mock.url}/app`, '--out', out)).code, 2, 'an env the project does not allow');
  assert.equal((await cli('record', 'selftest', '--env', 'local', '--start', 'not a url', '--out', out)).code, 2);
  assert.equal(existsSync(out), false);
});
