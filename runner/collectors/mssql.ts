// Evidence from the project's SQL Server (Azure SQL Database) for the "why is it slow" part of a report. Every query
// here only reads: DMVs and Query Store views, nothing that changes a setting or a plan. The database is shared, so all
// of it describes the database as a whole, not just the traffic of the run.
//
//   snapshotQueryStats + diffQueryStats   what the plan cache saw run between two moments (before and after the run)
//   resourceStats / latestResourceStats   sys.dm_db_resource_stats, one sample every 15 s (percent of the tier's limits)
//   missingIndexes                        indexes the optimizer wished for on the tables the slow statements read
//   queryStoreTop                         the same question answered from Query Store, when the plan cache lost the data
//   ResourcePoller                        feeds the DB abort rule while k6 runs

import type { Knex } from 'knex';
import type { ResourceSample } from '../guardrails.js';

/** One statement of the plan cache: cumulative counters since its plan was cached. `key` is stable while the plan lives. */
export interface QueryStat {
  /** plan_handle (hex) + statement start/end offsets: one cached statement. */
  key: string;
  /** The statement, at most 2000 characters. */
  text: string;
  executions: number;
  /** Total elapsed time, microseconds. */
  elapsedUs: number;
  /** Total CPU time, microseconds. */
  cpuUs: number;
  logicalReads: number;
  /** When the plan was cached (ISO, UTC). */
  createdAt: string;
}

/** What one statement did between two snapshots. */
export interface QueryStatDelta {
  key: string;
  text: string;
  executions: number;
  elapsedUs: number;
  cpuUs: number;
  logicalReads: number;
  /** elapsedUs / executions, in ms (3 decimals). */
  avgElapsedMs: number;
}

export interface MissingIndex {
  /** `schema.table`, lower-case. */
  table: string;
  equality: string[];
  inequality: string[];
  included: string[];
  /** Percent the optimizer expects queries to improve by (0..100). */
  avgUserImpact: number;
  userSeeks: number;
}

/**
 * One statement from Query Store, totalled over the intervals that overlap the window. Query Store keeps one row per
 * interval (60 minutes here), so these numbers cover whole intervals, `intervalStart`..`intervalEnd`, not just the run.
 */
export interface QueryStoreStat {
  queryId: number;
  text: string;
  executions: number;
  elapsedUs: number;
  cpuUs: number;
  logicalReads: number;
  intervalStart: string;
  intervalEnd: string;
}

export interface DbProfile {
  /** Azure SQL service objective, e.g. `S1`; null when the server does not report one. */
  tier: string | null;
  edition: string | null;
}

const TEXT_LIMIT = 2000;

const num = (value: unknown): number => (value === null || value === undefined ? NaN : Number(value));
const count = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const iso = (value: unknown): string => {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
};

/**
 * A short, safe description of a failed database call for logs and result files. A driver error is reduced to its code
 * (and SQL error number), because its message can name the server, the database or the login; an error without a code
 * (ours, or knex's own) keeps its message, cut at 200 characters.
 */
export function describeDbError(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const { code, number } = err as { code?: unknown; number?: unknown };
    if (typeof code === 'string' && code) return typeof number === 'number' ? `${code} ${number}` : code;
    if (typeof number === 'number') return `SQL error ${number}`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return message.split('\n')[0]!.slice(0, 200) || 'unknown error';
}

/** `db.raw` answers with the rows (the mssql dialect); a `{ recordset }` shape is read too. */
async function rows(db: Knex, sql: string, bindings: readonly unknown[] = []): Promise<Record<string, unknown>[]> {
  const result = (await db.raw(sql, bindings as Knex.RawBinding[])) as unknown;
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const recordset = (result as { recordset?: unknown } | null)?.recordset;
  return Array.isArray(recordset) ? (recordset as Record<string, unknown>[]) : [];
}

// ---------------------------------------------------------------------------------------------------------------
// plan cache
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every statement in the plan cache with its cumulative counters. Our own collector queries and other DMV/Query Store
 * reads are left out: they would only add noise to the top list.
 */
