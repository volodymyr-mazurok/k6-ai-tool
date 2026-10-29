import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Bucket } from '../timeseries.js';
import {
  BREAKING_LIMITS,
  FLAG_LIMITS,
  businessLoad,
  computeFlags,
  computeVerdict,
  crossedThresholds,
  dbHoldAverage,
  findBreakingPoint,
  stepStats,
  targetsMissed,
  type BaselineSlot,
  type DbSamples,
  type K6Summary,
  type StepStat,
  type VerdictMeta,
} from './model.js';

const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/report', import.meta.url));
const readFixture = <T>(run: 'load' | 'stress', file: string): T => JSON.parse(readFileSync(join(FIXTURES, run, file), 'utf8')) as T;

const STEP_IDS = ['analyst.grid_open', 'analyst.grid_search', 'analyst.grid_sort', 'analyst.grid_filter', 'analyst.grid_next_page', 'analyst.grid_export'];

const WORKLOAD = { businessUnit: 'analysts working', businessAction: 'grid actions', thinkTime: { min: 2, max: 6 } };

/** A StepStat with healthy numbers; tests override what they probe. */
const stat = (id: string, over: Partial<StepStat> = {}): StepStat => ({
  id,
  count: 300,
  rps: 0.5,
  p50: 400,
  p95: 800,
  p99: 1200,
  errorRate: 0,
  checkRate: 1,
  ...over,
});

const baselineOf = (steps: Record<string, number>): BaselineSlot => ({
  runId: '2026-10-01_2010_acme_forms_load',
  acceptedAt: '2026-10-01T21:00:00.000Z',
  steps: Object.fromEntries(Object.entries(steps).map(([id, p95]) => [id, { p50: p95 / 2, p95, p99: p95 * 1.5, errorRate: 0, rps: 0.5 }])),
});

const cleanMeta = (): VerdictMeta => readFixture<VerdictMeta>('load', 'meta.json');

// ---------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------

test('report fixtures are synthetic: no token, no setup_data, no connection detail', () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(path);
    }
  };
  walk(FIXTURES);
  assert.ok(files.length >= 8, `expected the load and stress fixtures, found ${files.length} files`);
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    assert.ok(!text.includes('eyJ'), `${file} holds a JWT-looking string`);
    assert.ok(!text.includes('setup_data'), `${file} holds setup_data`);
    assert.ok(!/Bearer |password|secret/i.test(text), `${file} holds credential-looking text`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// stepStats
// ---------------------------------------------------------------------------------------------------------------

test('stepStats reads p50/p95/p99, errorRate and checkRate from sub-metrics', () => {
  const summary = readFixture<K6Summary>('load', 'summary.json');
  const stats = stepStats(summary, STEP_IDS, 780);

  assert.deepEqual(
    stats.map((s) => s.id),
    STEP_IDS,
    'one stat per step, in the order asked',
  );
  const open = stats.find((s) => s.id === 'analyst.grid_open')!;
  assert.deepEqual(open, {
    id: 'analyst.grid_open',
    count: 300,
    rps: 300 / 780,
    p50: 520.304,
    p95: 1010.236,
    p99: 1450.9,
    errorRate: 0,
    checkRate: 1,
  });
  const search = stats.find((s) => s.id === 'analyst.grid_search')!;
  assert.equal(search.p50, 610.771);
  assert.equal(search.p95, 1240.66);
  assert.equal(search.p99, 1900.305);
  assert.equal(search.checkRate, 899 / 900, 'one failed check in 900');
  assert.equal(stats.find((s) => s.id === 'analyst.grid_filter')!.errorRate, 1 / 300, 'one failed request in 300');
  assert.equal(stats.find((s) => s.id === 'analyst.grid_export')!.count, 15);
});

test('stepStats gives null for a rate with no samples (not 0) and leaves out a step that sent nothing', () => {
  const summary = readFixture<K6Summary>('load', 'summary.json');
  const stats = stepStats(summary, ['auth_token', 'analyst.never_ran'], 780);

  assert.deepEqual(
    stats.map((s) => s.id),
    ['auth_token'],
    'a step with no duration metric is not reported',
  );
  assert.equal(stats[0]!.checkRate, null, 'checks{name:auth_token} has 0 passes and 0 fails');
  assert.equal(stats[0]!.errorRate, 0, 'its one request did not fail');
});

test('stepStats leaves out a step whose duration metric has no samples', () => {
  const summary: K6Summary = { metrics: { 'http_req_duration{name:a.b}': { values: { count: 0, med: 0, 'p(95)': 0, 'p(99)': 0 } } } };
  assert.deepEqual(stepStats(summary, ['a.b'], 60), []);
});

test('stepStats refuses a duration it cannot divide by', () => {
  const summary = readFixture<K6Summary>('load', 'summary.json');
  assert.throws(() => stepStats(summary, STEP_IDS, 0), RangeError);
  assert.throws(() => stepStats(summary, STEP_IDS, Number.NaN), RangeError);
});

// ---------------------------------------------------------------------------------------------------------------
// computeFlags
// ---------------------------------------------------------------------------------------------------------------

test('p95 1000→1250 is flagged', () => {
  const flags = computeFlags({ steps: [stat('a.x', { p95: 1250 })], baseline: baselineOf({ 'a.x': 1000 }) });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.code, 'P95_REGRESSION');
  assert.equal(flags[0]!.step, 'a.x');
  assert.match(flags[0]!.detail, /1250 ms/);
  assert.match(flags[0]!.detail, /1000 ms/);
  assert.match(flags[0]!.detail, /\+25%/);
});

