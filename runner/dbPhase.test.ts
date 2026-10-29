import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import type { Knex } from 'knex';
import type { ProjectAdapter } from './adapter.js';
import { createEnvAdapter } from './adapters/envAdapter.js';
import { ConfigError, loadFeature, loadProject, type Feature, type Project } from './config.js';
import { DbPhase } from './dbPhase.js';
import { GuardrailError, readSmokeLedger, type ResourceSample } from './guardrails.js';
import { runFeature } from './run.js';
import { startMockServer, type MockServer } from './selftest/server.js';

// The runner's DB phase end to end: busy check, DB abort, db.json and row counts. The k6 runs go against the local mock
// (selftest project, no database of its own); a resourceSource or a fake adapter stands in for the shared database.

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

before(async () => {
  for (const key of TOUCHED_ENV) savedEnv[key] = process.env[key];
  mock = await startMockServer();
  Object.assign(process.env, AUTH_ENV, {
    PERF_SELFTEST_URL: mock.url,
    PERF_TOKEN_URL: `${mock.url}/oauth/token`,
    K6_WEB_DASHBOARD_PORT: '-1',
  });
});

beforeEach(async () => {
  root = await tempDir('perf-results-');
  process.env.PERF_RESULTS_DIR = root;
});

afterEach(() => {
  delete (globalThis as { __perfFakeAdapter?: unknown }).__perfFakeAdapter;
});

after(async () => {
  await mock.stop();
  for (const key of TOUCHED_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));

async function runDirs(): Promise<string[]> {
  return (await readdir(root)).filter((name) => !name.startsWith('.')).sort();
}

const NOW = () => new Date('2026-10-24T12:00:00Z');

/** The selftest feature with a short load: `holdSec` of hold, 2 users. */
async function quickFeature(holdSec = 3): Promise<Feature> {
  const project = await loadProject('selftest');
  const feature = structuredClone(await loadFeature(project, 'items'));
  feature.workload.profiles.load = { users: 2, rampSec: 1, holdSec, rampDownSec: 1 };
  return feature;
}

/** A passing smoke in the ledger, so a load run that follows starts at once and its DB source calls are only its own. */
async function primeSmoke(feature: Feature): Promise<void> {
  const smoke = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'smoke', now: NOW, quiet: true });
  assert.equal(smoke.ok, true);
}

const sample = (endTime: number, pct: number): ResourceSample => ({ endTime: new Date(endTime), cpu: pct, dataIo: pct / 2, logWrite: 1 });
const calm = (): ResourceSample[] => [sample(Date.now() - 30_000, 5), sample(Date.now() - 15_000, 8)];

// ---------------------------------------------------------------------------------------------------------------
// busy check
// ---------------------------------------------------------------------------------------------------------------

test('busy env refuses load', async () => {
  const feature = await quickFeature();
  const busy = [sample(Date.now() - 30_000, 40), sample(Date.now() - 15_000, 36)]; // average CPU 38 %, limit 20 %

  await assert.rejects(
    runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now: NOW, quiet: true, resourceSource: async () => busy }),
    (err: unknown) =>
      err instanceof GuardrailError && err.code === 'ENV_BUSY' && /38/.test(err.message) && /--override-busy/.test(err.message),
  );
  assert.deepEqual(await runDirs(), [], 'nothing was sent: not even the smoke ran');
});

test('busy override runs and sets busyOverride', { timeout: 120_000 }, async () => {
  const feature = await quickFeature();
  const busy = [sample(Date.now() - 30_000, 40), sample(Date.now() - 15_000, 36)];

  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    overrideBusy: true,
    resourceSource: async () => busy, // always 40 %: busy, but not 95 % for four samples, so no abort
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.meta.guardrails.busyOverride, true);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.guardrails.busyOverride, true);
  const smokeDir = (await runDirs()).find((d) => d.endsWith('_smoke'))!;
  const smokeMeta = await readJson(join(root, smokeDir, 'meta.json'));
  assert.equal(smokeMeta.guardrails.busyOverride, false, 'the smoke that came first had no busy check to override');
});

test('a calm DB passes the busy check, and a needless --override-busy is not recorded', { timeout: 120_000 }, async () => {
  const feature = await quickFeature();

  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    overrideBusy: true,
    resourceSource: async () => calm(),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.meta.guardrails.busyOverride, false);
});

test('a DB load that cannot be read counts as busy: refused without the override, run with it', { timeout: 120_000 }, async () => {
  const feature = await quickFeature();
  const unreadable: [string, () => Promise<ResourceSample[]>][] = [
    ['no samples', async () => []],
    ['all-null samples', async () => [{ endTime: new Date(), cpu: NaN, dataIo: NaN, logWrite: NaN }]],
    ['a source that fails', async () => Promise.reject(new Error('connection refused'))],
  ];
  for (const [what, resourceSource] of unreadable) {
    await assert.rejects(
      runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now: NOW, quiet: true, resourceSource }),
      (err: unknown) => err instanceof GuardrailError && err.code === 'ENV_BUSY' && /could not be read/.test(err.message),
      what,
    );
  }
  assert.deepEqual(await runDirs(), []);

  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    overrideBusy: true,
    resourceSource: async () => [],
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.meta.guardrails.busyOverride, true);
});

