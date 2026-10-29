import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { acceptBaseline, BaselineRefusedError, compareRuns, loadBaseline, readBaselineFile } from './baseline.js';
import { loadFeature, type Feature } from './config.js';
import { buildReportModel } from './report/build.js';
import type { BaselineSlot } from './report/model.js';
import { loadFixtureProject } from '../tests/fixtures/report/fixtureProject.js';

const FIXTURES = fileURLToPath(new URL('../tests/fixtures/report', import.meta.url));
const NOW = new Date('2026-10-23T09:30:00.000Z');

let dir: string;
let feature: Feature;
const scratch: string[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'perf-baseline-'));
  feature = await loadFeature(await loadFixtureProject(), 'forms');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const root of scratch) await rm(root, { recursive: true, force: true });
});

const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, 'utf8'));
const writeJson = (file: string, value: unknown): Promise<void> => writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** A scratch copy of a fixture run folder (its meta.json edited by `edit`) next to an empty scratch feature folder. */
async function prepare(
  kind: 'load' | 'stress',
  edit: (files: { meta: any; summary: any }) => void = () => {},
): Promise<{ runDir: string; featureDir: string; feature: Feature }> {
  const root = await mkdtemp(join(tmpdir(), 'perf-accept-'));
  scratch.push(root);
  const runDir = join(root, 'run');
  const featureDir = join(root, 'feature');
  await cp(join(FIXTURES, kind), runDir, { recursive: true });
  await mkdir(featureDir);
  const meta = await readJson(join(runDir, 'meta.json'));
  const summary = await readJson(join(runDir, 'summary.json'));
  edit({ meta, summary });
  await writeJson(join(runDir, 'meta.json'), meta);
  await writeJson(join(runDir, 'summary.json'), summary);
  return { runDir, featureDir, feature: { ...feature, dir: featureDir } };
}

/** Set the p95 of a step in a summary.json. */
const setP95 = (summary: any, step: string, p95: number): void => {
  summary.metrics[`http_req_duration{name:${step}}`].values['p(95)'] = p95;
};

const slot = {
  runId: '2026-10-01_2010_acme_forms_load',
  acceptedAt: '2026-10-01T21:00:00.000Z',
  steps: { 'analyst.grid_open': { p50: 400, p95: 800, p99: 1200, errorRate: 0, rps: 0.5 } },
};

test('a feature without baseline.json has no baseline', async () => {
  assert.equal(await readBaselineFile(dir), undefined);
  assert.equal(await loadBaseline(dir, 'staging', 'load'), undefined);
});

test('loadBaseline returns the slot of the env and profile, and nothing for another', async () => {
  await writeFile(join(dir, 'baseline.json'), JSON.stringify({ staging: { load: slot } }), 'utf8');
  assert.deepEqual(await loadBaseline(dir, 'staging', 'load'), slot);
  assert.equal(await loadBaseline(dir, 'staging', 'stress'), undefined);
  assert.equal(await loadBaseline(dir, 'dev', 'load'), undefined);
  assert.equal(await loadBaseline(dir, 'constructor', 'load'), undefined, 'object prototype keys are not slots');
  assert.deepEqual(await readBaselineFile(dir), { staging: { load: slot } });
});

test('a baseline.json that is not JSON or holds a malformed slot is an error that names the file and the slot', async () => {
  await writeFile(join(dir, 'baseline.json'), '{ not json', 'utf8');
  await assert.rejects(loadBaseline(dir, 'staging', 'load'), /baseline\.json is not valid JSON/);

  await writeFile(join(dir, 'baseline.json'), JSON.stringify({ staging: { load: { ...slot, steps: { x: { p95: 'fast' } } } } }), 'utf8');
  await assert.rejects(loadBaseline(dir, 'staging', 'load'), /baseline\.json: \["staging"\]\["load"\]/);

  await writeFile(join(dir, 'baseline.json'), JSON.stringify({ staging: { load: { runId: 'r' } } }), 'utf8');
  await assert.rejects(loadBaseline(dir, 'staging', 'load'), /acceptedAt/);

  await writeFile(join(dir, 'baseline.json'), JSON.stringify([1, 2]), 'utf8');
  await assert.rejects(loadBaseline(dir, 'staging', 'load'), /must be an object/);
});