test('p95 100→130 is not flagged (+30 ms)', () => {
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { p95: 130 })], baseline: baselineOf({ 'a.x': 100 }) }), []);
});

test('p95 1000→1150 is not flagged (+15%)', () => {
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { p95: 1150 })], baseline: baselineOf({ 'a.x': 1000 }) }), []);
});

test('p95 needs both limits: exactly +20% and exactly +100 ms are not enough', () => {
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { p95: 1200 })], baseline: baselineOf({ 'a.x': 1000 }) }), [], '+20% exactly');
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { p95: 400 })], baseline: baselineOf({ 'a.x': 300 }) }), [], '+100 ms exactly (and +33%)');
  assert.equal(computeFlags({ steps: [stat('a.x', { p95: 401 })], baseline: baselineOf({ 'a.x': 300 }) }).length, 1, '+101 ms and +34%');
});

test('p95 is compared only for steps the baseline knows; an improvement is never flagged', () => {
  const steps = [stat('a.new', { p95: 9000 }), stat('a.fast', { p95: 100 })];
  assert.deepEqual(computeFlags({ steps, baseline: baselineOf({ 'a.fast': 900, 'a.gone': 100 }) }), []);
  assert.deepEqual(computeFlags({ steps }), [], 'no baseline: no regression flag');
});

test('computeFlags applies the limits it is given (the ones recorded with a run), not the current ones', () => {
  const steps = [stat('a.x', { errorRate: 0.011, p95: 1250, checkRate: 0.99 })];
  const baseline = baselineOf({ 'a.x': 1000 });
  const strict = { ...FLAG_LIMITS, errorRate: 0.001, checkFailureRate: 0.001, p95Factor: 1.1, p95AddMs: 10 };
  const lax = { ...FLAG_LIMITS, errorRate: 0.5, checkFailureRate: 0.5, p95Factor: 5, p95AddMs: 5000 };
  assert.deepEqual(computeFlags({ steps, baseline, limits: lax }), []);
  assert.deepEqual(
    computeFlags({ steps, baseline, limits: strict }).map((f) => f.code),
    ['ERRORS', 'CHECKS', 'P95_REGRESSION'],
  );
  const hot = { cpu: 70, dataIo: 10, samples: 4 };
  assert.deepEqual(computeFlags({ steps: [], dbHoldAvg: hot, limits: { ...FLAG_LIMITS, dbPct: 60 } }).map((f) => f.code), ['DB_HOT']);
  assert.deepEqual(computeFlags({ steps, baseline }), computeFlags({ steps, baseline, limits: FLAG_LIMITS }), 'the default is the code\'s limits');
});

test('errorRate 0.011 flags ERRORS', () => {
  const flags = computeFlags({ steps: [stat('a.x', { errorRate: 0.011 })] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.code, 'ERRORS');
  assert.equal(flags[0]!.step, 'a.x');
  assert.match(flags[0]!.detail, /1\.1%/);
});

test('errorRate exactly 0.01 is not flagged, and a null rate is skipped', () => {
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { errorRate: 0.01 }), stat('a.y', { errorRate: null })] }), []);
});

test('checkRate 0.994 flags CHECKS', () => {
  const flags = computeFlags({ steps: [stat('a.x', { checkRate: 0.994 })] });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.code, 'CHECKS');
  assert.equal(flags[0]!.step, 'a.x');
  assert.match(flags[0]!.detail, /0\.6%/);
});

