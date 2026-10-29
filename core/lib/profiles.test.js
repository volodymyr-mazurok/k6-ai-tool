import test from 'node:test';
import assert from 'node:assert/strict';
import { splitUsers, buildScenarios, CapsError } from './profiles.js';

const journeys = [
  { name: 'analyst_forms_grid', exec: 'analystFormsGrid' },
  { name: 'manager_forms_grid', exec: 'managerFormsGrid' },
];
const mix = { analyst_forms_grid: 70, manager_forms_grid: 30 };
const caps = { maxVus: 20, maxRps: 30 };
const stepsPerIteration = { analyst_forms_grid: 5, manager_forms_grid: 5 };

test('splitUsers 10 users 70/30 gives 7/3', () => {
  assert.deepEqual(splitUsers(10, { a: 70, b: 30 }), { a: 7, b: 3 });
});

test('splitUsers 1 user goes to the biggest share, the other gets 0', () => {
  assert.deepEqual(splitUsers(1, { a: 70, b: 30 }), { a: 1, b: 0 });
});

test('splitUsers by largest remainder: values sum to the total', () => {
  const out = splitUsers(3, { a: 34, b: 33, c: 33 });
  assert.equal(out.a + out.b + out.c, 3);
  assert.deepEqual(out, { a: 1, b: 1, c: 1 });
});

test('splitUsers gives every journey with a share at least 1 when total allows', () => {
  // quotas 0.5 / 0.5 / 9.0 -> naive rounding would leave a and b at 0 or 1
  const out = splitUsers(10, { a: 5, b: 5, c: 90 });
  assert.equal(out.a + out.b + out.c, 10);
  assert.ok(out.a >= 1 && out.b >= 1 && out.c >= 1);
  const tight = splitUsers(3, { a: 1, b: 1, c: 98 });
  assert.deepEqual(tight, { a: 1, b: 1, c: 1 });
});

test('splitUsers breaks ties in favour of the earlier journey', () => {
  assert.deepEqual(splitUsers(1, { a: 50, b: 50 }), { a: 1, b: 0 });
  assert.deepEqual(splitUsers(3, { a: 50, b: 50 }), { a: 2, b: 1 });
});

test('splitUsers never gives users to a journey with share 0', () => {
  assert.deepEqual(splitUsers(5, { a: 100, b: 0 }), { a: 5, b: 0 });
});

test('splitUsers with an empty mix or total 0 returns zeros', () => {
  assert.deepEqual(splitUsers(0, { a: 70, b: 30 }), { a: 0, b: 0 });
  assert.deepEqual(splitUsers(5, {}), {});
});

test('smoke: one VU, one iteration per journey', () => {
  const profile = { type: 'smoke', totalSec: 60 };
  const { scenarios, rps } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  assert.deepEqual(scenarios, {
    analyst_forms_grid: { executor: 'per-vu-iterations', exec: 'analystFormsGrid', vus: 1, iterations: 1 },
    manager_forms_grid: { executor: 'per-vu-iterations', exec: 'managerFormsGrid', vus: 1, iterations: 1 },
  });
  assert.equal(rps, 30);
});

test('load 10 users splits 7/3 with 120s/600s/60s stages', () => {
  const profile = { type: 'load', users: 10, rampSec: 120, holdSec: 600, rampDownSec: 60, totalSec: 780 };
  const { scenarios } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  const stagesFor = (n) => [
    { duration: '120s', target: n },
    { duration: '600s', target: n },
    { duration: '60s', target: 0 },
  ];
  assert.deepEqual(scenarios.analyst_forms_grid, {
    executor: 'ramping-vus',
    exec: 'analystFormsGrid',
    startVUs: 0,
    stages: stagesFor(7),
  });
  assert.deepEqual(scenarios.manager_forms_grid, {
    executor: 'ramping-vus',
    exec: 'managerFormsGrid',
    startVUs: 0,
    stages: stagesFor(3),
  });
});

