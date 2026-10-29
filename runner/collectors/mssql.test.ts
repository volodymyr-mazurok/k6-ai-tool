import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Knex } from 'knex';
import type { ResourceSample } from '../guardrails.js';
import {
  dbProfile,
  diffQueryStats,
  extractTables,
  latestResourceStats,
  missingIndexes,
  queryStoreTop,
  resourceStats,
  ResourcePoller,
  snapshotQueryStats,
  type QueryStat,
} from './mssql.js';

// ---------------------------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------------------------

const stat = (key: string, over: Partial<QueryStat> = {}): QueryStat => ({
  key,
  text: `select ${key}`,
  executions: 10,
  elapsedUs: 1000,
  cpuUs: 500,
  logicalReads: 100,
  createdAt: '2026-10-22T10:00:00.000Z',
  ...over,
});

interface Call {
  sql: string;
  bindings: unknown;
}

/** A Knex stand-in: `raw(sql, bindings)` answers with the rows of the first handler whose pattern is in the SQL. */
function fakeDb(handlers: [RegExp, unknown[] | Error][]): { db: Knex; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    raw: async (sql: string, bindings?: unknown) => {
      calls.push({ sql, bindings });
      for (const [pattern, answer] of handlers) {
        if (!pattern.test(sql)) continue;
        if (answer instanceof Error) throw answer;
        return answer;
      }
      throw new Error(`fakeDb: no handler for ${sql.slice(0, 60)}`);
    },
  } as unknown as Knex;
  return { db, calls };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------------------------------------------
// diffQueryStats
// ---------------------------------------------------------------------------------------------------------------

test('diff keeps only growth during the run', () => {
  const before = [stat('A', { executions: 10, elapsedUs: 1000, cpuUs: 500, logicalReads: 100 }), stat('B')];
  const after = [stat('A', { executions: 15, elapsedUs: 4000, cpuUs: 900, logicalReads: 160 }), stat('B')];

  const { top, evicted } = diffQueryStats(before, after);

  assert.equal(evicted, 0);
  assert.equal(top.length, 1, 'B did not run during the window, so it is dropped');
  assert.deepEqual(top[0], {
    key: 'A',
    text: 'select A',
    executions: 5,
    elapsedUs: 3000,
    cpuUs: 400,
    logicalReads: 60,
    avgElapsedMs: 0.6,
  });
});

test('statements new in after count fully', () => {
  const before = [stat('A')];
  const after = [stat('A'), stat('C', { executions: 3, elapsedUs: 9000, cpuUs: 8000, logicalReads: 700 })];

  const { top, evicted } = diffQueryStats(before, after);

  assert.equal(evicted, 0);
  assert.deepEqual(
    top.map((d) => [d.key, d.executions, d.elapsedUs, d.cpuUs, d.logicalReads]),
    [['C', 3, 9000, 8000, 700]],
  );
  assert.equal(top[0]!.avgElapsedMs, 3);
});

test('evicted counts vanished keys', () => {
  const before = [stat('A'), stat('D'), stat('E')];
  const after = [stat('A')];

  const { top, evicted } = diffQueryStats(before, after);

  assert.equal(evicted, 2);
  assert.deepEqual(top, []);
});

test('diff sorts by elapsed time and keeps the top 10', () => {
  const after = Array.from({ length: 12 }, (_, i) => stat(`S${i}`, { elapsedUs: (i + 1) * 100, executions: 1 }));

  const { top } = diffQueryStats([], after);

  assert.equal(top.length, 10);
  assert.deepEqual(
    top.map((d) => d.elapsedUs),
    [1200, 1100, 1000, 900, 800, 700, 600, 500, 400, 300],
  );
});

test('a statement whose counters went down (plan rebuilt) counts fully', () => {
  const before = [stat('A', { executions: 50, elapsedUs: 50_000 })];
  const after = [stat('A', { executions: 2, elapsedUs: 800, cpuUs: 100, logicalReads: 9 })];

  const { top } = diffQueryStats(before, after);

  assert.deepEqual(
    top.map((d) => [d.executions, d.elapsedUs, d.cpuUs, d.logicalReads]),
    [[2, 800, 100, 9]],
  );
});

