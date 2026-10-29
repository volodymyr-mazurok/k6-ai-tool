import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { describeSecretScan, scanRunFolder } from './secretScan.js';

// A JWT-shaped string, built from parts so no token-looking literal sits in the repo.
const JWT = ['eyJhbGciOiJSUzI1NiJ9', 'eyJzdWIiOiJwZXJmIn0', 'c2lnbmF0dXJl-_x'].join('.');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perf-secretscan-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = (name: string, content: string | object): Promise<void> =>
  writeFile(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
const get = (name: string): Promise<string> => readFile(join(dir, name), 'utf8');

test('a clean run folder is ok and meta.json records it', async () => {
  await put('summary.json', { metrics: { checks: { values: { rate: 1 } } } });
  await put('k6.log', 'level=info msg="running"\n');
  await put('k6-config.json', { runId: 'r1' });
  await put('timeseries.json', { buckets: [] });
  await put('meta.json', { runId: 'r1' });

  assert.deepEqual(await scanRunFolder(dir), { ok: true });

  assert.deepEqual(JSON.parse(await get('meta.json')), { runId: 'r1', secretScan: { ok: true } });
  assert.deepEqual(JSON.parse(await get('summary.json')), { metrics: { checks: { values: { rate: 1 } } } });
});

test('missing files are skipped', async () => {
  assert.deepEqual(await scanRunFolder(dir), { ok: true });
});

test('a setup_data key in summary.json is removed, the rest stays', async () => {
  await put('summary.json', { metrics: { checks: { values: { rate: 1 } } }, setup_data: { tokens: { User: { refresh: 'opaque-refresh' } } } });
  await put('meta.json', { runId: 'r1' });

  const scan = await scanRunFolder(dir);

  assert.deepEqual(scan, { ok: false, files: ['summary.json'] });
  const summary = JSON.parse(await get('summary.json'));
  assert.ok(!('setup_data' in summary));
  assert.ok(!(await get('summary.json')).includes('opaque-refresh'));
  assert.deepEqual(summary.metrics, { checks: { values: { rate: 1 } } });
  assert.deepEqual(JSON.parse(await get('meta.json')).secretScan, { ok: false, files: ['summary.json'] });
});

test('a JWT in any scanned file is replaced by [redacted] and the file is named, never the token', async () => {
  await put('summary.json', { tags: { note: `Bearer ${JWT}` } });
  await put('k6.log', `time=1 level=info msg="got ${JWT} back"\nsecond line\n`);
  await put('k6-config.json', { runId: 'r1' });
  await put('timeseries.json', { origin: JWT });
  await put('meta.json', { runId: 'r1', checks: [{ message: `GET /x?access_token=${JWT}` }] });

  const scan = await scanRunFolder(dir);

  assert.deepEqual(scan, { ok: false, files: ['summary.json', 'k6.log', 'timeseries.json', 'meta.json'] });
  assert.ok(!JSON.stringify(scan).includes('eyJ'));
  for (const name of ['summary.json', 'k6.log', 'timeseries.json', 'meta.json']) {
    assert.ok(!(await get(name)).includes('eyJ'), `${name} still holds a token`);
    assert.ok((await get(name)).includes('[redacted]'), `${name} shows [redacted]`);
  }
  assert.equal(await get('k6.log'), 'time=1 level=info msg="got [redacted] back"\nsecond line\n');
  assert.equal(await get('k6-config.json'), '{"runId":"r1"}'); // untouched
  JSON.parse(await get('summary.json')); // still valid JSON
  const meta = JSON.parse(await get('meta.json'));
  assert.deepEqual(meta.secretScan, { ok: false, files: ['summary.json', 'k6.log', 'timeseries.json', 'meta.json'] });
});

test('setup_data and a JWT in the same summary.json name the file once', async () => {
  await put('summary.json', { setup_data: { tokens: { User: { access: JWT } } }, note: JWT });

  assert.deepEqual(await scanRunFolder(dir), { ok: false, files: ['summary.json'] });

  assert.equal(await get('summary.json'), '{"note":"[redacted]"}');
});

test('text that only looks a little like a token is left alone', async () => {
  await put('k6.log', 'eyJ-no-dots-here and eyJabc.def without a second dot\n');

  assert.deepEqual(await scanRunFolder(dir), { ok: true });

  assert.equal(await get('k6.log'), 'eyJ-no-dots-here and eyJabc.def without a second dot\n');
});

test('a scan with nothing to redact leaves the files byte for byte as they were', async () => {
  const original = '{\n  "metrics": {}\n}\n';
  await put('summary.json', original);

  await scanRunFolder(dir);

  assert.equal(await get('summary.json'), original);
});

test('secrets the runner knows (a static header key) are redacted as literals in every file of the run folder, .gz included', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const key = 'k3y-from-env-0042';
  await put('k6.log', `level=info msg="header token ${key}"\n`);
  await put('summary.json', { metrics: {}, note: `Authorization: ${key}` });
  await put('extra.txt', `written by a handleSummary: ${key}`);
  await writeFile(join(dir, 'points.json.gz'), gzipSync(`{"tags":{"auth":"${key}"}}\n`));
  await put('timeseries.json', { buckets: [] });
  await put('meta.json', { runId: 'r1' });

  const scan = await scanRunFolder(dir, [key, 'ab']);
  assert.deepEqual(scan, { ok: false, files: ['summary.json', 'k6.log', 'extra.txt', 'points.json.gz'] });
  for (const name of ['k6.log', 'summary.json', 'extra.txt']) {
    const text = await get(name);
    assert.ok(!text.includes(key) && text.includes('[redacted]'), name);
  }
  const points = gunzipSync(await readFile(join(dir, 'points.json.gz'))).toString('utf8');
  assert.ok(!points.includes(key) && points.includes('[redacted]'));
  assert.deepEqual(JSON.parse(await get('meta.json')).secretScan, scan);
  assert.equal(await get('timeseries.json'), JSON.stringify({ buckets: [] }), 'a file without a hit is left byte for byte');
});

