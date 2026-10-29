import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startMockServer, type MockServer, type MockServerOptions } from './server.js';

async function withServer(opts: MockServerOptions, fn: (server: MockServer) => Promise<void>): Promise<void> {
  const server = await startMockServer(opts);
  try {
    await fn(server);
  } finally {
    await server.stop();
  }
}

function tokenRequest(server: MockServer, form: Record<string, string>): Promise<Response> {
  return fetch(`${server.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
  });
}

async function login(server: MockServer): Promise<string> {
  const res = await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' });
  assert.equal(res.status, 200);
  return ((await res.json()) as { access_token: string }).access_token;
}

function post(server: MockServer, path: string, token?: string): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ currentPage: 1, currentSize: 20 }),
  });
}

test('token endpoint issues a JWT about an hour ahead', async () => {
  await withServer({}, async (server) => {
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number };
    const parts = body.access_token.split('.');
    assert.equal(parts.length, 3);
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as { exp: number };
    assert.ok(payload.exp - nowSec >= 3590 && payload.exp - nowSec <= 3610, `exp is ${payload.exp - nowSec} s ahead`);
    assert.equal(body.expires_in, 3600);
    assert.ok(body.refresh_token.length > 0);
    assert.equal(server.tokenCalls(), 1);
  });
});

test('refresh_token grant issues a new token pair', async () => {
  await withServer({}, async (server) => {
    const first = (await (await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' })).json()) as {
      refresh_token: string;
    };
    const res = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: first.refresh_token });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    assert.equal(body.access_token.split('.').length, 3);
    assert.equal(body.expires_in, 3600);
    assert.equal(server.tokenCalls(), 2);

    const bad = await tokenRequest(server, { grant_type: 'refresh_token', refresh_token: 'not-ours' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'invalid_grant' });
  });
});

test('wrong credentials get 400 invalid_grant', async () => {
  await withServer({}, async (server) => {
    const res = await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'wrong' });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'invalid_grant' });
  });
});

test('setTokenStatus(429) makes the token endpoint answer 429', async () => {
  await withServer({}, async (server) => {
    server.setTokenStatus(429);
    const throttled = await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' });
    assert.equal(throttled.status, 429);
    assert.equal(server.tokenCalls(), 1, 'throttled calls still count as token requests');

    server.setTokenStatus(200);
    const ok = await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' });
    assert.equal(ok.status, 200);
  });
});

test('search requires a bearer token', async () => {
  await withServer({}, async (server) => {
    const denied = await post(server, '/api/items/search');
    assert.equal(denied.status, 401);

    const res = await post(server, '/api/items/search', await login(server));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { id: number; name: string }[]; totalCount: number };
    assert.equal(body.items.length, 20);
    assert.equal(typeof body.items[0].id, 'number');
    assert.equal(typeof body.items[0].name, 'string');
    assert.equal(body.totalCount, 500);
  });
});

test('export returns 2 KB of octet-stream', async () => {
  await withServer({}, async (server) => {
    assert.equal((await post(server, '/api/items/export')).status, 401);
    const res = await post(server, '/api/items/export', await login(server));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/octet-stream');
    assert.equal((await res.arrayBuffer()).byteLength, 2048);
  });
});

test('slow-search saturates above capacity', async () => {
  await withServer({}, async (server) => {
    const token = await login(server);

    const timed = async () => {
      const start = Date.now();
      const res = await post(server, '/api/items/slow-search', token);
      await res.arrayBuffer();
      return { status: res.status, ms: Date.now() - start };
    };

    const burst = await Promise.all(Array.from({ length: 30 }, timed));
    assert.ok(burst.every((r) => r.status === 200 || r.status === 503), 'only 200 or 503 expected');
    const rejected = burst.filter((r) => r.status === 503).length;
    const maxMs = Math.max(...burst.map((r) => r.ms));
    assert.ok(rejected > 0 || maxMs > 1500, `no saturation: ${rejected} rejected, max ${maxMs} ms`);

    const first = await timed();
    const second = await timed();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.ok(first.ms < 600 && second.ms < 600, `sequential calls took ${first.ms} and ${second.ms} ms`);
  });
});

test('slow-search returns the search body and honours setExtraDelay', async () => {
  await withServer({ slowServiceMs: 50 }, async (server) => {
    const token = await login(server);
    const res = await post(server, '/api/items/slow-search', token);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: unknown[]; totalCount: number };
    assert.equal(body.items.length, 20);
    assert.equal(body.totalCount, 500);

    server.setExtraDelay(300);
    const start = Date.now();
    await (await post(server, '/api/items/slow-search', token)).arrayBuffer();
    assert.ok(Date.now() - start >= 340, 'extra delay is added on top of the service time');
  });
});

test('queue beyond the limit is rejected with 503', async () => {
  await withServer({ slowSlots: 1, slowServiceMs: 200, queueLimit: 2 }, async (server) => {
    const token = await login(server);
    const statuses = await Promise.all(
      Array.from({ length: 6 }, async () => (await post(server, '/api/items/slow-search', token)).status),
    );
    assert.equal(statuses.filter((s) => s === 200).length, 3, 'one in service plus two queued');
    assert.equal(statuses.filter((s) => s === 503).length, 3);
  });
});

test('setFailRate(1) makes API calls return 500 planted', async () => {
  await withServer({ slowServiceMs: 10 }, async (server) => {
    const token = await login(server);
    server.setFailRate(1);
    for (const path of ['/api/items/search', '/api/items/slow-search', '/api/items/export']) {
      const res = await post(server, path, token);
      assert.equal(res.status, 500, path);
      assert.deepEqual(await res.json(), { error: 'planted' });
    }
    // auth, swagger and the root page are not API calls
    assert.equal((await tokenRequest(server, { grant_type: 'password', username: 'perf', password: 'perf' })).status, 200);
    assert.equal((await fetch(`${server.url}/swagger/v1/swagger.json`)).status, 200);

    server.setFailRate(0);
    assert.equal((await post(server, '/api/items/search', token)).status, 200);
  });
});

test('swagger lists the three item routes', async () => {
  await withServer({}, async (server) => {
    const res = await fetch(`${server.url}/swagger/v1/swagger.json`);
    assert.equal(res.status, 200);
    const doc = (await res.json()) as { paths: Record<string, Record<string, unknown>> };
    assert.deepEqual(Object.keys(doc.paths).sort(), ['/api/items/export', '/api/items/search', '/api/items/slow-search']);
    for (const operations of Object.values(doc.paths)) {
      assert.ok(operations.post, 'each route has a post operation');
    }
  });
});

test('root page references the self-test bundle', async () => {
  await withServer({}, async (server) => {
    const res = await fetch(`${server.url}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await res.text(), /<script src="main-SELFTEST\.js">/);
  });
});