// ---------------------------------------------------------------------------------------------------------------
// extractTables
// ---------------------------------------------------------------------------------------------------------------

test('extractTables finds dbo.forms and [dbo].[client]', () => {
  const tables = extractTables([
    'select * from dbo.forms f where f.id = @p0',
    'SELECT c.id FROM [dbo].[client] AS c INNER JOIN [dbo].[form_applicants] fa ON fa.client_id = c.id',
    'select n.id from notifications n left join dbo.Forms f on f.id = n.form_id',
  ]);

  assert.deepEqual(tables, ['dbo.client', 'dbo.form_applicants', 'dbo.forms', 'dbo.notifications']);
});

test('extractTables ignores system views, temp tables, sub-selects and functions, and keeps other schemas', () => {
  const tables = extractTables([
    'select * from sys.dm_exec_query_stats qs join INFORMATION_SCHEMA.TABLES t on 1 = 1',
    'select * from #tmp t join @vars v on 1 = 1',
    'select * from (select id from dbo.forms) x',
    'select value from string_split(@p0, \',\') join dbo.users u on 1 = 1',
    'select * from [reporting].[daily_totals] join [perf_db].[dbo].[clients] on 1 = 1',
    '',
  ]);

  assert.deepEqual(tables, ['dbo.clients', 'dbo.forms', 'dbo.users', 'reporting.daily_totals']);
});

// ---------------------------------------------------------------------------------------------------------------
// collectors against a fake connection
// ---------------------------------------------------------------------------------------------------------------

test('snapshotQueryStats maps rows: key from plan handle and offsets, numbers from bigints, text cut at 2000', async () => {
  const { db, calls } = fakeDb([
    [
      /dm_exec_query_stats/,
      [
        {
          planHandle: '0x0600',
          startOffset: 0,
          endOffset: 120,
          text: 'x'.repeat(2500),
          executions: '7',
          elapsedUs: '123456789012',
          cpuUs: '99',
          logicalReads: '1000',
          createdAt: new Date('2026-10-22T09:00:00Z'),
        },
        {
          planHandle: '0x0700',
          startOffset: 4,
          endOffset: -1,
          text: null,
          executions: 1,
          elapsedUs: 5,
          cpuUs: 5,
          logicalReads: 5,
          createdAt: new Date('2026-10-22T09:30:00Z'),
        },
      ],
    ],
  ]);

  const stats = await snapshotQueryStats(db);

  assert.equal(calls.length, 1);
  assert.equal(stats.length, 2);
  assert.equal(stats[0]!.key, '0x0600:0:120');
  assert.equal(stats[0]!.text.length, 2000);
  assert.equal(stats[0]!.executions, 7);
  assert.equal(stats[0]!.elapsedUs, 123456789012);
  assert.equal(stats[0]!.createdAt, '2026-10-22T09:00:00.000Z');
  assert.equal(stats[1]!.key, '0x0700:4:-1');
  assert.equal(stats[1]!.text, '', 'a missing text is an empty string');
});

test('resourceStats and latestResourceStats map rows to samples; a missing percentage is NaN, never 0', async () => {
  const rows = [
    { endTime: new Date('2026-10-22T10:00:15Z'), cpu: '12.5', dataIo: 3, logWrite: '0.5' },
    { endTime: new Date('2026-10-22T10:00:30Z'), cpu: null, dataIo: null, logWrite: null },
  ];
  const { db, calls } = fakeDb([[/dm_db_resource_stats/, rows]]);
  const from = new Date('2026-10-22T10:00:00Z');
  const to = new Date('2026-10-22T10:01:00Z');

  const window = await resourceStats(db, from, to);
  const latest = await latestResourceStats(db, 5);
  const defaulted = await latestResourceStats(db);

  assert.deepEqual(window[0], { endTime: new Date('2026-10-22T10:00:15Z'), cpu: 12.5, dataIo: 3, logWrite: 0.5 });
  assert.ok(Number.isNaN(window[1]!.cpu) && Number.isNaN(window[1]!.dataIo) && Number.isNaN(window[1]!.logWrite));
  assert.equal(latest.length, 2);
  assert.equal(defaulted.length, 2);
  assert.deepEqual(calls[0]!.bindings, [from, to]);
  assert.deepEqual(calls[1]!.bindings, [5]);
  assert.deepEqual(calls[2]!.bindings, [5], 'the default window is 5 minutes');
});

