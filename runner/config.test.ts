import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadAdapter } from './adapter.js';
import { loadFeature, loadProject, loadProjectFrom, parseDuration, type Project } from './config.js';
import { loadFixtureProject } from '../tests/fixtures/report/fixtureProject.js';

/** A writing feature declares its writes (each with who cleans up); UNDECLARED is the same feature without the declaration. */
const WRITES = 'writes:\n  - { request: POST /a, cleanup: app }\n';
const UNDECLARED = `
read_only: false
journeys:
  - name: first_flow
    key: first
    role: User
    evidence: { source: test }
    steps:
      - { name: one, request: POST /a, evidence: { source: test } }
  - name: second_flow
    key: second
    role: User
    steps:
      - { name: one, request: GET /b, optional_share: 20 }
`;
const JOURNEYS = `${UNDECLARED}${WRITES}`;

function workload(mix: string): string {
  return `
business_unit: users working
business_action: item actions
mix: ${mix}
think_time: { min: 1s, max: 2s }
profiles:
  load: { users: 4, ramp: 15s, hold: 1m, ramp_down: 10s }
targets: baseline
`;
}

/** Writes features/<name>/{journey,workload}.yaml into a temp dir and runs fn with a project that points there. */
async function withFeature(
  journeyYaml: string,
  workloadYaml: string,
  fn: (project: Project, feature: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'perf-config-'));
  try {
    await mkdir(join(dir, 'features', 'bad'), { recursive: true });
    await writeFile(join(dir, 'features', 'bad', 'journey.yaml'), journeyYaml, 'utf8');
    await writeFile(join(dir, 'features', 'bad', 'workload.yaml'), workloadYaml, 'utf8');
    const base = await loadProject('selftest');
    await fn({ ...base, dir }, 'bad');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('loads the selftest project and items feature', async () => {
  const project = await loadProject('selftest');
  assert.equal(project.name, 'selftest');
  assert.deepEqual(project.roles, ['User']);
  assert.deepEqual(project.auth, { type: 'ropc' });
  assert.deepEqual(project.abort, { errorRate: 0.1, p95Ms: 15000, dbCpuOrIoPct: 95 });
  assert.equal(project.rowCountTables, undefined, 'the selftest project has no database tables to count');
  const local = project.envs.local;
  assert.ok(local, 'env local exists');
  assert.deepEqual(local.caps, { maxVus: 20, maxRps: 30, maxDurationSec: 1800 });
  assert.deepEqual(local.defaults, { vus: 10, rps: 15 });
  assert.equal(local.windowUtc, undefined);

  const feature = await loadFeature(project, 'items');
  assert.equal(feature.name, 'items');
  assert.equal(feature.readOnly, true, 'the mock only reads');
  assert.deepEqual(project.readOnlyPostRoutes, ['/items/search', '/items/slow-search', '/items/export']);
  assert.ok(feature.script.endsWith(join('features', 'items', 'items.js')));
  assert.equal(feature.journeys.length, 1);
  const journey = feature.journeys[0]!;
  assert.equal(journey.name, 'items_grid');
  assert.equal(journey.key, 'items');
  assert.equal(journey.role, 'User');
  assert.equal(journey.exec, 'itemsGrid');
  assert.deepEqual(
    journey.steps.map((s) => [s.name, s.method, s.route, s.optionalShare]),
    [
      ['search', 'POST', '/items/search', 100],
      ['slow_search', 'POST', '/items/slow-search', 100],
      ['export', 'POST', '/items/export', 5],
    ],
  );
  assert.ok(journey.steps.every((s) => s.evidence !== undefined), 'every selftest step cites evidence');

  const w = feature.workload;
  assert.deepEqual(w.mix, { items_grid: 100 });
  assert.equal(w.businessUnit, 'users working');
  assert.equal(w.businessAction, 'item actions');
  assert.deepEqual(w.thinkTime, { min: 0.5, max: 1 });
  assert.deepEqual(w.profiles.load, { users: 4, rampSec: 15, holdSec: 60, rampDownSec: 10 });
  assert.deepEqual(w.profiles.stress, { startRps: 2, maxRps: 30, stepRps: 2, stepEverySec: 15 });
  assert.equal(w.profiles.soak, undefined);
  assert.equal(w.targets, 'baseline');
});

test('selftest api url follows PERF_SELFTEST_URL and has a placeholder when it is unset', async () => {
  const saved = process.env.PERF_SELFTEST_URL;
  try {
    process.env.PERF_SELFTEST_URL = 'http://127.0.0.1:4567';
    const set = (await loadProject('selftest')).envs.local!;
    assert.equal(set.apiUrl, 'http://127.0.0.1:4567/api');
    assert.equal(set.swaggerUrl, 'http://127.0.0.1:4567/swagger/v1/swagger.json');
    assert.equal(set.appUrl, 'http://127.0.0.1:4567');

    delete process.env.PERF_SELFTEST_URL;
    const unset = (await loadProject('selftest')).envs.local!;
    assert.equal(unset.apiUrl, 'http://127.0.0.1:0/api');
  } finally {
    if (saved === undefined) delete process.env.PERF_SELFTEST_URL;
    else process.env.PERF_SELFTEST_URL = saved;
  }
});

test('rejects a project that does not exist', async () => {
  await assert.rejects(() => loadProject('no_such_project'), /project no_such_project not found/);
});

test('workload standing_data is a free mapping kept as written; anything else is rejected', async () => {
  const body = (extra: string) => workload('{ first_flow: 100 }') + extra;
  const journeys = JOURNEYS;
  await withFeature(journeys, body('standing_data: { widgets: 40, nested: { a: [1, 2] }, label: x }\n'), async (project, name) => {
    assert.deepEqual((await loadFeature(project, name)).workload.standingData, { widgets: 40, nested: { a: [1, 2] }, label: 'x' });
  });
  await withFeature(journeys, body(''), async (project, name) => {
    assert.equal((await loadFeature(project, name)).workload.standingData, undefined, 'absent stays absent');
  });
  await withFeature(journeys, body('standing_data: [1, 2]\n'), async (project, name) => {
    await assert.rejects(() => loadFeature(project, name), /standing_data must be a mapping/);
  });
});

test('rejects a feature that does not exist', async () => {
  const project = await loadProject('selftest');
  await assert.rejects(() => loadFeature(project, 'no_such_feature'), /feature no_such_feature not found/);
});

test('rejects a workload whose mix does not sum to 100', async () => {
  await withFeature(JOURNEYS, workload('{ first_flow: 60, second_flow: 30 }'), async (project, name) => {
    await assert.rejects(() => loadFeature(project, name), /mix must sum to 100 \(got 90\)/);
  });
});

test('accepts a mix that sums to 100 over several journeys', async () => {
  await withFeature(JOURNEYS, workload('{ first_flow: 70, second_flow: 30 }'), async (project, name) => {
    const feature = await loadFeature(project, name);
    assert.deepEqual(feature.workload.mix, { first_flow: 70, second_flow: 30 });
    assert.equal(feature.readOnly, false);
    assert.equal(feature.journeys[1]!.exec, 'secondFlow', 'exec defaults to the camelCased journey name');
    assert.equal(feature.journeys[1]!.steps[0]!.optionalShare, 20);
    assert.equal(feature.journeys[0]!.steps[0]!.optionalShare, 100, 'optional_share defaults to 100');
  });
});

test('rejects a mix key that is not a journey', async () => {
  await withFeature(JOURNEYS, workload('{ first_flow: 50, ghost_flow: 50 }'), async (project, name) => {
    await assert.rejects(() => loadFeature(project, name), /mix key ghost_flow is not a journey/);
  });
});

test('rejects optional_share outside 1..100', async () => {
  for (const bad of ['0', '101']) {
    const journeys = JOURNEYS.replace('optional_share: 20', `optional_share: ${bad}`);
    await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
      await assert.rejects(() => loadFeature(project, name), /optional_share must be between 1 and 100/);
    });
  }
});

