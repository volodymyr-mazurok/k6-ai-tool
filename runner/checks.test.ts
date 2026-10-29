import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  checkFeature,
  checkJourney,
  checkScriptMatchesJourney,
  fetchSwagger,
  formatProblem,
  JourneyCheckError,
  SwaggerError,
  type Problem,
  type Swagger,
} from './checks.js';
import { ConfigError, loadFeature, loadProject, REPO_ROOT, type Feature, type Project } from './config.js';
import { readSmokeLedger } from './guardrails.js';
import { runFeature } from './run.js';
import { startMockServer, type MockServer } from './selftest/server.js';

const CLI = join(REPO_ROOT, 'runner', 'cli.ts');
const API = 'http://127.0.0.1:9/api';

// The env adapter of the selftest project reads these; the k6 runs go against the mock.
const AUTH_ENV = {
  PERF_TOKEN_CLIENT_ID: 'perf',
  PERF_SCOPE: 'openid perf offline_access',
  PERF_USER_LOGIN: 'perf',
  PERF_USER_PASSWORD: 'perf',
};
const TOUCHED_ENV = [...Object.keys(AUTH_ENV), 'PERF_SELFTEST_URL', 'PERF_TOKEN_URL', 'PERF_RESULTS_DIR', 'K6_WEB_DASHBOARD_PORT'];

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
    K6_WEB_DASHBOARD_PORT: '-1', // no live dashboard server in tests
  });
});

