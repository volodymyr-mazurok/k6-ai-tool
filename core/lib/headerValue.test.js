import test from 'node:test';
import assert from 'node:assert/strict';
import { expandRandom, RANDOM_ALPHABET } from './headerValue.js';

test('expandRandom replaces each ${random:N} with N characters of the alphabet and keeps the rest', () => {
  const value = expandRandom('token ${random:16}');
  assert.match(value, /^token [a-z0-9]{16}$/);
  assert.match(expandRandom('${random:3}-${random:5}'), /^[a-z0-9]{3}-[a-z0-9]{5}$/);
  assert.equal(expandRandom('fixed value'), 'fixed value');
});

test('expandRandom draws from the random source it is given, so two calls differ', () => {
  let i = 0;
  const counting = () => (i++ % RANDOM_ALPHABET.length) / RANDOM_ALPHABET.length;
  assert.equal(expandRandom('${random:4}', counting), RANDOM_ALPHABET.slice(0, 4));
  assert.notEqual(expandRandom('${random:16}'), expandRandom('${random:16}'));
});

test('expandRandom refuses a placeholder the runner should have replaced, without echoing any of the value', () => {
  for (const template of ['${env:PERF_API_KEY}', 'secret-part ${other}']) {
    assert.throws(
      () => expandRandom(template),
      (err) => /a placeholder other than \$\{random:N\} reached k6/.test(err.message) && !err.message.includes('PERF_API_KEY') && !err.message.includes('secret-part'),
    );
  }
});