// A feature may declare its own abort limits; they merge over the project's (run.ts effectiveAbort).
const withAbort = (abortYaml: string): string => `${workload('{ first_flow: 100 }')}${abortYaml}`;

test('a workload without abort has no abort override', async () => {
  await withFeature(JOURNEYS, workload('{ first_flow: 100 }'), async (project, name) => {
    assert.equal((await loadFeature(project, name)).workload.abort, undefined);
  });
});

test('workload abort: any of error_rate, p95_ms, db_cpu_or_io_pct, camelCased, only the keys that are written', async () => {
  await withFeature(JOURNEYS, withAbort('abort: { p95_ms: 45000 }\n'), async (project, name) => {
    assert.deepEqual((await loadFeature(project, name)).workload.abort, { p95Ms: 45000 });
  });
  await withFeature(JOURNEYS, withAbort('abort: { error_rate: 0.05, p95_ms: 30000.5, db_cpu_or_io_pct: 80 }\n'), async (project, name) => {
    assert.deepEqual((await loadFeature(project, name)).workload.abort, { errorRate: 0.05, p95Ms: 30000.5, dbCpuOrIoPct: 80 });
  });
});

// The selftest project's limits: error_rate 0.10, p95_ms 15000, db_cpu_or_io_pct 95. A feature may tighten the error rate and the
// DB limit, never loosen them (R34); the p95 limit may be raised (the owner did it for Forms).
test('workload abort: error_rate and db_cpu_or_io_pct are tighten-only (equal to the project is fine); p95_ms may be raised', async () => {
  await withFeature(JOURNEYS, withAbort('abort: { error_rate: 0.1, db_cpu_or_io_pct: 95, p95_ms: 15000 }\n'), async (project, name) => {
    assert.deepEqual((await loadFeature(project, name)).workload.abort, { errorRate: 0.1, dbCpuOrIoPct: 95, p95Ms: 15000 }, 'equal to the project is allowed');
  });
  await withFeature(JOURNEYS, withAbort('abort: { p95_ms: 600000 }\n'), async (project, name) => {
    assert.deepEqual((await loadFeature(project, name)).workload.abort, { p95Ms: 600000 }, 'p95 may be raised far above the project');
  });
  const file = (project: Project, name: string): string => join(project.dir, 'features', name, 'workload.yaml');
  for (const [yaml, path, limit] of [
    ['error_rate: 0.11', 'abort.error_rate', '0.1'],
    ['error_rate: 1', 'abort.error_rate', '0.1'],
    ['db_cpu_or_io_pct: 96', 'abort.db_cpu_or_io_pct', '95'],
    ['db_cpu_or_io_pct: 100', 'abort.db_cpu_or_io_pct', '95'],
  ] as const) {
    await withFeature(JOURNEYS, withAbort(`abort: { ${yaml} }\n`), async (project, name) => {
      await assert.rejects(
        () => loadFeature(project, name),
        (err: unknown) =>
          err instanceof Error &&
          err.name === 'ConfigError' &&
          err.message.includes(`${file(project, name)}: ${path} must be at most ${limit}`) &&
          /a feature may only tighten error_rate and db_cpu_or_io_pct/.test(err.message),
        yaml,
      );
    });
  }
});

