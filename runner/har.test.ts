import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from './cli.js';
import { summarizeHar } from './har.js';

const MINI_HAR = fileURLToPath(new URL('../tests/fixtures/mini.har', import.meta.url));
const API = 'https://api.example.test/api';
const JWT = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
const OPAQUE = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2';
const GUID = '3f2c9a1e-5b7d-4e8a-9c01-0a1b2c3d4e5f';

interface EntryOptions {
  url: string;
  method?: string;
  status?: number;
  time?: number;
  postText?: string;
  content?: { mimeType?: string; text?: string; encoding?: string };
}

function entry(o: EntryOptions): Record<string, unknown> {
  return {
    time: o.time ?? 10,
    request: {
      method: o.method ?? 'GET',
      url: o.url,
      headers: [{ name: 'Authorization', value: 'Bearer secret' }],
      cookies: [{ name: 'c', value: 'secret' }],
      ...(o.postText === undefined ? {} : { postData: { mimeType: 'application/json', text: o.postText } }),
    },
    response: {
      status: o.status ?? 200,
      headers: [{ name: 'Set-Cookie', value: 'secret' }],
      content: o.content ?? { mimeType: 'application/json', text: '{}' },
    },
  };
}

/** Writes a HAR with the given entries into a temp dir, runs fn with its path and removes the dir. */
async function withHar<T>(entries: Record<string, unknown>[], fn: (harPath: string, dir: string) => Promise<T> | T): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'perf-har-'));
  try {
    const harPath = join(dir, 'x.har');
    await writeFile(harPath, JSON.stringify({ log: { version: '1.2', entries } }));
    return await fn(harPath, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('summarizeHar keeps only the API entry of mini.har, with its original index', () => {
  const out = summarizeHar(MINI_HAR, API);

  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    index: 1,
    method: 'POST',
    path: '/analyst/form?lang=en',
    status: 200,
    ms: 2484,
    requestBody: {
      OrderColumn: 'UpdatedAt',
      Descending: true,
      Search: 'Smithson',
      CurrentPage: 0,
      CurrentSize: 10,
      Filters: [{ Column: 'Status', Values: [0, 1, 2] }],
    },
    responseKeys: ['data', 'status', 'message'],
  });
});

test('summarizeHar never copies headers, cookies or tokens into the output', () => {
  const text = JSON.stringify(summarizeHar(MINI_HAR, API));

  for (const forbidden of ['authorization', 'cookie', 'bearer', 'eyJhbGci', 'token-secret-value', 'cookie-secret-value']) {
    assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `output must not contain ${forbidden}`);
  }
});

test('summarizeHar matches the API url on a path boundary and drops entries that got no response', async () => {
  await withHar(
    [
      entry({ url: `${API}` }),
      entry({ url: `${API}x/other` }),
      entry({ url: 'https://api.example.test/baseHub/negotiate?negotiateVersion=1' }),
      entry({ url: `${API}/aborted`, status: -1, time: -1 }),
      entry({ url: `${API}/messaging/messages/unread-count`, time: 95.4 }),
      entry({ url: `${API}?q=1#frag`, method: 'POST', status: 400 }),
    ],
    (harPath) => {
      const out = summarizeHar(harPath, `${API}/`);
      assert.deepEqual(
        out.map((e) => [e.index, e.method, e.path, e.status, e.ms]),
        [
          [0, 'GET', '/', 200, 10],
          [4, 'GET', '/messaging/messages/unread-count', 200, 95],
          [5, 'POST', '/?q=1', 400, 10],
        ],
      );
    },
  );
});

test('summarizeHar reads responseKeys from JSON objects only and decodes base64 bodies', async () => {
  const b64 = Buffer.from('{"alpha":1,"beta":[2]}').toString('base64');
  await withHar(
    [
      entry({ url: `${API}/object`, content: { mimeType: 'application/json', text: '{"a":1,"b":{"c":2}}' } }),
      entry({ url: `${API}/array`, content: { mimeType: 'application/json', text: '[{"a":1}]' } }),
      entry({ url: `${API}/html`, content: { mimeType: 'text/html', text: '<html>' } }),
      entry({ url: `${API}/empty`, content: { mimeType: 'application/json' } }),
      entry({ url: `${API}/base64`, content: { mimeType: 'application/json', text: b64, encoding: 'base64' } }),
    ],
    (harPath) => {
      const out = summarizeHar(harPath, API);
      assert.deepEqual(
        out.map((e) => e.responseKeys),
        [['a', 'b'], undefined, undefined, undefined, ['alpha', 'beta']],
      );
      assert.ok(out.every((e) => !('requestBody' in e)), 'a GET without a body has no requestBody');
    },
  );
});

