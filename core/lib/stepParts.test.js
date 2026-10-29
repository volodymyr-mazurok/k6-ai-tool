import test from 'node:test';
import assert from 'node:assert/strict';
import { guardChecks, jsonHeaders } from './stepParts.js';

test('guardChecks: a predicate that throws answers false instead of ending the iteration', () => {
  const checks = guardChecks({
    'has items': (res) => res.json().items.length > 0,
    'status is 200': (res) => res.status === 200,
  });
  const errorPage = { status: 500, json: () => { throw new Error('not JSON'); } };
  assert.equal(checks['has items'](errorPage), false);
  assert.equal(checks['status is 200'](errorPage), false);
  const good = { status: 200, json: () => ({ items: [1] }) };
  assert.equal(checks['has items'](good), true);
  assert.equal(checks['status is 200'](good), true);
  assert.deepEqual(Object.keys(checks), ['has items', 'status is 200'], 'same names, same order');
});

test('guardChecks keeps what a predicate returns (k6 reads it as truthy or falsy)', () => {
  const checks = guardChecks({ count: (res) => res.count });
  assert.equal(checks.count({ count: 3 }), 3);
  assert.equal(checks.count({ count: 0 }), 0);
});

test('jsonHeaders: a JSON body gets Content-Type unless the caller set it, in any letter case', () => {
  assert.deepEqual(jsonHeaders(undefined, true), { 'Content-Type': 'application/json' });
  assert.deepEqual(jsonHeaders({ Accept: 'text/csv' }, true), { Accept: 'text/csv', 'Content-Type': 'application/json' });
  assert.deepEqual(jsonHeaders({ 'content-type': 'text/plain' }, true), { 'content-type': 'text/plain' }, 'no second Content-Type');
  assert.deepEqual(jsonHeaders({ 'CONTENT-TYPE': 'application/xml' }, true), { 'CONTENT-TYPE': 'application/xml' });
  assert.deepEqual(jsonHeaders({ Accept: 'x' }, false), { Accept: 'x' }, 'no body, no Content-Type');
  const given = { Accept: 'x' };
  jsonHeaders(given, true);
  assert.deepEqual(given, { Accept: 'x' }, "the caller's object is not changed");
});