test('check failures of exactly 0.5% (checkRate 0.995) are not flagged, and a null rate is skipped', () => {
  assert.deepEqual(computeFlags({ steps: [stat('a.x', { checkRate: 0.995 }), stat('a.y', { checkRate: null })] }), []);
});

test('db hold avg 81 flags DB_HOT', () => {
  const flags = computeFlags({ steps: [], dbHoldAvg: { cpu: 81, dataIo: 10, samples: 40 } });
  assert.equal(flags.length, 1);
  assert.equal(flags[0]!.code, 'DB_HOT');
  assert.equal(flags[0]!.step, undefined);
  assert.match(flags[0]!.detail, /CPU/);
  assert.match(flags[0]!.detail, /81%/);
  assert.ok(!/data IO/.test(flags[0]!.detail), 'only the metric over the limit is named');
});

test('DB_HOT names data IO when IO is the hot one, both when both are, and 80 exactly is fine', () => {
  const io = computeFlags({ steps: [], dbHoldAvg: { cpu: 10, dataIo: 85.5, samples: 40 } });
  assert.match(io[0]!.detail, /data IO/);
  assert.match(io[0]!.detail, /85\.5%/);
  const both = computeFlags({ steps: [], dbHoldAvg: { cpu: 90, dataIo: 85, samples: 40 } });
  assert.equal(both.length, 1, 'one flag for the database');
  assert.match(both[0]!.detail, /CPU/);
  assert.match(both[0]!.detail, /data IO/);
  assert.deepEqual(computeFlags({ steps: [], dbHoldAvg: { cpu: 80, dataIo: 80, samples: 40 } }), []);
  assert.deepEqual(computeFlags({ steps: [] }), [], 'no DB reading: no flag');
});

test('flags come in step order, then the database', () => {
  const flags = computeFlags({
    steps: [stat('a.one', { errorRate: 0.5, checkRate: 0.5 }), stat('a.two', { errorRate: 0.5 })],
    dbHoldAvg: { cpu: 99, dataIo: 99, samples: 40 },
  });
  assert.deepEqual(
    flags.map((f) => `${f.code}:${f.step ?? '-'}`),
    ['ERRORS:a.one', 'CHECKS:a.one', 'ERRORS:a.two', 'DB_HOT:-'],
  );
});

test('the load fixture raises no flags against itself', () => {
  const summary = readFixture<K6Summary>('load', 'summary.json');
  const steps = stepStats(summary, STEP_IDS, 780);
  const baseline = baselineOf(Object.fromEntries(steps.map((s) => [s.id, s.p95])));
  const db = readFixture<DbSamples>('load', 'db.json');
  assert.deepEqual(computeFlags({ steps, baseline, dbHoldAvg: dbHoldAverage(db, { fromSec: 120, toSec: 720 }) }), []);
});

// ---------------------------------------------------------------------------------------------------------------
// dbHoldAverage
// ---------------------------------------------------------------------------------------------------------------

test('dbHoldAverage averages the samples inside the hold window, ends included', () => {
  const db: DbSamples = {
    resource: [
      { t: 100, cpu: 99, dataIo: 99 }, // ramp-up
      { t: 120, cpu: 10, dataIo: 20 }, // window start
      { t: 400, cpu: 30, dataIo: 40 },
      { t: 720, cpu: 50, dataIo: 60 }, // window end
      { t: 735, cpu: 99, dataIo: 99 }, // ramp-down
      { t: null, cpu: 99, dataIo: 99 }, // cannot be placed
    ],
  };
  assert.deepEqual(dbHoldAverage(db, { fromSec: 120, toSec: 720 }), { cpu: 30, dataIo: 40, samples: 3 });
});

test('dbHoldAverage is undefined with no window, no DB or no sample inside', () => {
  const db: DbSamples = { resource: [{ t: 10, cpu: 50, dataIo: 50 }] };
  assert.equal(dbHoldAverage(db, undefined), undefined);
  assert.equal(dbHoldAverage(undefined, { fromSec: 0, toSec: 100 }), undefined);
  assert.equal(dbHoldAverage(db, { fromSec: 200, toSec: 300 }), undefined);
});

test('dbHoldAverage on the load fixture reads the hold phase only', () => {
  const avg = dbHoldAverage(readFixture<DbSamples>('load', 'db.json'), { fromSec: 120, toSec: 720 })!;
  assert.equal(avg.samples, 40);
  assert.ok(avg.cpu > 39 && avg.cpu < 41, `cpu ${avg.cpu}`);
  assert.ok(avg.dataIo > 51 && avg.dataIo < 53, `io ${avg.dataIo}`);
});