export async function snapshotQueryStats(db: Knex): Promise<QueryStat[]> {
  const result = await rows(
    db,
    `SELECT
       CONVERT(varchar(130), qs.plan_handle, 1) AS planHandle,
       qs.statement_start_offset AS startOffset,
       qs.statement_end_offset AS endOffset,
       LEFT(SUBSTRING(st.text, (qs.statement_start_offset / 2) + 1,
         ((CASE qs.statement_end_offset WHEN -1 THEN DATALENGTH(st.text) ELSE qs.statement_end_offset END
           - qs.statement_start_offset) / 2) + 1), ${TEXT_LIMIT}) AS text,
       qs.execution_count AS executions,
       qs.total_elapsed_time AS elapsedUs,
       qs.total_worker_time AS cpuUs,
       qs.total_logical_reads AS logicalReads,
       qs.creation_time AS createdAt
     FROM sys.dm_exec_query_stats AS qs
     CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) AS st
     WHERE st.text NOT LIKE '%sys.dm[_]%' AND st.text NOT LIKE '%sys.query[_]store%'`,
  );
  return result.map((row) => ({
    key: `${String(row.planHandle)}:${count(row.startOffset)}:${count(row.endOffset)}`,
    text: row.text === null || row.text === undefined ? '' : String(row.text).slice(0, TEXT_LIMIT),
    executions: count(row.executions),
    elapsedUs: count(row.elapsedUs),
    cpuUs: count(row.cpuUs),
    logicalReads: count(row.logicalReads),
    createdAt: iso(row.createdAt),
  }));
}

/**
 * What ran between two snapshots: the growth of every statement present in both, the full counters of those only in
 * `after` (cached during the run), without the ones that did not execute, busiest first by elapsed time, `topN` of them.
 * A statement whose counters went down was recompiled under the same key, so `after` counts in full.
 * `evicted` counts statements in `before` that are gone from `after`: their work during the run is lost to this method.
 */
export function diffQueryStats(before: QueryStat[], after: QueryStat[], topN = 10): { top: QueryStatDelta[]; evicted: number } {
  const earlier = new Map(before.map((s) => [s.key, s]));
  const present = new Set<string>();
  const deltas: QueryStatDelta[] = [];
  for (const now of after) {
    present.add(now.key);
    const then = earlier.get(now.key);
    const grew = then !== undefined && now.executions >= then.executions;
    const executions = grew ? now.executions - then.executions : now.executions;
    if (executions <= 0) continue;
    const elapsedUs = grew ? now.elapsedUs - then.elapsedUs : now.elapsedUs;
    deltas.push({
      key: now.key,
      text: now.text,
      executions,
      elapsedUs,
      cpuUs: grew ? now.cpuUs - then.cpuUs : now.cpuUs,
      logicalReads: grew ? now.logicalReads - then.logicalReads : now.logicalReads,
      avgElapsedMs: Math.round((elapsedUs / executions / 1000) * 1000) / 1000,
    });
  }
  deltas.sort((a, b) => b.elapsedUs - a.elapsedUs || b.executions - a.executions || a.key.localeCompare(b.key));
  return { top: deltas.slice(0, topN), evicted: before.filter((s) => !present.has(s.key)).length };
}

// ---------------------------------------------------------------------------------------------------------------
// resource use
// ---------------------------------------------------------------------------------------------------------------

const RESOURCE_COLUMNS = `end_time AS endTime, avg_cpu_percent AS cpu, avg_data_io_percent AS dataIo, avg_log_write_percent AS logWrite`;

function toSample(row: Record<string, unknown>): ResourceSample {
  return { endTime: row.endTime instanceof Date ? row.endTime : new Date(String(row.endTime)), cpu: num(row.cpu), dataIo: num(row.dataIo), logWrite: num(row.logWrite) };
}

/** The 15 s samples of `sys.dm_db_resource_stats` that ended in `from`..`to`, oldest first. A missing percentage is NaN. */
export async function resourceStats(db: Knex, from: Date, to: Date): Promise<ResourceSample[]> {
  const result = await rows(
    db,
    `SELECT ${RESOURCE_COLUMNS} FROM sys.dm_db_resource_stats WHERE end_time >= ? AND end_time <= ? ORDER BY end_time`,
    [from, to],
  );
  return result.map(toSample);
}

/** The samples of the last `minutes`, by the database's own clock (the busy check reads this). */
export async function latestResourceStats(db: Knex, minutes = 5): Promise<ResourceSample[]> {
  const result = await rows(
    db,
    `SELECT ${RESOURCE_COLUMNS} FROM sys.dm_db_resource_stats WHERE end_time >= DATEADD(MINUTE, -?, SYSUTCDATETIME()) ORDER BY end_time`,
    [minutes],
  );
  return result.map(toSample);
}

// ---------------------------------------------------------------------------------------------------------------
// tables and missing indexes
// ---------------------------------------------------------------------------------------------------------------

/** One identifier: `[bracketed]`, `"quoted"` or a bare word (not starting with # or @, so temp tables and variables never match). */
const IDENT = String.raw`(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_][\w$]*)`;
const TABLE_REF = new RegExp(String.raw`\b(?:from|join)\s+(${IDENT}(?:\s*\.\s*${IDENT}){0,2})(\s*\()?`, 'gi');
const IDENT_G = new RegExp(IDENT, 'g');
const SYSTEM_SCHEMAS = new Set(['sys', 'information_schema']);