beforeEach(async () => {
  root = await tempDir('perf-results-'); // its own smoke ledger and run folders per test
  process.env.PERF_RESULTS_DIR = root;
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

/** A fresh copy of the selftest items feature (journey `items_grid`, key `items`, steps search / slow_search / export). */
async function itemsFeature(): Promise<{ project: Project; feature: Feature }> {
  const project = await loadProject('selftest');
  // The self-test feature is read-only; these tests are about swagger routes, so they start from a feature that may write
  // and switch read-only on (with their own route list) where the read-only rules are the subject. Built in code without
  // `writes:` (a journey.yaml cannot be: loadFeature requires it), its steps are not checked for writes at all.
  return { project, feature: { ...structuredClone(await loadFeature(project, 'items')), readOnly: false } };
}

/** The swagger of the mock (keys carry the /api prefix, like the real API's). */
const SWAGGER: Swagger = {
  paths: {
    '/api/items/search': { post: {} },
    '/api/items/slow-search': { post: {} },
    '/api/items/export': { post: {} },
  },
};

const codes = (problems: Problem[]): string[] => problems.map((p) => p.code);

// ---------------------------------------------------------------------------------------------------------------
// checkJourney: P1 (evidence, swagger) and P7b (read-only)
// ---------------------------------------------------------------------------------------------------------------

test('selftest items feature has 0 problems', async () => {
  const { project, feature } = await itemsFeature();
  assert.deepEqual(checkJourney(feature, SWAGGER, project, API), []);
});

test('unknown route gives ROUTE_NOT_IN_SWAGGER', async () => {
  const { project, feature } = await itemsFeature();
  feature.journeys[0]!.steps[0]!.route = '/items/invented';

  const problems = checkJourney(feature, SWAGGER, project, API);

  assert.equal(problems.length, 1);
  assert.equal(problems[0]!.code, 'ROUTE_NOT_IN_SWAGGER');
  assert.equal(problems[0]!.journey, 'items_grid');
  assert.equal(problems[0]!.step, 'search');
  assert.match(problems[0]!.detail, /POST \/items\/invented/);
  assert.match(problems[0]!.detail, /\/api\/items\/invented/, 'the detail shows the route with the api path prefix');
});

test('a route that exists in swagger only under another method gives ROUTE_NOT_IN_SWAGGER', async () => {
  const { project, feature } = await itemsFeature();
  feature.journeys[0]!.steps[0]!.method = 'GET';

  const problems = checkJourney(feature, SWAGGER, project, API);

  assert.deepEqual(codes(problems), ['ROUTE_NOT_IN_SWAGGER']);
  assert.match(problems[0]!.detail, /GET/);
  assert.match(problems[0]!.detail, /post/i, 'it names the methods swagger does have');
});

test('step without evidence gives NO_EVIDENCE', async () => {
  const { project, feature } = await itemsFeature();
  const journey = feature.journeys[0]!;
  delete journey.steps[1]!.evidence;
  journey.steps[2]!.evidence = {}; // an empty object is no evidence either
  delete journey.evidence;

  const problems = checkJourney(feature, SWAGGER, project, API);

  assert.deepEqual(
    problems.map((p) => [p.code, p.step]),
    [
      ['NO_EVIDENCE', 'slow_search'],
      ['NO_EVIDENCE', 'export'],
    ],
  );
  assert.equal(problems[0]!.journey, 'items_grid');
});

test('journey evidence covers the steps that have none of their own', async () => {
  const { project, feature } = await itemsFeature();
  const journey = feature.journeys[0]!;
  for (const step of journey.steps) delete step.evidence;
  journey.evidence = { source: 'a HAR' };

  assert.deepEqual(checkJourney(feature, SWAGGER, project, API), []);

  journey.steps[0]!.evidence = {}; // an empty step object falls back to the journey's evidence
  assert.deepEqual(checkJourney(feature, SWAGGER, project, API), []);
});

test('PUT in a read-only feature gives WRITE_IN_READ_ONLY', async () => {
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    const { project, feature } = await itemsFeature();
    feature.readOnly = true;
    feature.journeys[0]!.steps = feature.journeys[0]!.steps.slice(0, 1);
    feature.journeys[0]!.steps[0]!.method = method;
    const swagger: Swagger = { paths: { ...SWAGGER.paths, '/api/items/search': { [method.toLowerCase()]: {} } } };

    const problems = checkJourney(feature, swagger, project, API);

    assert.deepEqual(codes(problems), ['WRITE_IN_READ_ONLY'], method);
    assert.equal(problems[0]!.step, 'search');
    assert.match(problems[0]!.detail, new RegExp(method));
  }
});

test('POST not in readOnlyPostRoutes gives WRITE_IN_READ_ONLY', async () => {
  const { project, feature } = await itemsFeature();
  feature.readOnly = true;
  project.readOnlyPostRoutes = ['/items/search']; // slow-search and export are not listed

  const problems = checkJourney(feature, SWAGGER, project, API);

  assert.deepEqual(
    problems.map((p) => [p.code, p.step]),
    [
      ['WRITE_IN_READ_ONLY', 'slow_search'],
      ['WRITE_IN_READ_ONLY', 'export'],
    ],
  );
  assert.match(problems[0]!.detail, /read_only_post_routes/);
});

test('listed POST passes', async () => {
  const { project, feature } = await itemsFeature();
  feature.readOnly = true;
  project.readOnlyPostRoutes = ['/items/search', '/items/slow-search/', '/items/export?x=1']; // trailing slash and query are ignored

  assert.deepEqual(checkJourney(feature, SWAGGER, project, API), []);
});

test('GET in a read-only feature passes, and a declared write passes in a feature that is not read-only', async () => {
  const { project, feature } = await itemsFeature();
  feature.readOnly = true;
  feature.journeys[0]!.steps = feature.journeys[0]!.steps.slice(0, 1);
  feature.journeys[0]!.steps[0]!.method = 'GET';
  const getSwagger: Swagger = { paths: { '/api/items/search': { get: {} } } };
  assert.deepEqual(checkJourney(feature, getSwagger, project, API), []);

  feature.readOnly = false;
  feature.journeys[0]!.steps[0]!.method = 'DELETE';
  feature.writes = [{ method: 'DELETE', route: '/items/search', cleanup: 'app' }];
  assert.deepEqual(checkJourney(feature, { paths: { '/api/items/search': { delete: {} } } }, project, API), []);
});

test('a feature that declares its writes: an undeclared write gives WRITE_NOT_DECLARED, a declared one and a listed read pass', async () => {
  const { project, feature } = await itemsFeature();
  project.readOnlyPostRoutes = ['/items/export']; // export only reads; search and slow-search are writes here
  feature.writes = [{ method: 'POST', route: '/items/search', cleanup: 'app' }];

  const problems = checkJourney(feature, SWAGGER, project, API);
  assert.deepEqual(problems.map((p) => [p.code, p.step]), [['WRITE_NOT_DECLARED', 'slow_search']]);
  assert.match(problems[0]!.detail, /POST \/items\/slow-search writes, but journey\.yaml writes: does not declare it/);

  feature.journeys[0]!.steps[0]!.method = 'PUT'; // the declared write is POST /items/search, not PUT
  const swagger: Swagger = { paths: { ...SWAGGER.paths, '/api/items/search': { put: {}, post: {} } } };
  assert.deepEqual(codes(checkJourney(feature, swagger, project, API)), ['WRITE_NOT_DECLARED', 'WRITE_NOT_DECLARED']);

  feature.journeys[0]!.steps[0]!.method = 'POST';
  feature.writes.push({ method: 'POST', route: '/items/slow-search', cleanup: 'app' });
  assert.deepEqual(checkJourney(feature, SWAGGER, project, API), [], 'every write declared, the listed POST is a read');
});

test('swagger path params match any segment', async () => {
  const { project, feature } = await itemsFeature();
  const journey = feature.journeys[0]!;
  journey.steps = [journey.steps[0]!];
  const check = (route: string, swagger: Swagger): string[] => {
    journey.steps[0]!.route = route;
    return codes(checkJourney(feature, swagger, project, API));
  };
  const swagger: Swagger = { paths: { '/api/items/{itemId}/details': { post: {} }, '/api/files/{name}.{ext}': { post: {} } } };

  assert.deepEqual(check('/items/42/details', swagger), [], 'a literal id fills {itemId}');
  assert.deepEqual(check('/items/{id}/details', swagger), [], 'a template param fills {itemId} too');
  assert.deepEqual(check('/ITEMS/42/Details', swagger), [], 'routing is case-insensitive');
  assert.deepEqual(check('/items/42/details/', swagger), [], 'a trailing slash is ignored');
  assert.deepEqual(check('/items/42/details?expand=1', swagger), [], 'the query string is ignored');
  assert.deepEqual(check('/files/report.xlsx', swagger), [], 'a param can sit inside a segment');
  assert.deepEqual(check('/items/42', swagger), ['ROUTE_NOT_IN_SWAGGER'], 'a param never matches nothing: segment counts must agree');
  assert.deepEqual(check('/items/42/details/extra', swagger), ['ROUTE_NOT_IN_SWAGGER']);
  assert.deepEqual(check('/items/42/other', swagger), ['ROUTE_NOT_IN_SWAGGER'], 'literal segments must still agree');
  assert.deepEqual(check('/items/42/details', { paths: { '/api/items/42/details': { post: {} } } }), [], 'a literal swagger path matches itself');
  assert.deepEqual(
    check('/items/{id}/details', { paths: { '/api/items/export/details': { post: {} } } }),
    ['ROUTE_NOT_IN_SWAGGER'],
    'a template param in the journey does not match a literal swagger segment',
  );
});

test('the api url path is prefixed to every journey route', async () => {
  const { project, feature } = await itemsFeature();

  assert.deepEqual(checkJourney(feature, SWAGGER, project, 'https://api.example.test/api/'), [], 'trailing slash on api_url');
  assert.deepEqual(codes(checkJourney(feature, SWAGGER, project, 'https://api.example.test/v2')), [
    'ROUTE_NOT_IN_SWAGGER',
    'ROUTE_NOT_IN_SWAGGER',
    'ROUTE_NOT_IN_SWAGGER',
  ]);
  const bare: Swagger = { paths: { '/items/search': { post: {} }, '/items/slow-search': { post: {} }, '/items/export': { post: {} } } };
  assert.deepEqual(checkJourney(feature, bare, project, 'https://api.example.test'), [], 'an api_url without a path');
  assert.throws(() => checkJourney(feature, SWAGGER, project, 'not a url'), (err: unknown) => err instanceof ConfigError);
});

test('formatProblem names the code, the journey step and the detail', () => {
  assert.equal(
    formatProblem({ code: 'NO_EVIDENCE', journey: 'items_grid', step: 'search', detail: 'cites nothing' }),
    'NO_EVIDENCE items_grid.search: cites nothing',
  );
  assert.equal(formatProblem({ code: 'STEP_NOT_EXERCISED', journey: 'items_grid', detail: 'x' }), 'STEP_NOT_EXERCISED items_grid: x');
  assert.equal(formatProblem({ code: 'UNNAMED_REQUEST', detail: 'x' }), 'UNNAMED_REQUEST: x');
});

// ---------------------------------------------------------------------------------------------------------------
// checkScriptMatchesJourney: P2 (and the route comparison)
// ---------------------------------------------------------------------------------------------------------------

/** What a clean smoke of the selftest feature sends: the token request and the three steps. */
const OBSERVED = [
  { name: 'auth_token', method: 'POST', url: 'http://127.0.0.1:9/oauth/token' },
  { name: 'items.search', method: 'POST', url: `${API}/items/search` },
  { name: 'items.slow_search', method: 'POST', url: `${API}/items/slow-search` },
  { name: 'items.export', method: 'POST', url: `${API}/items/export` },
];

test('a script that sends exactly the journey steps and the token request has 0 problems', async () => {
  const { feature } = await itemsFeature();
  assert.deepEqual(checkScriptMatchesJourney(feature, OBSERVED, API), []);
  // The traffic may arrive in any order, and the same step may appear with several urls.
  assert.deepEqual(checkScriptMatchesJourney(feature, [...OBSERVED].reverse(), API), []);
});

test('a URL-named observed request gives UNNAMED_REQUEST', async () => {
  const { feature } = await itemsFeature();
  const url = `${API}/items/search?secret=abc`;
  const observed = [...OBSERVED, { name: url, method: 'POST', url }];

  const problems = checkScriptMatchesJourney(feature, observed, API);

  assert.deepEqual(codes(problems), ['UNNAMED_REQUEST']);
  assert.match(problems[0]!.detail, /POST/);
  assert.match(problems[0]!.detail, /\/items\/search/);
  assert.doesNotMatch(problems[0]!.detail, /secret=abc/, 'the query string is not echoed');
});

test('a made-up step id and an empty name give UNNAMED_REQUEST', async () => {
  const { feature } = await itemsFeature();
  const observed = [
    ...OBSERVED,
    { name: 'items.invented', method: 'POST', url: `${API}/items/search` },
    { name: '', method: 'POST', url: `${API}/items/search` },
  ];
  assert.deepEqual(codes(checkScriptMatchesJourney(feature, observed, API)), ['UNNAMED_REQUEST', 'UNNAMED_REQUEST']);
});

test('a journey step never observed gives STEP_NOT_EXERCISED', async () => {
  const { feature } = await itemsFeature();
  const observed = OBSERVED.filter((r) => r.name !== 'items.export');

  const problems = checkScriptMatchesJourney(feature, observed, API);

  assert.deepEqual(codes(problems), ['STEP_NOT_EXERCISED']);
  assert.equal(problems[0]!.journey, 'items_grid');
  assert.equal(problems[0]!.step, 'export');
  assert.match(problems[0]!.detail, /items\.export/);
});

test('a script that sent nothing leaves every step not exercised', async () => {
  const { feature } = await itemsFeature();
  assert.deepEqual(
    checkScriptMatchesJourney(feature, [], API).map((p) => p.step),
    ['search', 'slow_search', 'export'],
  );
});

test('a step sent to another route or with another method gives ROUTE_MISMATCH', async () => {
  const { feature } = await itemsFeature();
  const wrongRoute = OBSERVED.map((r) => (r.name === 'items.search' ? { ...r, url: `${API}/items/export` } : r));
  const wrongMethod = OBSERVED.map((r) => (r.name === 'items.search' ? { ...r, method: 'GET' } : r));
  const wrongPrefix = OBSERVED.map((r) => (r.name === 'items.search' ? { ...r, url: 'http://127.0.0.1:9/other/items/search' } : r));

  for (const observed of [wrongRoute, wrongMethod, wrongPrefix]) {
    const problems = checkScriptMatchesJourney(feature, observed, API);
    assert.deepEqual(codes(problems), ['ROUTE_MISMATCH']);
    assert.equal(problems[0]!.journey, 'items_grid');
    assert.equal(problems[0]!.step, 'search');
    assert.match(problems[0]!.detail, /items\.search/);
  }
  assert.match(checkScriptMatchesJourney(feature, wrongMethod, API)[0]!.detail, /GET/);
});

test('route templates match any single segment and ignore the query string', async () => {
  const { feature } = await itemsFeature();
  feature.journeys[0]!.steps[0]!.route = '/items/{id}/details';
  const observed = (url: string) => OBSERVED.map((r) => (r.name === 'items.search' ? { ...r, url } : r));

  assert.deepEqual(checkScriptMatchesJourney(feature, observed(`${API}/items/42/details?x=1`), API), []);
  assert.deepEqual(checkScriptMatchesJourney(feature, observed(`${API}/Items/abc-def/DETAILS`), API), []);
  assert.deepEqual(codes(checkScriptMatchesJourney(feature, observed(`${API}/items/details`), API)), ['ROUTE_MISMATCH']);
  assert.deepEqual(codes(checkScriptMatchesJourney(feature, observed(`${API}/items/1/2/details`), API)), ['ROUTE_MISMATCH']);
  assert.deepEqual(codes(checkScriptMatchesJourney(feature, observed(`${API}/items/42/other`), API)), ['ROUTE_MISMATCH']);
});

test('auth_token is exempt from the route comparison', async () => {
  const { feature } = await itemsFeature();
  const observed = OBSERVED.map((r) => (r.name === 'auth_token' ? { ...r, method: 'POST', url: 'https://login.example.test/connect/token' } : r));
  assert.deepEqual(checkScriptMatchesJourney(feature, observed, API), []);
});

test('an observed url may be just the path k6 recorded for a step', async () => {
  const { feature } = await itemsFeature();
  const paths = OBSERVED.map((r) => (r.name === 'auth_token' ? r : { ...r, url: new URL(r.url).pathname }));
  assert.deepEqual(checkScriptMatchesJourney(feature, paths, API), []);

  const wrong = paths.map((r) => (r.name === 'items.export' ? { ...r, url: '/api/items/search' } : r));
  assert.deepEqual(codes(checkScriptMatchesJourney(feature, wrong, API)), ['ROUTE_MISMATCH']);
});

test('observed requests without a url are compared by name and method only', async () => {
  const { feature } = await itemsFeature();
  const observed = OBSERVED.map(({ name, method }) => ({ name, method }));
  assert.deepEqual(checkScriptMatchesJourney(feature, observed, API), []);
});

// ---------------------------------------------------------------------------------------------------------------
// the swagger document
// ---------------------------------------------------------------------------------------------------------------

/** Serve `body` with `status` on any path of a throwaway server. */
async function serveOnce(status: number, body: string): Promise<{ url: string; stop: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/swagger.json`,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

test('checkFeature fetches the env swagger once and finds 0 problems in the selftest feature', async () => {
  const { project, feature } = await itemsFeature();
  assert.deepEqual(await checkFeature(project, feature, 'local'), []);

  feature.journeys[0]!.steps[0]!.route = '/items/invented';
  assert.deepEqual(codes(await checkFeature(project, feature, 'local')), ['ROUTE_NOT_IN_SWAGGER']);
});

test('an env without swagger_url fails the check instead of skipping it', async () => {
  const { project, feature } = await itemsFeature();
  delete project.envs.local!.swaggerUrl;

  await assert.rejects(checkFeature(project, feature, 'local'), (err: unknown) => {
    assert.ok(err instanceof ConfigError);
    assert.equal(err.message, 'no swagger_url configured for env local');
    return true;
  });
  await assert.rejects(fetchSwagger(project.envs.local!, 'local'), /no swagger_url configured for env local/);
});

test('a swagger that cannot be fetched or read is an error, not a pass', async () => {
  const { project, feature } = await itemsFeature();
  const check = (swaggerUrl: string) => checkFeature({ ...project, envs: { local: { ...project.envs.local!, swaggerUrl } } }, feature, 'local');

  await assert.rejects(check('http://127.0.0.1:9/swagger.json'), (err: unknown) => err instanceof SwaggerError && /could not fetch the swagger/.test(err.message));

  const notFound = await serveOnce(404, '{"error":"nope"}');
  const html = await serveOnce(200, '<html>login page</html>');
  const noPaths = await serveOnce(200, '{"openapi":"3.0.1"}');
  try {
    await assert.rejects(check(notFound.url), (err: unknown) => err instanceof SwaggerError && /404/.test(err.message));
    await assert.rejects(check(html.url), (err: unknown) => err instanceof SwaggerError && /not JSON/.test(err.message));
    await assert.rejects(check(noPaths.url), (err: unknown) => err instanceof SwaggerError && /no "paths"/.test(err.message));
  } finally {
    await Promise.all([notFound.stop(), html.stop(), noPaths.stop()]);
  }
});

test('an OpenAPI document in YAML is read like a JSON one', async () => {
  const { project, feature } = await itemsFeature();
  const yaml = await serveOnce(200, 'openapi: 3.0.3\npaths:\n  /api/items/search:\n    post: {}\n  /api/items/slow-search:\n    post: {}\n  /api/items/export:\n    post: {}\n');
  try {
    const env = { ...project.envs.local!, swaggerUrl: yaml.url };
    assert.deepEqual(Object.keys((await fetchSwagger(env, 'local')).paths), ['/api/items/search', '/api/items/slow-search', '/api/items/export']);
    assert.deepEqual(await checkFeature({ ...project, envs: { local: env } }, feature, 'local'), []);
  } finally {
    await yaml.stop();
  }
});

// ---------------------------------------------------------------------------------------------------------------
// run.ts: refuse before any run, fail a smoke that does not match the journey
// ---------------------------------------------------------------------------------------------------------------

test('a journey with problems is refused before anything is sent', async () => {
  const { project, feature } = await itemsFeature();
  delete feature.journeys[0]!.steps[0]!.evidence;
  delete feature.journeys[0]!.evidence; // the journey's own evidence would cover the step
  feature.journeys[0]!.steps[1]!.route = '/items/invented';
  const tokenCallsBefore = mock.tokenCalls();

  await assert.rejects(runFeature({ project, feature, env: 'local', profile: 'smoke', quiet: true }), (err: unknown) => {
    assert.ok(err instanceof JourneyCheckError);
    assert.deepEqual(codes(err.problems), ['NO_EVIDENCE', 'ROUTE_NOT_IN_SWAGGER']);
    assert.match(err.message, /selftest\/items/);
    assert.match(err.message, /NO_EVIDENCE items_grid\.search/);
    assert.match(err.message, /ROUTE_NOT_IN_SWAGGER items_grid\.slow_search/);
    return true;
  });

  assert.deepEqual(await runDirs(), [], 'no run folder');
  assert.equal(mock.tokenCalls(), tokenCallsBefore, 'no request reached the env');
  assert.equal(Object.keys(await readSmokeLedger()).length, 0);
});

test('a run on an env without swagger_url is refused', async () => {
  const { project, feature } = await itemsFeature();
  delete project.envs.local!.swaggerUrl;

  await assert.rejects(runFeature({ project, feature, env: 'local', profile: 'smoke', quiet: true }), /no swagger_url configured for env local/);
  assert.deepEqual(await runDirs(), []);
});

test('a clean smoke records an empty meta.checks', async () => {
  const result = await runFeature({ project: 'selftest', feature: 'items', env: 'local', profile: 'smoke', quiet: true });

  assert.equal(result.ok, true);
  assert.deepEqual(result.meta.checks, []);
  assert.deepEqual((await readJson(join(result.runDir, 'meta.json'))).checks, []);
  assert.equal(Object.keys(await readSmokeLedger()).length, 1);
});

/** A smoke script for the selftest feature; `iteration` is the body of the `itemsGrid(data)` function. */
async function writeScript(iteration: string[]): Promise<string> {
  const core = (file: string) => pathToFileURL(join(REPO_ROOT, 'core', file)).href;
  const file = join(await tempDir('perf-script-'), 'items.js');
  await writeFile(
    file,
    [
      "import http from 'k6/http';",
      `import { loadRunConfig, loadSecrets, buildOptions } from '${core('config.js')}';`,
      `import { fetchTokens, bearer } from '${core('auth/ropc.js')}';`,
      `import { step } from '${core('request.js')}';`,
      `export { handleSummary } from '${core('summary.js')}';`,
      'const cfg = loadRunConfig();',
      'const secrets = loadSecrets();',
      'export const options = buildOptions(cfg);',
      'export function setup() { return { tokens: fetchTokens(cfg.auth, secrets.accounts) }; }',
      "const NONEMPTY = { 'body is not empty': (res) => res.body.length > 0 };",
      "const call = (id, route, data) => step(id, { method: 'POST', url: cfg.apiUrl + route, body: {}, token: bearer(data.tokens, 'User'), checks: NONEMPTY });",
      'export function itemsGrid(data) {',
      ...iteration.map((line) => `  ${line}`),
      '}',
    ].join('\n'),
  );
  return file;
}

/** Smoke the selftest feature with `iteration` as the script; the failure must come from the journey check alone. */
async function smokeWith(iteration: string[]) {
  const { project, feature } = await itemsFeature();
  const script = await writeScript(iteration);
  const result = await runFeature({ project, feature: { ...feature, script }, env: 'local', profile: 'smoke', quiet: true });
  return { result, meta: await readJson(join(result.runDir, 'meta.json')) };
}

const ALL_STEPS = [
  "call('items.search', '/items/search', data);",
  "call('items.slow_search', '/items/slow-search', data);",
  "call('items.export', '/items/export', data);",
];

test('a script that matches its journey passes the smoke with empty meta.checks', async () => {
  const { result, meta } = await smokeWith(ALL_STEPS);

  assert.equal(result.ok, true);
  assert.deepEqual(meta.checks, []);
  assert.equal(meta.k6.exitCode, 0);
  assert.equal(Object.keys(await readSmokeLedger()).length, 1);
});

test('a smoke whose script sends an unnamed request fails, with UNNAMED_REQUEST in meta.checks and no ledger entry', async () => {
  const { result, meta } = await smokeWith([
    ...ALL_STEPS,
    "http.post(cfg.apiUrl + '/items/search', '{}', { headers: { Authorization: bearer(data.tokens, 'User'), 'Content-Type': 'application/json' } });",
  ]);

  assert.equal(meta.k6.exitCode, 0, 'k6 itself is happy: only the journey check complains');
  assert.equal(result.ok, false);
  assert.deepEqual(codes(meta.checks), ['UNNAMED_REQUEST']);
  assert.match(meta.checks[0].detail, /\/items\/search/);
  assert.equal(Object.keys(await readSmokeLedger()).length, 0, 'a failed smoke is not recorded');
});

test('a smoke whose script skips a journey step fails with STEP_NOT_EXERCISED', async () => {
  const { result, meta } = await smokeWith(ALL_STEPS.slice(0, 2));

  assert.equal(result.ok, false);
  assert.deepEqual(
    meta.checks.map((p: Problem) => [p.code, p.journey, p.step]),
    [['STEP_NOT_EXERCISED', 'items_grid', 'export']],
  );
  assert.equal(Object.keys(await readSmokeLedger()).length, 0);
});

test('a smoke whose step goes to another route than journey.yaml says fails with ROUTE_MISMATCH', async () => {
  const { result, meta } = await smokeWith([
    "call('items.search', '/items/export', data);", // journey.yaml says POST /items/search
    ALL_STEPS[1]!,
    ALL_STEPS[2]!,
  ]);

  assert.equal(result.ok, false);
  assert.deepEqual(codes(meta.checks), ['ROUTE_MISMATCH']);
  assert.equal(meta.checks[0].step, 'search');
  assert.equal(Object.keys(await readSmokeLedger()).length, 0);
});

test('a load run is refused with SMOKE_REQUIRED when its first smoke fails the journey check', async () => {
  const { project, feature } = await itemsFeature();
  feature.workload.profiles.load = { users: 2, rampSec: 1, holdSec: 3, rampDownSec: 1 };
  const script = await writeScript(ALL_STEPS.slice(0, 2));

  await assert.rejects(
    runFeature({ project, feature: { ...feature, script }, env: 'local', profile: 'load', now: () => new Date('2026-10-24T12:00:00Z'), quiet: true }),
    (err: unknown) => (err as Error).message.includes('STEP_NOT_EXERCISED') && (err as { code?: string }).code === 'SMOKE_REQUIRED',
  );
  assert.equal((await runDirs()).length, 1, 'only the smoke ran');
});

// ---------------------------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------------------------

function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', CLI, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, PERF_RESULTS_DIR: root, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('perf check selftest items --env local prints 0 problems', { timeout: 60_000 }, async () => {
  const { code, out } = await cli(['check', 'selftest', 'items', '--env', 'local']);
  assert.equal(code, 0, out);
  assert.match(out, /^0 problems$/m);
});

test('perf check lists the problems it finds and exits 1', { timeout: 60_000 }, async () => {
  // A swagger that only knows the search route: slow-search and export are not in it.
  const swagger = await serveOnce(200, JSON.stringify({ paths: { '/api/items/search': { post: {} } } }));
  try {
    const { code, out } = await cli(['check', 'selftest', 'items', '--env', 'local'], { PERF_SELFTEST_URL: new URL(swagger.url).origin });
    assert.equal(code, 1, out);
    assert.match(out, /^ROUTE_NOT_IN_SWAGGER items_grid\.slow_search: POST \/items\/slow-search /m);
    assert.match(out, /^ROUTE_NOT_IN_SWAGGER items_grid\.export: /m);
    assert.match(out, /^2 problems$/m);
  } finally {
    await swagger.stop();
  }
});

test('perf check needs --env, and reports an unknown env or an unreachable swagger as a refusal', { timeout: 60_000 }, async () => {
  const missingEnv = await cli(['check', 'selftest', 'items']);
  assert.equal(missingEnv.code, 2, missingEnv.out);
  assert.match(missingEnv.out, /check needs --env/);

  const unknownEnv = await cli(['check', 'selftest', 'items', '--env', 'nowhere']);
  assert.equal(unknownEnv.code, 2, unknownEnv.out);
  assert.match(unknownEnv.out, /env nowhere is not defined/);

  const nothingListening = await cli(['check', 'selftest', 'items', '--env', 'local'], { PERF_SELFTEST_URL: 'http://127.0.0.1:9' });
  assert.equal(nothingListening.code, 2, nothingListening.out);
  assert.match(nothingListening.out, /could not fetch the swagger/);
});
