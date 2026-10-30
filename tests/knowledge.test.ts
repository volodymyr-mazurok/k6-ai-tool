import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadReferences, parseReferences, referenceIds } from '../runner/knowledge.js';

const today = new Date().toISOString().slice(0, 10);
const read = (file: string): Promise<string> => readFile(join('knowledge', file), 'utf8');

test('references.md holds at least 12 well-formed, unique, dated entries', async () => {
  const refs = await loadReferences();
  assert.ok(refs.length >= 12, `expected at least 12 references, got ${refs.length}`);
  const seen = new Set<string>();
  for (const ref of refs) {
    assert.match(ref.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `id ${ref.id}`);
    assert.ok(!seen.has(ref.id), `duplicate id ${ref.id}`);
    seen.add(ref.id);
    assert.ok(ref.title.length > 0, `${ref.id}: title`);
    assert.ok(ref.url.startsWith('https://'), `${ref.id}: url must start with https://`);
    assert.match(ref.read, /^\d{4}-\d{2}-\d{2}$/, `${ref.id}: read date format`);
    const parsed = new Date(`${ref.read}T00:00:00Z`);
    assert.ok(!Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === ref.read, `${ref.id}: read is not a real date`);
    assert.ok(ref.read <= today, `${ref.id}: read date ${ref.read} is after today`);
    assert.ok(ref.claim.trim().length > 0, `${ref.id}: claim is empty`);
  }
});

test('every [ref:<id>] in metrics.md and bottlenecks.md resolves to a reference', async () => {
  const ids = await referenceIds();
  for (const file of ['metrics.md', 'bottlenecks.md']) {
    const text = await read(file);
    const cited = [...text.matchAll(/\[ref:([^\]]*)\]/g)].map((m) => m[1]);
    assert.ok(cited.length > 0, `${file} cites no reference`);
    for (const id of cited) assert.ok(ids.has(id), `${file} cites [ref:${id}], which references.md does not define`);
  }
});

test('metrics.md covers each metric the report shows', async () => {
  const text = (await read('metrics.md')).toLowerCase();
  for (const term of ['p50', 'p95', 'p99', 'http_req_failed', 'checks', 'req/s', 'iterations', 'dropped iterations', 'db cpu', 'io']) {
    assert.ok(text.includes(term), `metrics.md does not mention ${term}`);
  }
});

test('knowledge/README.md explains the format', async () => {
  const text = await read('README.md');
  for (const needle of ['references.md', 'metrics.md', 'bottlenecks.md', '[ref:', '## <id>', '- Title:', '- URL:', '- Read:', '- Claim:']) {
    assert.ok(text.includes(needle), `knowledge/README.md does not explain ${needle}`);
  }
});

const GOOD = `## some-source
- Title: A title
- URL: https://example.org/a
- Read: 2026-10-30
- Claim: one thing it supports
`;

test('parseReferences reads the four lines of each entry', () => {
  const [ref] = parseReferences(GOOD);
  assert.deepEqual(ref, { id: 'some-source', title: 'A title', url: 'https://example.org/a', read: '2026-10-30', claim: 'one thing it supports' });
});

test('parseReferences names the id and the missing line', () => {
  for (const line of ['Title', 'URL', 'Read', 'Claim']) {
    const broken = GOOD.split('\n').filter((l) => !l.startsWith(`- ${line}:`)).join('\n');
    assert.throws(() => parseReferences(broken), (err: Error) => err.message.includes('some-source') && err.message.includes(`- ${line}:`), line);
  }
});

test('parseReferences rejects a bad id, a duplicate id, an http url and a bad date', () => {
  assert.throws(() => parseReferences(GOOD.replace('some-source', 'Some Source')), /Some Source/);
  assert.throws(() => parseReferences(GOOD + GOOD), /some-source.*duplicate/);
  assert.throws(() => parseReferences(GOOD.replace('https://', 'http://')), /some-source.*https/);
  assert.throws(() => parseReferences(GOOD.replace('2026-10-30', '2026-13-45')), /some-source.*date/);
  assert.throws(() => parseReferences(GOOD.replace('A title', 'A title\n- Extra: x')), /some-source/);
});

test('loadReferences reads from a given root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'perf-knowledge-'));
  try {
    await mkdir(join(root, 'knowledge'));
    await writeFile(join(root, 'knowledge', 'references.md'), `# Refs\n\nintro\n\n${GOOD}`, 'utf8');
    assert.deepEqual([...(await referenceIds(root))], ['some-source']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