test('a database that cannot be reached refuses a load even with --override-busy: no guard, no load', { timeout: 120_000 }, async () => {
  const project = await projectWithAdapter({
    db: async () => {
      throw Object.assign(new Error('connect failed to secret-host.example'), { code: 'ESOCKET' });
    },
  });
  const feature = await quickFeature();
  for (const overrideBusy of [false, true]) {
    await assert.rejects(
      runFeature({ project, feature, env: 'local', profile: 'load', now: NOW, quiet: true, overrideBusy }),
      (err: unknown) => {
        assert.ok(err instanceof GuardrailError);
        assert.equal(err.code, 'DB_UNREACHABLE');
        assert.match(err.message, /the database could not be reached \(ESOCKET\)/);
        assert.match(err.message, /--override-busy does not lift it/);
        assert.doesNotMatch(err.message, /secret-host/);
        return true;
      },
      `overrideBusy ${overrideBusy}`,
    );
  }
  assert.deepEqual(await runDirs(), [], 'nothing was sent');
  const smoke = await runFeature({ project, feature, env: 'local', profile: 'smoke', now: NOW, quiet: true });
  assert.equal(smoke.ok, true, 'a smoke still runs: one pass, no load to guard');
  assert.equal(smoke.meta.database, 'unavailable');
});

test('a smoke needs no busy check', { timeout: 120_000 }, async () => {
  let calls = 0;
  const result = await runFeature({
    project: 'selftest',
    feature: 'items',
    env: 'local',
    profile: 'smoke',
    now: NOW,
    quiet: true,
    resourceSource: async () => {
      calls++;
      return [sample(Date.now(), 90)];
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.meta.guardrails.busyOverride, false);
  assert.ok(calls >= 1, 'the source was still used for the run window');
});

test('R45: a project without db_cpu_or_io_pct is refused when it has a database, and runs when it has none', { timeout: 120_000 }, async () => {
  const project = structuredClone(await loadProject('selftest'));
  delete project.abort.dbCpuOrIoPct;
  await assert.rejects(
    runFeature({ project, feature: 'items', env: 'local', profile: 'smoke', now: NOW, quiet: true, resourceSource: async () => calm() }),
    (err: unknown) => err instanceof ConfigError && /abort\.db_cpu_or_io_pct is required for a project with a database.*no load was sent/.test(err.message),
  );
  assert.deepEqual(await runDirs(), [], 'refused before anything was sent');

  const result = await runFeature({ project, feature: 'items', env: 'local', profile: 'smoke', now: NOW, quiet: true });
  assert.equal(result.ok, true, 'no database: nothing for the limit to guard');
  assert.equal(result.meta.abort!.dbCpuOrIoPct, undefined);
  assert.equal(result.meta.database, 'none');
});

// run.ts refuses on DbPhase.hasEvidence, so an adapter whose db() fails is refused like one that connects.
test('R45: a database that cannot be reached also needs db_cpu_or_io_pct (it fails closed)', async () => {
  const project = structuredClone(await loadProject('selftest'));
  delete project.abort.dbCpuOrIoPct;
  const adapter: ProjectAdapter = {
    ...createEnvAdapter(project),
    db: async () => {
      throw Object.assign(new Error('connect failed'), { code: 'ESOCKET' });
    },
  };
  const phase = await DbPhase.open(adapter, { env: 'local', project, log: () => {} });
  assert.ok(phase?.hasEvidence, 'a failed connection still counts as a project with a database');
});

// ---------------------------------------------------------------------------------------------------------------
// DB abort
// ---------------------------------------------------------------------------------------------------------------

test('DB abort stops k6 and records the reason', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(300); // would hold for 5 minutes
  await primeSmoke(feature);
  // Call 1 is the busy check: calm. After that every call reports one more 96 % sample, like the real window query does.
  const t0 = Date.now();
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 1) return calm();
    return Array.from({ length: calls - 1 }, (_, i) => sample(t0 + i * 15_000, 96));
  };

  const startedAt = Date.now();
  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    resourceSource,
    dbPollMs: 400,
  });

  const tookSec = (Date.now() - startedAt) / 1000;
  assert.ok(tookSec < 120, `the run ended early (took ${tookSec.toFixed(0)} s of a 302 s profile)`);
  assert.equal(result.meta.k6.abortReason, 'db');
  assert.equal(result.ok, false);
  assert.equal(result.meta.interrupted, false, 'a DB abort is not a Ctrl+C');
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.k6.abortReason, 'db');
  assert.ok(existsSync(join(result.runDir, 'summary.json')), 'k6 stopped gracefully and wrote its summary');
});

