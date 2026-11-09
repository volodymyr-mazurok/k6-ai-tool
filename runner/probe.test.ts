import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { main } from './cli.js';
import { loadFeature, loadProject, type Feature, type Project } from './config.js';
import { describeShape, formatProbe, probe, ProbeRefusedError } from './probe.js';
import { startMockServer, type MockServer } from './selftest/server.js';

const TOUCHED_ENV = [
  'PERF_SELFTEST_URL',
  'PERF_TOKEN_URL',
  'PERF_TOKEN_CLIENT_ID',
  'PERF_SCOPE',
  'PERF_USER_LOGIN',
  'PERF_USER_PASSWORD',
  'PERF_PROBE_KEY',
];
const saved: Record<string, string | undefined> = {};
let mock: MockServer;
let project: Project;
let items: Feature;

before(async () => {
  for (const key of TOUCHED_ENV) saved[key] = process.env[key];
  mock = await startMockServer();
  process.env.PERF_SELFTEST_URL = mock.url;
  process.env.PERF_TOKEN_URL = `${mock.url}/oauth/token`;
  process.env.PERF_TOKEN_CLIENT_ID = 'probe-test';
  process.env.PERF_SCOPE = 'openid';
  process.env.PERF_USER_LOGIN = 'perf';
  process.env.PERF_USER_PASSWORD = 'perf';
  project = await loadProject('selftest');
  items = await loadFeature(project, 'items');
});

after(async () => {
  await mock.stop();
  for (const key of TOUCHED_ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

/** A fetch that records the headers of every request, then answers (with the real network unless `answer` is given). */
function recordingFetch(answer?: () => Response) {
  const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const impl: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method ?? 'GET', headers: { ...(init?.headers as Record<string, string>) } });
    return answer ? answer() : fetch(input, init);
  };
  return { impl, seen };
}

const bearerOf = (seen: Array<{ headers: Record<string, string> }>): string => {
  const header = Object.entries(seen[0]!.headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
  return header.replace(/^Bearer\s+/i, '');
};

/** Everything a probe could print: the line and the shape. */
const printed = (result: Awaited<ReturnType<typeof probe>>): string => formatProbe('GET', '/x', result).join('\n');

async function cli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const { log, error } = console;
  console.log = (...parts: unknown[]) => void out.push(parts.join(' '));
  console.error = (...parts: unknown[]) => void err.push(parts.join(' '));
  try {
    const code = await main(argv);
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// describeShape
// ---------------------------------------------------------------------------------------------------------------

test('describeShape: keys and types, numbers only under count/size/length/page-number keys, never a string', () => {
  const lines = describeShape({
    data: { entities: Array.from({ length: 10 }, (_, i) => ({ id: i })), totalCount: 1000, name: 'Alice Secret', age: 41, ok: true, none: null },
    pageSize: 25,
  });
  assert.deepEqual(lines, [
    'data: object {entities: array(10) of object, totalCount: 1000, name: string, age: number, ok: boolean, none: null}',
    'pageSize: 25',
  ]);
  assert.ok(!lines.join('\n').includes('Alice'));
});

test('describeShape: a key that is data (e-mail, GUID, mostly digits) prints as <key>, ordinary keys stay', () => {
  const lines = describeShape({
    'jane.doe@example.test': { total: 3 },
    '3f2c9a1e-5b7d-4e8a-9c01-0a1b2c3d4e5f': 'x',
    '20261030': 1,
    '4711-0815': true,
    page2: 1,
    item1: 'y',
    id: 7,
    totalCount: 9,
  });
  assert.deepEqual(lines, [
    '<key>: number', // 20261030 (JavaScript lists integer-like keys first)
    '<key>: object {total: number}',
    '<key>: string',
    '<key>: boolean',
    'page2: number',
    'item1: string',
    'id: number',
    'totalCount: 9',
  ]);
  const nested = describeShape({ byUser: { 'jane.doe@example.test': { n: 1 } } }, 3).join('\n');
  assert.ok(!nested.includes('jane') && !nested.includes('example.test'), nested);
});

test('describeShape: a total that is money stays a number type; counts, sizes, lengths and page numbers print', () => {
  const lines = describeShape({
    totalSalary: 52000,
    totalPrice: 19.99,
    total: 7,
    totalCount: 1000,
    itemCount: 3,
    pageSize: 20,
    length: 4,
    page: 2,
    pageNumber: 2,
    pageIndex: 1,
    currentPage: 2,
    totalPages: 50,
    salary: 1,
  });
  assert.deepEqual(lines, [
    'totalSalary: number',
    'totalPrice: number',
    'total: number',
    'totalCount: 1000',
    'itemCount: 3',
    'pageSize: 20',
    'length: 4',
    'page: 2',
    'pageNumber: 2',
    'pageIndex: 1',
    'currentPage: 2',
    'totalPages: 50',
    'salary: number',
  ]);
  const text = lines.join('\n');
  assert.ok(!text.includes('52000') && !text.includes('19.99'), text);
});

test('describeShape: a 50,000 element array is one line, not a dump', () => {
  const lines = describeShape(Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `Item ${i}` })));
  assert.equal(lines.length, 1);
  assert.equal(lines[0], 'array(50000) of object {id: number, name: string}');
  assert.deepEqual(describeShape([]), ['array(0)']);
  assert.deepEqual(describeShape([1, 'a']), ['array(2) of mixed']);
});