test('missingIndexes keeps the given tables, splits the column lists and sorts by impact x seeks', async () => {
  const { db, calls } = fakeDb([
    [
      /dm_db_missing_index_details/,
      [
        { statement: '[perf].[dbo].[forms]', equalityColumns: '[client_id], [status]', inequalityColumns: null, includedColumns: '[name]', avgUserImpact: '97.5', userSeeks: '42' },
        { statement: '[perf].[dbo].[other]', equalityColumns: '[x]', inequalityColumns: null, includedColumns: null, avgUserImpact: 99, userSeeks: 1000 },
        { statement: '[perf].[dbo].[client]', equalityColumns: null, inequalityColumns: '[created_at]', includedColumns: '[a], [b]', avgUserImpact: 50, userSeeks: 100 },
      ],
    ],
  ]);

  const found = await missingIndexes(db, ['forms', 'dbo.Client']);

  assert.deepEqual(found, [
    { table: 'dbo.client', equality: [], inequality: ['created_at'], included: ['a', 'b'], avgUserImpact: 50, userSeeks: 100 },
    { table: 'dbo.forms', equality: ['client_id', 'status'], inequality: [], included: ['name'], avgUserImpact: 97.5, userSeeks: 42 },
  ]);
  assert.equal(calls.length, 1);

  const none = await missingIndexes(db, []);
  assert.deepEqual(none, []);
  assert.equal(calls.length, 1, 'no tables: nothing to look up, no query sent');
});

test('dbProfile reads the service objective and edition', async () => {
  const { db } = fakeDb([[/ServiceObjective/, [{ tier: 'S1', edition: 'SQL Azure' }]]]);
  assert.deepEqual(await dbProfile(db), { tier: 'S1', edition: 'SQL Azure' });

  const { db: bare } = fakeDb([[/ServiceObjective/, [{ tier: null, edition: null }]]]);
  assert.deepEqual(await dbProfile(bare), { tier: null, edition: null });
});

test('queryStoreTop maps the busiest statements of the window', async () => {
  const { db, calls } = fakeDb([
    [
      /query_store_runtime_stats/,
      [
        {
          queryId: '17',
          text: 'select 1',
          executions: '40',
          elapsedUs: '800000',
          cpuUs: '600000',
          logicalReads: '5000',
          intervalStart: new Date('2026-10-22T10:00:00Z'),
          intervalEnd: new Date('2026-10-22T11:00:00Z'),
        },
      ],
    ],
  ]);
  const from = new Date('2026-10-22T10:10:00Z');
  const to = new Date('2026-10-22T10:20:00Z');

  const top = await queryStoreTop(db, from, to, 3);

  assert.deepEqual(top, [
    {
      queryId: 17,
      text: 'select 1',
      executions: 40,
      elapsedUs: 800000,
      cpuUs: 600000,
      logicalReads: 5000,
      intervalStart: '2026-10-22T10:00:00.000Z',
      intervalEnd: '2026-10-22T11:00:00.000Z',
    },
  ]);
  assert.deepEqual(calls[0]!.bindings, [from, to, 3]);
});

// ---------------------------------------------------------------------------------------------------------------
// ResourcePoller
// ---------------------------------------------------------------------------------------------------------------

const sample = (sec: number): ResourceSample => ({ endTime: new Date(Date.UTC(2026, 9, 22, 10, 0, sec)), cpu: 1, dataIo: 1, logWrite: 1 });