test('a feature may not loosen the DB limit: 99 % is refused (project 95 %), nothing starts', async () => {
  const feature = await quickFeature(4);
  feature.workload.abort = { dbCpuOrIoPct: 99 };

  await assert.rejects(
    runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now: NOW, quiet: true, resourceSource: async () => calm() }),
    (err: unknown) => err instanceof ConfigError && /abort\.db_cpu_or_io_pct must be at most 95/.test(err.message),
  );
  await assert.rejects(
    runFeature({ project: 'selftest', feature: await quickFeature(4), env: 'local', profile: 'load', now: NOW, quiet: true, abortOverride: { dbCpuOrIoPct: 99 } }),
    (err: unknown) => err instanceof GuardrailError && err.code === 'ABORT_LOOSENED',
  );
  assert.deepEqual(await runDirs(), [], 'refused before the smoke: no run folder');
});

test('the DB guard uses the feature abort limit: 92 % stops the run when the feature says 90 %', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(300); // would hold for 5 minutes
  feature.workload.abort = { dbCpuOrIoPct: 90 };
  await primeSmoke(feature);
  const t0 = Date.now();
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 1) return calm();
    return Array.from({ length: calls - 1 }, (_, i) => sample(t0 + i * 15_000, 92)); // below the project's 95 %
  };

  const startedAt = Date.now();
  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now: NOW, quiet: true, resourceSource, dbPollMs: 400 });

  assert.ok((Date.now() - startedAt) / 1000 < 120, 'the run ended early');
  assert.equal(result.meta.k6.abortReason, 'db');
  assert.equal(result.meta.abort?.dbCpuOrIoPct, 90);
  assert.equal(result.meta.abort?.source.dbCpuOrIoPct, 'feature');
});

test('the DB guard uses the run option: 85 % stops the run when the override says 80 %', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(300); // would hold for 5 minutes
  await primeSmoke(feature);
  const t0 = Date.now();
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 1) return calm();
    return Array.from({ length: calls - 1 }, (_, i) => sample(t0 + i * 15_000, 85)); // below the project's 95 %
  };

  const startedAt = Date.now();
  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    resourceSource,
    dbPollMs: 400,
    abortOverride: { dbCpuOrIoPct: 80 },
  });

  assert.ok((Date.now() - startedAt) / 1000 < 120, 'the run ended early');
  assert.equal(result.meta.k6.abortReason, 'db');
  assert.equal(result.meta.abort?.dbCpuOrIoPct, 80);
  assert.equal(result.meta.abort?.source.dbCpuOrIoPct, 'override');
});

test('the same samples seen again on every poll are one set of samples, not an abort', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(4);
  await primeSmoke(feature);
  const t0 = Date.now();
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 1) return calm();
    return [sample(t0, 97), sample(t0 + 15_000, 97)]; // two hot samples, returned again and again by overlapping windows
  };

  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    resourceSource,
    dbPollMs: 200,
  });

  assert.ok(calls > 6, `the source was polled many times (${calls})`);
  assert.equal(result.exitCode, 0);
  assert.equal(result.meta.k6.abortReason, undefined);
  const db = await readJson(join(result.runDir, 'db.json'));
  assert.equal(db.resource.length, 2, 'db.json lists each sample once');
});

// ---------------------------------------------------------------------------------------------------------------
// db.json
// ---------------------------------------------------------------------------------------------------------------

test('db.json holds the window, the samples aligned to the time series, and the shared-DB caveat', { timeout: 120_000 }, async () => {
  const feature = await quickFeature();
  const t0 = Date.now();
  // A smoke is a few seconds: the source returns samples that fall in it.
  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'smoke',
    now: NOW,
    quiet: true,
    resourceSource: async () => [sample(t0 + 4000, 12.5), sample(t0 + 19_000, 30)],
  });

  const db = await readJson(join(result.runDir, 'db.json'));
  const ts = await readJson(join(result.runDir, 'timeseries.json'));
  assert.deepEqual(Object.keys(db).sort(), ['caveat', 'edition', 'evicted', 'missingIndexes', 'resource', 'tier', 'topStatements', 'window']);
  assert.equal(db.caveat, 'Shared database: other activity during the window is included.');
  assert.equal(db.tier, null, 'no database connection: no tier');
  assert.equal(db.edition, null);
  assert.deepEqual(db.topStatements, []);
  assert.deepEqual(db.missingIndexes, []);
  assert.equal(db.evicted, 0);
  assert.ok(Date.parse(db.window.from) <= Date.parse(db.window.to));
  assert.equal(db.resource.length, 2);
  assert.deepEqual(Object.keys(db.resource[0]).sort(), ['cpu', 'dataIo', 'endTime', 'logWrite', 't']);
  assert.equal(db.resource[0].cpu, 12.5);
  assert.equal(db.resource[0].t, (Date.parse(db.resource[0].endTime) - Date.parse(ts.origin)) / 1000);
});

