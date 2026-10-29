import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startMockServer, type MockServer } from '../../runner/selftest/server.js';
import { runK6Script, type K6RunResult } from './harness.js';

const GLUE_SCRIPT = fileURLToPath(new URL('./glue.k6.js', import.meta.url));

const SECRETS = { accounts: { User: { login: 'perf', password: 'perf' } } };

interface SummaryMetric {
  values: Record<string, number>;
}
interface Summary {
  metrics: Record<string, SummaryMetric>;
}

/** RunConfig for the glue script: one journey with two steps against the mock server (smoke unless overridden). */
function glueConfig(mock: MockServer, opts: { data?: unknown; profile?: object; thinkTime?: object }): object {
  return {
    runId: 'glue-test',
    apiUrl: `${mock.url}/api`,
    profile: opts.profile ?? { type: 'smoke', totalSec: 10 },
    caps: { maxVus: 20, maxRps: 30 },
    mix: { items_grid: 100 },
    thinkTime: opts.thinkTime ?? { min: 1, max: 2 },
    stepsPerIteration: { items_grid: 2 },
    journeys: [
      {
        name: 'items_grid',
        key: 'items',
        role: 'User',
        exec: 'itemsGrid',
        steps: [{ name: 'search' }, { name: 'slow_search' }],
      },
    ],
    abort: { errorRate: 0.1, p95Ms: 15000 },
    auth: {
      type: 'ropc',
      tokenUrl: `${mock.url}/oauth/token`,
      clientId: 'perf',
      scope: 'openid perf offline_access',
    },
    ...(opts.data === undefined ? {} : { data: opts.data }),
  };
}

interface RunOptions {
  /** Passed to the script as cfg.data. */
  data?: unknown;
  profile?: object;
  thinkTime?: object;
  secrets?: object | null;
  /** Leave PERF_CONFIG_FILE unset. */
  noConfig?: boolean;
  /** Runs against the mock before k6 starts. */
  prepare?: (mock: MockServer) => void;
}

/** Start a mock, run the glue script once, hand the result over, then clean up the mock and the temp run folder. */
async function withGlueRun(
  opts: RunOptions,
  fn: (result: K6RunResult, mock: MockServer) => Promise<void>,
): Promise<void> {
  const mock = await startMockServer();
  let runDir: string | undefined;
  try {
    opts.prepare?.(mock);
    const secrets = opts.secrets === undefined ? SECRETS : opts.secrets;
    const result = await runK6Script(GLUE_SCRIPT, opts.noConfig ? null : glueConfig(mock, opts), secrets);
    runDir = result.runDir;
    await fn(result, mock);
  } finally {
    await mock.stop();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  }
}

const output = (r: K6RunResult): string => `${r.stdout}\n${r.stderr}`;

async function readSummary(r: K6RunResult): Promise<Summary> {
  return JSON.parse(await readFile(join(r.runDir, 'summary.json'), 'utf8')) as Summary;
}

function metric(summary: Summary, name: string): SummaryMetric {
  const found = summary.metrics[name];
  assert.ok(found, `summary.json has no metric ${name}; it has: ${Object.keys(summary.metrics).sort().join(', ')}`);
  return found;
}

test('glue script passes smoke against the mock', async () => {
  await withGlueRun({}, async (r) => {
    assert.equal(r.code, 0, output(r));
    const summary = await readSummary(r);

    // dotted step ids are accepted as submetric names and carry p(95) and count
    for (const id of ['items.search', 'items.slow_search']) {
      const duration = metric(summary, `http_req_duration{name:${id}}`);
      assert.equal(typeof duration.values['p(95)'], 'number', `p(95) of ${id}`);
      assert.equal(duration.values.count, 1, `count of ${id}`);
      assert.equal(metric(summary, `http_req_failed{name:${id}}`).values.rate, 0, `failed rate of ${id}`);
      // check() tags flow through: the per-step checks submetric receives data
      assert.equal(metric(summary, `checks{name:${id}}`).values.rate, 1, `check rate of ${id}`);
    }
    assert.equal(metric(summary, 'checks').values.rate, 1);
    // the token request is tagged auth_token
    assert.equal(metric(summary, 'http_req_duration{name:auth_token}').values.count, 1);
  });
});

test('summary.json carries no setup_data and no token, only the metrics', async () => {
  await withGlueRun({}, async (r, mock) => {
    assert.equal(r.code, 0, output(r));
    assert.equal(mock.tokenCalls(), 1, 'setup did fetch a token, so setup_data would have held it');
    const text = await readFile(join(r.runDir, 'summary.json'), 'utf8');
    const summary = JSON.parse(text) as Summary & Record<string, unknown>;

    // setup() returns { tokens }; k6 puts that in the summary as setup_data, which would write live tokens to disk
    assert.ok(!('setup_data' in summary), 'summary.json must not have a setup_data key');
    assert.ok(!text.includes('eyJ'), 'summary.json must not contain a JWT');
    assert.ok(!text.includes('mock-refresh-'), 'summary.json must not contain a refresh token');

    // the rest of the summary is untouched: the per-step submetrics are still there
    for (const id of ['items.search', 'items.slow_search']) {
      assert.equal(metric(summary, `http_req_duration{name:${id}}`).values.count, 1, `count of ${id}`);
      assert.equal(typeof metric(summary, `http_req_duration{name:${id}}`).values['p(95)'], 'number', `p(95) of ${id}`);
    }
    assert.equal(metric(summary, 'checks').values.rate, 1);
  });
});