test('soak uses the same ramping-vus shape as load', () => {
  const profile = { type: 'soak', users: 4, rampSec: 60, holdSec: 1200, rampDownSec: 30, totalSec: 1290 };
  const { scenarios } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  assert.equal(scenarios.analyst_forms_grid.executor, 'ramping-vus');
  assert.deepEqual(scenarios.analyst_forms_grid.stages, [
    { duration: '60s', target: 3 },
    { duration: '1200s', target: 3 },
    { duration: '30s', target: 0 },
  ]);
});

test('load skips a journey that gets 0 users', () => {
  const profile = { type: 'load', users: 1, rampSec: 10, holdSec: 20, rampDownSec: 5, totalSec: 35 };
  const { scenarios } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  assert.deepEqual(Object.keys(scenarios), ['analyst_forms_grid']);
});

test('stress levels 1,3,…,15 req/s become 8 stages with timeUnit 1m', () => {
  const stages = [1, 3, 5, 7, 9, 11, 13, 15].map((rps, i) => ({ fromSec: i * 120, rps }));
  const profile = { type: 'stress', stages, totalSec: 960 };
  const { scenarios, rps } = buildScenarios({
    profile,
    journeys: [journeys[0]],
    mix: { analyst_forms_grid: 100 },
    caps,
    stepsPerIteration: { analyst_forms_grid: 5 },
  });
  const sc = scenarios.analyst_forms_grid;
  assert.equal(sc.executor, 'ramping-arrival-rate');
  assert.equal(sc.exec, 'analystFormsGrid');
  assert.equal(sc.timeUnit, '1m');
  assert.equal(sc.stages.length, 8);
  // iterations per minute = rps * 60 / steps per iteration
  assert.deepEqual(
    sc.stages.map((s) => s.target),
    [12, 36, 60, 84, 108, 132, 156, 180],
  );
  assert.ok(sc.stages.every((s) => s.duration === '120s'));
  assert.equal(sc.startRate, 12);
  assert.equal(sc.preAllocatedVUs, 20);
  assert.equal(sc.maxVUs, 20);
  assert.equal(rps, 30);
});

test('stress: the last stage runs until totalSec and the target follows the journey share', () => {
  const stages = [
    { fromSec: 0, rps: 2 },
    { fromSec: 100, rps: 4 },
  ];
  const profile = { type: 'stress', stages, totalSec: 130 };
  const { scenarios } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  // 70% of 2 req/s, 5 steps per iteration: 2 * 70 * 60 / (100 * 5) = 16.8 -> 17
  assert.deepEqual(scenarios.analyst_forms_grid.stages, [
    { duration: '100s', target: 17 },
    { duration: '30s', target: 34 },
  ]);
  // 30% of 2 req/s: 7.2 -> 7 ; 30% of 4 req/s: 14.4 -> 14
  assert.deepEqual(scenarios.manager_forms_grid.stages, [
    { duration: '100s', target: 7 },
    { duration: '30s', target: 14 },
  ]);
  assert.equal(scenarios.analyst_forms_grid.startRate, 17);
});

test('stress: pre-allocated and max VUs follow splitUsers(caps.maxVus, mix)', () => {
  const profile = { type: 'stress', stages: [{ fromSec: 0, rps: 2 }], totalSec: 60 };
  const { scenarios } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
  assert.equal(scenarios.analyst_forms_grid.preAllocatedVUs, 14);
  assert.equal(scenarios.analyst_forms_grid.maxVUs, 14);
  assert.equal(scenarios.manager_forms_grid.preAllocatedVUs, 6);
  assert.equal(scenarios.manager_forms_grid.maxVUs, 6);
});

