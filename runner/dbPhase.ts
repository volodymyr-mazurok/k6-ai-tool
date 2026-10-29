// The database side of a run, kept apart from run.ts: the busy check before a load, the evidence collected around each
// k6 run (query-stats snapshots, resource samples, db.json), the abort rule while k6 runs, and the row counts that prove
// the run left no data behind.
//
//   DbPhase.open       once per runFeature: the adapter's connection (or the injected resourceSource), row-count tables
//   DbPhase.busyCheck  before a non-smoke run: the last 5 minutes of DB load, refused when busy or unreadable, and always
//                      when the database cannot be reached (no guard, no load)
//   DbPhase.begin      per k6 run, just before it starts: row counts + query-stats snapshot "before"
//   DbRun.watch        while k6 runs: poll resource samples, stop k6 when the DB is saturated (dbAbortDecision)
//   DbRun.finish       after k6: row counts "after", snapshot "after", db.json
// Evidence is best effort: a query that fails or hangs (each step is capped at 20 s) is noted in db.json (error code only,
// never the message) and the run goes on; finish() never throws, so meta.json is always written. Row counts are not best
// effort: counts that cannot be read before the run refuse it, after the run they mark cleanup not ok.
// The abort watch can go blind (polls fail or hang). That is noted in db.json and meta.dbGuard, logged, and after 4 failed
// polls in a row (the same 60 s as the hot-sample rule) k6 is stopped with abortReason `db`: no guard, no load.

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { Knex } from 'knex';
import type { ProjectAdapter } from './adapter.js';
import {
  dbProfile,
  describeDbError,
  diffQueryStats,
  extractTables,
  latestResourceStats,
  missingIndexes,
  queryStoreTop,
  resourceStats,
  ResourcePoller,
  snapshotQueryStats,
  type DbProfile,
  type MissingIndex,
  type QueryStat,
  type QueryStatDelta,
  type QueryStoreStat,
} from './collectors/mssql.js';
import type { Project } from './config.js';
import { checkBusy, dbAbortDecision, GuardrailError, type ProfileType, type ResourceSample } from './guardrails.js';

/** meta.cleanup: the row counts of the project's tables before and after the run. `ok` is true when they are equal. */
export interface CleanupResult {
  before: Record<string, number>;
  /** null when the counts could not be read after the run (then `ok` is false and `error` says why). */
  after: Record<string, number> | null;
  ok: boolean;
  error?: string;
}

/** meta.dbGuard: how the DB abort watch fared; present only when a poll failed. */
export interface DbGuardStatus {
  polls: number;
  pollFailures: number;
  lastError?: string;
  /** The guard failed `4` polls in a row, so the run was stopped (meta.k6.abortReason is `db`). */
  blindStop: boolean;
}

/** db.json. `errors` is present only when some evidence could not be collected. */
export interface DbEvidence {
  tier: string | null;
  edition: string | null;
  window: { from: string; to: string };
  /** Every 15 s resource sample of the window; `t` is its end in seconds from the time series' origin (null when unknown). */
  resource: { endTime: string; t: number | null; cpu: number; dataIo: number; logWrite: number }[];
  topStatements: QueryStatDelta[];
  evicted: number;
  missingIndexes: MissingIndex[];
  /** Present only when the plan cache could not answer (statements evicted, or none grew). */
  queryStore?: QueryStoreStat[];
  caveat: string;
  errors?: string[];
}

export const DB_CAVEAT = 'Shared database: other activity during the window is included.';

/** What the busy check looks at: the average of the last 5 minutes against this limit (percent). */
const BUSY_MINUTES = 5;
const BUSY_LIMIT_PCT = 20;
/** dm_db_resource_stats rows are 15 s apart. */
const SAMPLE_SEC = 15;
/** Failed polls in a row after which the abort guard counts as blind and k6 is stopped (4 x 15 s, like the hot-sample rule). */
const BLIND_POLLS = 4;
/** The longest any one evidence step (a query, a row count) may take before it is recorded as timed out. */
const STEP_TIMEOUT_MS = 20_000;