// ---------------------------------------------------------------------------------------------------------------
// a project with a database (fake adapter)
// ---------------------------------------------------------------------------------------------------------------

/** A selftest copy whose adapter is `extra` on top of the env adapter, via a temp project dir with an adapter.ts. */
async function projectWithAdapter(extra: Partial<ProjectAdapter>, rowCountTables?: string[]): Promise<Project> {
  const dir = await tempDir('perf-fake-project-');
  await writeFile(join(dir, 'adapter.ts'), 'export default (project: unknown) => (globalThis as any).__perfFakeAdapter(project);\n');
  (globalThis as { __perfFakeAdapter?: unknown }).__perfFakeAdapter = (project: Project) => ({ ...createEnvAdapter(project), ...extra });
  const base = await loadProject('selftest');
  return { ...base, dir, ...(rowCountTables ? { rowCountTables } : {}) };
}

async function smokeOf(project: Project): Promise<{ meta: any; dbJson: any | null; runDir: string }> {
  return smokeOfWith(project, {});
}

async function smokeOfWith(
  project: Project,
  extra: Partial<Parameters<typeof runFeature>[0]>,
  expectOk = true,
): Promise<{ meta: any; dbJson: any | null; runDir: string }> {
  const feature = await loadFeature(await loadProject('selftest'), 'items');
  const result = await runFeature({ project, feature, env: 'local', profile: 'smoke', now: NOW, quiet: true, ...extra });
  assert.equal(result.ok, expectOk, expectOk ? 'the smoke passed' : 'the smoke failed');
  const dbFile = join(result.runDir, 'db.json');
  const dbJson = await readJson(dbFile).catch(() => null);
  return { meta: await readJson(join(result.runDir, 'meta.json')), dbJson, runDir: result.runDir };
}

interface FakeDbOptions {
  statsBefore?: unknown[];
  statsAfter?: unknown[];
  missing?: unknown[];
  queryStore?: unknown[];
  resource?: unknown[];
  fail?: RegExp;
  /** The n-th query-stats snapshot (1 = before, 2 = after) never answers. */
  hangOnSnapshot?: number;
}

/** A Knex stand-in that answers the collector's queries: the first query-stats call is the before snapshot, the second the after. */
function evidenceDb(opts: FakeDbOptions): { db: Knex; sqls: string[] } {
  const sqls: string[] = [];
  let snapshots = 0;
  const db = {
    raw: async (sql: string) => {
      sqls.push(sql);
      if (opts.fail?.test(sql)) throw Object.assign(new Error('Login failed for user "secret_user" on server secret.example'), { code: 'ELOGIN' });
      if (/dm_exec_query_stats/.test(sql)) {
        snapshots++;
        if (snapshots === opts.hangOnSnapshot) return new Promise(() => {}); // a hung connection
        return snapshots === 1 ? (opts.statsBefore ?? []) : (opts.statsAfter ?? []);
      }
      if (/dm_db_resource_stats/.test(sql)) return opts.resource ?? [];
      if (/ServiceObjective/.test(sql)) return [{ tier: 'S1', edition: 'SQL Azure' }];
      if (/dm_db_missing_index_details/.test(sql)) return opts.missing ?? [];
      if (/query_store_runtime_stats/.test(sql)) return opts.queryStore ?? [];
      throw new Error(`unexpected query: ${sql.slice(0, 50)}`);
    },
    destroy: async () => {},
  } as unknown as Knex;
  return { db, sqls };
}

const statRow = (planHandle: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  planHandle,
  startOffset: 0,
  endOffset: -1,
  text: 'select f.id from dbo.forms f join dbo.client c on c.id = f.client_id',
  executions: 10,
  elapsedUs: 10_000,
  cpuUs: 5000,
  logicalReads: 100,
  createdAt: new Date('2026-10-20T10:00:00Z'),
  ...over,
});