// ---------------------------------------------------------------------------------------------------------------
// targetsMissed
// ---------------------------------------------------------------------------------------------------------------

test('targetsMissed is empty in baseline mode', () => {
  assert.deepEqual(targetsMissed([stat('a.x', { p95: 99999 })], 'baseline'), []);
});

test('targetsMissed lists the steps whose p95 is over their explicit target', () => {
  const steps = [stat('a.x', { p95: 1001 }), stat('a.y', { p95: 1000 }), stat('a.z', { p95: 5000 })];
  const targets = { 'a.x': { p95Ms: 1000 }, 'a.y': { p95Ms: 1000 }, 'a.unknown': { p95Ms: 1 } };
  assert.deepEqual(targetsMissed(steps, targets), ['a.x'], 'equal is met; a step with no target or no data is not a miss');
});

// ---------------------------------------------------------------------------------------------------------------
// computeVerdict
// ---------------------------------------------------------------------------------------------------------------

test('clean with baseline → PASS', () => {
  const v = computeVerdict({ meta: cleanMeta(), flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'PASS');
  assert.equal(v.reasons.length, 1);
});

test('any flag with baseline → DEGRADED', () => {
  const flags = computeFlags({ steps: [stat('a.x', { errorRate: 0.02 })] });
  const v = computeVerdict({ meta: cleanMeta(), flags, hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'DEGRADED');
  assert.equal(v.reasons.length, 1);
  assert.match(v.reasons[0]!, /ERRORS/);
  assert.match(v.reasons[0]!, /a\.x/);
});

test('no baseline → NO BASELINE', () => {
  const v = computeVerdict({ meta: cleanMeta(), flags: [], hasBaseline: false, targetsMissed: [] });
  assert.equal(v.verdict, 'NO BASELINE');
  assert.match(v.reasons[0]!, /baseline/i);
});

test('NO BASELINE still mentions the flags the run raised', () => {
  const flags = computeFlags({ steps: [stat('a.x', { errorRate: 0.02 })], dbHoldAvg: { cpu: 90, dataIo: 10, samples: 40 } });
  const v = computeVerdict({ meta: cleanMeta(), flags, hasBaseline: false, targetsMissed: [] });
  assert.equal(v.verdict, 'NO BASELINE');
  assert.ok(v.reasons.some((r) => /2 automatic flags/.test(r)), v.reasons.join(' | '));
});

test('crossedThresholds lists the metric and the expression of every threshold k6 marked not ok', () => {
  const summary: K6Summary = {
    metrics: {
      http_req_duration: { type: 'trend', values: {}, thresholds: { 'p(95)<300': { ok: false }, 'max>=0': { ok: true } } } as never,
      http_req_failed: { type: 'rate', values: {}, thresholds: { 'rate<0.1': { ok: true } } } as never,
      'http_req_duration{name:a.b}': { type: 'trend', values: {}, thresholds: { 'max>=0': { ok: true } } } as never,
      checks: { type: 'rate', values: {} } as never,
    },
  };
  assert.deepEqual(crossedThresholds(summary), ['http_req_duration p(95)<300']);
  assert.deepEqual(crossedThresholds({ metrics: {} }), []);
  assert.deepEqual(crossedThresholds(undefined), []);
});

test('a threshold abort names the metric that tripped when the summary says which', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: 99, signal: null, scriptErrors: 0, abortReason: 'thresholds' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [], crossed: ['http_req_failed rate<0.1'] });
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.reasons.some((r) => /aborted by a k6 threshold: http_req_failed rate<0\.1 was crossed/.test(r)), v.reasons.join(' | '));
  const unknown = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.ok(unknown.reasons.some((r) => /aborted by a k6 threshold \(error rate or p95 too high\)/.test(r)), 'no summary: the generic wording');
});

test('exit code 99 names the crossed metric even when the runner recorded no abort (a threshold that failed at the end)', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: 99, signal: null, scriptErrors: 0 };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [], crossed: ['http_req_duration p(95)<300'] });
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.reasons.some((r) => /k6 exited with code 99: http_req_duration p\(95\)<300 was crossed/.test(r)), v.reasons.join(' | '));
  const plain = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.ok(plain.reasons.some((r) => r === 'k6 exited with code 99'), plain.reasons.join(' | '));
});

test('abort → FAIL', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: 99, signal: null, scriptErrors: 0, abortReason: 'thresholds' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.reasons.some((r) => /exit(ed)? (with )?code 99/i.test(r)), v.reasons.join(' | '));
  assert.ok(v.reasons.some((r) => /abort/i.test(r)), v.reasons.join(' | '));
});

