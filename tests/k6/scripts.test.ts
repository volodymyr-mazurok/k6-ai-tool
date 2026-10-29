// The project scripts that ship with the framework, run inside k6 against the local mock: the template's example.js (its
// routes are the mock's, so a copied project starts from a script that works) and the self-test's items.js. Needs k6 on
// the PATH. Nothing leaves the machine.
import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadFeature, loadProject, type Feature } from '../../runner/config.js';
import { stepsPerIteration } from '../../runner/run.js';
import { startMockServer, type MockServer } from '../../runner/selftest/server.js';
import { runK6Script, type K6RunResult } from './harness.js';

/** The run config the runner would write for a smoke of `feature` against the mock. */
function smokeConfig(feature: Feature, mock: MockServer): Record<string, unknown> {
  return {
    runId: 'scripts-test',
    apiUrl: `${mock.url}/api`,
    profile: { type: 'smoke', totalSec: 0 },
    caps: { maxVus: 20, maxRps: 30 },
    rps: 30,
    mix: feature.workload.mix,
    thinkTime: feature.workload.thinkTime,
    stepsPerIteration: Object.fromEntries(feature.journeys.map((j) => [j.name, stepsPerIteration(j)])),
    journeys: feature.journeys.map((j) => ({
      name: j.name,
      key: j.key,
      role: j.role,
      exec: j.exec,
      steps: j.steps.map((s) => ({ name: s.name, optionalShare: s.optionalShare })),
    })),
    abort: { errorRate: 0.1, p95Ms: 15000 },
    auth: { type: 'ropc', tokenUrl: `${mock.url}/oauth/token`, clientId: 'perf', scope: 'openid perf offline_access' },
  };
}

/** One k6 run of `script` against a fresh mock; the mock and the run folder are removed afterwards. */
async function withScriptRun(
  script: string,
  config: (mock: MockServer) => Record<string, unknown>,
  roles: string[],
  fn: (result: K6RunResult) => Promise<void>,
): Promise<void> {
  const mock = await startMockServer();
  let runDir: string | undefined;
  try {
    const accounts = Object.fromEntries(roles.map((role) => [role, { login: 'perf', password: 'perf' }]));
    const result = await runK6Script(script, config(mock), { accounts });
    runDir = result.runDir;
    await fn(result);
  } finally {
    await mock.stop();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  }
}

const output = (r: K6RunResult): string => `${r.stdout}\n${r.stderr}`;

test("the template's example.js passes a smoke against the mock: every step once, every check green", { timeout: 120_000 }, async () => {
  const project = await loadProject('_template');
  const feature = await loadFeature(project, 'example');
  await withScriptRun(feature.script, (mock) => smokeConfig(feature, mock), project.roles!, async (r) => {
    assert.equal(r.code, 0, output(r));
    const summary = JSON.parse(await readFile(join(r.runDir, 'summary.json'), 'utf8')) as { metrics: Record<string, { values: Record<string, number> }> };
    for (const journey of feature.journeys) {
      for (const step of journey.steps) {
        const id = `${journey.key}.${step.name}`;
        assert.equal(summary.metrics[`http_req_duration{name:${id}}`]?.values.count, 1, `${id} was sent once`);
        assert.equal(summary.metrics[`checks{name:${id}}`]?.values.rate, 1, `${id} passed its checks`);
      }
    }
  });
});

for (const [name, load] of [
  ['_template example.js', async () => loadFeature(await loadProject('_template'), 'example')],
  ['selftest items.js', async () => loadFeature(await loadProject('selftest'), 'items')],
] as const) {
  test(`${name}: an optional step that journey.yaml does not have is named in the error`, { timeout: 120_000 }, async () => {
    const feature = await load();
    const journey = feature.journeys[0]!;
    const optional = journey.steps.find((s) => s.optionalShare < 100)!;
    const without: Feature = { ...feature, journeys: [{ ...journey, steps: journey.steps.filter((s) => s !== optional) }] };
    const roles = [...new Set(feature.journeys.map((j) => j.role))];
    await withScriptRun(feature.script, (mock) => smokeConfig(without, mock), roles, async (r) => {
      assert.notEqual(r.code, 0);
      assert.match(output(r), new RegExp(`journey ${journey.name} has no step ${optional.name} in journey\\.yaml`));
    });
  });
}