test('with a database: db.json has tier, top statements, missing indexes; no Query Store when the diff is whole', { timeout: 120_000 }, async () => {
  const { db } = evidenceDb({
    statsBefore: [statRow('0xA1'), statRow('0xB2', { text: 'select 1 from dbo.other' })],
    statsAfter: [
      statRow('0xA1', { executions: 40, elapsedUs: 70_000, cpuUs: 30_000, logicalReads: 700 }),
      statRow('0xB2', { text: 'select 1 from dbo.other' }),
    ],
    missing: [
      { statement: '[db].[dbo].[forms]', equalityColumns: '[client_id]', inequalityColumns: null, includedColumns: '[name]', avgUserImpact: 91.5, userSeeks: 12 },
      { statement: '[db].[dbo].[other]', equalityColumns: '[z]', inequalityColumns: null, includedColumns: null, avgUserImpact: 99, userSeeks: 99 },
    ],
    resource: [{ endTime: new Date(), cpu: 11, dataIo: 2, logWrite: 0 }],
  });
  const project = await projectWithAdapter({ db: async () => db });

  const { dbJson, meta } = await smokeOf(project);

  assert.equal(dbJson.tier, 'S1');
  assert.equal(dbJson.edition, 'SQL Azure');
  assert.equal(dbJson.evicted, 0);
  assert.equal(dbJson.topStatements.length, 1, 'only the statement that ran during the window');
  assert.equal(dbJson.topStatements[0].executions, 30);
  assert.equal(dbJson.topStatements[0].elapsedUs, 60_000);
  assert.equal(dbJson.topStatements[0].avgElapsedMs, 2);
  assert.deepEqual(
    dbJson.missingIndexes,
    [{ table: 'dbo.forms', equality: ['client_id'], inequality: [], included: ['name'], avgUserImpact: 91.5, userSeeks: 12 }],
    'only for tables the top statements read (dbo.forms, dbo.client)',
  );
  assert.equal(dbJson.queryStore, undefined);
  assert.equal(dbJson.resource.length, 1);
  assert.equal(meta.cleanup, undefined, 'no row_count_tables: no cleanup record');
});

test('Query Store is consulted when plans were evicted or nothing was cached', { timeout: 120_000 }, async () => {
  const storeRow = { queryId: 3, text: 'select 2', executions: 5, elapsedUs: 500, cpuUs: 400, logicalReads: 50, intervalStart: new Date('2026-10-24T11:00:00Z'), intervalEnd: new Date('2026-10-24T12:00:00Z') };

  const evicting = evidenceDb({ statsBefore: [statRow('0xA1'), statRow('0xB2')], statsAfter: [statRow('0xA1', { executions: 11, elapsedUs: 11_000 })], queryStore: [storeRow] });
  const evicted = await smokeOf(await projectWithAdapter({ db: async () => evicting.db }));
  assert.equal(evicted.dbJson.evicted, 1);
  assert.equal(evicted.dbJson.topStatements.length, 1);
  assert.equal(evicted.dbJson.queryStore.length, 1);
  assert.equal(evicted.dbJson.queryStore[0].queryId, 3);

  const empty = evidenceDb({ statsBefore: [statRow('0xA1')], statsAfter: [statRow('0xA1')], queryStore: [storeRow] });
  const nothing = await smokeOf(await projectWithAdapter({ db: async () => empty.db }));
  assert.equal(nothing.dbJson.evicted, 0);
  assert.deepEqual(nothing.dbJson.topStatements, []);
  assert.equal(nothing.dbJson.queryStore.length, 1);
});

test('evidence that cannot be read is noted in db.json without failing the run or leaking the error text', { timeout: 120_000 }, async () => {
  const { db } = evidenceDb({ fail: /dm_exec_query_stats|query_store|missing_index/ });
  const project = await projectWithAdapter({ db: async () => db });

  const { dbJson, meta } = await smokeOf(project);

  assert.equal(meta.k6.exitCode, 0);
  assert.equal(dbJson.tier, 'S1', 'what could be read is kept');
  assert.deepEqual(dbJson.topStatements, []);
  assert.ok(dbJson.errors.length >= 1);
  const text = JSON.stringify(dbJson);
  assert.ok(!text.includes('secret_user') && !text.includes('secret.example'), 'error messages (which can name users and servers) are not copied');
  assert.match(text, /ELOGIN/, 'the error code is');
});

test('row counts before and after: equal counts are ok', { timeout: 120_000 }, async () => {
  const seen: string[][] = [];
  const project = await projectWithAdapter(
    {
      rowCounts: async (_env, tables) => {
        seen.push(tables);
        return { forms: 120, client: 7 };
      },
    },
    ['forms', 'client'],
  );

  const { meta } = await smokeOf(project);

  assert.deepEqual(meta.cleanup, { before: { forms: 120, client: 7 }, after: { forms: 120, client: 7 }, ok: true });
  assert.deepEqual(seen, [['forms', 'client'], ['forms', 'client']], 'asked before and after, with the project tables');
});

test('row counts that moved are not ok: the smoke fails and unlocks no load', { timeout: 120_000 }, async () => {
  let n = 0;
  const project = await projectWithAdapter({ rowCounts: async () => ({ forms: 120 + n++ }) }, ['forms']);

  const { meta } = await smokeOfWith(project, {}, false);

  assert.deepEqual(meta.cleanup, { before: { forms: 120 }, after: { forms: 121 }, ok: false });
  assert.deepEqual(await readSmokeLedger(), {}, 'a smoke that left rows behind is not recorded as passed');

  const feature = await quickFeature();
  await assert.rejects(
    runFeature({ project, feature, env: 'local', profile: 'load', now: NOW, quiet: true }),
    (err: unknown) => err instanceof GuardrailError && err.code === 'SMOKE_REQUIRED' && /row counts changed/.test(err.message),
    'the smoke that comes first fails the same way, so the load is refused',
  );
});

