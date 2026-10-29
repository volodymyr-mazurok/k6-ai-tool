import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatNumber } from './formats.js';
import { evaluate, jsonPath, SourceError, source, window, type Sources } from './sources.js';
import { verifyHtml } from './verify.js';

const near = (actual: number, expected: number): void => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

const sources: Sources = {
  'summary.json': {
    state: { testRunDurationMs: 20000 },
    metrics: {
      'http_req_duration{name:a.b}': { values: { count: 40, 'p(95)': 812.4, med: 300 } },
      'checks{name:a.b}': { values: { passes: 199, fails: 1 } },
      'http_req_failed{name:a.b}': { values: { passes: 0, fails: 0 } },
      http_reqs: { values: { count: 7 } },
    },
  },
  'timeseries.json': {
    buckets: [
      { t: 0, vus: 1, reqs: 2, p95: 100, errors: 0 },
      { t: 15, vus: 4, reqs: 6, p95: null, errors: 1 },
      { t: 30, vus: 6, reqs: 10, p95: 300, errors: 2 },
      { t: 45, vus: 6, reqs: 12, p95: 500, errors: 0 },
    ],
  },
  'db.json': { resource: [{ t: null, cpu: 90 }, { t: 10, cpu: 20 }, { t: 25, cpu: 40 }, { t: 40, cpu: 60 }] },
  // what a run folder's meta.json carries: the profile, the baseline slot used and the limits applied
  'meta.json': {
    profile: { users: 10, stages: [{ fromSec: 0, rps: 1 }, { fromSec: 120, rps: 3 }] },
    baseline: { env: 'staging', profile: 'load', runId: 'r1', acceptedAt: '2026-10-01T21:00:00.000Z', steps: { 'a.b': { p95: 700 } } },
    rules: { flags: { errorRate: 0.01, p95AddMs: 100, p95Factor: 1.2 }, breaking: { latencyFactor: 3 } },
  },
};

// ---------------------------------------------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------------------------------------------

test('jsonPath writes identifiers with dots, other keys in brackets, indexes and windows', () => {
  assert.equal(jsonPath(['metrics', 'http_req_duration{name:a.b}', 'values', 'p(95)']), 'metrics["http_req_duration{name:a.b}"].values["p(95)"]');
  assert.equal(jsonPath(['profile', 'stages', 2, 'rps']), 'profile.stages[2].rps');
  assert.equal(jsonPath(['staging', 'load', 'steps']), 'staging.load.steps');
  assert.equal(jsonPath(['buckets', window('t', 120, 720), 'reqs']), 'buckets[t>=120&t<720].reqs');
  assert.equal(jsonPath(['buckets', window('t', -7.5, null), 'reqs']), 'buckets[t>=-7.5].reqs');
  assert.equal(source('meta.json', 'baseline', 'steps', 'a.b', 'p95'), 'meta.json#baseline.steps["a.b"].p95');
  assert.equal(evaluate(source('meta.json', 'baseline', 'steps', 'a.b', 'p95'), sources), 700);
  assert.equal(source('meta.json', 'rules', 'flags', 'errorRate'), 'meta.json#rules.flags.errorRate');
});

test('a key with a quote, a backslash or a bracket survives the round trip', () => {
  const odd = { 'a"b\\c]d': { v: 5 } };
  const path = source('meta.json', 'a"b\\c]d', 'v');
  assert.equal(evaluate(path, { 'meta.json': odd }), 5);
});

// ---------------------------------------------------------------------------------------------------------------
// evaluation
// ---------------------------------------------------------------------------------------------------------------

test('a reference reads a number from the named file', () => {
  assert.equal(evaluate('summary.json#metrics["http_req_duration{name:a.b}"].values["p(95)"]', sources), 812.4);
  assert.equal(evaluate('meta.json#profile.stages[1].rps', sources), 3);
  assert.equal(evaluate('meta.json#baseline.steps["a.b"].p95', sources), 700);
});

test('arithmetic follows the usual precedence and takes parentheses', () => {
  assert.equal(evaluate('2 + 3 * 4', sources), 14);
  assert.equal(evaluate('(2 + 3) * 4', sources), 20);
  assert.equal(evaluate('10 - 4 - 3', sources), 3);
  assert.equal(evaluate('8 / 4 / 2', sources), 1);
  assert.equal(evaluate('-3 + 5', sources), 2);
  near(evaluate('summary.json#metrics.http_reqs.values.count / summary.json#state.testRunDurationMs * 1000', sources), 0.35);
});