test('one token request per account', async () => {
  await withGlueRun({}, async (r, mock) => {
    assert.equal(r.code, 0, output(r));
    assert.equal(mock.tokenCalls(), 1);
  });
});

test('a token close to expiry is refreshed lazily, once', async () => {
  await withGlueRun({ data: { expireTokens: true } }, async (r, mock) => {
    assert.equal(r.code, 0, output(r));
    // 1 password grant in setup + 1 refresh_token grant by the first bearer(); the second step reuses the new token
    assert.equal(mock.tokenCalls(), 2);
    const summary = await readSummary(r);
    assert.equal(metric(summary, 'http_req_duration{name:auth_token}').values.count, 2);
    assert.equal(metric(summary, 'checks').values.rate, 1);
  });
});

test('an opaque access token (not a JWT) is timed by expires_in: one token request, no refresh per step', async () => {
  await withGlueRun({ prepare: (mock) => mock.setTokenShape({ opaque: true, lifetimeSec: 3600 }) }, async (r, mock) => {
    assert.equal(r.code, 0, output(r));
    assert.equal(mock.tokenCalls(), 1);
    assert.equal(metric(await readSummary(r), 'checks').values.rate, 1);
  });
});

test('a token that lives less than the refresh margin is refreshed at half its life, not on every step', async () => {
  // 4 s tokens over a 6 s load of short iterations: about one refresh every 2 s, where a 300 s margin would refresh on
  // every bearer() call (two per iteration, a dozen or more here).
  const profile = { type: 'load', users: 1, rampSec: 0, holdSec: 6, rampDownSec: 0, totalSec: 6 };
  await withGlueRun(
    { profile, thinkTime: { min: 0.1, max: 0.1 }, prepare: (mock) => mock.setTokenShape({ opaque: true, lifetimeSec: 4 }) },
    async (r, mock) => {
      assert.equal(r.code, 0, output(r));
      const summary = await readSummary(r);
      const bearerCalls = 2 * metric(summary, 'iterations').values.count!;
      assert.ok(bearerCalls >= 10, `enough steps to tell the two apart (${bearerCalls})`);
      assert.ok(mock.tokenCalls() >= 2, 'the token was refreshed before it expired');
      assert.ok(mock.tokenCalls() <= 6, `refreshed about every 2 s, not on each of ${bearerCalls} steps (token calls: ${mock.tokenCalls()})`);
      assert.equal(metric(summary, 'checks').values.rate, 1);
    },
  );
});

test('a check that throws counts as failed and the iteration goes on to its next step', async () => {
  await withGlueRun({ data: { throwingCheck: true } }, async (r) => {
    const summary = await readSummary(r);
    assert.equal(metric(summary, 'http_req_duration{name:items.slow_search}').values.count, 1, 'the second step still ran');
    const checks = metric(summary, 'checks{name:items.search}').values;
    assert.ok(checks.rate! < 1 && checks.rate! > 0, `one of the step's checks failed, the others passed (rate ${checks.rate})`);
    assert.ok(!output(r).includes('planted check error'), 'no script exception was logged');
  });
});

test('smoke runs an optional step whatever its share', async () => {
  await withGlueRun({ data: { optionalShare: 0 } }, async (r) => {
    assert.equal(r.code, 0, output(r));
    const summary = await readSummary(r);
    assert.equal(metric(summary, 'http_req_duration{name:items.slow_search}').values.count, 1);
  });
});

test('load: think time pauses between steps and a 0% optional step never runs', async () => {
  const profile = { type: 'load', users: 1, rampSec: 1, holdSec: 2, rampDownSec: 1, totalSec: 4 };
  await withGlueRun({ profile, thinkTime: { min: 0.2, max: 0.2 }, data: { optionalShare: 0 } }, async (r) => {
    assert.equal(r.code, 0, output(r));
    const summary = await readSummary(r);
    assert.ok(metric(summary, 'http_req_duration{name:items.search}').values.count >= 2, 'several iterations ran');
    assert.equal(metric(summary, 'http_req_duration{name:items.slow_search}').values.count, 0);
    // search answers in ~20 ms, so an iteration that lasts 200 ms or more slept for the think time
    assert.ok(metric(summary, 'iteration_duration').values.min >= 200, 'every iteration includes the think time');
  });
});

test('script refuses to run without PERF_CONFIG_FILE', async () => {
  await withGlueRun({ noConfig: true }, async (r) => {
    assert.notEqual(r.code, 0);
    assert.ok(output(r).includes('PERF_CONFIG_FILE not set'), output(r));
  });
});

test('token 429 fails setup with the status in the message', async () => {
  await withGlueRun({ prepare: (mock) => mock.setTokenStatus(429) }, async (r) => {
    assert.notEqual(r.code, 0);
    assert.ok(output(r).includes('token endpoint returned 429 for User'), output(r));
  });
});

test('wrong password fails setup with 400', async () => {
  const secrets = { accounts: { User: { login: 'perf', password: 'not-the-password' } } };
  await withGlueRun({ secrets }, async (r) => {
    assert.notEqual(r.code, 0);
    assert.ok(output(r).includes('token endpoint returned 400 for User'), output(r));
    assert.ok(!output(r).includes('not-the-password'), 'the password must not appear in k6 output');
  });
});

test('a step with no content check fails', async () => {
  await withGlueRun({ data: { noChecks: true } }, async (r) => {
    assert.notEqual(r.code, 0, output(r));
    assert.ok(output(r).includes('step items.search has no content check'), output(r));
  });
});