test('a load that leaves rows behind fails (exit 1), though k6 itself passed', { timeout: 120_000 }, async () => {
  let moving = false;
  let n = 0;
  const project = await projectWithAdapter({ rowCounts: async () => ({ forms: moving ? 120 + n++ : 120 }) }, ['forms']);
  const feature = await quickFeature();
  const smoke = await runFeature({ project, feature, env: 'local', profile: 'smoke', now: NOW, quiet: true });
  assert.equal(smoke.ok, true, 'equal counts: the smoke passes and unlocks the load');

  moving = true;
  const load = await runFeature({ project, feature, env: 'local', profile: 'load', now: NOW, quiet: true });
  assert.equal(load.exitCode, 0, 'k6 passed');
  assert.equal(load.meta.cleanup!.ok, false);
  assert.equal(load.ok, false, 'leftover rows fail the run');
});

test('no tables, or an adapter without rowCounts: no cleanup record', { timeout: 120_000 }, async () => {
  const noTables = await smokeOf(await projectWithAdapter({ rowCounts: async () => ({ forms: 1 }) }));
  assert.equal(noTables.meta.cleanup, undefined);

  const noCounter = await smokeOf(await projectWithAdapter({}, ['forms']));
  assert.equal(noCounter.meta.cleanup, undefined);
  assert.equal(noCounter.dbJson, null, 'and without db() or a resource source there is no db.json');
});

test('row counts that cannot be read after the run are recorded as not ok', { timeout: 120_000 }, async () => {
  let n = 0;
  const project = await projectWithAdapter(
    {
      rowCounts: async () => {
        if (n++ === 0) return { forms: 5 };
        throw Object.assign(new Error('timeout talking to secret.example'), { code: 'ETIMEOUT' });
      },
    },
    ['forms'],
  );

  const { meta } = await smokeOfWith(project, {}, false);

  assert.equal(meta.cleanup.ok, false);
  assert.deepEqual(meta.cleanup.before, { forms: 5 });
  assert.equal(meta.cleanup.after, null);
  assert.match(meta.cleanup.error, /ETIMEOUT/);
  assert.ok(!JSON.stringify(meta).includes('secret.example'));
});

test('row counts that cannot be read before the run refuse it, before anything is sent', async () => {
  const project = await projectWithAdapter({ rowCounts: async () => Promise.reject(new Error('invalid table name "Forms"')) }, ['forms']);
  const feature = await loadFeature(await loadProject('selftest'), 'items');

  await assert.rejects(runFeature({ project, feature, env: 'local', profile: 'smoke', now: NOW, quiet: true }), /row counts/i);

  assert.deepEqual(await runDirs(), []);
});

test('the adapter is closed when the run ends', { timeout: 120_000 }, async () => {
  let closed = 0;
  const project = await projectWithAdapter({ close: async () => void closed++ });
  await smokeOf(project);
  assert.equal(closed, 1);
});

test('the connection and the adapter are released when the busy check refuses the run', async () => {
  let closed = 0;
  let destroyed = 0;
  const { db } = evidenceDb({ resource: [{ endTime: new Date(), cpu: 70, dataIo: 60, logWrite: 0 }] });
  (db as unknown as { destroy: () => Promise<void> }).destroy = async () => void destroyed++;
  const project = await projectWithAdapter({ db: async () => db, close: async () => void closed++ });
  const feature = await quickFeature();

  await assert.rejects(
    runFeature({ project, feature, env: 'local', profile: 'load', now: NOW, quiet: true }),
    (err: unknown) => err instanceof GuardrailError && err.code === 'ENV_BUSY' && /70/.test(err.message),
  );

  assert.equal(closed, 1);
  assert.equal(destroyed, 1);
  assert.deepEqual(await runDirs(), []);
});

// ---------------------------------------------------------------------------------------------------------------
// a guard that cannot see: failing or hanging polls
// ---------------------------------------------------------------------------------------------------------------

const timeoutError = (): Error => Object.assign(new Error('read ETIMEDOUT secret-host.example:1433'), { code: 'ETIMEOUT' });

test('polls that fail mid-run: the guard is blind, k6 is stopped with abortReason db, meta.json and the errors are written', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(300);
  await primeSmoke(feature);
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls <= 3) return calm(); // busy check, then two polls that work
    throw timeoutError();
  };

  const startedAt = Date.now();
  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    resourceSource,
    dbPollMs: 300,
    dbStepTimeoutMs: 1000,
  });

  assert.ok((Date.now() - startedAt) / 1000 < 120, 'the run ended early');
  assert.equal(result.meta.k6.abortReason, 'db');
  assert.equal(result.ok, false);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.k6.abortReason, 'db');
  assert.equal(meta.dbGuard.blindStop, true);
  assert.ok(meta.dbGuard.pollFailures >= 4);
  assert.equal(meta.dbGuard.lastError, 'ETIMEOUT');
  const db = await readJson(join(result.runDir, 'db.json'));
  const errors: string[] = db.errors;
  assert.ok(errors.some((e) => /abort watch blind: k6 stopped after 4 failed polls in a row \(last: ETIMEOUT\)/.test(e)), errors.join(' | '));
  assert.ok(errors.some((e) => /abort watch: \d+ of \d+ polls failed/.test(e)));
  assert.ok(!JSON.stringify([meta, db]).includes('secret-host'), 'the driver message (host name) is not copied');
});

