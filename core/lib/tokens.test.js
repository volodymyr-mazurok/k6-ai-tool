import test from 'node:test';
import assert from 'node:assert/strict';
import { jwtExp, needsRefresh, tokenTiming } from './tokens.js';

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const makeJwt = (payload) => `${b64url({ alg: 'RS256', typ: 'JWT' })}.${b64url(payload)}.signature`;

test('jwtExp reads exp (epoch seconds) from the payload', () => {
  assert.equal(jwtExp(makeJwt({ sub: 'x', exp: 1893456000 })), 1893456000);
});

test('jwtExp copes with every base64url padding length', () => {
  for (let n = 0; n < 6; n++) {
    const token = makeJwt({ s: 'a'.repeat(n), exp: 1700000000 + n });
    assert.equal(jwtExp(token), 1700000000 + n, `pad variant ${n}`);
  }
});

test('jwtExp copes with non-ASCII claims and url-safe characters', () => {
  const token = makeJwt({ name: 'Іван Мазурок ?>?>', exp: 1800000000 });
  assert.equal(jwtExp(token), 1800000000);
});

test('jwtExp throws on a token without three parts, bad payload or no exp', () => {
  assert.throws(() => jwtExp('not-a-jwt'), /invalid JWT/);
  assert.throws(() => jwtExp('a.b'), /invalid JWT/);
  assert.throws(() => jwtExp(`${b64url({})}.%%%.sig`), /invalid JWT/);
  assert.throws(() => jwtExp(makeJwt({ sub: 'x' })), /exp/);
  assert.throws(() => jwtExp(undefined), /invalid JWT/);
});

test('needsRefresh is true 299 s before exp and false 301 s before', () => {
  const exp = 1_800_000_000;
  assert.equal(needsRefresh(exp, (exp - 299) * 1000), true);
  assert.equal(needsRefresh(exp, (exp - 301) * 1000), false);
});

test('needsRefresh is true at the margin edge and once expired', () => {
  const exp = 1_800_000_000;
  assert.equal(needsRefresh(exp, (exp - 300) * 1000), true);
  assert.equal(needsRefresh(exp, (exp + 10) * 1000), true);
});

test('needsRefresh honours a custom margin', () => {
  const exp = 1_800_000_000;
  assert.equal(needsRefresh(exp, (exp - 50) * 1000, 60), true);
  assert.equal(needsRefresh(exp, (exp - 70) * 1000, 60), false);
});

test('tokenTiming: a JWT expires at its exp claim and refreshes 300 s before it', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(tokenTiming({ access_token: makeJwt({ exp: 1_800_003_600 }), expires_in: 10 }, now), { exp: 1_800_003_600, marginSec: 300 });
});

test('tokenTiming: an opaque token expires after expires_in (a number or digits)', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(tokenTiming({ access_token: 'opaque-abc', expires_in: 3600 }, now), { exp: 1_800_003_600, marginSec: 300 });
  assert.deepEqual(tokenTiming({ access_token: 'opaque-abc', expires_in: '3600' }, now), { exp: 1_800_003_600, marginSec: 300 });
});

test('tokenTiming: a token that lives no longer than the margin is refreshed at half its life, not on every call', () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(tokenTiming({ access_token: 'opaque-abc', expires_in: 240 }, now), { exp: 1_800_000_240, marginSec: 120 });
  assert.deepEqual(tokenTiming({ access_token: 'opaque-abc', expires_in: 300 }, now), { exp: 1_800_000_300, marginSec: 150 });
  assert.deepEqual(tokenTiming({ access_token: makeJwt({ exp: 1_800_000_060 }) }, now), { exp: 1_800_000_060, marginSec: 30 });
  const { exp, marginSec } = tokenTiming({ access_token: 'opaque-abc', expires_in: 240 }, now);
  assert.equal(needsRefresh(exp, now + 100_000, marginSec), false, '100 s in: still fresh');
  assert.equal(needsRefresh(exp, now + 121_000, marginSec), true, 'past half its life: refresh');
});

test('tokenTiming: an opaque token without a usable expires_in is an error that shows no token', () => {
  for (const body of [{ access_token: 'opaque-secret' }, { access_token: 'opaque-secret', expires_in: 0 }, { access_token: 'opaque-secret', expires_in: 'soon' }]) {
    assert.throws(
      () => tokenTiming(body, Date.now()),
      (err) => /not a JWT with an exp claim, and the answer has no expires_in/.test(err.message) && !err.message.includes('opaque-secret'),
      JSON.stringify(body.expires_in),
    );
  }
});

test('tokenTiming: the margin is the smaller of 300 s and half the life, with no jump at 300 s', () => {
  const now = 1_800_000_000_000;
  const margin = (life) => tokenTiming({ access_token: 'opaque-abc', expires_in: life }, now).marginSec;
  assert.equal(margin(300), 150);
  assert.equal(margin(301), 150.5, 'just over the margin: still half its life, not 1 s before expiry');
  assert.equal(margin(305), 152.5, 'a 305 s token is refreshed after about 152 s, not after 5 s');
  assert.equal(margin(600), 300);
  assert.equal(margin(3600), 300);
});

test('tokenTiming: a JWT whose exp already looks past (local clock skew) is dated by expires_in when the answer has it', () => {
  const now = 1_800_000_000_000;
  const skewed = makeJwt({ exp: 1_800_000_000 - 120 }); // two minutes "ago" by this machine's clock
  assert.deepEqual(tokenTiming({ access_token: skewed, expires_in: 3600 }, now), { exp: 1_800_003_600, marginSec: 300 });
  assert.deepEqual(tokenTiming({ access_token: skewed }, now), { exp: 1_800_000_000 - 120, marginSec: 0 }, 'no expires_in: the claim stands');
});
