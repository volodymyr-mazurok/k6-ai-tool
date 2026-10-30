import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { requestToken } from './token.js';
import { startMockServer, type MockServer } from './selftest/server.js';

let mock: MockServer;
before(async () => {
  mock = await startMockServer();
});
after(async () => {
  await mock.stop();
});

const auth = () => ({ tokenUrl: `${mock.url}/oauth/token`, clientId: 'token-test', scope: 'openid' });

test('requestToken returns the status and the access token of a good login', async () => {
  const answer = await requestToken(auth(), { login: 'perf', password: 'perf' });
  assert.equal(answer.status, 200);
  assert.match(answer.accessToken ?? '', /^eyJ/);
});

test('requestToken returns only the status for a wrong password and for a refusing endpoint', async () => {
  const wrong = await requestToken(auth(), { login: 'perf', password: 'nope' });
  assert.deepEqual(wrong, { status: 400 });
  mock.setTokenStatus(429);
  try {
    assert.deepEqual(await requestToken(auth(), { login: 'perf', password: 'perf' }), { status: 429 });
  } finally {
    mock.setTokenStatus(200);
  }
});

test('requestToken sends one request per call and never retries', async () => {
  const before = mock.tokenCalls();
  mock.setTokenStatus(500);
  try {
    await requestToken(auth(), { login: 'perf', password: 'perf' });
  } finally {
    mock.setTokenStatus(200);
  }
  assert.equal(mock.tokenCalls() - before, 1);
});