test('describeShape: depth and maxKeys bound the output', () => {
  const deep = { a: { b: { c: { d: 1 } } } };
  assert.deepEqual(describeShape(deep), ['a: object {b: object(1 key)}']);
  assert.deepEqual(describeShape(deep, 3), ['a: object {b: object {c: object(1 key)}}']);
  const wide = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${i}`, i]));
  const lines = describeShape(wide, 2, 5);
  assert.equal(lines.length, 6);
  assert.equal(lines.at(-1), '… 25 more keys');
  assert.deepEqual(describeShape('plain text'), ['string']);
  assert.deepEqual(describeShape(7), ['number']);
});

test('describeShape: a key that looks like a token or runs long is not echoed whole', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
  const lines = describeShape({ [jwt]: 1, ['x'.repeat(200)]: 2 });
  assert.ok(!lines.join('\n').includes('eyJ'));
  assert.ok(lines.every((line) => line.length < 100), lines.join('\n'));
});

// ---------------------------------------------------------------------------------------------------------------
// probe against the mock
// ---------------------------------------------------------------------------------------------------------------

test('a GET on a real GET route prints status, timing, type, bytes and the shape with totalCount but no string', async () => {
  const { impl, seen } = recordingFetch();
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.equal(result.status, 200);
  assert.match(result.contentType, /application\/json/);
  assert.deepEqual(result.shape, ['totalCount: 500', 'pageSize: 20', 'name: string']);
  assert.equal(result.hint, undefined);
  const text = formatProbe('GET', '/api/items/count', result);
  assert.match(text[0]!, /^200 GET \/api\/items\/count \d+ ms application\/json [\d,]+ bytes$/);
  assert.ok(!text.join('\n').includes('Items'), 'the string value is not printed');
  const token = bearerOf(seen);
  assert.ok(token.length > 20);
  assert.ok(!text.join('\n').includes(token));
});

test('the path may be given without the API base: /items/count is the same request', async () => {
  const { impl, seen } = recordingFetch();
  await probe({ project, env: 'local', method: 'GET', path: '/items/count', fetchImpl: impl });
  assert.equal(new URL(seen[0]!.url).pathname, '/api/items/count');
});

test('a POST on a read_only_post_routes path is allowed without --feature, with the project role and its token', async () => {
  const { impl, seen } = recordingFetch();
  const result = await probe({ project, env: 'local', method: 'POST', path: '/api/items/search', body: { q: 'a' }, fetchImpl: impl });
  assert.equal(result.status, 200);
  assert.deepEqual(result.shape, ['items: array(20) of object {id: number, name: string}', 'totalCount: 500']);
  assert.equal(seen[0]!.method, 'POST');
  assert.equal(seen[0]!.headers['content-type'] ?? seen[0]!.headers['Content-Type'], 'application/json');
});

test('a POST to a read-only route with --feature items is allowed too', async () => {
  const result = await probe({ project, feature: items, env: 'local', method: 'POST', path: '/api/items/search' });
  assert.equal(result.status, 200);
});

test('a POST that no read_only_post_routes or writes entry covers is refused with PROBE_REFUSED, and nothing is sent', async () => {
  const { impl, seen } = recordingFetch();
  for (const [method, path] of [['POST', '/api/items/delete-all'], ['DELETE', '/api/items/1'], ['PUT', '/api/items/search']] as const) {
    await assert.rejects(
      probe({ project, feature: items, env: 'local', method, path, fetchImpl: impl }),
      (err: unknown) => err instanceof ProbeRefusedError && err.code === 'PROBE_REFUSED',
      `${method} ${path}`,
    );
  }
  assert.equal(seen.length, 0);
  const viaCli = await cli('probe', 'selftest', 'POST', '/api/items/delete-all', '--env', 'local');
  assert.equal(viaCli.code, 2);
  assert.match(viaCli.err, /PROBE_REFUSED/);
});

test('a write the feature declares in writes: is allowed, with method and route both matching', async () => {
  const writing: Feature = {
    ...items,
    readOnly: false,
    writes: [{ method: 'PUT', route: '/items/{id}', cleanup: 'app' }],
  };
  const { impl, seen } = recordingFetch(() => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await probe({ project, feature: writing, env: 'local', method: 'PUT', path: '/api/items/42', body: {}, fetchImpl: impl });
  assert.equal(result.status, 200);
  assert.equal(seen.length, 1);
  await assert.rejects(probe({ project, feature: writing, env: 'local', method: 'DELETE', path: '/api/items/42', fetchImpl: impl }), ProbeRefusedError);
  await assert.rejects(probe({ project, env: 'local', method: 'PUT', path: '/api/items/42', fetchImpl: impl }), ProbeRefusedError, 'no --feature, no write');
});

test('the env must be one project.yaml allows', async () => {
  await assert.rejects(probe({ project, env: 'prod', method: 'GET', path: '/api/items/count' }), (err: unknown) => (err as { code?: string }).code === 'ENV_NOT_ALLOWED');
});

test('a path that leaves the API host or base is refused', async () => {
  const { impl, seen } = recordingFetch();
  for (const path of ['http://evil.example/api/items/count', '//evil.example/x', 'items/count', '/api/../oauth/token']) {
    await assert.rejects(probe({ project, env: 'local', method: 'GET', path, fetchImpl: impl }), ProbeRefusedError, path);
  }
  assert.equal(seen.length, 0);
});

test('an unknown --role is refused and names the roles', async () => {
  await assert.rejects(probe({ project, env: 'local', method: 'GET', path: '/api/items/count', role: 'Nobody' }), /User/);
});

test('a token endpoint that refuses stops the probe with the auth hint and sends no API request', async () => {
  const { impl, seen } = recordingFetch();
  mock.setTokenStatus(401);
  try {
    await assert.rejects(
      probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl }),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /401/);
        assert.match(message, /check the project's auth \(auth\.type ropc, role User\); the token itself is never shown/);
        assert.ok(!/eyJ|Bearer/.test(message));
        return true;
      },
    );
  } finally {
    mock.setTokenStatus(200);
  }
  assert.equal(seen.length, 0);
});

// ---------------------------------------------------------------------------------------------------------------
// probe with a stub fetch
// ---------------------------------------------------------------------------------------------------------------

test('401 and 403 from the API give the hint and never the token', async () => {
  for (const status of [401, 403]) {
    const { impl, seen } = recordingFetch(() => new Response('{"error":"unauthorized"}', { status, headers: { 'content-type': 'application/json' } }));
    const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
    assert.equal(result.status, status);
    assert.equal(result.hint, "check the project's auth (auth.type ropc, role User); the token itself is never shown");
    const text = printed(result);
    assert.ok(text.includes('the token itself is never shown'));
    assert.ok(!text.includes(bearerOf(seen)), 'the token is not in the output');
    assert.deepEqual(result.shape, ['error: string']);
  }
});

test('an HTML 500 gives a bounded shape: type and size, none of its text', async () => {
  const page = `<html><body><h1>Server Error</h1><pre>at Secret.Method() key=SECRET-VALUE-123</pre>${'x'.repeat(5_000)}</body></html>`;
  const { impl } = recordingFetch(() => new Response(page, { status: 500, headers: { 'content-type': 'text/html; charset=utf-8' } }));
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.equal(result.status, 500);
  assert.equal(result.bytes, Buffer.byteLength(page));
  assert.deepEqual(result.shape, [`[text/html, ${Buffer.byteLength(page).toLocaleString('en-US')} bytes]`]);
  assert.ok(!printed(result).includes('SECRET-VALUE'));
  assert.equal(result.hint, undefined);
});

test('JSON that does not parse is described by type and size, not echoed', async () => {
  const { impl } = recordingFetch(() => new Response('{"a": SECRET-oops', { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.deepEqual(result.shape, [`[application/json, ${Buffer.byteLength('{"a": SECRET-oops')} bytes, not valid JSON]`]);
});

test('a 5 MB JSON array is summed up as array(50000), without its elements', async () => {
  const big = JSON.stringify(Array.from({ length: 50_000 }, (_, i) => ({ id: i, name: `Item number ${i}`, note: 'x'.repeat(60) })));
  assert.ok(big.length > 5_000_000);
  const { impl } = recordingFetch(() => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.equal(result.bytes, big.length);
  assert.deepEqual(result.shape, ['array(50000) of object {id: number, name: string, note: string}']);
  assert.ok(printed(result).length < 500);
});

test('a body above the read limit is counted up to the limit and not parsed', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(97);
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(chunk); // endless
    },
  });
  const { impl } = recordingFetch(() => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } }));
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.match(result.shape[0]!, /^\[application\/json, at least [\d,]+ bytes, too large to read\]$/);
});

test('the API request carries a timeout signal', async () => {
  let signal: AbortSignal | null | undefined;
  const impl: typeof fetch = async (_input, init) => {
    signal = init?.signal;
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  assert.ok(signal instanceof AbortSignal);
});

test('a redirect is reported, not followed (the token must not travel on)', async () => {
  let redirect: RequestRedirect | undefined;
  const impl2: typeof fetch = async (_input, init) => {
    redirect = init?.redirect;
    return new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/' } });
  };
  const result = await probe({ project, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl2 });
  assert.equal(redirect, 'manual');
  assert.equal(result.status, 302);
  assert.ok(!printed(result).includes('elsewhere'));
});

test('a static_header project: the header is built from the env and random parts, and is never printed', async () => {
  const staticProject: Project = {
    ...project,
    auth: { type: 'static_header', header: 'X-Api-Key', value: '${env:PERF_PROBE_KEY}-${random:8}' },
  };
  process.env.PERF_PROBE_KEY = 'probe-key-value-123';
  const { impl, seen } = recordingFetch(() => new Response('{"totalCount": 3}', { headers: { 'content-type': 'application/json' } }));
  const first = await probe({ project: staticProject, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  const second = await probe({ project: staticProject, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl });
  const value = (i: number) => seen[i]!.headers['X-Api-Key']!;
  assert.match(value(0), /^probe-key-value-123-[a-z0-9]{8}$/);
  assert.notEqual(value(0), value(1), 'each probe draws its own random part');
  for (const text of [printed(first), printed(second)]) {
    assert.ok(!text.includes('probe-key-value-123'));
    assert.ok(!text.includes(value(0).slice(-8)));
  }
  delete process.env.PERF_PROBE_KEY;
  await assert.rejects(
    probe({ project: staticProject, env: 'local', method: 'GET', path: '/api/items/count', fetchImpl: impl }),
    (err: unknown) => /PERF_PROBE_KEY is not set/.test((err as Error).message),
  );
  const hint = await (async () => {
    process.env.PERF_PROBE_KEY = 'probe-key-value-123';
    const r = await probe({
      project: staticProject,
      env: 'local',
      method: 'GET',
      path: '/api/items/count',
      fetchImpl: recordingFetch(() => new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })).impl,
    });
    return r.hint;
  })();
  assert.equal(hint, "check the project's auth (auth.type static_header, header X-Api-Key); the token itself is never shown");
});

// ---------------------------------------------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------------------------------------------

test('perf probe prints one line and the shape; no token, password or header value reaches the output', async () => {
  const get = await cli('probe', 'selftest', 'GET', '/api/items/count', '--env', 'local');
  assert.equal(get.code, 0, get.err);
  const lines = get.out.split('\n');
  assert.match(lines[0]!, /^200 GET \/api\/items\/count \d+ ms application\/json [\d,]+ bytes$/);
  assert.deepEqual(lines.slice(1), ['totalCount: 500', 'pageSize: 20', 'name: string']);

  const post = await cli('probe', 'selftest', 'POST', '/api/items/search', '--env', 'local', '--role', 'User');
  assert.equal(post.code, 0, post.err);
  assert.match(post.out.split('\n')[0]!, /^200 POST \/api\/items\/search /);

  // the token this login is issued: same second, same claims, same HMAC
  const token = (await (await fetch(`${mock.url}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', client_id: 'x', scope: 'openid', username: 'perf', password: 'perf' }),
  })).json() as { access_token: string; refresh_token: string }).access_token;
  for (const text of [get.out, get.err, post.out, post.err]) {
    assert.ok(!text.includes(token.split('.')[2]!), 'the token signature is not printed');
    assert.ok(!/eyJ|Bearer|password|mock-refresh/i.test(text));
  }
});

