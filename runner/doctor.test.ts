import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Knex } from 'knex';
import type { ProjectAdapter, ResolvedEnv } from './adapter.js';
import { main } from './cli.js';
import { loadProject } from './config.js';
import { doctor, formatCheck, missingDependencies, type DoctorCheck, type DoctorProbes } from './doctor.js';
import { startMockServer, type MockServer } from './selftest/server.js';

const TOUCHED_ENV = ['PERF_SELFTEST_URL', 'PERF_TOKEN_URL', 'PERF_TOKEN_CLIENT_ID', 'PERF_SCOPE', 'PERF_USER_LOGIN', 'PERF_USER_PASSWORD'];
const saved: Record<string, string | undefined> = {};
const scratch: string[] = [];
let mock: MockServer;

before(async () => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  mock = await startMockServer();
  process.env.PERF_SELFTEST_URL = mock.url;
  process.env.PERF_TOKEN_URL = `${mock.url}/oauth/token`;
  process.env.PERF_TOKEN_CLIENT_ID = 'doctor-test';
  process.env.PERF_SCOPE = 'openid';
  process.env.PERF_USER_LOGIN = 'perf';
  process.env.PERF_USER_PASSWORD = 'perf';
});

after(async () => {
  await mock.stop();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

const SECRET_LOGIN = 'secret-login-7f3a@example.test';
const SECRET_PASSWORD = 'secret-password-91bc';
const SECRET_TOKEN = 'eyJsecret.token.value';

const FAKE_ENV: ResolvedEnv = {
  apiUrl: 'http://127.0.0.1:1/api',
  auth: { tokenUrl: 'http://127.0.0.1:1/oauth/token', clientId: 'client', scope: 'openid' },
  accounts: {
    Admin: { login: SECRET_LOGIN, password: SECRET_PASSWORD },
    Analyst: { login: `analyst-${SECRET_LOGIN}`, password: `analyst-${SECRET_PASSWORD}` },
  },
};

/** Probes that all succeed; a test overrides the one it is about. `calls` counts what was asked. */
function healthy(overrides: Partial<DoctorProbes> = {}, adapter: Partial<ProjectAdapter> = {}) {
  const calls = { adapter: 0, tokens: [] as string[], close: 0 };
  const probes: Partial<DoctorProbes> = {
    k6Version: async () => '2.3.0',
    nodeVersion: () => '22.14.0',
    missingDependencies: async () => [],
    loadProject: (name) => loadProject(name),
    loadAdapter: async () => {
      calls.adapter++;
      return {
        resolveEnv: async () => FAKE_ENV,
        close: async () => void calls.close++,
        ...adapter,
      };
    },
    swaggerStatus: async () => 200,
    tokenAnswer: async (_auth, account) => {
      calls.tokens.push(account.login);
      return { status: 200, hasAccessToken: true };
    },
    database: async () => ({ viewDatabaseState: true, profile: { tier: 'S1', edition: 'SQL Azure' } }),
    ...overrides,
  };
  return { probes, calls };
}

const lines = (checks: DoctorCheck[]): string[] => checks.map(formatCheck);

test('formatCheck prints a passed check as "✓ label" and a failed one as "✗ label — fix"', () => {
  assert.equal(formatCheck({ ok: true, label: 'k6 v2.3.0' }), '✓ k6 v2.3.0');
  assert.equal(
    formatCheck({ ok: false, label: 'k6 1.0 or newer', fix: 'install it with: brew install k6' }),
    '✗ k6 1.0 or newer — install it with: brew install k6',
  );
});

test('doctor formats a failing check with its fix (fake probes)', async () => {
  const { probes } = healthy({
    k6Version: async () => {
      throw new Error('k6 not found — install with: brew install k6');
    },
    nodeVersion: () => '20.11.1',
    missingDependencies: async () => ['knex', 'yaml'],
  });
  const checks = await doctor(undefined, undefined, { probes });

  assert.deepEqual(checks, [
    { ok: false, label: 'k6 1.0 or newer', fix: 'install it with: brew install k6' },
    { ok: false, label: 'Node 22 or newer (found v20.11.1)', fix: 'install Node 22 or newer from https://nodejs.org, then reopen the terminal' },
    { ok: false, label: 'dependencies installed (missing: knex, yaml)', fix: 'run: npm install' },
  ]);
  assert.deepEqual(lines(checks), [
    '✗ k6 1.0 or newer — install it with: brew install k6',
    '✗ Node 22 or newer (found v20.11.1) — install Node 22 or newer from https://nodejs.org, then reopen the terminal',
    '✗ dependencies installed (missing: knex, yaml) — run: npm install',
  ]);
});

test('an old k6 is told to upgrade, not install', async () => {
  const { probes } = healthy({
    k6Version: async () => {
      throw new Error('k6 1.0 or newer required (found 0.50.0)');
    },
  });
  const [k6] = await doctor(undefined, undefined, { probes });
  assert.equal(k6!.ok, false);
  assert.equal(k6!.fix, 'upgrade it with: brew upgrade k6 (found 0.50.0)');
});

test('without a project doctor checks only the tools, and reports each check as it is made', async () => {
  const { probes, calls } = healthy();
  const seen: string[] = [];
  const checks = await doctor(undefined, undefined, { probes, onCheck: (c) => void seen.push(formatCheck(c)) });
  assert.deepEqual(lines(checks), ['✓ k6 v2.3.0', '✓ Node v22.14.0', '✓ dependencies installed']);
  assert.deepEqual(seen, lines(checks));
  assert.equal(calls.adapter, 0, 'no adapter was loaded');
});

test('with a project doctor checks the env, accounts, swagger, one token per role and the database', async () => {
  const { probes, calls } = healthy(
    {},
    { db: async () => ({}) as Knex }, // the database probe is faked below; the adapter only has to say it has one
  );
  const checks = await doctor('selftest', 'local', { probes });
  assert.deepEqual(lines(checks), [
    '✓ k6 v2.3.0',
    '✓ Node v22.14.0',
    '✓ dependencies installed',
    '✓ project selftest loaded',
    '✓ env local is allowed (caps 20 users / 30 req/s, defaults 10 users / 15 req/s)',
    '✓ Admin account',
    '✓ Analyst account',
    '✓ swagger answers 200',
    '✓ Admin token',
    '✓ Analyst token',
    '✓ database reachable',
    '✓ VIEW DATABASE STATE granted',
    '✓ database tier S1 (SQL Azure)',
  ]);
  assert.equal(calls.tokens.length, 2, 'one token request per role');
  assert.equal(calls.close, 1, 'the adapter was closed');
});

test('a project without a database is not a failure', async () => {
  const { probes } = healthy();
  const checks = await doctor('selftest', 'local', { probes });
  assert.equal(checks.every((c) => c.ok), true);
  assert.equal(checks.at(-1)!.label, 'no database for this project (database evidence is skipped)');
});

/** The selftest project with a static header in place of the password grant. */
async function staticProject(value: string) {
  const project = await loadProject('selftest');
  return { ...project, auth: { type: 'static_header' as const, header: 'X-Api-Key', value } };
}

test('a static_header project: no accounts and no token request, one line for the header, the value never shown', async () => {
  const project = await staticProject('key ${env:PERF_DOCTOR_KEY} ${random:4}');
  const resolveEnv = async (): Promise<ResolvedEnv> => {
    throw new Error('resolveEnv must not be called for a static header');
  };
  const { probes, calls } = healthy({ loadProject: async () => project }, { resolveEnv });
  process.env.PERF_DOCTOR_KEY = 'doctor-secret-key-55';
  try {
    const checks = await doctor('selftest', 'local', { probes });
    assert.deepEqual(lines(checks).slice(5), [
      '✓ swagger answers 200',
      '✓ X-Api-Key header from project.yaml (no login, no token request)',
      '✓ no database for this project (database evidence is skipped)',
    ]);
    assert.deepEqual(calls.tokens, []);
    assert.ok(!lines(checks).join('\n').includes('doctor-secret-key-55'));
  } finally {
    delete process.env.PERF_DOCTOR_KEY;
  }
});

test('a static_header project whose ${env:NAME} is not set fails with the variable to set', async () => {
  const project = await staticProject('${env:PERF_DOCTOR_UNSET}');
  delete process.env.PERF_DOCTOR_UNSET;
  const { probes } = healthy({ loadProject: async () => project });
  const checks = await doctor('selftest', 'local', { probes });
  const header = checks.find((c) => c.label.startsWith('X-Api-Key header'))!;
  assert.equal(header.ok, false);
  assert.match(header.fix!, /PERF_DOCTOR_UNSET is not set/);
});

test('a project with a database but no db_cpu_or_io_pct fails the check: every run would be refused', async () => {
  const project = structuredClone(await loadProject('selftest'));
  delete project.abort.dbCpuOrIoPct;
  const { probes } = healthy({ loadProject: async () => project }, { db: async () => ({}) as Knex });
  const checks = await doctor('selftest', 'local', { probes });
  const limit = checks.find((c) => c.label.startsWith('abort.db_cpu_or_io_pct'))!;
  assert.equal(limit.ok, false);
  assert.match(limit.fix!, /add abort\.db_cpu_or_io_pct to project\.yaml/);
  assert.match(limit.fix!, /a run of a feature that does not set it is refused/);

  const withLimit = await doctor('selftest', 'local', { probes: healthy({}, { db: async () => ({}) as Knex }).probes });
  assert.ok(!withLimit.some((c) => c.label.startsWith('abort.db_cpu_or_io_pct')), 'no line when the limit is set');
});

test('a missing VIEW DATABASE STATE grant fails with the fix; an unknown tier is not a failure', async () => {
  const { probes } = healthy(
    { database: async () => ({ viewDatabaseState: false, profile: { tier: null, edition: null } }) },
    { db: async () => ({}) as Knex },
  );
  const checks = await doctor('selftest', 'local', { probes });
  const grant = checks.find((c) => c.label === 'VIEW DATABASE STATE granted');
  assert.equal(grant?.ok, false);
  assert.match(grant!.fix!, /ask a database admin/i);
  assert.deepEqual(checks.at(-1), { ok: true, label: 'database tier not reported by the server' });
});

test('an unreachable database fails with the fix and no server detail', async () => {
  const { probes } = healthy(
    {
      database: async () => {
        throw Object.assign(new Error(`Failed to connect to ${SECRET_LOGIN}.database.windows.net:1433`), { code: 'ESOCKET' });
      },
    },
    { db: async () => ({}) as Knex },
  );
  const checks = await doctor('selftest', 'local', { probes });
  const reach = checks.find((c) => c.label === 'database reachable');
  assert.equal(reach?.ok, false);
  assert.match(reach!.fix!, /ESOCKET/);
  assert.doesNotMatch(JSON.stringify(checks), /windows\.net|secret-login/);
});

test('swagger that does not answer 200 fails with the url to try', async () => {
  const { probes } = healthy({ swaggerStatus: async () => 503 });
  const checks = await doctor('selftest', 'local', { probes });
  const swagger = checks.find((c) => c.label === 'swagger answers 200');
  assert.equal(swagger?.ok, false);
  assert.match(swagger!.fix!, /returned 503/);
  assert.match(swagger!.fix!, /\/swagger\/v1\/swagger\.json/);
});

test('a project that does not load stops the checks that need it, and loads no adapter', async () => {
  const { probes, calls } = healthy({
    loadProject: async () => {
      throw new Error('project nope not found (expected /somewhere/projects/nope/project.yaml)');
    },
  });
  const checks = await doctor('nope', 'staging', { probes });
  assert.equal(checks.length, 4);
  assert.deepEqual(checks[3], {
    ok: false,
    label: 'project nope loads',
    fix: 'project nope not found (expected /somewhere/projects/nope/project.yaml)',
  });
  assert.equal(calls.adapter, 0);
});

test('an env the project does not list fails and names the env it has', async () => {
  const { probes, calls } = healthy();
  const checks = await doctor('selftest', 'prod', { probes });
  const env = checks.at(-1)!;
  assert.equal(env.ok, false);
  assert.equal(env.label, 'env prod is allowed');
  assert.match(env.fix!, /local/);
  assert.equal(calls.adapter, 0);
});

test('accounts that cannot be resolved fail with the message, then the token and database checks wait', async () => {
  const { probes, calls } = healthy({}, {
    resolveEnv: async () => {
      throw new Error('PERF_USER_LOGIN is not set — put it in .env (names are in .env.example) or in the environment');
    },
  });
  const checks = await doctor('selftest', 'local', { probes });
  const accounts = checks.find((c) => c.label === 'accounts for env local');
  assert.equal(accounts?.ok, false);
  assert.match(accounts!.fix!, /PERF_USER_LOGIN is not set/);
  assert.equal(checks.some((c) => /token/.test(c.label)), false, 'no token was tried');
  assert.equal(calls.tokens.length, 0);
  assert.equal(calls.close, 1);
});

test('no login, password or token reaches the output, not even through an error message', async () => {
  const leak = (what: string) => new Error(`${what} failed for ${SECRET_LOGIN} with ${SECRET_PASSWORD} and ${SECRET_TOKEN}`);
  const { probes } = healthy(
    {
      swaggerStatus: async () => {
        throw leak('swagger');
      },
      tokenAnswer: async (_auth, account) => {
        if (account.login === SECRET_LOGIN) throw leak('token');
        return { status: 200, hasAccessToken: true };
      },
    },
    { db: async () => ({}) as Knex },
  );
  const seen: string[] = [];
  const checks = await doctor('selftest', 'local', { probes, onCheck: (c) => void seen.push(formatCheck(c)) });
  const everything = `${JSON.stringify(checks)}\n${seen.join('\n')}`;
  for (const secret of [SECRET_LOGIN, SECRET_PASSWORD, SECRET_TOKEN, `analyst-${SECRET_LOGIN}`, `analyst-${SECRET_PASSWORD}`]) {
    assert.equal(everything.includes(secret), false, `"${secret}" must not be printed`);
  }
  assert.match(everything, /✓ Analyst account/);
  assert.equal(checks.find((c) => c.label === 'Admin token')?.ok, false, 'the failure is still reported');
});

test('doctor sends at most one token request per role to the real token endpoint, and never retries', async () => {
  const before = mock.tokenCalls();
  const ok = await doctor('selftest', 'local');
  assert.equal(mock.tokenCalls() - before, 1, 'one role, one request');
  assert.equal(ok.every((c) => c.ok), true, lines(ok).join('\n'));
  assert.ok(lines(ok).includes('✓ User token'), lines(ok).join('\n'));
  assert.equal(JSON.stringify(ok).includes('eyJ'), false, 'no token in the output');

  mock.setTokenStatus(429);
  try {
    const afterThrottle = mock.tokenCalls();
    const throttled = await doctor('selftest', 'local');
    assert.equal(mock.tokenCalls() - afterThrottle, 1, 'a throttled token endpoint is asked once, not retried');
    const token = throttled.find((c) => c.label === 'User token');
    assert.equal(token?.ok, false);
    assert.match(token!.fix!, /429/);
    assert.match(token!.fix!, /throttl/i);
  } finally {
    mock.setTokenStatus(200);
  }
});

test('three roles cost three token requests', async () => {
  const roles = ['Admin', 'Manager', 'Analyst'];
  const accounts = Object.fromEntries(roles.map((role) => [role, { login: 'perf', password: 'perf' }]));
  const { probes } = healthy(
    {},
    { resolveEnv: async () => ({ ...FAKE_ENV, auth: { tokenUrl: `${mock.url}/oauth/token`, clientId: 'c', scope: 'openid' }, accounts }) },
  );
  delete probes.tokenAnswer; // the real probe, against the mock
  const before = mock.tokenCalls();
  const checks = await doctor('selftest', 'local', { probes });
  assert.equal(mock.tokenCalls() - before, 3);
  assert.deepEqual(checks.filter((c) => c.label.endsWith(' token')).map((c) => c.label), ['Admin token', 'Manager token', 'Analyst token']);
  assert.equal(checks.every((c) => c.ok), true, lines(checks).join('\n'));
});

test('a wrong password reads as a bad login, not as a broken endpoint', async () => {
  const { probes } = healthy(
    { tokenAnswer: async () => ({ status: 400, hasAccessToken: false }) },
    { resolveEnv: async () => FAKE_ENV },
  );
  const checks = await doctor('selftest', 'local', { probes });
  const token = checks.find((c) => c.label === 'Admin token');
  assert.equal(token?.ok, false);
  assert.match(token!.fix!, /400/);
  assert.match(token!.fix!, /login or password/);
});

test('missingDependencies names the packages a folder of node_modules lacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perf-deps-'));
  scratch.push(root);
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({ dependencies: { knex: '^3', yaml: '^2' }, devDependencies: { tsx: '^4' } }),
    'utf8',
  );
  assert.deepEqual(await missingDependencies(root), ['knex', 'tsx', 'yaml']);

  for (const name of ['knex', 'yaml']) {
    await mkdir(join(root, 'node_modules', name), { recursive: true });
    await writeFile(join(root, 'node_modules', name, 'package.json'), '{}', 'utf8');
  }
  assert.deepEqual(await missingDependencies(root), ['tsx']);
});