test('a few failed polls are recorded, the guard recovers and the run completes', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(4);
  await primeSmoke(feature);
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 3 || calls === 4 || calls === 6) throw timeoutError(); // never 4 in a row
    return calm();
  };

  const result = await runFeature({ project: 'selftest', feature, env: 'local', profile: 'load', now: NOW, quiet: true, resourceSource, dbPollMs: 200 });

  assert.equal(result.exitCode, 0);
  assert.equal(result.meta.k6.abortReason, undefined);
  assert.equal(result.meta.dbGuard?.pollFailures, 3);
  assert.equal(result.meta.dbGuard?.blindStop, false);
  const db = await readJson(join(result.runDir, 'db.json'));
  assert.ok(db.errors.some((e: string) => /abort watch: 3 of \d+ polls failed \(last: ETIMEOUT\)/.test(e)), 'db.json shows it although the final read worked');
});

test('a poll that hangs counts as a failed poll; the hung final read is capped and the run still has its meta', { timeout: 120_000 }, async () => {
  const feature = await quickFeature(300);
  await primeSmoke(feature);
  let calls = 0;
  const resourceSource = async (): Promise<ResourceSample[]> => {
    calls++;
    if (calls === 1) return calm();
    return new Promise(() => {}); // never answers
  };

  const startedAt = Date.now();
  const result = await runFeature({
    project: 'selftest',
    feature,
    env: 'local',
    profile: 'load',
    now: NOW,
    quiet: true,
    resourceSource,
    dbPollMs: 300,
    dbStepTimeoutMs: 400,
  });

  assert.ok((Date.now() - startedAt) / 1000 < 60);
  assert.equal(result.meta.k6.abortReason, 'db');
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.dbGuard.blindStop, true);
  assert.match(meta.dbGuard.lastError, /^timed out after \d+(\.\d)? s$/, 'the longer it hangs, the longer the wait it reports');
  const db = await readJson(join(result.runDir, 'db.json'));
  assert.ok(db.errors.some((e: string) => /resource stats: timed out after 0\.4 s/.test(e)), 'the final read was capped too');
});

test('the DB watch fails closed: with no database limit resolved it stops k6 and throws instead of using a default', async () => {
  const project = structuredClone(await loadProject('selftest'));
  delete project.abort.dbCpuOrIoPct;
  const phase = await DbPhase.open({ resolveEnv: async () => Promise.reject(new Error('unused')) }, { env: 'local', project, resourceSource: async () => calm(), log: () => {} });
  const stops: string[] = [];
  const run = await phase!.begin();
  assert.throws(() => run.watch({ stop: (reason) => void stops.push(reason) }), /no database abort limit/);
  assert.deepEqual(stops, ['db'], 'k6 is stopped before the error');
});

interface WatchHarness {
  stops: string[];
  logs: string[];
  run: Awaited<ReturnType<DbPhase['begin']>>;
  dir: string;
}

/** A DbPhase over an injected resource source, begun and ready to watch a fake k6. */
async function watchHarness(resourceSource: () => Promise<ResourceSample[]>, pollMs: number): Promise<WatchHarness> {
  const logs: string[] = [];
  const phase = await DbPhase.open({ resolveEnv: async () => Promise.reject(new Error('unused')) }, {
    env: 'local',
    project: await loadProject('selftest'),
    resourceSource,
    pollMs,
    stepTimeoutMs: 500,
    log: (message) => logs.push(message),
  });
  assert.ok(phase);
  return { stops: [], logs, run: await phase.begin(), dir: await tempDir('perf-watch-') };
}

