import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { bucketize, buildTimeseries, observedRequests, readPoints, type Point } from './timeseries.js';

const T0 = Date.parse('2026-10-22T18:00:00.000Z');

const point = (metric: string, offsetMs: number, value: number, tags: Record<string, string> = {}): Point => ({
  metric,
  time: T0 + offsetMs,
  value,
  tags,
});

test('bucketize computes rps and p95 per 15 s bucket', () => {
  const points: Point[] = [];
  // bucket 0: 30 requests with durations 1..30 spread over the first 15 s, plus 70 more durations 31..100
  for (let i = 0; i < 30; i++) points.push(point('http_reqs', i * 400, 1));
  for (let d = 1; d <= 100; d++) points.push(point('http_req_duration', d * 100, d));
  // bucket 1: 15 requests -> 1 req/s
  for (let i = 0; i < 15; i++) points.push(point('http_reqs', 15_000 + i * 900, 1));
  points.push(point('http_req_duration', 15_500, 400));

  const buckets = bucketize(points);

  assert.equal(buckets.length, 2);
  assert.equal(buckets[0]!.t, 0);
  assert.equal(buckets[0]!.reqs, 30);
  assert.equal(buckets[0]!.rps, 2);
  assert.equal(buckets[0]!.p95, 95);
  assert.equal(buckets[1]!.t, 15);
  assert.equal(buckets[1]!.reqs, 15);
  assert.equal(buckets[1]!.rps, 1);
  assert.equal(buckets[1]!.p95, 400);
});

test('bucketize counts errors and dropped iterations, keeps the peak users and fills empty buckets', () => {
  const points: Point[] = [
    point('vus', 0, 1),
    point('vus', 5_000, 4),
    point('vus', 10_000, 3),
    point('http_req_failed', 1_000, 1),
    point('http_req_failed', 2_000, 0),
    point('http_req_failed', 3_000, 1),
    point('dropped_iterations', 4_000, 2),
    point('dropped_iterations', 4_500, 1),
    // nothing at all in 15..30 s
    point('vus', 31_000, 2),
  ];

  const buckets = bucketize(points, 15);

  assert.deepEqual(
    buckets.map((b) => ({ t: b.t, vus: b.vus, errors: b.errors, dropped: b.dropped, reqs: b.reqs, p95: b.p95 })),
    [
      { t: 0, vus: 4, errors: 2, dropped: 3, reqs: 0, p95: null },
      { t: 15, vus: 0, errors: 0, dropped: 0, reqs: 0, p95: null },
      { t: 30, vus: 2, errors: 0, dropped: 0, reqs: 0, p95: null },
    ],
  );
});

test('bucketize measures time from the given origin, or from the earliest point', () => {
  const points = [point('http_reqs', 20_000, 1), point('http_reqs', 2_000, 1)];
  assert.deepEqual(
    bucketize(points).map((b) => [b.t, b.reqs]),
    [
      [0, 1],
      [15, 1],
    ],
  );
  assert.deepEqual(
    bucketize(points, 10, T0 - 10_000).map((b) => [b.t, b.reqs]),
    [
      [0, 0],
      [10, 1],
      [20, 0],
      [30, 1],
    ],
  );
  assert.deepEqual(bucketize([]), []);
});

test('observedRequests lists each name, method and url once', () => {
  const tags = (name: string, method: string, url: string) => ({ name, method, url, status: '200' });
  const points: Point[] = [
    point('http_reqs', 0, 1, tags('auth_token', 'POST', 'http://127.0.0.1:1/oauth/token')),
    point('http_reqs', 10, 1, tags('items.search', 'POST', 'http://127.0.0.1:1/api/items/search')),
    point('http_req_duration', 10, 25, tags('items.search', 'POST', 'http://127.0.0.1:1/api/items/search')),
    point('http_reqs', 20, 1, tags('items.search', 'POST', 'http://127.0.0.1:1/api/items/search')),
    point('http_reqs', 30, 1, tags('http://127.0.0.1:1/api/items/x', 'GET', 'http://127.0.0.1:1/api/items/x')),
  ];

  assert.deepEqual(observedRequests(points), [
    { name: 'auth_token', method: 'POST', url: 'http://127.0.0.1:1/oauth/token' },
    { name: 'items.search', method: 'POST', url: 'http://127.0.0.1:1/api/items/search' },
    { name: 'http://127.0.0.1:1/api/items/x', method: 'GET', url: 'http://127.0.0.1:1/api/items/x' },
  ]);
});