test('workload abort: an unknown key is rejected with the file and the path', async () => {
  await withFeature(JOURNEYS, withAbort('abort: { p95: 45000 }\n'), async (project, name) => {
    await assert.rejects(
      () => loadFeature(project, name),
      (err: unknown) =>
        err instanceof Error &&
        err.name === 'ConfigError' &&
        err.message.includes(join(project.dir, 'features', name, 'workload.yaml')) &&
        /abort has unknown key p95 \(known: error_rate, p95_ms, db_cpu_or_io_pct\)/.test(err.message),
    );
  });
});

test('workload abort: values outside the sensible ranges, and things that are not numbers, are rejected by path', async () => {
  const bad: Array<[string, RegExp]> = [
    ['{ error_rate: 0 }', /abort\.error_rate must be above 0 and at most 1/],
    ['{ error_rate: 1.5 }', /abort\.error_rate must be above 0 and at most 1/],
    ['{ error_rate: -0.1 }', /abort\.error_rate must be above 0 and at most 1/],
    ['{ p95_ms: 0 }', /abort\.p95_ms must be at least 1/],
    ['{ p95_ms: -5 }', /abort\.p95_ms must be at least 1/],
    ['{ db_cpu_or_io_pct: 0 }', /abort\.db_cpu_or_io_pct must be above 0 and at most 100/],
    ['{ db_cpu_or_io_pct: 101 }', /abort\.db_cpu_or_io_pct must be above 0 and at most 100/],
    ['{ p95_ms: fast }', /abort\.p95_ms must be a number/],
    ['{ p95_ms: "45000" }', /abort\.p95_ms must be a number/],
    ['{ p95_ms: .nan }', /abort\.p95_ms must be a number/],
    ['{ p95_ms: .inf }', /abort\.p95_ms must be a number/],
    ['{ error_rate: null }', /abort\.error_rate must be a number/],
    ['45000', /abort must be a mapping/],
    ['[p95_ms]', /abort must be a mapping/],
    ['', /abort must be a mapping/],
  ];
  for (const [value, expected] of bad) {
    await withFeature(JOURNEYS, withAbort(`abort: ${value}\n`), async (project, name) => {
      await assert.rejects(() => loadFeature(project, name), expected, `abort: ${value}`);
    });
  }
});