test('summarizeHar keeps JSON request bodies, drops credential fields and leaves out non-JSON bodies', async () => {
  await withHar(
    [
      entry({
        url: `${API}/a`,
        method: 'POST',
        postText: JSON.stringify({ Search: 'x', Password: 'p', nested: { accessToken: 't', keep: 1 }, list: [{ secret: 's', ok: true }] }),
      }),
      entry({ url: `${API}/b`, method: 'POST', postText: 'grant_type=password&password=hunter2' }),
      entry({ url: `${API}/c`, method: 'POST', postText: '' }),
    ],
    (harPath) => {
      const out = summarizeHar(harPath, API);
      assert.deepEqual(out[0]!.requestBody, { Search: 'x', nested: { keep: 1 }, list: [{ ok: true }] });
      assert.ok(!('requestBody' in out[1]!), 'a non-JSON body is not copied');
      assert.ok(!('requestBody' in out[2]!), 'an empty body is not copied');
      assert.ok(!JSON.stringify(out).includes('hunter2'));
    },
  );
});

test('summarizeHar redacts secret query parameters, keeping their names, and secret-looking values and path segments', async () => {
  await withHar(
    [
      entry({
        url: `${API}/x?access_token=${JWT}&code=ABC123&sig=zzz&page=2&q=smithson&data=${JWT}&blob=${OPAQUE}&userId=${GUID}`,
      }),
      entry({ url: `${API}/reset/${OPAQUE}/confirm?Password=hunter2&key=k` }),
    ],
    (harPath) => {
      const out = summarizeHar(harPath, API);
      assert.equal(
        out[0]!.path,
        `/x?access_token=[redacted]&code=[redacted]&sig=[redacted]&page=2&q=smithson&data=[redacted]&blob=[redacted]&userId=${GUID}`,
      );
      assert.equal(out[1]!.path, '/reset/[redacted]/confirm?Password=[redacted]&key=[redacted]');
      const text = JSON.stringify(out);
      for (const secret of [JWT, OPAQUE, 'ABC123', 'zzz', 'hunter2']) assert.ok(!text.includes(secret), `output must not contain ${secret}`);
    },
  );
});

test('summarizeHar redacts a JWT or opaque token under an innocent key and drops widened credential keys', async () => {
  await withHar(
    [
      entry({
        url: `${API}/a`,
        method: 'POST',
        postText: JSON.stringify({
          Value: JWT,
          Jwt: JWT,
          Code: '123456',
          Otp: '654321',
          pwd: 'hunter2',
          pass: 'p',
          Passphrase: 'pp',
          Credentials: { user: 'u', pw: 'p' },
          Blob: OPAQUE,
          list: [JWT, 'ok'],
          Id: GUID,
          Search: 'smithson sample order application version two',
          OrderColumn: 'UpdatedAt',
          CurrentPage: 1,
          Filters: [{ Column: 'Status', Values: [0, 3] }],
        }),
      }),
    ],
    (harPath) => {
      const out = summarizeHar(harPath, API);
      assert.deepEqual(out[0]!.requestBody, {
        Value: '[redacted]',
        Blob: '[redacted]',
        list: ['[redacted]', 'ok'],
        Id: GUID,
        Search: 'smithson sample order application version two',
        OrderColumn: 'UpdatedAt',
        CurrentPage: 1,
        Filters: [{ Column: 'Status', Values: [0, 3] }],
      });
      const text = JSON.stringify(out);
      for (const secret of [JWT, OPAQUE, '123456', '654321', 'hunter2']) assert.ok(!text.includes(secret), `output must not contain ${secret}`);
    },
  );
});

test('summarizeHar rejects a file that is not a HAR', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-har-'));
  try {
    const harPath = join(dir, 'bad.har');
    await writeFile(harPath, '{"not":"a har"}');
    assert.throws(() => summarizeHar(harPath, API), /not a HAR/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('har-summary writes the scrubbed summary to --out and reports the count', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'perf-har-'));
  try {
    const out = join(dir, 'nested', 'summary.json');
    const log = mock.method(console, 'log', () => {});
    let code: number;
    try {
      code = await main(['har-summary', MINI_HAR, '--api', API, '--out', out]);
    } finally {
      log.mock.restore();
    }

    assert.equal(code, 0);
    const written = JSON.parse(await readFile(out, 'utf8'));
    assert.deepEqual(written, summarizeHar(MINI_HAR, API));
    const printed = log.mock.calls.map((c) => String(c.arguments[0])).join('\n');
    assert.match(printed, /1 API call summarised/);
    assert.match(printed, /delete the raw HAR/i, 'the command reminds the user to delete the raw HAR');
    assert.ok(printed.includes(MINI_HAR), 'the reminder names the file to delete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('har-summary refuses a call without --api or --out (exit 2)', async () => {
  assert.equal(await main(['har-summary', MINI_HAR, '--out', '/tmp/never-written.json']), 2);
  assert.equal(await main(['har-summary', MINI_HAR, '--api', API]), 2);
  assert.equal(await main(['har-summary', '--api', API, '--out', '/tmp/never-written.json']), 2);
});
