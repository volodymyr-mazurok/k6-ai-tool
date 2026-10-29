// core/auth/static.js inside k6: the header value is made once per virtual user (init context), so each VU keeps its own
// value for all its requests and VUs do not share one. Needs k6 on the PATH. Nothing leaves the machine.
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { runK6Script } from './harness.js';

const SCRIPT = fileURLToPath(new URL('./static.k6.js', import.meta.url));

test('a static header with ${random:16}: one value per VU, the same on every request of that VU', async () => {
  const seen: { vu: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    seen.push({ vu: String(req.headers['x-vu']), auth: String(req.headers['x-quick-token']) });
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let runDir: string | undefined;
  try {
    const result = await runK6Script(SCRIPT, { apiUrl: url }, { accounts: {}, header: { name: 'X-Quick-Token', value: 'token ${random:16}' } });
    runDir = result.runDir;
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    server.close();
    server.closeAllConnections();
    if (runDir) await rm(runDir, { recursive: true, force: true });
  }
  assert.equal(seen.length, 9, 'three VUs, three requests each');
  const byVu = new Map<string, Set<string>>();
  for (const { vu, auth } of seen) {
    assert.match(auth, /^token [a-z0-9]{16}$/);
    byVu.set(vu, (byVu.get(vu) ?? new Set()).add(auth));
  }
  assert.equal(byVu.size, 3);
  for (const [vu, values] of byVu) assert.equal(values.size, 1, `VU ${vu} kept one value`);
  assert.equal(new Set([...byVu.values()].map((v) => [...v][0])).size, 3, 'no two VUs share a value');
});

test('staticHeaders refuses a secrets file without a header (a project whose auth is not static_header)', async () => {
  const result = await runK6Script(SCRIPT, { apiUrl: 'http://127.0.0.1:9' }, { accounts: {} });
  await rm(result.runDir, { recursive: true, force: true });
  assert.notEqual(result.code, 0);
  assert.match(`${result.stdout}${result.stderr}`, /no static header in the secrets file/);
});
