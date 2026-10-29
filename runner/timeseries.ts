// k6's raw points (`--out json=points.json.gz`) turned into 15 s buckets for the report's load chart, plus the list of
// requests the script actually sent (the journey check compares it with journey.yaml).

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';

/** One k6 sample. `time` is epoch milliseconds. */
export interface Point {
  metric: string;
  time: number;
  value: number;
  tags: Record<string, string>;
}

/** One time slice of the run. `t` is its start in seconds from the origin; `p95` is null when no request ended in it. */
export interface Bucket {
  t: number;
  /** Peak active users seen in the bucket (k6 samples `vus` every second). */
  vus: number;
  reqs: number;
  rps: number;
  /** p95 of http_req_duration in ms (nearest rank). */
  p95: number | null;
  /** Failed requests (http_req_failed). */
  errors: number;
  /** Iterations k6 could not start in time (dropped_iterations), a sign the arrival rate outran the users. */
  dropped: number;
}

/** What `timeseries.json` holds. `origin` is the time of t = 0 (ISO, UTC), so other samples (DB %) can be aligned. */
export interface Timeseries {
  bucketSec: number;
  origin: string | null;
  buckets: Bucket[];
  /** Set when points.json.gz was missing or cut short; the buckets hold what could be read. */
  warning?: string;
}

export interface ObservedRequest {
  name: string;
  method: string;
  /**
   * Where the request went. k6 overwrites the `url` tag of a named request with its name, so a step sent through
   * core/request.js `step()` is read from the `path` tag (`/api/items/search`: no host, no query); a request without
   * a name keeps k6's `url` tag, the full URL.
   */
  url: string;
}

/** The metrics the buckets are built from; everything else in points.json.gz is skipped. */
const BUCKET_METRICS = new Set(['vus', 'http_reqs', 'http_req_duration', 'http_req_failed', 'dropped_iterations']);

/** The Point lines of a gzipped k6 JSON output, in file order. Metric definition lines are skipped. */
export async function* readPoints(gzPath: string): AsyncIterable<Point> {
  const gunzip = createGunzip();
  // pipe() does not forward errors: a missing file must reach the reader, not crash the process
  const source = createReadStream(gzPath).on('error', (err) => gunzip.destroy(err));
  const lines = createInterface({ input: source.pipe(gunzip), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    const entry = JSON.parse(line) as { type?: string; metric?: string; data?: { time?: string; value?: number; tags?: Record<string, string> | null } };
    if (entry.type !== 'Point' || !entry.metric || !entry.data?.time) continue;
    yield { metric: entry.metric, time: Date.parse(entry.data.time), value: Number(entry.data.value), tags: entry.data.tags ?? {} };
  }
}

/** Nearest-rank percentile of an ascending list: the smallest value with at least `p` of the list at or below it. */
function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!;
}

/**
 * Cut the points into `bucketSec` slices counted from `origin` (epoch ms; default the earliest point). Every slice up to
 * the last point is present, empty ones as zeros, so the chart's time axis has no holes.
 */
export function bucketize(points: Point[], bucketSec = 15, origin?: number): Bucket[] {
  if (points.length === 0) return [];
  const start = origin ?? points.reduce((min, p) => Math.min(min, p.time), Infinity);
  const sizeMs = bucketSec * 1000;
  const last = points.reduce((max, p) => Math.max(max, p.time), -Infinity);
  const count = Math.max(0, Math.floor((last - start) / sizeMs)) + 1;

  const acc = Array.from({ length: count }, () => ({ vus: 0, reqs: 0, errors: 0, dropped: 0, durations: [] as number[] }));
  for (const p of points) {
    if (p.time < start) continue;
    const slot = acc[Math.floor((p.time - start) / sizeMs)]!;
    switch (p.metric) {
      case 'vus':
        slot.vus = Math.max(slot.vus, p.value);
        break;
      case 'http_reqs':
        slot.reqs += p.value;
        break;
      case 'http_req_duration':
        slot.durations.push(p.value);
        break;
      case 'http_req_failed':
        slot.errors += p.value;
        break;
      case 'dropped_iterations':
        slot.dropped += p.value;
        break;
    }
  }
  return acc.map((slot, i) => ({
    t: i * bucketSec,
    vus: slot.vus,
    reqs: slot.reqs,
    rps: slot.reqs / bucketSec,
    p95: percentile(slot.durations.sort((a, b) => a - b), 0.95),
    errors: slot.errors,
    dropped: slot.dropped,
  }));
}

/** Every distinct (name, method, url) the script requested, in first-seen order, from the `http_reqs` points' tags. */
export function observedRequests(points: Iterable<Point>): ObservedRequest[] {
  const seen = new Map<string, ObservedRequest>();
  for (const p of points) {
    if (p.metric !== 'http_reqs') continue;
    const request = { name: p.tags.name ?? '', method: p.tags.method ?? '', url: p.tags.path || p.tags.url || '' };
    const key = `${request.method} ${request.name} ${request.url}`;
    if (!seen.has(key)) seen.set(key, request);
  }
  return [...seen.values()];
}

/**
 * Read a run's points file into `timeseries.json` content and the observed requests. Only the bucket metrics are
 * kept in memory, with only the tags observedRequests needs. A missing or truncated file (k6 killed) is not an
 * error: the buckets hold what could be read and `warning` says what happened.
 */
export async function buildTimeseries(
  gzPath: string,
  bucketSec = 15,
): Promise<{ timeseries: Timeseries; observed: ObservedRequest[] }> {
  const points: Point[] = [];
  let warning: string | undefined;
  try {
    for await (const p of readPoints(gzPath)) {
      if (!BUCKET_METRICS.has(p.metric) || Number.isNaN(p.time)) continue;
      const tags: Record<string, string> =
        p.metric === 'http_reqs'
          ? { name: p.tags.name ?? '', method: p.tags.method ?? '', url: p.tags.url ?? '', path: p.tags.path ?? '' }
          : {};
      points.push({ metric: p.metric, time: p.time, value: p.value, tags });
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    warning =
      code === 'ENOENT'
        ? 'no points.json.gz: k6 wrote no points'
        : `points.json.gz could not be read to the end (${(err as Error).message}); the time series covers what was read`;
  }
  const origin = points.length === 0 ? undefined : points.reduce((min, p) => Math.min(min, p.time), Infinity);
  const timeseries: Timeseries = {
    bucketSec,
    origin: origin === undefined ? null : new Date(origin).toISOString(),
    buckets: bucketize(points, bucketSec, origin),
  };
  if (warning) timeseries.warning = warning;
  return { timeseries, observed: observedRequests(points) };
}