test('perf probe with --body reads the JSON file, and with --feature reaches a declared route', async () => {
  const { writeFile, mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'perf-probe-'));
  try {
    const file = join(dir, 'body.json');
    await writeFile(file, '{"q":"a"}', 'utf8');
    const run = await cli('probe', 'selftest', 'POST', '/api/items/search', '--env', 'local', '--feature', 'items', '--body', file);
    assert.equal(run.code, 0, run.err);
    const missing = await cli('probe', 'selftest', 'POST', '/api/items/search', '--env', 'local', '--body', join(dir, 'nope.json'));
    assert.equal(missing.code, 2);
    await writeFile(file, '{not json', 'utf8');
    const broken = await cli('probe', 'selftest', 'POST', '/api/items/search', '--env', 'local', '--body', file);
    assert.equal(broken.code, 2);
    assert.ok(!broken.err.includes('{not json'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('perf probe misuse exits 2 and --help lists it', async () => {
  assert.equal((await cli('probe', 'selftest', 'GET')).code, 2);
  assert.equal((await cli('probe', 'selftest', 'GET', '/api/items/count')).code, 2, '--env is required');
  assert.equal((await cli('probe', 'selftest', 'GET', '/api/items/count', '--env', 'prod')).code, 2, 'an env the project does not allow');
  assert.match((await cli('--help')).out, /^ {2}probe <project> <METHOD> <path> --env <env>/m);
});