test('a feature without read_only is read-only (strictest guardrails by default)', async () => {
  const journeys = UNDECLARED.replace('read_only: false\n', '');
  await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
    assert.equal((await loadFeature(project, name)).readOnly, true);
  });
});

test('rejects a request that is not "METHOD /route"', async () => {
  const journeys = JOURNEYS.replace('POST /a', 'fetch things');
  await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
    await assert.rejects(() => loadFeature(project, name), /request must look like "POST \/route"/);
  });
});

test('parseDuration handles 90s, 2m, 1h', () => {
  assert.equal(parseDuration('90s'), 90);
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('1h'), 3600);
  assert.equal(parseDuration('0.5s'), 0.5);
  assert.equal(parseDuration('30m'), 1800);
});

test('parseDuration rejects a missing or unknown unit', () => {
  for (const bad of ['90', '2d', 'm', '', '1h30m', '-5s']) {
    assert.throws(() => parseDuration(bad), /duration/, `"${bad}" must be rejected`);
  }
  assert.throws(() => parseDuration(90 as unknown as string), /duration/);
});

test('loadAdapter gives the env adapter to a project without adapter.ts', async () => {
  const project = await loadProject('selftest');
  const adapter = await loadAdapter(project);
  assert.equal(typeof adapter.resolveEnv, 'function');
  assert.equal(adapter.db, undefined);
});