const unquote = (ident: string): string => (ident.startsWith('[') || ident.startsWith('"') ? ident.slice(1, -1) : ident);

/** `schema.table` (lower-case) from a one-, two- or three-part name; a bare name is in `dbo`. */
function qualified(name: string): string | null {
  const parts = (name.match(IDENT_G) ?? []).map(unquote);
  if (parts.length === 0) return null;
  const table = parts[parts.length - 1]!;
  const schema = parts.length >= 2 ? parts[parts.length - 2]! : 'dbo';
  return `${schema}.${table}`.toLowerCase();
}

/**
 * The tables the statements read: `dbo.x`, `[dbo].[x]` or a bare name after FROM or JOIN, as sorted unique lower-case
 * `schema.table` (a bare name is in `dbo`). System views, temp tables, table variables, sub-selects and table functions
 * are skipped.
 */
export function extractTables(statements: string[]): string[] {
  const found = new Set<string>();
  for (const statement of statements) {
    for (const match of statement.matchAll(TABLE_REF)) {
      if (match[2]) continue; // string_split(...), OPENJSON(...): a function, not a table
      const table = qualified(match[1]!);
      if (table && !SYSTEM_SCHEMAS.has(table.split('.')[0]!)) found.add(table);
    }
  }
  return [...found].sort();
}

const columnList = (text: unknown): string[] =>
  text === null || text === undefined
    ? []
    : String(text)
        .split(',')
        .map((c) => c.trim().replace(/^\[|\]$/g, ''))
        .filter((c) => c !== '');

/**
 * The optimizer's missing-index suggestions for `tables` (`dbo.forms`, or a bare `forms` meaning `dbo.forms`), the most
 * valuable first (impact x seeks). The DMV is cumulative since the server last started, so a suggestion is a hint about
 * the table, not proof about this run.
 */
export async function missingIndexes(db: Knex, tables: string[]): Promise<MissingIndex[]> {
  const wanted = new Set(tables.map((t) => qualified(t)).filter((t): t is string => t !== null));
  if (wanted.size === 0) return [];
  const result = await rows(
    db,
    `SELECT d.statement AS statement, d.equality_columns AS equalityColumns, d.inequality_columns AS inequalityColumns,
            d.included_columns AS includedColumns, gs.avg_user_impact AS avgUserImpact, gs.user_seeks AS userSeeks
     FROM sys.dm_db_missing_index_details AS d
     JOIN sys.dm_db_missing_index_groups AS g ON g.index_handle = d.index_handle
     JOIN sys.dm_db_missing_index_group_stats AS gs ON gs.group_handle = g.index_group_handle
     WHERE d.database_id = DB_ID()
     ORDER BY gs.avg_user_impact * gs.user_seeks DESC`,
  );
  const found: MissingIndex[] = [];
  for (const row of result) {
    const table = qualified(String(row.statement));
    if (!table || !wanted.has(table)) continue;
    found.push({
      table,
      equality: columnList(row.equalityColumns),
      inequality: columnList(row.inequalityColumns),
      included: columnList(row.includedColumns),
      avgUserImpact: count(row.avgUserImpact),
      userSeeks: count(row.userSeeks),
    });
  }
  return found.sort((a, b) => b.avgUserImpact * b.userSeeks - a.avgUserImpact * a.userSeeks);
}

// ---------------------------------------------------------------------------------------------------------------
// Query Store and the database itself
// ---------------------------------------------------------------------------------------------------------------

/**
 * The `n` statements with the most elapsed time in the Query Store intervals that overlap `from`..`to`. Only for when the
 * plan cache cannot answer (statements evicted, or nothing cached); the intervals are coarse (see QueryStoreStat).
 */
export async function queryStoreTop(db: Knex, from: Date, to: Date, n = 10): Promise<QueryStoreStat[]> {
  const result = await rows(
    db,
    `SELECT q.query_id AS queryId, MAX(LEFT(qt.query_sql_text, ${TEXT_LIMIT})) AS text,
            SUM(rs.count_executions) AS executions,
            SUM(rs.count_executions * rs.avg_duration) AS elapsedUs,
            SUM(rs.count_executions * rs.avg_cpu_time) AS cpuUs,
            SUM(rs.count_executions * rs.avg_logical_io_reads) AS logicalReads,
            MIN(i.start_time) AS intervalStart, MAX(i.end_time) AS intervalEnd
     FROM sys.query_store_runtime_stats AS rs
     JOIN sys.query_store_runtime_stats_interval AS i ON i.runtime_stats_interval_id = rs.runtime_stats_interval_id
     JOIN sys.query_store_plan AS p ON p.plan_id = rs.plan_id
     JOIN sys.query_store_query AS q ON q.query_id = p.query_id
     JOIN sys.query_store_query_text AS qt ON qt.query_text_id = q.query_text_id
     WHERE i.end_time >= ? AND i.start_time <= ?
       AND qt.query_sql_text NOT LIKE '%sys.dm[_]%' AND qt.query_sql_text NOT LIKE '%sys.query[_]store%'
     GROUP BY q.query_id
     ORDER BY SUM(rs.count_executions * rs.avg_duration) DESC
     OFFSET 0 ROWS FETCH NEXT ? ROWS ONLY`,
    [from, to, n],
  );
  return result.map((row) => ({
    queryId: count(row.queryId),
    text: row.text === null || row.text === undefined ? '' : String(row.text).slice(0, TEXT_LIMIT),
    executions: count(row.executions),
    elapsedUs: count(row.elapsedUs),
    cpuUs: count(row.cpuUs),
    logicalReads: count(row.logicalReads),
    intervalStart: iso(row.intervalStart),
    intervalEnd: iso(row.intervalEnd),
  }));
}