test('a k6 stop that throws is retried at the next poll and logged once it worked', async () => {
  const hot = (n: number): ResourceSample[] => Array.from({ length: 4 }, (_, i) => sample(1_000_000 + (n * 4 + i) * 15_000, 99));
  let polls = 0;
  const h = await watchHarness(async () => hot(polls++), 60);
  let attempts = 0;
  const end = h.run.watch({
    stop: (reason) => {
      attempts++;
      if (attempts === 1) throw new Error('kill EPERM');
      h.stops.push(reason);
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 500));
  end();
  await h.run.finish(h.dir, null);

  assert.equal(attempts, 2, 'retried once, then not again');
  assert.deepEqual(h.stops, ['db']);
  assert.equal(h.logs.filter((l) => /saturated/.test(l)).length, 1, 'logged once, after the stop worked');
  const db = await readJson(join(h.dir, 'db.json'));
  assert.ok(db.errors.some((e: string) => /stopping k6 failed \(kill EPERM\); retried/.test(e)));
});

test('the first failed poll is logged, the fourth in a row stops k6', async () => {
  const h = await watchHarness(async () => Promise.reject(timeoutError()), 50);
  const end = h.run.watch({ stop: (reason) => void h.stops.push(reason) });

  await new Promise((resolve) => setTimeout(resolve, 600));
  end();
  const { guard } = await h.run.finish(h.dir, null);

  assert.deepEqual(h.stops, ['db'], 'stopped exactly once');
  assert.equal(h.logs.filter((l) => /a poll failed \(ETIMEOUT\)/.test(l)).length, 1, 'the first failure is logged once');
  assert.ok(h.logs.some((l) => /abort guard is blind \(4 polls in a row failed, last: ETIMEOUT\)/.test(l)));
  assert.equal(guard?.blindStop, true);
  assert.ok(h.logs.every((l) => !l.includes('secret-host')));
});

// ---------------------------------------------------------------------------------------------------------------
// finish() never loses the run's results
// ---------------------------------------------------------------------------------------------------------------

test('a hung after-snapshot is capped, noted, and the run keeps its meta.json', { timeout: 120_000 }, async () => {
  const { db } = evidenceDb({ statsBefore: [statRow('0xA1')], hangOnSnapshot: 2, resource: [{ endTime: new Date(), cpu: 5, dataIo: 1, logWrite: 0 }] });
  const project = await projectWithAdapter({ db: async () => db, rowCounts: async () => ({ forms: 3 }) }, ['forms']);
  const feature = await loadFeature(await loadProject('selftest'), 'items');

  const startedAt = Date.now();
  const result = await runFeature({ project, feature, env: 'local', profile: 'smoke', now: NOW, quiet: true, dbStepTimeoutMs: 300 });

  assert.ok((Date.now() - startedAt) / 1000 < 30, 'finish gave up after its cap instead of waiting for the hung query');
  assert.equal(result.ok, true);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.cleanup.ok, true);
  const dbJson = await readJson(join(result.runDir, 'db.json'));
  assert.equal(dbJson.tier, 'S1', 'steps before the hang are kept');
  assert.equal(dbJson.resource.length, 1);
  assert.ok(dbJson.errors.includes('query stats after: timed out after 0.3 s'), dbJson.errors.join(' | '));
});

test('row counts that hang after the run give a cleanup that is not ok, and meta.json is still written', { timeout: 120_000 }, async () => {
  let n = 0;
  const { db } = evidenceDb({});
  const project = await projectWithAdapter(
    { db: async () => db, rowCounts: async () => (n++ === 0 ? { forms: 3 } : new Promise<Record<string, number>>(() => {})) },
    ['forms'],
  );

  const { meta, dbJson } = await smokeOfWith(project, { dbStepTimeoutMs: 300 }, false);

  assert.equal(meta.cleanup.ok, false);
  assert.equal(meta.cleanup.after, null);
  assert.match(meta.cleanup.error, /timed out after 0\.3 s/);
  assert.ok(dbJson.errors.includes('later database steps were skipped after a timeout'), 'one dead step does not cost a cap per remaining step');
});

test('a db.json that cannot be written does not lose meta.json or the row counts', { timeout: 120_000 }, async () => {
  let n = 0;
  const project = await projectWithAdapter(
    {
      rowCounts: async () => {
        if (n++ === 1) {
          // the second call comes from finish(), before db.json is written: make that path a folder so the write fails
          const runDir = (await runDirs()).find((d) => d.endsWith('_smoke'))!;
          await mkdir(join(root, runDir, 'db.json'));
        }
        return { forms: 3 };
      },
    },
    ['forms'],
  );
  const feature = await loadFeature(await loadProject('selftest'), 'items');

  const result = await runFeature({
    project,
    feature,
    env: 'local',
    profile: 'smoke',
    now: NOW,
    quiet: true,
    resourceSource: async () => [sample(Date.now(), 5)],
  });

  assert.equal(result.ok, true);
  const meta = await readJson(join(result.runDir, 'meta.json'));
  assert.equal(meta.cleanup.ok, true);
  assert.ok((await stat(join(result.runDir, 'db.json'))).isDirectory(), 'the write really failed');
});

test('a sample with an invalid time is left out instead of breaking finish', { timeout: 120_000 }, async () => {
  const result = await runFeature({
    project: 'selftest',
    feature: 'items',
    env: 'local',
    profile: 'smoke',
    now: NOW,
    quiet: true,
    resourceSource: async () => [{ endTime: new Date(NaN), cpu: 1, dataIo: 1, logWrite: 1 }, sample(Date.now(), 7)],
  });

  assert.equal(result.ok, true);
  const db = await readJson(join(result.runDir, 'db.json'));
  assert.equal(db.resource.length, 1);
  assert.equal(db.resource[0].cpu, 7);
});