test('perf doctor runs from the command line: exit 0 and a line per check when everything works', async () => {
  const out: string[] = [];
  const { log } = console;
  console.log = (...parts: unknown[]) => void out.push(parts.join(' '));
  let code: number;
  try {
    code = await main(['doctor', 'selftest', '--env', 'local']);
  } finally {
    console.log = log;
  }
  assert.equal(code, 0, out.join('\n'));
  assert.match(out[0]!, /^✓ k6 v\d+\.\d+\.\d+$/);
  assert.ok(out.includes('✓ User account'));
  assert.ok(out.includes('✓ User token'));
  assert.equal(out.some((line) => line.startsWith('✗')), false);
});

test('perf doctor exits 1 when a check fails, and 2 when misused', async () => {
  const run = async (...argv: string[]) => {
    const out: string[] = [];
    const err: string[] = [];
    const { log, error } = console;
    console.log = (...parts: unknown[]) => void out.push(parts.join(' '));
    console.error = (...parts: unknown[]) => void err.push(parts.join(' '));
    try {
      return { code: await main(argv), out: out.join('\n'), err: err.join('\n') };
    } finally {
      console.log = log;
      console.error = error;
    }
  };

  mock.setTokenStatus(401);
  try {
    const failed = await run('doctor', 'selftest', '--env', 'local');
    assert.equal(failed.code, 1);
    assert.match(failed.out, /^✗ User token — .*401/m);
  } finally {
    mock.setTokenStatus(200);
  }

  assert.equal((await run('doctor', '--env', 'local')).code, 2, 'an env without a project');
  assert.equal((await run('doctor', 'selftest')).code, 2, 'a project without an env');
  const extra = await run('doctor', 'selftest', 'more', '--env', 'local');
  assert.equal(extra.code, 2);
  assert.match(extra.err, /doctor needs/);
});