// ---------------------------------------------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------------------------------------------

test('accept writes the env/profile slot from the run\'s own numbers', async () => {
  const run = await prepare('load');
  const message = await acceptBaseline(run.runDir, { feature: run.feature, now: () => NOW });

  const file = await readJson(join(run.featureDir, 'baseline.json'));
  assert.deepEqual(Object.keys(file), ['staging']);
  assert.deepEqual(Object.keys(file.staging), ['load']);
  const slot = file.staging.load;
  assert.equal(slot.runId, '2026-10-22_2010_acme_forms_load');
  assert.equal(slot.acceptedAt, NOW.toISOString());
  assert.deepEqual(Object.keys(slot.steps), [
    'analyst.grid_open',
    'analyst.grid_search',
    'analyst.grid_sort',
    'analyst.grid_filter',
    'analyst.grid_next_page',
    'analyst.grid_export',
  ]);
  // the numbers of summary.json: http_req_duration{name:analyst.grid_open} has med 520.304, p(95) 1010.236, p(99) 1450.9, count 300
  const open = slot.steps['analyst.grid_open'];
  assert.deepEqual(Object.keys(open), ['p50', 'p95', 'p99', 'errorRate', 'rps']);
  assert.equal(open.p50, 520.304);
  assert.equal(open.p95, 1010.236);
  assert.equal(open.p99, 1450.9);
  assert.equal(open.errorRate, 0);
  assert.ok(Math.abs(open.rps - 300 / 781.4528) < 1e-9, `rps is count / run duration (got ${open.rps})`);

  // what it wrote is what the report reads back, and the message names the slot, the run and the file
  assert.deepEqual(await loadBaseline(run.featureDir, 'staging', 'load'), slot as BaselineSlot);
  assert.match(message, /staging\/load/);
  assert.match(message, /2026-10-22_2010_acme_forms_load/);
  assert.match(message, /6 steps/);
  assert.match(message, /baseline\.json/);
  assert.deepEqual(await readdir(run.featureDir), ['baseline.json'], 'no temp file is left behind');
});

test('accept keeps every other slot of baseline.json as it was', async () => {
  const run = await prepare('load');
  const other = { runId: 'other', acceptedAt: '2026-09-01T00:00:00.000Z', steps: { 'analyst.grid_open': { p50: 1, p95: 2, p99: 3, errorRate: 0, rps: 4 } } };
  const odd = { note: 'a slot the code does not know' };
  await writeJson(join(run.featureDir, 'baseline.json'), { staging: { stress: other, load: { runId: 'old', acceptedAt: 'x', steps: {} } }, dev: { load: odd } });

  await acceptBaseline(run.runDir, { feature: run.feature, now: () => NOW });

  const file = await readJson(join(run.featureDir, 'baseline.json'));
  assert.deepEqual(file.staging.stress, other);
  assert.deepEqual(file.dev, { load: odd });
  assert.equal(file.staging.load.runId, '2026-10-22_2010_acme_forms_load');
});

test('accept refuses FAIL and INVALID runs and writes nothing', async () => {
  const failed = await prepare('load', ({ meta }) => {
    meta.k6.exitCode = 99;
    meta.k6.abortReason = 'thresholds';
  });
  await assert.rejects(acceptBaseline(failed.runDir, { feature: failed.feature }), (err: Error) => {
    assert.ok(err instanceof BaselineRefusedError);
    assert.match(err.message, /^cannot accept a FAIL run as baseline/);
    return true;
  });
  assert.deepEqual(await readdir(failed.featureDir), [], 'a refused run creates no baseline.json');

  const invalid = await prepare('load', ({ meta }) => {
    meta.fingerprint.changed = true;
  });
  await assert.rejects(acceptBaseline(invalid.runDir, { feature: invalid.feature }), /cannot accept a INVALID run as baseline/);

  // an existing baseline.json stays as it is
  const existing = { staging: { load: { runId: 'keep', acceptedAt: 'x', steps: {} } } };
  await writeJson(join(invalid.featureDir, 'baseline.json'), existing);
  await assert.rejects(acceptBaseline(invalid.runDir, { feature: invalid.feature }), /cannot accept a INVALID run as baseline/);
  assert.deepEqual(await readJson(join(invalid.featureDir, 'baseline.json')), existing);
});