test('a window keeps the array elements inside it, and the aggregates reduce them', () => {
  const reqs = (w: string): string => `timeseries.json#buckets[${w}].reqs`;
  assert.equal(evaluate(`sum(${reqs('t>=15&t<45')})`, sources), 16);
  assert.equal(evaluate(`sum(${reqs('t>=15&t<=45')})`, sources), 28);
  assert.equal(evaluate(`sum(${reqs('t>15')})`, sources), 22);
  assert.equal(evaluate(`sum(${reqs('t<15')})`, sources), 2);
  assert.equal(evaluate(`sum(timeseries.json#buckets[*].reqs)`, sources), 30);
  assert.equal(evaluate('max(timeseries.json#buckets[*].vus)', sources), 6);
  assert.equal(evaluate('min(timeseries.json#buckets[*].vus)', sources), 1);
  assert.equal(evaluate('count(timeseries.json#buckets[*].reqs)', sources), 4);
  assert.equal(evaluate('sum(timeseries.json#buckets[t>=100].reqs)', sources), 0, 'an empty sum is 0');
});

test('null elements (a bucket with no p95) are skipped by avg, max and count; samples without a time never pass a window', () => {
  assert.equal(evaluate('avg(timeseries.json#buckets[*].p95)', sources), 300);
  assert.equal(evaluate('max(timeseries.json#buckets[*].p95)', sources), 500);
  assert.equal(evaluate('count(timeseries.json#buckets[*].p95)', sources), 3);
  assert.equal(evaluate('avg(db.json#resource[t>=0&t<=40].cpu)', sources), 40, 'the sample with t = null (cpu 90) is outside every window');
});

test('wavg is the weighted mean, skipping buckets with no value', () => {
  // (100*2 + 300*10 + 500*12) / (2 + 10 + 12): the bucket with p95 null is left out
  assert.equal(evaluate('wavg(timeseries.json#buckets[*].p95, timeseries.json#buckets[*].reqs)', sources), 9200 / 24);
});

test('functions take several arguments, scalars among them', () => {
  assert.equal(evaluate('max(1, 5, 3)', sources), 5);
  assert.equal(evaluate('sum(meta.json#profile.users, 5)', sources), 15);
  near(evaluate('max(1.2 * meta.json#baseline.steps["a.b"].p95, meta.json#baseline.steps["a.b"].p95 + 100)', sources), 840);
});

test('the limits a run applied are read from the run folder (meta.json#rules), not from the code', () => {
  assert.equal(evaluate('meta.json#rules.flags.errorRate', sources), 0.01);
  assert.equal(evaluate('meta.json#rules.flags.p95AddMs', sources), 100);
  assert.equal(evaluate('meta.json#rules.breaking.latencyFactor', sources), 3);
});

test('only the run folder\'s files are sources: the live rules and a feature\'s baseline.json are not', () => {
  assert.throws(() => evaluate('rules#flags.errorRate', sources), SourceError);
  assert.throws(() => evaluate('baseline.json#staging.load.steps', { ...sources }), SourceError);
});

test('what cannot be evaluated says why, and an empty result is told apart from a broken path', () => {
  const kind = (expr: string): string | undefined => {
    try {
      evaluate(expr, sources);
    } catch (err) {
      assert.ok(err instanceof SourceError, `${expr}: ${(err as Error).message}`);
      return err.kind;
    }
    return undefined;
  };
  assert.equal(kind('summary.json#metrics["http_req_failed{name:a.b}"].values.passes / (summary.json#metrics["http_req_failed{name:a.b}"].values.passes + summary.json#metrics["http_req_failed{name:a.b}"].values.fails)'), 'empty', '0 / 0');
  assert.equal(kind('avg(timeseries.json#buckets[t>=999].reqs)'), 'empty');
  assert.equal(kind('max(timeseries.json#buckets[t>=999].reqs)'), 'empty');
  assert.equal(kind('summary.json#metrics.nothing.values.count'), 'invalid', 'a missing key');
  assert.equal(kind('summary.json#metrics["checks{name:a.b}"]'), 'invalid', 'an object, not a number');
  assert.equal(kind('meta.json#baseline.steps["a.b"].p95'), undefined);
  assert.equal(kind('nofile.json#x'), 'invalid');
  assert.equal(kind('timeseries.json#buckets[*].reqs'), 'invalid', 'an array is not a number: reduce it');
  assert.equal(kind('1 +'), 'invalid');
  assert.equal(kind('2 3'), 'invalid');
  assert.equal(kind('bogus(1)'), 'invalid');
  assert.equal(kind('timeseries.json#buckets[x'), 'invalid');
  assert.equal(kind('meta.json#profile.users'), undefined);
  assert.equal(kind('db.json#resource[0].t'), 'invalid', 'a null is not a number');
});

