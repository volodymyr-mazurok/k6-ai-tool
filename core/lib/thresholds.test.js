import test from 'node:test';
import assert from 'node:assert/strict';
import { buildThresholds } from './thresholds.js';

const abort = { errorRate: 0.1, p95Ms: 15000 };
const stepIds = ['analyst.open', 'analyst.search', 'auth_token'];

test('smoke thresholds: checks rate==1 and http_req_failed rate==0', () => {
  const t = buildThresholds({ stepIds, profileType: 'smoke', abort });
  assert.deepEqual(t.checks, ['rate==1']);
  assert.deepEqual(t.http_req_failed, ['rate==0']);
  assert.equal(t.http_req_duration, undefined);
});

for (const profileType of ['load', 'stress', 'soak']) {
  test(`${profileType} thresholds carry abortOnFail, delays 30s/60s, values 0.10 and 15000`, () => {
    const t = buildThresholds({ stepIds, profileType, abort: { errorRate: 0.1, p95Ms: 15000 } });
    assert.deepEqual(t.http_req_failed, [
      { threshold: 'rate<0.1', abortOnFail: true, delayAbortEval: '30s' },
    ]);
    assert.deepEqual(t.http_req_duration, [
      { threshold: 'p(95)<15000', abortOnFail: true, delayAbortEval: '60s' },
    ]);
    assert.equal(t.checks, undefined);
  });
}

test('abort values come from the abort argument', () => {
  const t = buildThresholds({ stepIds: [], profileType: 'load', abort: { errorRate: 0.05, p95Ms: 8000 } });
  assert.equal(t.http_req_failed[0].threshold, 'rate<0.05');
  assert.equal(t.http_req_duration[0].threshold, 'p(95)<8000');
});

for (const profileType of ['smoke', 'load', 'stress', 'soak']) {
  test(`a no-op submetric threshold exists for every step id including auth_token (${profileType})`, () => {
    const t = buildThresholds({ stepIds, profileType, abort });
    for (const id of stepIds) {
      assert.deepEqual(t[`http_req_duration{name:${id}}`], ['max>=0'], id);
      assert.deepEqual(t[`http_req_failed{name:${id}}`], ['rate>=0'], id);
      assert.deepEqual(t[`checks{name:${id}}`], ['rate>=0'], id);
    }
  });
}

test('only the expected keys exist: three per step plus the global ones', () => {
  const smoke = buildThresholds({ stepIds, profileType: 'smoke', abort });
  assert.equal(Object.keys(smoke).length, stepIds.length * 3 + 2);
  const load = buildThresholds({ stepIds, profileType: 'load', abort });
  assert.equal(Object.keys(load).length, stepIds.length * 3 + 2);
});