test('the rps option is the run config rps when given (load and soak at the env default, 15), at most caps.maxRps', () => {
  const load = { type: 'load', users: 2, rampSec: 1, holdSec: 1, rampDownSec: 1, totalSec: 3 };
  const soak = { ...load, type: 'soak' };
  assert.equal(buildScenarios({ profile: load, journeys, mix, caps, stepsPerIteration, rps: 15 }).rps, 15);
  assert.equal(buildScenarios({ profile: soak, journeys, mix, caps, stepsPerIteration, rps: 15 }).rps, 15);
  assert.equal(buildScenarios({ profile: load, journeys, mix, caps, stepsPerIteration, rps: 30 }).rps, 30, '--allow-max: up to the cap');
  assert.throws(
    () => buildScenarios({ profile: load, journeys, mix, caps, stepsPerIteration, rps: 31 }),
    (err) => err instanceof CapsError && err.message === 'rps option 31 exceeds max_rps 30',
  );
});

test('rps option without a run config rps is caps.maxRps (30)', () => {
  const profiles = [
    { type: 'smoke', totalSec: 60 },
    { type: 'load', users: 2, rampSec: 1, holdSec: 1, rampDownSec: 1, totalSec: 3 },
    { type: 'stress', stages: [{ fromSec: 0, rps: 1 }], totalSec: 60 },
    { type: 'soak', users: 2, rampSec: 1, holdSec: 1, rampDownSec: 1, totalSec: 3 },
  ];
  for (const profile of profiles) {
    const { rps } = buildScenarios({ profile, journeys, mix, caps, stepsPerIteration });
    assert.equal(rps, 30, profile.type);
  }
});

test('21 users with maxVus 20 throws CapsError', () => {
  const profile = { type: 'load', users: 21, rampSec: 1, holdSec: 1, rampDownSec: 1, totalSec: 3 };
  assert.throws(
    () => buildScenarios({ profile, journeys, mix, caps, stepsPerIteration }),
    (err) => err instanceof CapsError && err instanceof Error && err.message === 'users 21 exceeds max_vus 20',
  );
});

test('rate 31 with maxRps 30 throws CapsError', () => {
  const profile = {
    type: 'stress',
    stages: [
      { fromSec: 0, rps: 29 },
      { fromSec: 60, rps: 31 },
    ],
    totalSec: 120,
  };
  assert.throws(
    () => buildScenarios({ profile, journeys, mix, caps, stepsPerIteration }),
    (err) => err instanceof CapsError && err.message === 'rate 31 req/s exceeds max_rps 30',
  );
});

test('exactly at the caps is allowed', () => {
  const load = { type: 'load', users: 20, rampSec: 1, holdSec: 1, rampDownSec: 1, totalSec: 3 };
  assert.doesNotThrow(() => buildScenarios({ profile: load, journeys, mix, caps, stepsPerIteration }));
  const stress = { type: 'stress', stages: [{ fromSec: 0, rps: 30 }], totalSec: 60 };
  assert.doesNotThrow(() => buildScenarios({ profile: stress, journeys, mix, caps, stepsPerIteration }));
});

test('smoke with more journeys than maxVus throws CapsError', () => {
  const profile = { type: 'smoke', totalSec: 60 };
  assert.throws(
    () => buildScenarios({ profile, journeys, mix, caps: { maxVus: 1, maxRps: 30 }, stepsPerIteration }),
    (err) => err instanceof CapsError && err.message === 'users 2 exceeds max_vus 1',
  );
});

test('stress needs a positive steps-per-iteration for each journey', () => {
  const profile = { type: 'stress', stages: [{ fromSec: 0, rps: 1 }], totalSec: 60 };
  assert.throws(
    () => buildScenarios({ profile, journeys, mix, caps, stepsPerIteration: { analyst_forms_grid: 5 } }),
    /stepsPerIteration.*manager_forms_grid/,
  );
});

test('an unknown profile type is rejected', () => {
  assert.throws(
    () => buildScenarios({ profile: { type: 'spike', totalSec: 1 }, journeys, mix, caps, stepsPerIteration }),
    /unknown profile type/,
  );
});