test('loadAdapter: a static_header project may ship an adapter without resolveEnv; a password-grant one may not', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-adapter-'));
  try {
    await writeFile(join(dir, 'adapter.ts'), 'export default { runData: async () => ({ terms: ["a"] }) };\n', 'utf8');
    const base = await loadProject('selftest');
    const staticProject: Project = { ...base, dir, auth: { type: 'static_header', header: 'X-Api-Key', value: 'token ${random:8}' } };
    const adapter = await loadAdapter(staticProject);
    assert.equal(typeof adapter.runData, 'function');
    await assert.rejects(() => adapter.resolveEnv('local'), /signs in with a static header: it has no accounts or token endpoint to resolve/);
    await assert.rejects(() => loadAdapter({ ...base, dir }), /adapter\.ts must define resolveEnv\(env\): project selftest signs in with the password grant \(auth\.type: ropc\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('loadAdapter: a static_header class adapter with #private fields keeps working without resolveEnv', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-adapter-class-'));
  try {
    await writeFile(
      join(dir, 'adapter.ts'),
      [
        'class Adapter {',
        '  #calls = 0;',
        '  async runData() { this.#calls++; return { calls: this.#calls }; }',
        '  async close() { this.#calls = 0; }',
        '}',
        'export default new Adapter();',
        '',
      ].join('\n'),
      'utf8',
    );
    const base = await loadProject('selftest');
    const project: Project = { ...base, dir, auth: { type: 'static_header', header: 'X-Api-Key', value: 'token ${random:8}' } };
    const adapter = await loadAdapter(project);
    assert.deepEqual(await adapter.runData!('local', {} as never), { calls: 1 }, 'a method that reads a #private field works');
    assert.deepEqual(await adapter.runData!('local', {} as never), { calls: 2 }, 'and its state is the instance\'s own');
    await adapter.close!();
    await assert.rejects(() => adapter.resolveEnv('local'), /signs in with a static header/);
    const again = await loadAdapter(project);
    assert.deepEqual(await again.runData!('local', {} as never), { calls: 1 }, 'the shared export got no resolveEnv of its own');
    assert.equal(Object.hasOwn((await import(pathToFileURL(join(dir, 'adapter.ts')).href)).default, 'resolveEnv'), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('adapter_options is passed to the project untouched; a project without it has none', async () => {
  const withOptions = await loadFixtureProject();
  assert.deepEqual(withOptions.adapterOptions, { greeting: 'passed to the adapter untouched', nested: { depth: 2, list: ['a', 'b'] } });
  assert.equal((await loadProject('selftest')).adapterOptions, undefined, 'absent stays absent');
});

// ---------------------------------------------------------------------------------------------------------------
// auth: static_header
// ---------------------------------------------------------------------------------------------------------------

/** A project.yaml whose auth block is `auth` (YAML text), loaded from a temp folder. */
async function projectWithAuth(auth: string): Promise<Project> {
  const dir = await mkdtemp(join(tmpdir(), 'perf-auth-'));
  try {
    await writeFile(
      join(dir, 'project.yaml'),
      `name: authtest
roles: [Visitor]
envs:
  hosted:
    api_url: https://api.example.test
    caps: { max_vus: 5, max_rps: 5, max_duration: 5m }
    defaults: { vus: 2, rps: 2 }
auth: ${auth}
abort: { error_rate: 0.1, p95_ms: 5000, db_cpu_or_io_pct: 95 }
`,
      'utf8',
    );
    return await loadProjectFrom(dir, 'authtest');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('auth static_header: a header name and a value template with ${random:N} and ${env:NAME} are kept as written', async () => {
  const project = await projectWithAuth('{ type: static_header, header: Authorization, value: "token ${random:16}" }');
  assert.deepEqual(project.auth, { type: 'static_header', header: 'Authorization', value: 'token ${random:16}' });
  const fromEnv = await projectWithAuth('{ type: static_header, header: X-Api-Key, value: "${env:PERF_API_KEY}" }');
  assert.deepEqual(fromEnv.auth, { type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_API_KEY}' });
});

test('auth: an unknown type, a bad header name, an empty value or an unknown placeholder is rejected by path', async () => {
  const cases: [string, RegExp][] = [
    ['{ type: basic }', /auth\.type must be ropc or static_header/],
    ['{ type: static_header, value: "token ${random:16}" }', /auth\.header must be a non-empty text/],
    ['{ type: static_header, header: "Bad Header", value: x }', /auth\.header must be an HTTP header name/],
    ['{ type: static_header, header: Authorization }', /auth\.value must be a non-empty text/],
    ['{ type: static_header, header: Authorization, value: "token ${random:0}" }', /auth\.value .*\$\{random:0\}.*1 to 256/],
    ['{ type: static_header, header: Authorization, value: "token ${random:300}" }', /auth\.value .*1 to 256/],
    ['{ type: static_header, header: Authorization, value: "token ${uuid:4}" }', /auth\.value has an unknown placeholder \$\{uuid:4\}/],
    ['{ type: static_header, header: Authorization, value: "${env:lower-case}" }', /auth\.value has an unknown placeholder/],
    // k6 inherits every variable without the PERF_ prefix, so a secret read from another name would reach the k6 process.
    ['{ type: static_header, header: X-Api-Key, value: "${env:API_KEY}" }', /auth\.value \$\{env:API_KEY\}: the variable must start with PERF_ \(upper-case letters, digits, _\)/],
    ['{ type: static_header, header: X-Api-Key, value: "${env:PERF_lower}" }', /auth\.value \$\{env:PERF_lower\}: the variable must start with PERF_/],
  ];
  for (const [auth, expected] of cases) {
    await assert.rejects(() => projectWithAuth(auth), expected, auth);
  }
});

test('auth is read as written: ${NAME} expansion in auth.value is refused, pointing to ${env:PERF_NAME}', async () => {
  // The probe: a 3-character key in MY_API_KEY. Expanded at load it would skip the PERF_ prefix, the 4-character minimum
  // and the run-folder scan, and reach k6 as part of the header.
  const saved = process.env.MY_API_KEY;
  process.env.MY_API_KEY = 'abc';
  try {
    for (const value of ['${MY_API_KEY}', 'key ${MY_API_KEY:-fallback}']) {
      await assert.rejects(
        () => projectWithAuth(`{ type: static_header, header: X-Api-Key, value: "${value}" }`),
        (err: Error) => {
          assert.match(err.message, /auth\.value \$\{MY_API_KEY(:-fallback)?\}: auth is read as written, without \$\{NAME\} expansion/);
          assert.match(err.message, /write \$\{env:PERF_MY_API_KEY\}/);
          assert.doesNotMatch(err.message, /abc/, 'the value is never shown');
          return true;
        },
        value,
      );
    }
    delete process.env.MY_API_KEY;
    await assert.rejects(
      () => projectWithAuth('{ type: static_header, header: X-Api-Key, value: "${MY_API_KEY}" }'),
      /auth is read as written/,
      'unset: the auth rule is named, not a missing variable',
    );
    process.env.PERF_HEADER_NAME = 'X-Api-Key';
    await assert.rejects(
      () => projectWithAuth('{ type: static_header, header: "${PERF_HEADER_NAME}", value: "token ${random:8}" }'),
      /auth\.header must be an HTTP header name/,
      'no expansion anywhere under auth',
    );
  } finally {
    if (saved === undefined) delete process.env.MY_API_KEY;
    else process.env.MY_API_KEY = saved;
    delete process.env.PERF_HEADER_NAME;
  }
});

// ---------------------------------------------------------------------------------------------------------------
// journey.yaml: roles
// ---------------------------------------------------------------------------------------------------------------

test('a journey role must be one of project.yaml roles when the project lists roles', async () => {
  const journeys = JOURNEYS.replace('role: User\n    evidence', 'role: Admin\n    evidence');
  await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
    await assert.rejects(() => loadFeature(project, name), /journeys\[0\]\.role must be one of project\.yaml roles \(User\) \(got "Admin"\)/);
    const { roles: _roles, ...noRoles } = project;
    assert.equal((await loadFeature(noRoles, name)).journeys[0]!.role, 'Admin', 'a project without roles takes any role name');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// journey.yaml: declared writes
// ---------------------------------------------------------------------------------------------------------------

test('journey.yaml writes: a writing feature declares which requests write and who cleans up', async () => {
  await withFeature(JOURNEYS, workload('{ first_flow: 100 }'), async (project, name) => {
    const feature = await loadFeature(project, name);
    assert.equal(feature.readOnly, false);
    assert.deepEqual(feature.writes, [{ method: 'POST', route: '/a', cleanup: 'app' }]);
  });
});

test('journey.yaml writes: read_only: false without writes (or with none listed) is rejected, naming the rule', async () => {
  for (const journeys of [UNDECLARED, `${UNDECLARED}writes: []\n`]) {
    await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
      await assert.rejects(
        () => loadFeature(project, name),
        /journey\.yaml: writes must list every write of a feature with read_only: false, each with its cleanup \(cleanup: app/,
        journeys.slice(-30),
      );
    });
  }
});

test('journey.yaml writes: rejected on a read-only feature, with an unknown cleanup, or for a request no step sends', async () => {
  const cases: [string, RegExp][] = [
    [JOURNEYS.replace('read_only: false', 'read_only: true'), /writes is only for a feature with read_only: false/],
    [`${UNDECLARED}writes:\n  - { request: POST /a, cleanup: nobody }\n`, /writes\[0\]\.cleanup must be app/],
    [`${UNDECLARED}writes:\n  - { request: POST /zzz, cleanup: app }\n`, /writes\[0\] POST \/zzz is not a step of any journey/],
    [`${UNDECLARED}writes:\n  - { request: make things, cleanup: app }\n`, /writes\[0\]\.request must look like "POST \/route"/],
    [`${UNDECLARED}writes: yes\n`, /writes must be a list/],
  ];
  for (const [journeys, expected] of cases) {
    await withFeature(journeys, workload('{ first_flow: 100 }'), async (project, name) => {
      await assert.rejects(() => loadFeature(project, name), expected, journeys.slice(-60));
    });
  }
});

test('project abort: db_cpu_or_io_pct may be left out (a project without a database); the other two are required', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-abort-'));
  try {
    const write = (abort: string) =>
      writeFile(
        join(dir, 'project.yaml'),
        `name: aborttest
envs:
  local:
    api_url: https://api.example.test
    caps: { max_vus: 5, max_rps: 5, max_duration: 5m }
    defaults: { vus: 2, rps: 2 }
auth: { type: ropc }
abort: ${abort}
`,
        'utf8',
      );
    await write('{ error_rate: 0.1, p95_ms: 5000 }');
    assert.deepEqual((await loadProjectFrom(dir, 'aborttest')).abort, { errorRate: 0.1, p95Ms: 5000 });
    await write('{ error_rate: 0.1, db_cpu_or_io_pct: 95 }');
    await assert.rejects(() => loadProjectFrom(dir, 'aborttest'), /abort\.p95_ms must be a number/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