test('ResourcePoller polls on its interval, passes the samples on and stops', async () => {
  let calls = 0;
  const seen: number[] = [];
  const poller = new ResourcePoller(async () => [sample(++calls)], 20);
  poller.start((samples) => seen.push(samples.length));

  await sleep(130);
  poller.stop();
  const after = calls;
  await sleep(80);

  assert.ok(after >= 3, `polled at least 3 times in 130 ms (got ${after})`);
  assert.equal(calls, after, 'no poll after stop()');
  assert.equal(seen.length, after);
});

test('ResourcePoller survives a failing source and never overlaps two polls', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  let calls = 0;
  let delivered = 0;
  const poller = new ResourcePoller(async () => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    calls++;
    await sleep(50); // slower than the interval
    inFlight--;
    if (calls === 1) throw new Error('db hiccup');
    return [sample(calls)];
  }, 10, 1000); // slow, but not slow enough to be a timeout
  poller.start(() => delivered++);

  await sleep(300);
  poller.stop();

  assert.equal(maxInFlight, 1, 'a slow poll is not started again on top of itself');
  assert.ok(calls >= 3);
  assert.ok(delivered >= 1, 'polling went on after the first poll failed');
  assert.match(poller.lastError ?? '', /db hiccup|Error/);
});

test('ResourcePoller drops the result of a poll that finishes after stop()', async () => {
  let delivered = 0;
  const poller = new ResourcePoller(async () => {
    await sleep(60);
    return [sample(1)];
  }, 10);
  poller.start(() => delivered++);
  await sleep(30);
  poller.stop();
  await sleep(150);

  assert.equal(delivered, 0);
});

test('ResourcePoller counts failed polls, reports the streak and resets it on a success', async () => {
  let calls = 0;
  const failures: [string, number, number][] = [];
  let delivered = 0;
  // fail, fail, work, fail: streaks of 2 then 1
  const poller = new ResourcePoller(async () => {
    calls++;
    if (calls === 1 || calls === 2 || calls === 4) throw Object.assign(new Error('read ETIMEDOUT db-host.example'), { code: 'ETIMEOUT' });
    return [sample(calls)];
  }, 15);
  poller.start(
    () => delivered++,
    (f) => failures.push([f.error, f.consecutive, f.total]),
  );

  await sleep(150);
  poller.stop();

  assert.deepEqual(failures.slice(0, 3), [
    ['ETIMEOUT', 1, 1],
    ['ETIMEOUT', 2, 2],
    ['ETIMEOUT', 1, 3],
  ]);
  assert.equal(poller.failures, 3);
  assert.equal(poller.consecutiveFailures, 0, 'later polls worked');
  assert.equal(poller.lastError, 'ETIMEOUT', 'the code, not the message with the host name');
  assert.ok(poller.polls >= 5);
  assert.ok(delivered >= 2);
});

test('ResourcePoller counts a hung poll as a failure at every tick without starting another query', async () => {
  let calls = 0;
  const errors: string[] = [];
  const poller = new ResourcePoller(
    () => {
      calls++;
      return new Promise<ResourceSample[]>(() => {}); // never answers
    },
    10,
    25,
  );
  poller.start(
    () => assert.fail('no samples ever arrive'),
    (f) => errors.push(f.error),
  );

  await sleep(200);
  poller.stop();

  assert.equal(calls, 1, 'one outstanding query, not one per tick');
  assert.ok(errors.length >= 3, `failures keep counting while it hangs (${errors.length})`);
  assert.ok(errors.every((e) => /^timed out after \d+(\.\d)? s$/.test(e)), errors.join(','));
  assert.equal(poller.consecutiveFailures, errors.length);
});

test('ResourcePoller still delivers an answer that arrives after its timeout, and the streak ends', async () => {
  let delivered = 0;
  let calls = 0;
  const poller = new ResourcePoller(async () => {
    calls++;
    await sleep(calls === 1 ? 70 : 0);
    return [sample(calls)];
  }, 10, 30);
  poller.start(() => delivered++);

  await sleep(200);
  poller.stop();

  assert.ok(poller.failures >= 1, 'the slow answer was a failed poll at some tick');
  assert.ok(delivered >= 1, 'but it was delivered when it came');
  assert.equal(poller.consecutiveFailures, 0);
});