test('accept refuses a smoke run: its timings are single samples', async () => {
  const smoke = await prepare('load', ({ meta }) => {
    meta.profile = { type: 'smoke', totalSec: 0 };
  });
  await assert.rejects(acceptBaseline(smoke.runDir, { feature: smoke.feature }), (err: Error) => {
    assert.ok(err instanceof BaselineRefusedError);
    assert.match(err.message, /^cannot accept a smoke run as baseline: its timings are single samples/);
    return true;
  });
  assert.deepEqual(await readdir(smoke.featureDir), [], 'nothing is written');
});

test('accept takes a DEGRADED run (the brief refuses only FAIL and INVALID) and says so', async () => {
  const run = await prepare('load', ({ meta, summary }) => {
    // a baseline half as slow as the run flags every step P95_REGRESSION
    const steps: BaselineSlot['steps'] = {};
    for (const id of ['analyst.grid_open', 'analyst.grid_search']) {
      const v = summary.metrics[`http_req_duration{name:${id}}`].values;
      steps[id] = { p50: v.med / 2, p95: v['p(95)'] / 2, p99: v['p(99)'] / 2, errorRate: 0, rps: 0.3 };
    }
    meta.baseline = { env: 'staging', profile: 'load', runId: 'older', acceptedAt: '2026-10-01T00:00:00.000Z', steps };
  });
  assert.equal((await buildReportModel(run.runDir)).verdict.verdict, 'DEGRADED');
  const message = await acceptBaseline(run.runDir, { feature: run.feature, now: () => NOW });
  assert.match(message, /DEGRADED/);
  assert.equal((await loadBaseline(run.featureDir, 'staging', 'load'))?.runId, '2026-10-22_2010_acme_forms_load');
});

test('re-accept overwrites runId, numbers and time of the slot', async () => {
  const first = await prepare('load');
  await acceptBaseline(first.runDir, { feature: first.feature, now: () => NOW });

  const second = await prepare('load', ({ meta, summary }) => {
    meta.runId = '2026-10-23_2010_acme_forms_load';
    setP95(summary, 'analyst.grid_open', 777);
  });
  const later = new Date('2026-10-24T10:00:00.000Z');
  // the same feature folder: move the first run's baseline.json next to the second run
  await cp(join(first.featureDir, 'baseline.json'), join(second.featureDir, 'baseline.json'));
  const message = await acceptBaseline(second.runDir, { feature: second.feature, now: () => later });

  const slot = await loadBaseline(second.featureDir, 'staging', 'load');
  assert.equal(slot?.runId, '2026-10-23_2010_acme_forms_load');
  assert.equal(slot?.acceptedAt, later.toISOString());
  assert.equal(slot?.steps['analyst.grid_open']?.p95, 777);
  assert.match(message, /replacing 2026-10-22_2010_acme_forms_load/);
  assert.deepEqual(Object.keys(await readJson(join(second.featureDir, 'baseline.json'))), ['staging']);
});