test('a DB-guard stop is named', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: null, signal: 'SIGTERM', scriptErrors: 0, abortReason: 'db' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.reasons.some((r) => /database/i.test(r)), v.reasons.join(' | '));
});

test('a non-zero k6 exit without an abort is FAIL', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: 107, signal: null, scriptErrors: 0 };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons[0]!, /107/);
});

test('an interrupted run is FAIL', () => {
  const meta = cleanMeta();
  meta.interrupted = true;
  meta.k6 = { exitCode: null, signal: 'SIGINT', scriptErrors: 0, abortReason: 'interrupted' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.ok(v.reasons.some((r) => /interrupted/i.test(r)), v.reasons.join(' | '));
});

test('row counts differ → FAIL', () => {
  const meta = cleanMeta();
  meta.cleanup = { before: { forms: 1000, client: 5000 }, after: { forms: 1003, client: 5000 }, ok: false };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons[0]!, /forms 1000 → 1003/);
  assert.ok(!v.reasons[0]!.includes('client'), 'only the table that changed');
});

test('row counts that could not be read after the run → FAIL with the reason', () => {
  const meta = cleanMeta();
  meta.cleanup = { before: { forms: 1000 }, after: null, ok: false, error: 'ETIMEOUT' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons[0]!, /ETIMEOUT/);
});

test('an explicit target missed → FAIL', () => {
  const v = computeVerdict({ meta: cleanMeta(), flags: [], hasBaseline: true, targetsMissed: ['a.x', 'a.y'] });
  assert.equal(v.verdict, 'FAIL');
  assert.match(v.reasons[0]!, /a\.x, a\.y/);
});

test('failed journey checks or script errors → FAIL', () => {
  const checks = cleanMeta();
  checks.checks = [{ code: 'ROUTE_MISMATCH', journey: 'analyst_forms_grid', step: 'grid_open', detail: 'went to GET /x' }];
  const v1 = computeVerdict({ meta: checks, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v1.verdict, 'FAIL');
  assert.match(v1.reasons[0]!, /journey/i);
  assert.match(v1.reasons[0]!, /ROUTE_MISMATCH/);

  const errors = cleanMeta();
  errors.k6.scriptErrors = 3;
  const v2 = computeVerdict({ meta: errors, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v2.verdict, 'FAIL');
  assert.match(v2.reasons[0]!, /3 script errors/);
});

test('FAIL outranks NO BASELINE and DEGRADED', () => {
  const meta = cleanMeta();
  meta.k6 = { exitCode: 1, signal: null, scriptErrors: 0 };
  const flags = computeFlags({ steps: [stat('a.x', { errorRate: 0.5 })] });
  assert.equal(computeVerdict({ meta, flags, hasBaseline: false, targetsMissed: [] }).verdict, 'FAIL');
  assert.equal(computeVerdict({ meta, flags, hasBaseline: true, targetsMissed: [] }).verdict, 'FAIL');
});

test('fingerprint change + abort → INVALID', () => {
  const meta = cleanMeta();
  meta.fingerprint = { ...meta.fingerprint, changed: true };
  meta.k6 = { exitCode: 99, signal: null, scriptErrors: 0, abortReason: 'thresholds' };
  const v = computeVerdict({ meta, flags: [], hasBaseline: false, targetsMissed: ['a.x'] });
  assert.equal(v.verdict, 'INVALID');
  assert.match(v.reasons[0]!, /redeployed|fingerprint/i);
});

test('an override of the busy check → INVALID', () => {
  const meta = cleanMeta();
  meta.guardrails = { ...meta.guardrails, busyOverride: true };
  const v = computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] });
  assert.equal(v.verdict, 'INVALID');
  assert.match(v.reasons[0]!, /busy/i);
});

test('overriding the window or --allow-max does not make a run INVALID', () => {
  const meta = cleanMeta();
  meta.guardrails = { allowMax: true, windowOverride: true, busyOverride: false };
  assert.equal(computeVerdict({ meta, flags: [], hasBaseline: true, targetsMissed: [] }).verdict, 'PASS');
});

// ---------------------------------------------------------------------------------------------------------------
// findBreakingPoint
// ---------------------------------------------------------------------------------------------------------------

const stressStages = (): { fromSec: number; rps: number }[] => readFixture<{ profile: { stages: { fromSec: number; rps: number }[] } }>('stress', 'meta.json').profile.stages;
const stressBuckets = (): Bucket[] => readFixture<{ buckets: Bucket[] }>('stress', 'timeseries.json').buckets;
const stressDb = (): { resource: { t: number | null; cpu: number; dataIo: number }[] } => readFixture('stress', 'db.json');