test('a secret shorter than 4 characters is not redacted (it would match ordinary text)', async () => {
  await put('k6.log', 'ab ab ab\n');
  await put('meta.json', { runId: 'r1' });
  assert.deepEqual(await scanRunFolder(dir, ['ab']), { ok: true });
});

test('a truncated .gz (k6 killed mid-write) is recorded as not scanned; the rest is still scanned and meta.json is written', async () => {
  const { gzipSync } = await import('node:zlib');
  const key = 'k3y-from-env-0042';
  const whole = gzipSync(`{"line":1}\n{"auth":"${key}"}\n`.repeat(50));
  await writeFile(join(dir, 'points.json.gz'), whole.subarray(0, Math.floor(whole.length / 2)));
  await put('k6.log', `token ${key}\n`);
  await put('meta.json', { runId: 'r1' });

  const scan = await scanRunFolder(dir, [key]);
  assert.deepEqual(scan, {
    ok: false,
    files: ['k6.log', 'points.json.gz'],
    unscanned: [{ file: 'points.json.gz', reason: 'could not be decompressed, not scanned' }],
  });
  assert.equal(await get('k6.log'), 'token [redacted]\n');
  assert.deepEqual(JSON.parse(await get('meta.json')).secretScan, scan);
});

test('a .gz is scanned as a stream, line by line; a line above the size limit leaves the file unscanned, not a crash', async () => {
  const { gzipSync, gunzipSync } = await import('node:zlib');
  const key = 'k3y-from-env-0042';
  const lines = Array.from({ length: 2000 }, (_v, i) => `{"n":${i},"auth":"${i === 1500 ? key : 'none'}"}`).join('\n') + '\n';
  await writeFile(join(dir, 'points.json.gz'), gzipSync(lines));
  await put('meta.json', { runId: 'r1' });
  assert.deepEqual(await scanRunFolder(dir, [key], { maxLineBytes: 200 }), { ok: false, files: ['points.json.gz'] });
  const after = gunzipSync(await readFile(join(dir, 'points.json.gz'))).toString('utf8');
  assert.equal(after, lines.replace(key, '[redacted]'), 'every other byte is kept');

  await writeFile(join(dir, 'big.json.gz'), gzipSync(`{"blob":"${'x'.repeat(5000)}${key}"}\n`));
  const scan = await scanRunFolder(dir, [key], { maxLineBytes: 1000 });
  assert.deepEqual(scan, {
    ok: false,
    files: ['big.json.gz'],
    unscanned: [{ file: 'big.json.gz', reason: 'has a line longer than 1000 bytes, not scanned' }],
  });
});

test('a secret is also found in its JSON-escaped form (a value holding " or \\)', async () => {
  const key = 'pa"ss\\word-77';
  await put('summary.json', { leaked: key });
  await put('k6.log', `raw ${key}\n`);
  await put('meta.json', { runId: 'r1' });
  assert.deepEqual(await scanRunFolder(dir, [key]), { ok: false, files: ['summary.json', 'k6.log'] });
  assert.deepEqual(JSON.parse(await get('summary.json')), { leaked: '[redacted]' });
  assert.equal(await get('k6.log'), 'raw [redacted]\n');
});

test('describeSecretScan says which files were redacted and which could not be scanned, apart', () => {
  assert.equal(describeSecretScan({ ok: true }), 'no token found');
  assert.equal(describeSecretScan({ ok: false, files: ['k6.log', 'meta.json'] }), 'tokens were found and removed from k6.log, meta.json');
  assert.equal(
    describeSecretScan({ ok: false, files: ['points.json.gz'], unscanned: [{ file: 'points.json.gz', reason: 'could not be decompressed, not scanned' }] }),
    'points.json.gz could not be decompressed, not scanned',
    'an unscanned file is not called redacted',
  );
  assert.equal(
    describeSecretScan({ ok: false, files: ['k6.log', 'points.json.gz'], unscanned: [{ file: 'points.json.gz', reason: 'could not be decompressed, not scanned' }] }),
    'tokens were found and removed from k6.log; points.json.gz could not be decompressed, not scanned',
  );
});