test('observedRequests reads the route of a named request from the path tag, because k6 overwrites its url tag with the name', async () => {
  // What k6 really writes for http.request(..., { tags: { name: 'items.search', path: '/api/items/search' } }):
  const named = { name: 'items.search', method: 'POST', url: 'items.search', path: '/api/items/search' };
  const unnamed = { name: 'http://x/api/items/x?a=1', method: 'GET', url: 'http://x/api/items/x?a=1' };
  const lines = [named, named, unnamed].map((tags, i) => ({
    metric: 'http_reqs',
    type: 'Point',
    data: { time: `2026-10-22T21:00:0${i}+03:00`, value: 1, tags },
  }));
  const dir = await mkdtemp(join(tmpdir(), 'perf-ts-'));
  try {
    const { observed } = await buildTimeseries(await writePointsFile(dir, lines));
    assert.deepEqual(observed, [
      { name: 'items.search', method: 'POST', url: '/api/items/search' },
      { name: 'http://x/api/items/x?a=1', method: 'GET', url: 'http://x/api/items/x?a=1' },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A gzipped k6 JSON output file: Metric lines (skipped) and Point lines. */
async function writePointsFile(dir: string, lines: unknown[]): Promise<string> {
  const file = join(dir, 'points.json.gz');
  await writeFile(file, gzipSync(lines.map((l) => JSON.stringify(l)).join('\n') + '\n'));
  return file;
}

const K6_LINES = [
  { type: 'Metric', data: { name: 'http_reqs', type: 'counter' }, metric: 'http_reqs' },
  {
    metric: 'http_reqs',
    type: 'Point',
    data: { time: '2026-10-22T21:00:00.250000+03:00', value: 1, tags: { name: 'items.search', method: 'POST', url: 'http://x/api/items/search' } },
  },
  {
    metric: 'http_req_duration',
    type: 'Point',
    data: { time: '2026-10-22T21:00:00.250000+03:00', value: 21.5, tags: { name: 'items.search', method: 'POST', url: 'http://x/api/items/search' } },
  },
  { metric: 'vus', type: 'Point', data: { time: '2026-10-22T21:00:16.000000+03:00', value: 3, tags: {} } },
  { metric: 'data_sent', type: 'Point', data: { time: '2026-10-22T21:00:16.000000+03:00', value: 999, tags: {} } },
];

test('readPoints yields the Point lines of a gzipped k6 JSON output with epoch-ms times', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-ts-'));
  try {
    const file = await writePointsFile(dir, K6_LINES);
    const points: Point[] = [];
    for await (const p of readPoints(file)) points.push(p);
    assert.equal(points.length, 4);
    assert.deepEqual(points[0], {
      metric: 'http_reqs',
      time: Date.parse('2026-10-22T18:00:00.250Z'),
      value: 1,
      tags: { name: 'items.search', method: 'POST', url: 'http://x/api/items/search' },
    });
    assert.equal(points[2]!.metric, 'vus');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildTimeseries buckets a points file and reports where t = 0 is', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-ts-'));
  try {
    const file = await writePointsFile(dir, K6_LINES);
    const { timeseries, observed } = await buildTimeseries(file);
    assert.equal(timeseries.bucketSec, 15);
    assert.equal(timeseries.origin, '2026-10-22T18:00:00.250Z');
    assert.deepEqual(
      timeseries.buckets.map((b) => ({ t: b.t, vus: b.vus, reqs: b.reqs, p95: b.p95 })),
      [
        { t: 0, vus: 0, reqs: 1, p95: 21.5 },
        { t: 15, vus: 3, reqs: 0, p95: null },
      ],
    );
    assert.equal(timeseries.warning, undefined);
    assert.deepEqual(observed, [{ name: 'items.search', method: 'POST', url: 'http://x/api/items/search' }]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('buildTimeseries of a missing or truncated file keeps what it could read and says why', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-ts-'));
  try {
    const missing = await buildTimeseries(join(dir, 'nope.json.gz'));
    assert.deepEqual(missing.timeseries.buckets, []);
    assert.equal(missing.timeseries.origin, null);
    assert.match(missing.timeseries.warning ?? '', /points/);

    const full = gzipSync(K6_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n');
    const truncated = join(dir, 'cut.json.gz');
    await writeFile(truncated, full.subarray(0, full.length - 12));
    const cut = await buildTimeseries(truncated);
    assert.match(cut.timeseries.warning ?? '', /points/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
