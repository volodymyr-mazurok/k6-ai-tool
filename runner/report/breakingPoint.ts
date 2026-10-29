// The stress breaking point: the first load stage the system could not carry, and what gave first.
//
// A stage is broken when, over the stage:
//   - the error rate is above 5%, or
//   - p95 is above 3x the first stage's p95 (the first stage is the reference, so it cannot break on latency), or
//   - k6 dropped iterations (the arrival rate outran the users, which happens when answers get slow).
// The database alone never breaks a stage; it only decides who gave first. Inside the broken stage each signal has a
// time when it first showed (a 15 s bucket that was over the limit; a database sample at CPU or data IO >= 90%) and
// the earliest wins. A tie goes to the database: a saturated database is the cause of API errors that start in the same
// 15 s, not their result. Dropped iterations count as latency.
//
// Buckets and database samples are placed in stages by the middle of their 15 s window, so a timeline that is a few
// seconds off the stage clock (the time series starts at k6's first point, not at the scenario's start) still lands
// each window in the stage where most of it ran. A stage's p95 is the request-weighted mean of its buckets' p95: the
// buckets keep no raw durations, so this is an approximation of the stage's p95, good enough for a 3x test.

import type { Bucket } from '../timeseries.js';
import type { DbSamples } from './model.js';

export interface BreakingPoint {
  /** The req/s of the stage that broke (the profile's number for it). */
  rps: number;
  /** Seconds from the start of the time series when the first signal showed; never before the stage started. */
  atSec: number;
  gaveFirst: 'api-errors' | 'latency' | 'db';
}

export interface Stage {
  fromSec: number;
  rps: number;
}

/** What counts as broken (the numbers of BREAKING_LIMITS, or the ones a run recorded in meta.json). */
export interface BreakingLimits {
  errorRate: number;
  latencyFactor: number;
  dbPct: number;
}

/** What counts as broken. A run copies it into meta.json (`meta.rules`); its report reads it back from there. */
export const BREAKING_LIMITS = {
  /** Error rate over a stage, as a fraction; above this breaks it. */
  errorRate: 0.05,
  /** p95 as a multiple of the first stage's p95; above this breaks it. */
  latencyFactor: 3,
  /** DB CPU or data IO percent that counts as the database giving way (at or above). */
  dbPct: 90,
} as const;

/** dm_db_resource_stats rows are 15 s apart and `t` is a sample's end. */
const SAMPLE_SEC = 15;

type Signal = BreakingPoint['gaveFirst'];
/** Who wins a tie in time. */
const PRIORITY: Record<Signal, number> = { db: 0, 'api-errors': 1, latency: 2 };

interface StageData {
  buckets: Bucket[];
  /** Start (seconds) of each database sample at or above the limit. */
  hot: number[];
}

const sum = (values: number[]): number => values.reduce((total, v) => total + v, 0);

/** Request-weighted mean of the buckets' p95; null when no bucket has both requests and a p95. */
function stageP95(buckets: Bucket[]): number | null {
  const timed = buckets.filter((b): b is Bucket & { p95: number } => b.p95 !== null && b.reqs > 0);
  const weight = sum(timed.map((b) => b.reqs));
  return weight === 0 ? null : sum(timed.map((b) => b.p95 * b.reqs)) / weight;
}

/**
 * The first stage that broke and which signal showed first in it, or null when every stage held.
 * @param buckets the 15 s buckets of timeseries.json
 * @param stages the stress profile's stages (`fromSec`, `rps`), ascending
 * @param db the DB samples (db.json `resource`), if there is a database; samples without a time are ignored
 * @param bucketSec the bucket width (timeseries.json `bucketSec`)
 * @param limits what counts as broken; the code's BREAKING_LIMITS unless the run's recorded ones are given
 */
export function findBreakingPoint(
  buckets: Bucket[],
  stages: Stage[],
  db?: DbSamples | null,
  bucketSec = 15,
  limits: BreakingLimits = BREAKING_LIMITS,
): BreakingPoint | null {
  if (buckets.length === 0 || stages.length === 0) return null;
  const ordered = [...stages].sort((a, b) => a.fromSec - b.fromSec);
  const stageAt = (sec: number): number => ordered.reduce((found, stage, i) => (stage.fromSec <= sec ? i : found), -1);

  const data: StageData[] = ordered.map(() => ({ buckets: [], hot: [] }));
  for (const bucket of buckets) data[stageAt(bucket.t + bucketSec / 2)]?.buckets.push(bucket);
  for (const sample of db?.resource ?? []) {
    if (sample.t === null || !(sample.cpu >= limits.dbPct || sample.dataIo >= limits.dbPct)) continue;
    data[stageAt(sample.t - SAMPLE_SEC / 2)]?.hot.push(sample.t - SAMPLE_SEC);
  }

  const reference = stageP95(data[0]!.buckets);
  const slowAbove = reference === null ? null : reference * limits.latencyFactor;

  for (const [i, stage] of ordered.entries()) {
    const { buckets: inStage, hot } = data[i]!;
    const first = (matches: (b: Bucket) => boolean): number | undefined => inStage.find(matches)?.t;
    const events: { signal: Signal; startSec: number }[] = [];
    const add = (signal: Signal, startSec: number | undefined): void => {
      if (startSec !== undefined) events.push({ signal, startSec });
    };

    const requests = sum(inStage.map((b) => b.reqs));
    if (requests > 0 && sum(inStage.map((b) => b.errors)) / requests > limits.errorRate) {
      add('api-errors', first((b) => b.reqs > 0 && b.errors / b.reqs > limits.errorRate));
    }
    const p95 = stageP95(inStage);
    if (slowAbove !== null && p95 !== null && p95 > slowAbove) {
      add('latency', first((b) => b.p95 !== null && b.p95 > slowAbove));
    }
    add('latency', first((b) => b.dropped > 0));
    if (events.length === 0) continue; // the stage held, whatever the database did

    for (const startSec of hot) add('db', startSec);
    const clamped = events.map((e) => ({ ...e, startSec: Math.max(e.startSec, stage.fromSec) }));
    clamped.sort((a, b) => a.startSec - b.startSec || PRIORITY[a.signal] - PRIORITY[b.signal]);
    const earliest = clamped[0]!;
    return { rps: stage.rps, atSec: earliest.startSec, gaveFirst: earliest.signal };
  }
  return null;
}