/** A step that did not answer in time. Its message reads `timed out after N s`; it has no code, so describeDbError keeps it. */
class StepTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${Math.round(ms / 100) / 10} s`);
    this.name = 'StepTimeoutError';
  }
}

/** `step()`, giving up after `ms`. The step itself cannot be cancelled: a hung query stays pending until the connection goes. */
function capped<T>(ms: number, step: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new StepTimeoutError(ms)), ms);
    Promise.resolve()
      .then(step)
      .then(resolve, reject)
      .finally(() => clearTimeout(timer));
  });
}

/** The part of the k6 run the DB watch needs: a way to stop it. (run.ts's K6Control fits.) */
export interface StoppableRun {
  stop(reason: 'db'): void;
}

export interface DbPhaseOptions {
  env: string;
  project: Project;
  /** CPU or data IO percent that stops the run (4 samples in a row): the run's effective abort limit. Default: the project's. */
  dbCpuOrIoPct?: number;
  /** DB resource samples in place of the database's (tests). */
  resourceSource?: () => Promise<ResourceSample[]>;
  /** Poll interval of the abort watch, ms. Default 15 000, the rate of the samples. */
  pollMs?: number;
  /** Longest any one evidence step may take, ms. Default 20 000. Tests shorten it. */
  stepTimeoutMs?: number;
  log: (message: string) => void;
}

const finite = (s: ResourceSample): boolean => Number.isFinite(s.cpu) && Number.isFinite(s.dataIo);

export class DbPhase {
  private constructor(
    readonly adapter: ProjectAdapter,
    readonly db: Knex | null,
    /** Why adapter.db() failed, when it did (error code only). */
    private readonly dbError: string | undefined,
    readonly opts: DbPhaseOptions,
  ) {}

  /**
   * The DB side of a run, or null when the project has neither a database nor an injected resource source nor row-count
   * tables to compare. An adapter whose db() fails still gives a phase: the run goes on without evidence (a non-smoke run
   * is refused by the busy check, DB_UNREACHABLE, since no guard could watch it).
   */
  static async open(adapter: ProjectAdapter, opts: DbPhaseOptions): Promise<DbPhase | null> {
    let db: Knex | null = null;
    let dbError: string | undefined;
    if (!opts.resourceSource && adapter.db) {
      try {
        db = await adapter.db(opts.env);
      } catch (err) {
        dbError = describeDbError(err);
      }
    }
    const phase = new DbPhase(adapter, db, dbError, opts);
    return phase.hasEvidence || phase.countsRows ? phase : null;
  }

  /** The DB (or an injected source) can tell how loaded it is. */
  get readsLoad(): boolean {
    return this.db !== null || this.opts.resourceSource !== undefined;
  }

  /** db.json is written: there is a database, a source, or a failure to explain. */
  get hasEvidence(): boolean {
    return this.readsLoad || this.dbError !== undefined;
  }

  get countsRows(): boolean {
    return this.adapter.rowCounts !== undefined && (this.opts.project.rowCountTables?.length ?? 0) > 0;
  }

  get stepMs(): number {
    return this.opts.stepTimeoutMs ?? STEP_TIMEOUT_MS;
  }

  /** Release what this phase holds: the connection (the adapter's close() does it too; destroying twice is harmless). */
  async release(): Promise<void> {
    await this.db?.destroy().catch(() => {});
  }

  /** Samples ending in `from`..`to`, from the injected source or the database. */
  async samples(from: Date, to: Date): Promise<ResourceSample[]> {
    if (this.opts.resourceSource) return this.opts.resourceSource();
    if (!this.db) throw new Error(this.dbError ?? 'no database');
    return resourceStats(this.db, from, to);
  }

  /** The last 5 minutes of DB load. */
  private latest(): Promise<ResourceSample[]> {
    if (this.opts.resourceSource) return this.opts.resourceSource();
    if (!this.db) return Promise.reject(new Error(this.dbError ?? 'no database'));
    return latestResourceStats(this.db, BUSY_MINUTES);
  }

  /**
   * Refuse a load/stress/soak run on a busy shared database: CPU or data IO averaging above 20% over the last 5 minutes.
   * A DB load that cannot be read (no samples, only empty ones, or the read failed) counts as busy, since idleness is not
   * shown. `override` lets the run go; the result says whether it was needed (`overridden`), which makes the verdict INVALID.
   * A database that cannot be reached at all (the adapter's db() threw) is refused even with `override`: without a
   * connection the DB abort guard cannot watch the run (no guard, no load).
   * A smoke, or a project without a database, is never checked.
   * @throws {GuardrailError} ENV_BUSY | DB_UNREACHABLE
   */
  async busyCheck(profile: ProfileType, override: boolean): Promise<{ overridden: boolean }> {
    if (profile === 'smoke' || !this.hasEvidence) return { overridden: false };
    if (!this.readsLoad) {
      throw new GuardrailError(
        'DB_UNREACHABLE',
        `the database could not be reached (${this.dbError ?? 'no connection'}), so the database abort guard cannot watch a ` +
          `${profile} run: no guard, no load. --override-busy does not lift it; check the connection the project reads (perf doctor)`,
      );
    }
    let samples: ResourceSample[] = [];
    let readError: string | undefined;
    try {
      samples = (await capped(this.stepMs, () => this.latest())).filter(finite);
    } catch (err) {
      readError = describeDbError(err);
    }

    let problem: string | undefined;
    if (samples.length === 0) {
      problem =
        `the database load could not be read (${readError ?? `no resource samples in the last ${BUSY_MINUTES} minutes`}), ` +
        'so the database cannot be shown to be idle';
    } else {
      const { busy, avgCpu, avgIo } = checkBusy(samples, BUSY_LIMIT_PCT);
      if (busy) {
        problem =
          `the database is busy: over the last ${BUSY_MINUTES} minutes CPU averaged ${avgCpu.toFixed(0)}% and data IO ` +
          `${avgIo.toFixed(0)}% (limit ${BUSY_LIMIT_PCT}%); somebody else is loading the shared database`;
      }
    }
    if (!problem) return { overridden: false };
    if (!override) {
      throw new GuardrailError('ENV_BUSY', `${problem}. Wait, or pass --override-busy (the verdict becomes INVALID)`);
    }
    this.opts.log(`${problem}; running anyway because of --override-busy (the verdict will be INVALID)`);
    return { overridden: true };
  }

  /**
   * Take the "before" evidence of one k6 run: the row counts (an error refuses the run: nothing has been sent yet) and the
   * query-stats snapshot.
   * @throws {Error} when the row counts cannot be read
   */
  async begin(): Promise<DbRun> {
    const run = new DbRun(this);
    if (this.dbError !== undefined) run.note(`database connection: ${this.dbError}`);
    if (this.countsRows) {
      try {
        run.countsBefore = await capped(this.stepMs, () => this.adapter.rowCounts!(this.opts.env, this.opts.project.rowCountTables!));
      } catch (err) {
        throw new Error(`row counts could not be read before the run (${describeDbError(err)}); nothing was sent`);
      }
    }
    if (this.db) run.statsBefore = await run.attempt('query stats before', () => snapshotQueryStats(this.db!));
    run.from = new Date();
    return run;
  }
}

/** The DB evidence of one k6 run. */
export class DbRun {
  from = new Date();
  countsBefore: Record<string, number> | undefined;
  statsBefore: QueryStat[] | undefined;
  private readonly seen = new Map<number, ResourceSample>();
  private readonly errors: string[] = [];
  private poller: ResourcePoller | undefined;
  /** An evidence step timed out: the rest of this phase skips the database instead of waiting for it again. */
  private timedOut = false;
  /** The watch stopped k6 because its polls kept failing. */
  private blindStop = false;

  constructor(private readonly phase: DbPhase) {}

  /** Record that some evidence is missing. */
  note(problem: string): void {
    if (!this.errors.includes(problem)) this.errors.push(problem);
  }

  /**
   * Run an evidence step, giving up after the phase's step cap; a failure or timeout is noted (error code only) and the
   * step yields undefined. After a timeout the database is not asked again until the next phase.
   */
  async attempt<T>(label: string, step: () => Promise<T>): Promise<T | undefined> {
    if (this.timedOut) {
      this.note('later database steps were skipped after a timeout');
      return undefined;
    }
    try {
      return await capped(this.phase.stepMs, step);
    } catch (err) {
      if (err instanceof StepTimeoutError) this.timedOut = true;
      this.note(`${label}: ${describeDbError(err)}`);
      return undefined;
    }
  }

  /** Samples are kept once each, by the time they ended: overlapping poll windows return the same ones again. */
  private take(samples: ResourceSample[]): void {
    for (const s of samples) {
      const at = s?.endTime instanceof Date ? s.endTime.getTime() : NaN;
      if (Number.isFinite(at)) this.seen.set(at, s);
    }
  }

  /**
   * Poll the DB's resource samples while k6 runs and stop the run (reason `db`) when
   *  - the abort rule fires: the effective db_cpu_or_io_pct (project, feature or run option) for 4 samples in a row, or
   *  - the guard is blind: 4 polls in a row failed or hung, so the rule can no longer fire.
   * The sample that straddles the start is left out: it mixes in the time before. A stop that throws is retried at the next
   * poll. The first failed poll is logged and every one is counted (see finish).
   * @returns a function that ends the watch
   */
  watch(run: StoppableRun): () => void {
    if (!this.phase.db && !this.phase.opts.resourceSource) return () => {};
    const { log, project } = this.phase.opts;
    const abortPct = this.phase.opts.dbCpuOrIoPct ?? project.abort.dbCpuOrIoPct;
    if (abortPct === undefined) {
      // Fails closed: run.ts refuses such a run before k6 starts (R45); if one gets here anyway, no guard means no load.
      run.stop('db');
      throw new Error('no database abort limit (db_cpu_or_io_pct) was resolved for a project with a database; k6 was stopped');
    }
    const guardFrom = new Date(this.from.getTime() + SAMPLE_SEC * 1000);
    let stopped = false;
    const stop = (why: string): boolean => {
      try {
        run.stop('db');
      } catch (err) {
        this.note(`stopping k6 failed (${describeDbError(err)}); retried at the next poll`);
        return false;
      }
      stopped = true;
      log(`${why}: k6 was told to stop`);
      return true;
    };
    const poller = new ResourcePoller(() => this.phase.samples(guardFrom, new Date()), this.phase.opts.pollMs ?? SAMPLE_SEC * 1000);
    this.poller = poller;
    poller.start(
      (samples) => {
        this.take(samples);
        if (stopped || !dbAbortDecision([...this.seen.values()], abortPct)) return;
        stop(`the database is saturated (CPU or data IO at ${abortPct}% or more for 4 samples in a row)`);
      },
      (failure) => {
        if (failure.total === 1) {
          log(`database abort watch: a poll failed (${failure.error}); k6 is stopped if ${BLIND_POLLS} polls in a row fail`);
        }
        if (stopped || failure.consecutive < BLIND_POLLS) return;
        const why = `the database abort guard is blind (${failure.consecutive} polls in a row failed, last: ${failure.error})`;
        if (stop(why)) {
          this.blindStop = true;
          this.note(`abort watch blind: k6 stopped after ${failure.consecutive} failed polls in a row (last: ${failure.error})`);
        }
      },
    );
    return () => poller.stop();
  }

  /** How the abort watch fared, when any poll failed. */
  private guardStatus(): DbGuardStatus | undefined {
    const poller = this.poller;
    if (!poller || poller.failures === 0) return undefined;
    return {
      polls: poller.polls,
      pollFailures: poller.failures,
      ...(poller.lastError ? { lastError: poller.lastError } : {}),
      blindStop: this.blindStop,
    };
  }

  /** The row counts after the run against the ones before. Never throws. */
  private async countAfter(): Promise<CleanupResult | undefined> {
    const { phase } = this;
    if (!phase.countsRows || !this.countsBefore) return undefined;
    try {
      const after = await capped(phase.stepMs, () => phase.adapter.rowCounts!(phase.opts.env, phase.opts.project.rowCountTables!));
      return { before: this.countsBefore, after, ok: isDeepStrictEqual(this.countsBefore, after) };
    } catch (err) {
      if (err instanceof StepTimeoutError) this.timedOut = true;
      return { before: this.countsBefore, after: null, ok: false, error: `row counts could not be read after the run (${describeDbError(err)})` };
    }
  }

  /**
   * The "after" evidence: row counts, snapshot, resource samples and missing indexes, written to `<runDir>/db.json`.
   * Nothing here may stop the run's own results from being written, so every database call is capped and noted on failure,
   * and anything else that goes wrong (the file write, a malformed sample) is logged and swallowed.
   * @param origin the time series' origin (ISO), to give each resource sample its `t`
   * @returns meta.cleanup (undefined when the project counts no rows) and meta.dbGuard (undefined when no poll failed)
   */
  async finish(runDir: string, origin: string | null): Promise<{ cleanup?: CleanupResult; guard?: DbGuardStatus }> {
    const { log } = this.phase.opts;
    const to = new Date();
    this.poller?.stop();
    this.timedOut = false;

    const cleanup = await this.countAfter();
    if (cleanup && !cleanup.ok) log(`row counts changed during the run or could not be compared: ${JSON.stringify(cleanup)}`);

    const guard = this.guardStatus();
    if (guard) {
      this.note(`abort watch: ${guard.pollFailures} of ${guard.polls} polls failed (last: ${guard.lastError ?? 'unknown'})`);
    }
    try {
      if (this.phase.hasEvidence) {
        const evidence = await this.collect(to, origin);
        await writeFile(join(runDir, 'db.json'), `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
        if (evidence.errors) log(`database evidence is incomplete (see db.json errors): ${evidence.errors.join('; ')}`);
      }
    } catch (err) {
      log(`db.json could not be written (${describeDbError(err)}); the run's other results are unaffected`);
    }
    return { ...(cleanup ? { cleanup } : {}), ...(guard ? { guard } : {}) };
  }

  private skeleton(to: Date, origin: string | null, profile: DbProfile | null): DbEvidence {
    const t0 = origin ? Date.parse(origin) : NaN;
    const resource = [...this.seen.values()]
      .sort((a, b) => a.endTime.getTime() - b.endTime.getTime())
      .map((s) => ({
        endTime: s.endTime.toISOString(),
        t: Number.isNaN(t0) ? null : (s.endTime.getTime() - t0) / 1000,
        cpu: s.cpu,
        dataIo: s.dataIo,
        logWrite: s.logWrite,
      }));
    const evidence: DbEvidence = {
      tier: profile?.tier ?? null,
      edition: profile?.edition ?? null,
      window: { from: this.from.toISOString(), to: to.toISOString() },
      resource,
      topStatements: [],
      evicted: 0,
      missingIndexes: [],
      caveat: DB_CAVEAT,
    };
    if (this.errors.length > 0) evidence.errors = [...this.errors];
    return evidence;
  }

  private async collect(to: Date, origin: string | null): Promise<DbEvidence> {
    const { db } = this.phase;
    if (this.phase.readsLoad) {
      const samples = await this.attempt('resource stats', () => this.phase.samples(this.from, to));
      if (samples) this.take(samples);
    }

    let profile: DbProfile | null = null;
    let top: QueryStatDelta[] = [];
    let evicted = 0;
    let missing: MissingIndex[] = [];
    let queryStore: QueryStoreStat[] | undefined;
    if (db) {
      profile = (await this.attempt('database profile', () => dbProfile(db))) ?? null;
      const after = await this.attempt('query stats after', () => snapshotQueryStats(db));
      if (this.statsBefore && after) {
        ({ top, evicted } = diffQueryStats(this.statsBefore, after));
        const tables = extractTables(top.map((s) => s.text));
        missing = (await this.attempt('missing indexes', () => missingIndexes(db, tables))) ?? [];
        if (evicted > 0 || top.length === 0) {
          queryStore = (await this.attempt('query store', () => queryStoreTop(db, this.from, to))) ?? undefined;
        }
      }
    }
    const evidence = this.skeleton(to, origin, profile);
    evidence.topStatements = top;
    evidence.evicted = evicted;
    evidence.missingIndexes = missing;
    if (queryStore) evidence.queryStore = queryStore;
    return evidence;
  }
}
