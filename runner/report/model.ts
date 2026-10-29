// The report's logic, kept pure so it can be tested without a run: per-step numbers from summary.json, the automatic
// flags, the verdict, the DB average of the hold phase, and the load in business terms. The stress breaking point is in
// breakingPoint.ts (re-exported here). Nothing here reads a file; render.ts / build.ts (Task 14) feed it and draw the result.

import type { Workload } from '../config.js';
import type { ResolvedProfile } from '../guardrails.js';
import type { CleanupResult } from '../dbPhase.js';
import type { RunMeta } from '../run.js';
import type { BreakingLimits } from './breakingPoint.js';

export { BREAKING_LIMITS, findBreakingPoint, type BreakingLimits, type BreakingPoint, type Stage } from './breakingPoint.js';

// ---------------------------------------------------------------------------------------------------------------
// inputs
// ---------------------------------------------------------------------------------------------------------------

/** One metric of k6's end-of-test summary. Trends carry `med`, `p(95)`, `count`...; rates carry `rate`, `passes`, `fails`. */
export interface K6Metric {
  values?: Record<string, number>;
  /** Threshold expression -> result, as k6 writes it (`{ 'p(95)<300': { ok: false } }`). */
  thresholds?: Record<string, { ok?: boolean }>;
}

/**
 * The thresholds k6 marked as crossed, as `metric expression` (`http_req_duration p(95)<300`), in the summary's order.
 * Only the metrics that carry a threshold can be listed; the per-step no-op thresholds (`max>=0`) never fail.
 */
export function crossedThresholds(summary: K6Summary | undefined): string[] {
  return Object.entries(summary?.metrics ?? {}).flatMap(([metric, m]) =>
    Object.entries(m?.thresholds ?? {})
      .filter(([, result]) => result?.ok === false)
      .map(([expression]) => `${metric} ${expression}`),
  );
}

/** The part of summary.json (k6 handleSummary data, setup_data removed) the report reads. */
export interface K6Summary {
  state?: { testRunDurationMs?: number };
  metrics: Record<string, K6Metric | undefined>;
}

/** The part of db.json the report reads: `t` is a sample's end in seconds from the time series' origin (null when unknown). */
export interface DbSamples {
  resource: { t: number | null; cpu: number; dataIo: number }[];
}

/** What the verdict reads of meta.json. */
export type VerdictMeta = Pick<RunMeta, 'fingerprint' | 'guardrails' | 'k6' | 'interrupted' | 'checks' | 'cleanup'>;

/** The slot of a feature's baseline.json for one env and profile (written by `perf baseline accept`, Task 15). */
export interface BaselineSlot {
  runId: string;
  acceptedAt: string;
  steps: Record<string, { p50: number; p95: number; p99: number; errorRate: number; rps: number }>;
}

/** The baseline slot a run was judged against, as the run recorded it in meta.json (`meta.baseline`; null there when it had none). */
export interface BaselineSnapshot extends BaselineSlot {
  env: string;
  profile: string;
}

/** The workload fields that word the load in business terms (think time in seconds). */
export type BusinessWorkload = Pick<Workload, 'businessUnit' | 'businessAction' | 'thinkTime'>;

/** The limits a run applied, as it records them in meta.json (`meta.rules`): its report reads them back from there. */
export interface ReportRules {
  flags: FlagLimits;
  breaking: BreakingLimits;
}