test('breaking point at 9 req/s with 6% errors → gaveFirst api-errors', () => {
  const bp = findBreakingPoint(stressBuckets(), stressStages(), stressDb());
  assert.deepEqual(bp, { rps: 9, atSec: 510, gaveFirst: 'api-errors' });
});

test('findBreakingPoint applies the limits it is given', () => {
  const lax = { ...BREAKING_LIMITS, errorRate: 0.5, latencyFactor: 1000, dbPct: 100 };
  assert.equal(findBreakingPoint(stressBuckets(), stressStages(), stressDb(), 15, lax), null, 'a 6% stage is fine when the limit is 50%');
  const strict = { ...BREAKING_LIMITS, errorRate: 0.02 };
  assert.deepEqual(findBreakingPoint(stressBuckets(), stressStages(), stressDb(), 15, strict)?.gaveFirst, 'api-errors');
  assert.deepEqual(findBreakingPoint(stressBuckets(), stressStages(), stressDb()), findBreakingPoint(stressBuckets(), stressStages(), stressDb(), 15, BREAKING_LIMITS));
});

test('no break → null', () => {
  const upTo7 = stressBuckets().filter((b) => b.t < 480);
  assert.equal(findBreakingPoint(upTo7, stressStages(), stressDb()), null);
  assert.equal(findBreakingPoint([], stressStages(), stressDb()), null);
  assert.equal(findBreakingPoint(stressBuckets(), [], stressDb()), null);
});

/** A bucket list from per-stage specs: 8 buckets of 15 s per 120 s stage. */
function stageBuckets(stages: { reqs: number; p95: number | null; errors?: number[]; dropped?: number[] }[]): Bucket[] {
  return stages.flatMap((stage, s) =>
    Array.from({ length: 8 }, (_, i) => ({
      t: (s * 8 + i) * 15,
      vus: 5,
      reqs: stage.reqs,
      rps: stage.reqs / 15,
      p95: stage.p95,
      errors: stage.errors?.[i] ?? 0,
      dropped: stage.dropped?.[i] ?? 0,
    })),
  );
}
const STAGES3 = [
  { fromSec: 0, rps: 1 },
  { fromSec: 120, rps: 3 },
  { fromSec: 240, rps: 5 },
];

test('error rate must be above 5% over the stage: exactly 5% is not a break', () => {
  // 100 requests per bucket, 5 errors in each: exactly 5%
  const buckets = stageBuckets([{ reqs: 100, p95: 300 }, { reqs: 100, p95: 300 }, { reqs: 100, p95: 300, errors: Array(8).fill(5) }]);
  assert.equal(findBreakingPoint(buckets, STAGES3, undefined), null);
  const worse = stageBuckets([{ reqs: 100, p95: 300 }, { reqs: 100, p95: 300 }, { reqs: 100, p95: 300, errors: Array(8).fill(6) }]);
  assert.deepEqual(findBreakingPoint(worse, STAGES3, undefined), { rps: 5, atSec: 240, gaveFirst: 'api-errors' });
});

test('a single bad bucket does not break a stage whose error rate over the stage is within 5%', () => {
  const buckets = stageBuckets([{ reqs: 100, p95: 300 }, { reqs: 100, p95: 300, errors: [0, 0, 9, 0, 0, 0, 0, 0] }, { reqs: 100, p95: 300 }]);
  assert.equal(findBreakingPoint(buckets, STAGES3, undefined), null, '9 errors in 800 requests');
});

test('p95 above 3× the first stage breaks on latency; 3× exactly does not', () => {
  const exactly = stageBuckets([{ reqs: 15, p95: 300 }, { reqs: 45, p95: 600 }, { reqs: 75, p95: 900 }]);
  assert.equal(findBreakingPoint(exactly, STAGES3, undefined), null);
  const over = stageBuckets([{ reqs: 15, p95: 300 }, { reqs: 45, p95: 600 }, { reqs: 75, p95: 901 }]);
  assert.deepEqual(findBreakingPoint(over, STAGES3, undefined), { rps: 5, atSec: 240, gaveFirst: 'latency' });
});

test('the first stage is the latency reference and cannot break on latency', () => {
  const buckets = stageBuckets([{ reqs: 15, p95: 5000 }, { reqs: 45, p95: 5000 }, { reqs: 75, p95: 5000 }]);
  assert.equal(findBreakingPoint(buckets, STAGES3, undefined), null);
});