test('accept leaves out steps with no data and refuses a run with none', async () => {
  const run = await prepare('load', ({ summary }) => {
    delete summary.metrics['http_req_failed{name:analyst.grid_export}']; // no error rate to store
    delete summary.metrics['http_req_duration{name:analyst.grid_sort}']; // sent nothing
  });
  await acceptBaseline(run.runDir, { feature: run.feature, now: () => NOW });
  const slot = await loadBaseline(run.featureDir, 'staging', 'load');
  assert.ok(slot, 'the slot passes the loader\'s check: every stored step has all five numbers');
  assert.ok(!('analyst.grid_export' in slot.steps) && !('analyst.grid_sort' in slot.steps));
  assert.equal(Object.keys(slot.steps).length, 4);

  const empty = await prepare('load', ({ summary }) => {
    for (const key of Object.keys(summary.metrics)) if (key.startsWith('http_req_failed{name:')) delete summary.metrics[key];
  });
  await assert.rejects(acceptBaseline(empty.runDir, { feature: empty.feature }), /no per-step numbers/);
  assert.deepEqual(await readdir(empty.featureDir), []);
});

test('accept refuses to write over a baseline.json it cannot read', async () => {
  const run = await prepare('load');
  await writeFile(join(run.featureDir, 'baseline.json'), '{ not json', 'utf8');
  await assert.rejects(acceptBaseline(run.runDir, { feature: run.feature }), /baseline\.json is not valid JSON/);
  assert.equal(await readFile(join(run.featureDir, 'baseline.json'), 'utf8'), '{ not json');

  await writeJson(join(run.featureDir, 'baseline.json'), { staging: [1] });
  await assert.rejects(acceptBaseline(run.runDir, { feature: run.feature }), /\["staging"\] must be an object keyed by profile/);
});

test('accept needs a run folder', async () => {
  await assert.rejects(acceptBaseline(join(dir, 'no-such-run')), /is not a run folder/);
});

// ---------------------------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------------------------

test('compare shows +25.0% for a step whose p95 went 1000→1250', async () => {
  const a = await prepare('load', ({ summary }) => setP95(summary, 'analyst.grid_open', 1000));
  const b = await prepare('load', ({ meta, summary }) => {
    meta.runId = '2026-10-23_2010_acme_forms_load';
    setP95(summary, 'analyst.grid_open', 1250);
    setP95(summary, 'analyst.grid_search', 100);
  });
  const text = await compareRuns(a.runDir, b.runDir);
  const lines = text.split('\n');

  assert.ok(lines.includes('| step | p95 A | p95 B | Δ% |'), 'the table has the four columns');
  assert.ok(lines.includes('| analyst.grid_open | 1,000 ms | 1,250 ms | +25.0% |'), text);
  const search = lines.find((l) => l.startsWith('| analyst.grid_search '))!;
  assert.match(search, /\| -\d+\.\d% \|$/, 'a faster step has a minus sign');
  assert.ok(lines.includes('| analyst.grid_sort | 931 ms | 931 ms | 0.0% |'), 'an unchanged step is 0.0%');
  // A and B are named above the table
  assert.match(text, /^A: 2026-10-22_2010_acme_forms_load /m);
  assert.match(text, /^B: 2026-10-23_2010_acme_forms_load /m);
  assert.doesNotMatch(text, /differ/, 'two runs of the same feature, env and profile need no warning');
});

test('compare marks a step only one run measured, and warns when the runs are not alike', async () => {
  const a = await prepare('load');
  const b = await prepare('stress', ({ summary }) => {
    delete summary.metrics['http_req_duration{name:analyst.grid_export}'];
  });
  const text = await compareRuns(a.runDir, b.runDir);
  const row = text.split('\n').find((l) => l.startsWith('| analyst.grid_export '))!;
  assert.match(row, /^\| analyst\.grid_export \| 1,500 ms \| – \| – \|$/, row);
  assert.match(text, /the runs differ in profile \(load, stress\)/);
});

test('compare of a step with a zero p95 in A gives no percentage', async () => {
  const a = await prepare('load', ({ summary }) => setP95(summary, 'analyst.grid_open', 0));
  const b = await prepare('load');
  const row = (await compareRuns(a.runDir, b.runDir)).split('\n').find((l) => l.startsWith('| analyst.grid_open '))!;
  assert.match(row, /\| 0 ms \| 1,010 ms \| – \|$/);
});
