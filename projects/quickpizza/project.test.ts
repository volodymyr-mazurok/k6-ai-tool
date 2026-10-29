// Offline: the quickpizza project keeps to its politeness rules and its journey passes the journey checks. Nothing here
// sends a request; the swagger below lists only the four routes the journey uses (the real document is checked by
// `perf check quickpizza pizza --env hosted`).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkJourney, type Swagger } from '../../runner/checks.js';
import { ConfigError, loadFeature, loadProject } from '../../runner/config.js';
import { resolveProfile } from '../../runner/guardrails.js';
import { resolveRun } from '../../runner/run.js';

const COMMIT = 'fa8f2e382fcc7d0caee4a2abac8200b9f71778d7';
const project = await loadProject('quickpizza');
const feature = await loadFeature(project, 'pizza');
const env = project.envs.hosted!;

test('one env, hosted, with tiny caps, small defaults, no load window and no secrets', () => {
  assert.deepEqual(Object.keys(project.envs), ['hosted']);
  assert.equal(env.apiUrl, 'https://quickpizza.grafana.com');
  assert.deepEqual(env.caps, { maxVus: 5, maxRps: 5, maxDurationSec: 300 });
  assert.deepEqual(env.defaults, { vus: 2, rps: 2 });
  assert.equal(env.windowUtc, undefined, 'a public demo site has no load window');
  assert.deepEqual(project.auth, { type: 'static_header', header: 'Authorization', value: 'token ${random:16}' }, 'a random token, no secret');
  assert.deepEqual(project.abort, { errorRate: 0.1, p95Ms: 5000 }, 'no database limit: the project has no database');
  assert.equal(project.rowCountTables, undefined, 'no database to count rows in');
});

test('the OpenAPI document and every piece of evidence are pinned to one QuickPizza commit', () => {
  assert.equal(env.swaggerUrl, `https://raw.githubusercontent.com/grafana/quickpizza/${COMMIT}/quickpizza-openapi.yaml`);
  const urls = feature.journeys.flatMap((j) => [j.evidence, ...j.steps.map((s) => s.evidence)]).flatMap((e) => Object.values(e ?? {}));
  assert.ok(urls.length > 0);
  for (const url of urls) assert.match(String(url), new RegExp(`^https://github\\.com/grafana/quickpizza/blob/${COMMIT}/`), String(url));
});

test('smoke and load only: the load holds 2 visitors for 2 minutes, and stress and soak are refused', () => {
  assert.deepEqual(Object.keys(feature.workload.profiles), ['load']);
  const load = resolveProfile('load', feature.workload, env, { allowMax: false });
  assert.equal(load.users, 2);
  assert.equal(load.totalSec, 180);
  assert.ok(load.totalSec <= env.caps.maxDurationSec);
  for (const type of ['stress', 'soak'] as const) {
    assert.throws(() => resolveProfile(type, feature.workload, env, { allowMax: false }), ConfigError, type);
  }
  // At any hour: no window to refuse it.
  for (const at of ['2026-10-27T10:00:00Z', '2026-10-27T23:30:00Z']) {
    const { windowOverride } = resolveRun({ project, feature, env: 'hosted', profile: 'load' }, project, feature, () => new Date(at));
    assert.equal(windowOverride, false);
  }
});

test('the journey passes the checks: evidence on every step, the routes exist, the one write is declared', () => {
  assert.equal(feature.readOnly, false);
  assert.deepEqual(feature.writes, [{ method: 'POST', route: '/api/pizza', cleanup: 'app' }]);
  const swagger: Swagger = {
    paths: { '/api/quotes': { get: {} }, '/api/doughs': { get: {} }, '/api/tools': { get: {} }, '/api/pizza': { post: {} } },
  };
  assert.deepEqual(checkJourney(feature, swagger, project, env.apiUrl), []);

  // A write the feature did not declare (say, deleting ratings) is refused.
  const extra = structuredClone(feature);
  extra.journeys[0]!.steps.push({ name: 'clear_ratings', method: 'DELETE', route: '/api/ratings', optionalShare: 100, evidence: { openapi: 'x' } });
  const problems = checkJourney(extra, { paths: { ...swagger.paths, '/api/ratings': { delete: {} } } }, project, env.apiUrl);
  assert.deepEqual(problems.map((p) => [p.code, p.step]), [['WRITE_NOT_DECLARED', 'clear_ratings']]);
});