/** The database's service objective (tier, e.g. `S1`) and edition. */
export async function dbProfile(db: Knex): Promise<DbProfile> {
  const [row] = await rows(
    db,
    `SELECT CAST(DATABASEPROPERTYEX(DB_NAME(), 'ServiceObjective') AS varchar(100)) AS tier,
            CAST(SERVERPROPERTY('Edition') AS varchar(100)) AS edition`,
  );
  const text = (value: unknown): string | null => (value === null || value === undefined || value === '' ? null : String(value));
  return { tier: text(row?.tier), edition: text(row?.edition) };
}

// ---------------------------------------------------------------------------------------------------------------
// polling while k6 runs
// ---------------------------------------------------------------------------------------------------------------

/** A failed poll, as `ResourcePoller` reports it. */
export interface PollFailure {
  /** See describeDbError. A poll that took longer than the poll timeout reads `timed out after N s`. */
  error: string;
  /** Failed polls in a row, this one included. */
  consecutive: number;
  /** Failed polls so far. */
  total: number;
}

/**
 * Calls `source` every `intervalMs` (15 s: the rate of sys.dm_db_resource_stats) and hands what it returns to the callback.
 * Only one call is ever outstanding, so a hung connection is not piled up with queries. A tick that finds the previous
 * call still unanswered after `timeoutMs` (default the interval) counts as a failed poll, and so does every later tick
 * until it answers: the caller learns that its guard cannot see (`onFailure`, `failures`, `consecutiveFailures`,
 * `lastError`) and decides what that is worth. Polling goes on after a failure; a late answer is still delivered; a result
 * that arrives after stop() is dropped.
 */
export class ResourcePoller {
  /** Why the most recent failed poll failed; stays set after later polls work. */
  lastError: string | undefined;
  /** Polls that ended (worked or failed). */
  polls = 0;
  failures = 0;
  consecutiveFailures = 0;
  private timer: NodeJS.Timeout | undefined;
  /** The source call that has not answered yet, and when it started. */
  private inFlight: { startedAt: number } | undefined;
  private stopped = false;
  private onSamples: (samples: ResourceSample[]) => void = () => {};
  private onFailure: ((failure: PollFailure) => void) | undefined;

  constructor(
    private readonly source: () => Promise<ResourceSample[]>,
    private readonly intervalMs = 15_000,
    private readonly timeoutMs = intervalMs,
  ) {}

  start(onSamples: (samples: ResourceSample[]) => void, onFailure?: (failure: PollFailure) => void): void {
    if (this.timer || this.stopped) throw new Error('a ResourcePoller starts once');
    this.onSamples = onSamples;
    this.onFailure = onFailure;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.inFlight) {
      const waitedMs = Date.now() - this.inFlight.startedAt;
      if (waitedMs >= this.timeoutMs) this.fail(new Error(`timed out after ${Math.round(waitedMs / 100) / 10} s`));
      return;
    }
    const call = { startedAt: Date.now() };
    this.inFlight = call;
    Promise.resolve()
      .then(() => this.source())
      .then(
        (samples) => {
          this.inFlight = undefined;
          if (this.stopped) return;
          this.polls++;
          this.consecutiveFailures = 0;
          try {
            this.onSamples(samples);
          } catch (err) {
            // a callback that throws is the caller's bug, not a failed poll
            this.lastError = describeDbError(err);
          }
        },
        (err) => {
          this.inFlight = undefined;
          if (!this.stopped) this.fail(err);
        },
      );
  }

  private fail(err: unknown): void {
    this.polls++;
    this.failures++;
    this.consecutiveFailures++;
    this.lastError = describeDbError(err);
    try {
      this.onFailure?.({ error: this.lastError, consecutive: this.consecutiveFailures, total: this.failures });
    } catch {
      // the caller's callback must not end the polling
    }
  }
}