test('any dropped iterations break a stage, and read as latency (the users could not keep up)', () => {
  const buckets = stageBuckets([{ reqs: 15, p95: 300 }, { reqs: 45, p95: 310, dropped: [0, 0, 0, 0, 0, 2, 0, 0] }, { reqs: 75, p95: 320 }]);
  assert.deepEqual(findBreakingPoint(buckets, STAGES3, undefined), { rps: 3, atSec: 120 + 5 * 15, gaveFirst: 'latency' });
});

test('the first stage can break on errors', () => {
  const buckets = stageBuckets([{ reqs: 15, p95: 300, errors: Array(8).fill(3) }, { reqs: 45, p95: 300 }, { reqs: 75, p95: 300 }]);
  assert.deepEqual(findBreakingPoint(buckets, STAGES3, undefined), { rps: 1, atSec: 0, gaveFirst: 'api-errors' });
});

test('the earliest signal inside the stage names what gave first: latency before errors', () => {
  // 5 req/s stage (240 s): p95 is 1000 from the second bucket (t=255), errors start at the sixth (t=315)
  const stage = { reqs: 75, p95: 1000, errors: [0, 0, 0, 0, 0, 15, 15, 15] };
  const buckets = stageBuckets([{ reqs: 15, p95: 300 }, { reqs: 45, p95: 300 }, stage]);
  buckets[16]!.p95 = 300;
  assert.deepEqual(findBreakingPoint(buckets, STAGES3, undefined), { rps: 5, atSec: 255, gaveFirst: 'latency' });
  // the same stage with the errors first: p95 only climbs at the seventh bucket (t=330); the stage mean
  // (6 × 300 + 2 × 3000) / 8 = 975 is over 3 × 300, so latency broke too, but later than the errors
  const later = stageBuckets([{ reqs: 15, p95: 300 }, { reqs: 45, p95: 300 }, stage]);
  for (let i = 16; i < 22; i++) later[i]!.p95 = 300;
  later[22]!.p95 = 3000;
  later[23]!.p95 = 3000;
  assert.deepEqual(findBreakingPoint(later, STAGES3, undefined), { rps: 5, atSec: 315, gaveFirst: 'api-errors' });
});

test('the database gave first when it crossed 90% before the errors, even by IO alone', () => {
  const db = stressDb();
  // the sample ending at 500.5 s covers 485.5–500.5 s, inside the 9 req/s stage (from 480 s); the errors start at 510 s
  db.resource.find((s) => s.t === 500.5)!.dataIo = 90;
  assert.deepEqual(findBreakingPoint(stressBuckets(), stressStages(), db), { rps: 9, atSec: 485.5, gaveFirst: 'db' });
});

test('89.9% is not a database crossing, and a crossing after the errors does not change the answer', () => {
  const almost = stressDb();
  almost.resource.find((s) => s.t === 500.5)!.cpu = 89.9;
  assert.equal(findBreakingPoint(stressBuckets(), stressStages(), almost)!.gaveFirst, 'api-errors');
  const late = stressDb();
  late.resource.find((s) => s.t === 575.5)!.cpu = 97;
  assert.equal(findBreakingPoint(stressBuckets(), stressStages(), late)!.gaveFirst, 'api-errors');
});

test('only DB samples inside the breaking stage count', () => {
  const db = stressDb();
  db.resource.find((s) => s.t === 275.5)!.cpu = 99; // 5 req/s stage, long before the break
  assert.equal(findBreakingPoint(stressBuckets(), stressStages(), db)!.gaveFirst, 'api-errors');
});

test('a hot database alone is not a breaking point', () => {
  const calm = stressBuckets().map((b) => ({ ...b, errors: 0, p95: 400 }));
  const db = stressDb();
  for (const s of db.resource) s.cpu = 99;
  assert.equal(findBreakingPoint(calm, stressStages(), db), null);
});

test('a tie between the database and the API in the same 15 s goes to the database (cause before symptom)', () => {
  // errors begin in the bucket 510–525 s; the DB sample ending at 525 s covers the same 15 s
  const db = { resource: [{ t: 525, cpu: 91, dataIo: 10 }] };
  assert.deepEqual(findBreakingPoint(stressBuckets(), stressStages(), db), { rps: 9, atSec: 510, gaveFirst: 'db' });
});