test('a file that is not loaded cannot be read', () => {
  assert.throws(() => evaluate('summary.json#metrics.x', {}), SourceError);
  assert.throws(() => evaluate('db.json#resource[0].cpu', {}), /db\.json/);
});

// ---------------------------------------------------------------------------------------------------------------
// formats
// ---------------------------------------------------------------------------------------------------------------

test('formats round once, the same way for the page and for the check', () => {
  assert.equal(formatNumber('int', 1445.637), '1,446');
  assert.equal(formatNumber('int', 83.5), '84');
  assert.equal(formatNumber('int', 1234567), '1,234,567');
  assert.equal(formatNumber('dec1', 12.34), '12.3');
  assert.equal(formatNumber('dec2', 0.3333), '0.33');
  assert.equal(formatNumber('dec2', 14.2), '14.2', 'trailing zeros are trimmed');
  assert.equal(formatNumber('dec2', 5), '5');
  assert.equal(formatNumber('pct', 0.0123), '1.23%');
  assert.equal(formatNumber('pct', 0), '0%');
  assert.equal(formatNumber('pct', 1), '100%');
  assert.equal(formatNumber('pctPoints', 46.09), '46.1%');
  assert.equal(formatNumber('signedInt', 250.4), '+250');
  assert.equal(formatNumber('signedInt', -80), '-80');
  assert.equal(formatNumber('signedInt', 0), '0');
  assert.equal(formatNumber('signedPct', 0.256), '+26%');
  assert.equal(formatNumber('signedPct', -0.12), '-12%');
  assert.equal(formatNumber('signedPct', 0.001), '0%');
  assert.equal(formatNumber('dur', 20.1), '20 s');
  assert.equal(formatNumber('dur', 780), '13 min');
  assert.equal(formatNumber('dur', 781.4), '13 min 1 s');
  assert.equal(formatNumber('dur', 3725), '1 h 2 min');
  assert.equal(formatNumber('dur', 0), '0 s');
  assert.equal(formatNumber('ratio', 3.04), '3×');
  assert.equal(formatNumber('ratio', 2.75), '2.8×');
});

// ---------------------------------------------------------------------------------------------------------------
// verifying a page
// ---------------------------------------------------------------------------------------------------------------

const span = (src: string, fmt: string, text: string, extra = ''): string =>
  `<span class="num${extra}" data-src="${src.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}" data-fmt="${fmt}">${text}</span>`;

test('verifyHtml counts the numbers that match and names the ones that do not', () => {
  const p95 = 'summary.json#metrics["http_req_duration{name:a.b}"].values["p(95)"]';
  const ok = verifyHtml(`<td>${span(p95, 'int', '812')}</td><td>${span('meta.json#profile.users', 'int', '10', ' bad')}</td>`, sources);
  assert.deepEqual(ok, { checked: 2, mismatches: [] });

  const wrong = verifyHtml(`<td>${span(p95, 'int', '813')}</td>`, sources);
  assert.equal(wrong.checked, 1);
  assert.equal(wrong.mismatches.length, 1);
  assert.match(wrong.mismatches[0]!, /813/);
  assert.match(wrong.mismatches[0]!, /812/);
  assert.match(wrong.mismatches[0]!, /p\(95\)/);
});

test('verifyHtml fails a number without a source, an unknown format and a source that does not resolve', () => {
  assert.match(verifyHtml('<td><span class="num">5</span></td>', sources).mismatches[0]!, /no data-src/);
  assert.match(verifyHtml(span('meta.json#profile.users', 'bogus', '10'), sources).mismatches[0]!, /format/);
  assert.match(verifyHtml(span('meta.json#profile.nobody', 'int', '10'), sources).mismatches[0]!, /nobody/);
  assert.match(verifyHtml(span('meta.json#profile.users', 'int', ''), sources).mismatches[0]!, /10/);
});

test('verifyHtml reads entity-encoded text and attributes, and counts nothing outside number elements', () => {
  assert.deepEqual(verifyHtml('<p>10 users</p><span class="id">12</span>', sources), { checked: 0, mismatches: [] });
  assert.equal(verifyHtml(span('summary.json#metrics["checks{name:a.b}"].values.passes / (summary.json#metrics["checks{name:a.b}"].values.passes + summary.json#metrics["checks{name:a.b}"].values.fails)', 'pct', '99.5%'), sources).mismatches.length, 0);
});