/** What a run records of its workload (`meta.workload`), so its report can word the load without the feature files. */
export interface RunWorkload extends BusinessWorkload {
  readOnly: boolean;
  /** The writes the feature declared (journey.yaml `writes:`), as `METHOD /route` and who cleans up; absent when it declared none. */
  writes?: { request: string; cleanup: 'app' }[];
  /** `METHOD /route` of every journey step, by step id. */
  requests: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------------------------
// limits and small helpers
// ---------------------------------------------------------------------------------------------------------------

/** The automatic flags' limits (the numbers of FLAG_LIMITS, or the ones a run recorded in meta.json). */
export interface FlagLimits {
  errorRate: number;
  checkFailureRate: number;
  p95Factor: number;
  p95AddMs: number;
  dbPct: number;
}

/** The automatic flags' limits. A run copies them into meta.json (`meta.rules`); its report reads them back from there. */
export const FLAG_LIMITS = {
  /** Error rate above this (a fraction) flags ERRORS. */
  errorRate: 0.01,
  /** Failed checks above this (a fraction of all checks) flag CHECKS. */
  checkFailureRate: 0.005,
  /** p95 must be above baseline x this ... */
  p95Factor: 1.2,
  /** ... and above baseline plus this many ms to flag P95_REGRESSION. */
  p95AddMs: 100,
  /** DB CPU or data IO average above this percent over the hold phase flags DB_HOT. */
  dbPct: 80,
} as const;

const round1 = (n: number): number => Math.round(n * 10) / 10;
/** A fraction as a percent without float noise: 0.011 -> `1.1%`. */
const pct = (fraction: number): string => `${Math.round(fraction * 10000) / 100}%`;
/** A percent that is already a percent: 81 -> `81%`. */
const percent = (value: number): string => `${round1(value)}%`;
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

function assertDuration(durationSec: number, who: string): void {
  if (!(durationSec > 0) || !Number.isFinite(durationSec)) {
    throw new RangeError(`${who}: durationSec must be a positive number of seconds (got ${durationSec})`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// per-step numbers
// ---------------------------------------------------------------------------------------------------------------

export interface StepStat {
  id: string;
  /** Requests the step sent. */
  count: number;
  /** count / durationSec. */
  rps: number;
  /** Milliseconds. */
  p50: number;
  p95: number;
  p99: number;
  /** Failed requests / requests; null when http_req_failed has no samples for the step. */
  errorRate: number | null;
  /** Checks passed / checks run; null when the step ran no checks. */
  checkRate: number | null;
}

/** passes / (passes + fails) of a k6 rate metric; null when it has no samples (0 and 0 is "nothing measured", not 0%). */
function rateOf(metric: K6Metric | undefined): number | null {
  const v = metric?.values;
  if (!v) return null;
  if (v.passes !== undefined && v.fails !== undefined) {
    const total = v.passes + v.fails;
    return total > 0 ? v.passes / total : null;
  }
  return typeof v.rate === 'number' ? v.rate : null;
}

/**
 * Per-step numbers from the `{name:<id>}` sub-metrics (the runner forces them into summary.json). A step that sent
 * nothing has no entry. `durationSec` is the span the counts cover (k6's `state.testRunDurationMs`, or the profile's
 * total for a timed run); it only scales `rps`.
 * @throws {RangeError} when durationSec is not above 0
 * @throws {Error} when a step has requests but the summary lacks median, p(95) or p(99) (k6 must keep them in summaryTrendStats)
 */
export function stepStats(summary: K6Summary, stepIds: string[], durationSec: number): StepStat[] {
  assertDuration(durationSec, 'stepStats');
  const stats: StepStat[] = [];
  for (const id of stepIds) {
    const duration = summary.metrics[`http_req_duration{name:${id}}`]?.values;
    const count = duration?.count ?? 0;
    if (!duration || !(count > 0)) continue;
    const p50 = duration.med ?? duration['p(50)'];
    const p95 = duration['p(95)'];
    const p99 = duration['p(99)'];
    if (p50 === undefined || p95 === undefined || p99 === undefined) {
      throw new Error(`summary.json: http_req_duration{name:${id}} has no med, p(95) or p(99); k6 summaryTrendStats must include them`);
    }
    stats.push({
      id,
      count,
      rps: count / durationSec,
      p50,
      p95,
      p99,
      errorRate: rateOf(summary.metrics[`http_req_failed{name:${id}}`]),
      checkRate: rateOf(summary.metrics[`checks{name:${id}}`]),
    });
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------------------------
// database during the hold phase
// ---------------------------------------------------------------------------------------------------------------

export interface DbHoldAvg {
  cpu: number;
  dataIo: number;
  /** Samples averaged. */
  samples: number;
}

/**
 * Average DB CPU and data IO over the samples whose end falls inside the hold window (both ends included; window and
 * `t` are seconds from the time series' origin). Undefined when there is no DB, no hold phase or no sample inside.
 */
export function dbHoldAverage(
  db: DbSamples | null | undefined,
  holdWindow: { fromSec: number; toSec: number } | undefined,
): DbHoldAvg | undefined {
  if (!db || !holdWindow) return undefined;
  const inside = db.resource.filter(
    (s) => s.t !== null && s.t >= holdWindow.fromSec && s.t <= holdWindow.toSec && Number.isFinite(s.cpu) && Number.isFinite(s.dataIo),
  );
  if (inside.length === 0) return undefined;
  const mean = (pick: (s: DbSamples['resource'][number]) => number): number => inside.reduce((total, s) => total + pick(s), 0) / inside.length;
  return { cpu: mean((s) => s.cpu), dataIo: mean((s) => s.dataIo), samples: inside.length };
}

// ---------------------------------------------------------------------------------------------------------------
// flags
// ---------------------------------------------------------------------------------------------------------------

export interface Flag {
  code: 'ERRORS' | 'CHECKS' | 'P95_REGRESSION' | 'DB_HOT';
  /** The step id; absent for DB_HOT. */
  step?: string;
  detail: string;
}

/**
 * The automatic flags: error rate above 1%, failed checks above 0.5%, p95 above baseline x 1.2 and above baseline +
 * 100 ms, DB CPU or data IO averaging above 80% over the hold phase (the defaults; `limits` replaces them, e.g. with the
 * ones a run recorded). In step order (ERRORS, CHECKS, P95_REGRESSION
 * for each), then the database. A step with no baseline entry, or a null rate, raises nothing for that rule.
 */
export function computeFlags(input: { steps: StepStat[]; baseline?: BaselineSlot; dbHoldAvg?: DbHoldAvg; limits?: FlagLimits }): Flag[] {
  const limits = input.limits ?? FLAG_LIMITS;
  const flags: Flag[] = [];
  for (const step of input.steps) {
    if (step.errorRate !== null && step.errorRate > limits.errorRate) {
      flags.push({ code: 'ERRORS', step: step.id, detail: `error rate ${pct(step.errorRate)} (limit ${pct(limits.errorRate)})` });
    }
    if (step.checkRate !== null) {
      const failed = Math.round((1 - step.checkRate) * 1e6) / 1e6; // 1 - 0.995 is 0.0050000000000000044 as a double
      if (failed > limits.checkFailureRate) {
        flags.push({ code: 'CHECKS', step: step.id, detail: `${pct(failed)} of checks failed (limit ${pct(limits.checkFailureRate)})` });
      }
    }
    const base = input.baseline?.steps[step.id];
    if (base && step.p95 > base.p95 * limits.p95Factor && step.p95 > base.p95 + limits.p95AddMs) {
      const rise = Math.round(((step.p95 - base.p95) / base.p95) * 100);
      flags.push({
        code: 'P95_REGRESSION',
        step: step.id,
        detail: `p95 ${Math.round(step.p95)} ms against a baseline of ${Math.round(base.p95)} ms (+${rise}%; flagged above +${Math.round((limits.p95Factor - 1) * 100)}% and +${limits.p95AddMs} ms)`,
      });
    }
  }
  const db = input.dbHoldAvg;
  if (db) {
    const hot = [
      db.cpu > limits.dbPct ? `CPU averaged ${percent(db.cpu)}` : null,
      db.dataIo > limits.dbPct ? `data IO averaged ${percent(db.dataIo)}` : null,
    ].filter((part): part is string => part !== null);
    if (hot.length > 0) {
      flags.push({ code: 'DB_HOT', detail: `database ${hot.join(' and ')} over the hold phase (limit ${limits.dbPct}%)` });
    }
  }
  return flags;
}

/** The step ids whose p95 is over their explicit target; empty in baseline mode. A step with no target or no data is not a miss. */
export function targetsMissed(steps: StepStat[], targets: Workload['targets']): string[] {
  if (targets === 'baseline') return [];
  return steps.filter((s) => Object.hasOwn(targets, s.id) && s.p95 > targets[s.id]!.p95Ms).map((s) => s.id);
}

// ---------------------------------------------------------------------------------------------------------------
// verdict
// ---------------------------------------------------------------------------------------------------------------

export type VerdictName = 'PASS' | 'DEGRADED' | 'FAIL' | 'NO BASELINE' | 'INVALID';

export interface Verdict {
  verdict: VerdictName;
  /** Why, one line each; for the verdict reached only (a FAIL's reasons are not listed under an INVALID). */
  reasons: string[];
}

function invalidReasons(meta: VerdictMeta): string[] {
  const reasons: string[] = [];
  if (meta.fingerprint.changed) {
    reasons.push('the app or API was redeployed during the run (the build fingerprint differs before and after)');
  }
  if (meta.guardrails.busyOverride) {
    reasons.push('the busy check was overridden (--override-busy): other load on the shared database may have shaped the numbers');
  }
  return reasons;
}

/** Why row counts that are not ok fail a run (the verdict's reason; run.ts uses it for a smoke that left rows behind). */
export function cleanupReason(cleanup: CleanupResult): string {
  if (cleanup.after === null) return `row counts could not be read after the run (${cleanup.error ?? 'unknown error'}), so cleanup is unproven`;
  const { before, after } = cleanup;
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((table) => before[table] !== after[table])
    .map((table) => `${table} ${before[table] ?? '?'} → ${after[table] ?? '?'}`);
  return changed.length > 0
    ? `row counts changed during the run, so cleanup is incomplete: ${changed.join(', ')}`
    : `row counts differ after the run${cleanup.error ? ` (${cleanup.error})` : ''}`;
}

function failReasons(meta: VerdictMeta, missed: string[], crossed: string[]): string[] {
  const reasons: string[] = [];
  const { exitCode, signal, abortReason, scriptErrors } = meta.k6;
  if (meta.interrupted || abortReason === 'interrupted') {
    reasons.push('the run was interrupted');
  } else if (abortReason === 'db') {
    reasons.push('the run was stopped by the database guard: the database was saturated, or its load could not be read');
  } else if (abortReason === 'thresholds') {
    reasons.push(
      crossed.length > 0
        ? `the run was aborted by a k6 threshold: ${crossed.join(', ')} ${crossed.length === 1 ? 'was' : 'were'} crossed; k6 exited with code ${exitCode}`
        : `the run was aborted by a k6 threshold (error rate or p95 too high); k6 exited with code ${exitCode}`,
    );
  } else if (exitCode === null) {
    reasons.push(signal ? `k6 was stopped by ${signal}` : 'k6 did not finish (no exit code)');
  } else if (exitCode === 99 && crossed.length > 0) {
    // k6 exits 99 when any threshold failed, also one that failed only at the end, which the runner does not call an abort
    reasons.push(`k6 exited with code 99: ${crossed.join(', ')} ${crossed.length === 1 ? 'was' : 'were'} crossed`);
  } else if (exitCode !== 0) {
    reasons.push(`k6 exited with code ${exitCode}`);
  }
  if (scriptErrors > 0) reasons.push(`k6 reported ${plural(scriptErrors, 'script error')}`);
  if (meta.checks.length > 0) {
    const shown = meta.checks.slice(0, 3).map((p) => `${p.code}${p.journey ? ` ${p.journey}${p.step ? `.${p.step}` : ''}` : ''}`);
    const more = meta.checks.length > shown.length ? `, +${meta.checks.length - shown.length} more` : '';
    reasons.push(`journey check failed (${plural(meta.checks.length, 'problem')}): ${shown.join(', ')}${more}`);
  }
  if (meta.cleanup && !meta.cleanup.ok) reasons.push(cleanupReason(meta.cleanup));
  if (missed.length > 0) reasons.push(`p95 target missed: ${missed.join(', ')}`);
  return reasons;
}

const flagLine = (flag: Flag): string => `${flag.code}${flag.step ? ` ${flag.step}` : ''}: ${flag.detail}`;

/**
 * The run's verdict, first match wins: INVALID (the build fingerprint changed, or the busy check was overridden) >
 * FAIL (k6 exit not 0, aborted, interrupted, script errors, failed journey checks, row counts differ, explicit target
 * missed) > NO BASELINE > DEGRADED (any flag) > PASS.
 */
export function computeVerdict(input: {
  meta: VerdictMeta;
  flags: Flag[];
  hasBaseline: boolean;
  targetsMissed: string[];
  /** The thresholds the summary marks as crossed (`crossedThresholds`); names the metric in a threshold abort's reason. */
  crossed?: string[];
}): Verdict {
  const invalid = invalidReasons(input.meta);
  if (invalid.length > 0) return { verdict: 'INVALID', reasons: invalid };
  const failed = failReasons(input.meta, input.targetsMissed, input.crossed ?? []);
  if (failed.length > 0) return { verdict: 'FAIL', reasons: failed };
  if (!input.hasBaseline) {
    const reasons = ['no accepted baseline for this environment and profile: the numbers stand alone'];
    if (input.flags.length > 0) reasons.push(`${plural(input.flags.length, 'automatic flag')} raised, see Automatic flags`);
    return { verdict: 'NO BASELINE', reasons };
  }
  if (input.flags.length > 0) return { verdict: 'DEGRADED', reasons: input.flags.map(flagLine) };
  return { verdict: 'PASS', reasons: ['no automatic flags; within the baseline limits'] };
}

// ---------------------------------------------------------------------------------------------------------------
// load in business terms
// ---------------------------------------------------------------------------------------------------------------

/** `analysts working` -> `analyst working` for one user. Assumes the unit is a plural noun first. */
function unitFor(unit: string, users: number): string {
  return users === 1 ? unit.replace(/^(\S*[^s\s])s(?=\s|$)/, '$1') : unit;
}

function thinkTimeText({ min, max }: { min: number; max: number }): string {
  if (min === 0 && max === 0) return 'no pausing between actions';
  return `pausing ${min === max ? min : `${min}–${max}`} s between actions`;
}

/**
 * What the load means in the business's words.
 *   load/soak  `10 analysts working (pausing 2–6 s between actions) ≈ 140 grid actions/min`
 *   stress     `arrival rate stepped up from 1 to 11 req/s (no pausing between actions) ≈ 360 grid actions/min on average`
 *   smoke      `smoke check: each journey once, 6 grid actions in 20 s (not a load)`
 * Actions per minute = the requests of `steps` (journey steps only, not the token request) per minute of `durationSec`,
 * rounded. Pass the span the step counts cover: for a load run that includes the ramps, so it is the run's average.
 * @throws {RangeError} when durationSec is not above 0
 */
export function businessLoad(workload: BusinessWorkload, profile: ResolvedProfile, steps: StepStat[], durationSec: number): string {
  assertDuration(durationSec, 'businessLoad');
  const total = steps.reduce((sum, s) => sum + s.count, 0);
  const perMin = Math.round((total * 60) / durationSec);
  const { businessUnit: unit, businessAction: action } = workload;
  switch (profile.type) {
    case 'smoke':
      return `smoke check: each journey once, ${total} ${action} in ${Math.round(durationSec)} s (not a load)`;
    case 'stress': {
      const levels = [...(profile.stages ?? [])].sort((a, b) => a.fromSec - b.fromSec);
      if (levels.length === 0) throw new Error('businessLoad: a stress profile needs stages');
      const from = levels[0]!.rps;
      const to = levels[levels.length - 1]!.rps;
      const rate = from === to ? `held at ${to} req/s` : `stepped ${to > from ? 'up ' : ''}from ${from} to ${to} req/s`;
      return `arrival rate ${rate} (no pausing between actions) ≈ ${perMin} ${action}/min on average`;
    }
    default: {
      if (profile.users === undefined) throw new Error(`businessLoad: a ${profile.type} profile needs users`);
      return `${profile.users} ${unitFor(unit, profile.users)} (${thinkTimeText(workload.thinkTime)}) ≈ ${perMin} ${action}/min`;
    }
  }
}