test('buckets are placed in stages by their middle, so a timeline a few seconds off still lands in the right stage', () => {
  // the bucket that starts at 118 s spends 2 s in the 1 req/s stage and 13 s in the 3 req/s stage; 60 of its 100 requests fail
  const buckets: Bucket[] = [];
  for (let t = 0; t < 360; t += 15) {
    buckets.push({ t: Math.max(0, t - 2), vus: 2, reqs: 100, rps: 6.7, p95: 300, errors: t === 120 ? 60 : 0, dropped: 0 });
  }
  const bp = findBreakingPoint(buckets, STAGES3, undefined)!;
  assert.equal(bp.rps, 3);
  assert.equal(bp.atSec, 120, 'clamped to the start of the stage');
});

test('DB samples without a time are ignored', () => {
  const db = { resource: [{ t: null, cpu: 99, dataIo: 99 }] };
  assert.equal(findBreakingPoint(stressBuckets(), stressStages(), db)!.gaveFirst, 'api-errors');
});

// ---------------------------------------------------------------------------------------------------------------
// businessLoad
// ---------------------------------------------------------------------------------------------------------------

const loadProfile = { type: 'load' as const, users: 10, rampSec: 120, holdSec: 600, rampDownSec: 60, totalSec: 780, holdWindow: { fromSec: 120, toSec: 720 } };

test('businessLoad renders the exact sentence', () => {
  const steps = [1, 2, 3, 4, 5].map((n) => stat(`a.s${n}`, { count: 280 })); // 1400 requests in 10 minutes
  assert.equal(businessLoad(WORKLOAD, loadProfile, steps, 600), '10 analysts working (pausing 2–6 s between actions) ≈ 140 grid actions/min');
});

test('businessLoad counts the steps given, per minute of the duration given, rounded', () => {
  const summary = readFixture<K6Summary>('load', 'summary.json');
  const steps = stepStats(summary, STEP_IDS, 780); // 1515 requests in 13 minutes = 116.5
  assert.equal(businessLoad(WORKLOAD, loadProfile, steps, 780), '10 analysts working (pausing 2–6 s between actions) ≈ 117 grid actions/min');
});

test('businessLoad words one user, equal pauses and no pause', () => {
  const steps = [stat('a.x', { count: 60 })];
  const one = { ...loadProfile, users: 1 };
  assert.equal(businessLoad(WORKLOAD, one, steps, 60), '1 analyst working (pausing 2–6 s between actions) ≈ 60 grid actions/min');
  assert.equal(businessLoad({ ...WORKLOAD, thinkTime: { min: 4, max: 4 } }, loadProfile, steps, 60), '10 analysts working (pausing 4 s between actions) ≈ 60 grid actions/min');
  assert.equal(businessLoad({ ...WORKLOAD, thinkTime: { min: 0, max: 0 } }, loadProfile, steps, 60), '10 analysts working (no pausing between actions) ≈ 60 grid actions/min');
});

test('businessLoad words a soak like a load', () => {
  const steps = [stat('a.x', { count: 120 })];
  assert.equal(businessLoad(WORKLOAD, { ...loadProfile, type: 'soak' }, steps, 60), '10 analysts working (pausing 2–6 s between actions) ≈ 120 grid actions/min');
});

test('businessLoad words a stress run by its arrival rate, with no pausing', () => {
  const summary = readFixture<K6Summary>('stress', 'summary.json');
  const profile = readFixture<{ profile: Parameters<typeof businessLoad>[1] }>('stress', 'meta.json').profile;
  const steps = stepStats(summary, STEP_IDS, 720); // 4319 requests in 12 minutes = 359.9
  assert.equal(businessLoad(WORKLOAD, profile, steps, 720), 'arrival rate stepped up from 1 to 11 req/s (no pausing between actions) ≈ 360 grid actions/min on average');
  const flat = { type: 'stress' as const, stages: [{ fromSec: 0, rps: 5 }], totalSec: 60 };
  assert.equal(businessLoad(WORKLOAD, flat, [stat('a.x', { count: 300 })], 60), 'arrival rate held at 5 req/s (no pausing between actions) ≈ 300 grid actions/min on average');
});

test('businessLoad words a smoke run as a check, not a load', () => {
  const steps = [stat('a.x', { count: 5 }), stat('a.y', { count: 1 })];
  assert.equal(businessLoad(WORKLOAD, { type: 'smoke', totalSec: 0 }, steps, 20.4), 'smoke check: each journey once, 6 grid actions in 20 s (not a load)');
});

test('businessLoad refuses a duration it cannot divide by, and a hold profile without users', () => {
  const steps = [stat('a.x')];
  assert.throws(() => businessLoad(WORKLOAD, loadProfile, steps, 0), RangeError);
  assert.throws(() => businessLoad(WORKLOAD, { type: 'load', totalSec: 60 }, steps, 60), /users/);
});
