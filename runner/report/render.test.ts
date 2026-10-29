import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../cli.js';
import { loadFeature, type Feature, type Project } from '../config.js';
import { buildReportModel, renderRunReport, verifyRunReport } from './build.js';
import { BREAKING_LIMITS, FLAG_LIMITS, stepStats, type BaselineSlot, type K6Summary } from './model.js';
import { maskSql, renderHtml, renderMarkdown, REPORT_TERMS } from './render.js';
import { evaluate } from './sources.js';
import { verifyHtml } from './verify.js';
import { lineChart } from './svg.js';
import { loadFixtureProject } from '../../tests/fixtures/report/fixtureProject.js';

const FIXTURES = fileURLToPath(new URL('../../tests/fixtures/report', import.meta.url));
const STEP_IDS = ['analyst.grid_open', 'analyst.grid_search', 'analyst.grid_sort', 'analyst.grid_filter', 'analyst.grid_next_page', 'analyst.grid_export'];
const HEADINGS = ['Verdict', 'What ran', 'Under what load', 'Results per step', 'Breaking point', 'Database', 'Compared with baseline', 'Automatic flags', 'Findings and recommendations', 'Files'];

let project: Project;
let feature: Feature;
const scratch: string[] = [];

before(async () => {
  project = await loadFixtureProject(); // a shared test never reads a real project
  feature = await loadFeature(project, 'forms');
});

after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'));
const writeJson = (file: string, value: unknown): void => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');

/** A baseline slot built from a run's own summary, `scale` times its p95/p50/p99 (so 1 is "no change"). */
function baselineFrom(summary: K6Summary, scale = 1, over: Record<string, Partial<BaselineSlot['steps'][string]>> = {}): BaselineSlot {
  const steps: BaselineSlot['steps'] = {};
  for (const s of stepStats(summary, STEP_IDS, summary.state!.testRunDurationMs! / 1000)) {
    steps[s.id] = { p50: s.p50 * scale, p95: s.p95 * scale, p99: s.p99 * scale, errorRate: s.errorRate ?? 0, rps: s.rps, ...over[s.id] };
  }
  return { runId: '2026-10-01_2010_acme_forms_load', acceptedAt: '2026-10-01T21:00:00.000Z', steps };
}

interface Prepared {
  runDir: string;
  feature: Feature;
  html: string;
  md: string;
  model: Awaited<ReturnType<typeof buildReportModel>>;
}

interface PrepareOptions {
  /**
   * `1` = a baseline equal to the run; a function builds the slot from the run's summary. Recorded in meta.json (`meta.baseline`),
   * as the runner does when a run finishes; with `legacy` it goes to the feature's baseline.json instead.
   */
  baseline?: number | ((summary: K6Summary) => BaselineSlot);
  /** An older run folder: no baseline, limits or workload terms in meta.json, no k6-config.json. */
  legacy?: boolean;
  findings?: string;
  /** Edit the run folder's files before the report is built. */
  edit?: (runDir: string) => void;
}

/**
 * A scratch copy of a fixture run folder (and a scratch feature folder, which only an older run folder falls back to),
 * with the report built from it.
 */
async function prepare(kind: 'load' | 'stress', options: PrepareOptions = {}): Promise<Prepared> {
  const root = mkdtempSync(join(tmpdir(), 'perf-report-'));
  scratch.push(root);
  const runDir = join(root, 'run');
  cpSync(join(FIXTURES, kind), runDir, { recursive: true });
  const featureDir = join(root, 'feature');
  mkdirSync(featureDir);
  const scratchFeature: Feature = { ...feature, dir: featureDir };
  if (options.findings !== undefined) writeFileSync(join(runDir, 'findings.md'), options.findings, 'utf8');
  options.edit?.(runDir);
  if (options.legacy) {
    const meta = readJson(join(runDir, 'meta.json'));
    for (const key of ['baseline', 'rules', 'workload', 'abort']) delete meta[key];
    writeJson(join(runDir, 'meta.json'), meta);
    rmSync(join(runDir, 'k6-config.json'));
  }
  if (options.baseline !== undefined) {
    const summary = readJson(join(runDir, 'summary.json')) as K6Summary;
    const slot = typeof options.baseline === 'function' ? options.baseline(summary) : baselineFrom(summary, options.baseline);
    const meta = readJson(join(runDir, 'meta.json'));
    if (options.legacy) {
      writeJson(join(featureDir, 'baseline.json'), { [meta.env]: { [meta.profile.type]: slot } });
    } else {
      writeJson(join(runDir, 'meta.json'), { ...meta, baseline: { env: meta.env, profile: meta.profile.type, ...slot } });
    }
  }
  const model = await buildReportModel(runDir, { project, feature: scratchFeature });
  return { runDir, feature: scratchFeature, html: renderHtml(model), md: renderMarkdown(model), model };
}

// --- reading the output back --------------------------------------------------------------------------------------

const decode = (text: string): string =>
  text.replaceAll('&quot;', '"').replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
const stripTags = (html: string): string => decode(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();

const headingsOf = (html: string): string[] => [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => decode(m[1]!));
const mdHeadingsOf = (md: string): string[] => [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());

function section(html: string, id: string): string | undefined {
  return new RegExp(`<section id="${id}"[^>]*>([\\s\\S]*?)</section>`).exec(html)?.[1];
}

/** Rows of the first table in an HTML fragment as plain cell text (header row first). */
function htmlTable(fragment: string): string[][] {
  const table = /<table[\s\S]*?<\/table>/.exec(fragment)?.[0] ?? '';
  return [...table.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((row) => [...row[1]!.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => stripTags(cell[1]!)));
}

function mdSection(md: string, title: string): string | undefined {
  const start = md.search(new RegExp(`^## ${title}$`, 'm'));
  if (start < 0) return undefined;
  const rest = md.slice(start + title.length + 3);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

function mdTable(fragment: string): string[][] {
  return fragment
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|[\s:|-]+\|$/.test(line))
    .map((line) => line.slice(1, -1).split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/^`(.*)`$/, '$1').replace(/\\(.)/g, '$1')));
}

const column = (rows: string[][], prefix: string): number => {
  const i = rows[0]!.findIndex((h) => h.startsWith(prefix));
  assert.ok(i >= 0, `no column starting with "${prefix}" in ${JSON.stringify(rows[0])}`);
  return i;
};

const numbers = (html: string): string[] => [...html.matchAll(/<span class="num[ "][^>]*>/g)].map((m) => m[0]);

// ---------------------------------------------------------------------------------------------------------------
// the brief's tests
// ---------------------------------------------------------------------------------------------------------------

test('html has no external URLs', async () => {
  const hostile = '# Findings\n\n[docs](https://example.com/x) and ![pic](https://example.com/p.png)';
  for (const kind of ['load', 'stress'] as const) {
    const { html } = await prepare(kind, { findings: hostile, baseline: 1 });
    assert.ok(!/(?:src|href)="https?:/i.test(html), 'no src/href to a remote file');
    assert.ok(!/(?<![-\w])(?:src|href)=/i.test(html.replace(/href="[^":#][^":]*"/g, '')), 'only relative file links remain');
    assert.ok(!/<script|<link|<iframe|<img|@import|url\(/i.test(html), 'no script, stylesheet link, frame, image or import');
    assert.ok(!/https?:\/\//.test(html.replace(/https?:\/\/example\.com[^\s<)]*/g, '')), 'no URL except the findings text itself');
  }
});

test('stress fixture renders every heading in order', async () => {
  const { html, md } = await prepare('stress', { findings: '# Findings\n\n1. The break is at 9 req/s.' });
  assert.deepEqual(headingsOf(html), HEADINGS);
  assert.deepEqual(mdHeadingsOf(md), HEADINGS);
});

test('load fixture has no Breaking point section', async () => {
  const { html, md } = await prepare('load');
  assert.deepEqual(headingsOf(html), HEADINGS.filter((h) => h !== 'Breaking point' && h !== 'Findings and recommendations'));
  assert.ok(!html.includes('Breaking point'));
  assert.ok(!md.includes('Breaking point'));
});

test('every number has a data-src that resolves to the same value', async () => {
  for (const kind of ['load', 'stress'] as const) {
    const { html, model } = await prepare(kind, { baseline: (s) => baselineFrom(s, 0.9) });
    const spans = numbers(html);
    assert.ok(spans.length > 100, `${kind}: expected a page full of traced numbers, found ${spans.length}`);
    assert.ok(spans.every((s) => /data-src="[^"]+"/.test(s) && /data-fmt="[a-zA-Z0-9]+"/.test(s)), `${kind}: every number element carries data-src and data-fmt`);
    const result = verifyHtml(html, model.sources);
    assert.deepEqual(result.mismatches, []);
    assert.equal(result.checked, spans.length);
  }
  // an independent spot check, with no help from the evaluator: the p95 of grid_open as k6 wrote it
  const { html, model } = await prepare('load');
  const p95 = (model.sources['summary.json'] as K6Summary).metrics['http_req_duration{name:analyst.grid_open}']!.values!['p(95)']!;
  const rows = htmlTable(section(html, 'steps')!);
  const row = rows.find((r) => r[0]!.includes('analyst.grid_open'))!;
  assert.equal(row[column(rows, 'p95')], String(Math.round(p95)).replace(/\B(?=(\d{3})+$)/g, ','));
  assert.match(html, /data-src="summary\.json#metrics\[&quot;http_req_duration\{name:analyst\.grid_open\}&quot;\]\.values\[&quot;p\(95\)&quot;\]"/);
});

test('markdown has the same per-step p95 values as html', async () => {
  for (const kind of ['load', 'stress'] as const) {
    const { html, md } = await prepare(kind, { baseline: (s) => baselineFrom(s, 0.9) });
    const h = htmlTable(section(html, 'steps')!);
    const m = mdTable(mdSection(md, 'Results per step')!);
    assert.equal(m.length, h.length);
    const hp = column(h, 'p95');
    const mp = column(m, 'p95');
    for (const id of STEP_IDS) {
      const hr = h.find((r) => r[0]!.includes(id));
      const mr = m.find((r) => r[0]!.includes(id));
      assert.ok(hr && mr, `${id} has a row in both`);
      assert.equal(mr[mp], hr[hp], `${kind} ${id} p95`);
    }
    // not just p95: the two tables hold the same text in every cell
    assert.deepEqual(m, h);
  }
});

test('findings.md appears under Findings and recommendations', async () => {
  const findings = ['# Findings', '', '1. **Slow search** (confidence: high, owner: DB)', '', '   - evidence: `summary.json` p95 of grid_search', '', '<b>raw html</b> & more'].join('\n');
  const { html, md } = await prepare('load', { findings });
  const body = section(html, 'findings')!;
  assert.match(body, /Slow search/);
  assert.match(body, /<strong>Slow search<\/strong>/);
  assert.match(body, /&lt;b&gt;raw html&lt;\/b&gt; &amp; more/, 'agent text is escaped');
  assert.ok(headingsOf(html).includes('Findings and recommendations'));
  assert.match(mdSection(md, 'Findings and recommendations')!, /Slow search/);
  // and nothing when there is no findings.md
  const without = await prepare('load');
  assert.ok(!without.html.includes('Findings and recommendations'));
  assert.ok(!without.md.includes('Findings and recommendations'));
});

test('lineChart draws one path per series', () => {
  const two = lineChart(
    [
      { name: 'users', points: [[0, 1], [15, 4], [30, 6]] },
      { name: 'req/s', points: [[0, 0.5], [15, 3], [30, 5]] },
    ],
    { width: 640, height: 200, yLabel: 'users and requests/s' },
  );
  assert.equal(two.match(/<path\b/g)!.length, 2);
  assert.match(two, /^<svg\b[\s\S]*<\/svg>$/);
  assert.ok(two.includes('>users<') && two.includes('>req/s<'), 'a legend names both series');

  const one = lineChart([{ name: 'CPU %', points: [[0, 10], [15, 90]] }], { width: 640, height: 200, yLabel: 'CPU %' });
  assert.equal(one.match(/<path\b/g)!.length, 1);
  assert.ok(!one.includes('class="legend"'), 'a single series needs no legend');

  const dot = lineChart([{ name: 'x', points: [[0, 5]] }], { width: 320, height: 120, yLabel: 'x' });
  assert.equal((dot.match(/<path\b/g) ?? []).length, 0, 'one point draws a dot, not a path');
  assert.match(dot, /<circle/);

  const empty = lineChart([], { width: 320, height: 120, yLabel: 'x' });
  assert.equal((empty.match(/<path\b/g) ?? []).length, 0);
  assert.match(empty, /No data recorded/);

  const evil = lineChart([{ name: '<b>"x"</b>', points: [[0, 1], [1, 2]] }], { width: 320, height: 120, yLabel: 'a&b' });
  assert.ok(!evil.includes('<b>') && evil.includes('a&amp;b'));
  assert.ok(!/https?:/.test(evil));
});

// ---------------------------------------------------------------------------------------------------------------
// what each section says
// ---------------------------------------------------------------------------------------------------------------

test('the verdict follows the model: NO BASELINE alone, PASS next to an equal baseline, DEGRADED when slower, FAIL, INVALID', async () => {
  const verdictOf = (html: string): string => /<span class="verdict-word">([^<]*)<\/span>/.exec(section(html, 'verdict')!)![1]!;

  assert.equal(verdictOf((await prepare('load')).html), 'NO BASELINE');
  assert.equal(verdictOf((await prepare('load', { baseline: 1 })).html), 'PASS');

  const slower = await prepare('load', { baseline: (s) => baselineFrom(s, 1, { 'analyst.grid_search': { p95: 600 } }) });
  assert.equal(verdictOf(slower.html), 'DEGRADED');

  const failed = await prepare('load', {
    baseline: 1,
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.k6.exitCode = 99;
      meta.k6.abortReason = 'thresholds';
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  assert.equal(verdictOf(failed.html), 'FAIL');
  assert.match(section(failed.html, 'verdict')!, /aborted by a k6 threshold/);

  const invalid = await prepare('load', {
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.guardrails.busyOverride = true;
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  assert.equal(verdictOf(invalid.html), 'INVALID');
  assert.match(section(invalid.html, 'what-ran')!, /--override-busy/);
  assert.match(mdSection(invalid.md, 'Verdict')!, /INVALID/);
});

test('explicit targets count as a baseline: a missed target is FAIL, met targets are PASS, never NO BASELINE', async () => {
  const withTargets = (p95Ms: number) => (dir: string) => {
    const meta = readJson(join(dir, 'meta.json'));
    meta.targets = { 'analyst.grid_open': { p95Ms } };
    writeJson(join(dir, 'meta.json'), meta);
  };
  const missed = await prepare('load', { edit: withTargets(500) });
  assert.match(section(missed.html, 'verdict')!, /<span class="verdict-word">FAIL<\/span>/);
  assert.match(section(missed.html, 'verdict')!, /p95 target missed: analyst\.grid_open/);
  const rows = htmlTable(section(missed.html, 'steps')!);
  const open = rows.find((r) => r[0]!.includes('analyst.grid_open'))!;
  assert.match(open[open.length - 1]!, /missed.*500/, 'the target is shown next to the verdict on the step');

  const met = await prepare('load', { edit: withTargets(5000) });
  assert.match(section(met.html, 'verdict')!, /<span class="verdict-word">PASS<\/span>/);
});

test('raised flags show their step, measure, value, baseline and limit as traced numbers', async () => {
  const run = await prepare('load', {
    baseline: (s) => baselineFrom(s, 1, { 'analyst.grid_search': { p95: 600 } }),
    edit: (dir) => {
      const summary = readJson(join(dir, 'summary.json'));
      summary.metrics['http_req_failed{name:analyst.grid_open}'].values = { rate: 0.1, passes: 30, fails: 270 };
      summary.metrics['checks{name:analyst.grid_sort}'].values = { rate: 0.98, passes: 882, fails: 18 };
      writeJson(join(dir, 'summary.json'), summary);
      const db = readJson(join(dir, 'db.json'));
      for (const sample of db.resource) sample.cpu = 85;
      writeJson(join(dir, 'db.json'), db);
    },
  });
  const rows = htmlTable(section(run.html, 'flags')!);
  const codes: string[] = rows.slice(1).map((r) => r[column(rows, 'Flag')]!);
  assert.deepEqual(codes, run.model.flags.map((f): string => f.code), 'one row per flag, in the model order');
  for (const code of ['ERRORS', 'CHECKS', 'P95_REGRESSION', 'DB_HOT']) assert.ok(codes.includes(code), `${code} is listed`);

  const p95 = rows.find((r) => r[0] === 'P95_REGRESSION')!;
  const stepsRows = htmlTable(section(run.html, 'steps')!);
  const search = stepsRows.find((r) => r[0]!.includes('analyst.grid_search'))!;
  assert.equal(p95[column(rows, 'Step')], 'analyst.grid_search');
  assert.equal(p95[column(rows, 'Value')], search[column(stepsRows, 'p95')]);
  assert.equal(p95[column(rows, 'Baseline')], '600');
  assert.equal(p95[column(rows, 'Limit')], '720', 'baseline x 1.2 is higher than baseline + 100 ms');

  const errors = rows.find((r) => r[0] === 'ERRORS')!;
  assert.equal(errors[column(rows, 'Value')], '10%');
  assert.equal(errors[column(rows, 'Limit')], '1%');
  assert.equal(rows.find((r) => r[0] === 'CHECKS')![column(rows, 'Value')], '2%');
  const db = rows.find((r) => r[0] === 'DB_HOT')!;
  assert.equal(db[column(rows, 'Value')], '85%');
  assert.equal(db[column(rows, 'Limit')], '80%');

  assert.deepEqual(verifyHtml(run.html, run.model.sources).mismatches, []);
  assert.match(run.html, /data-src="meta\.json#rules\.flags\.errorRate"/);
  assert.ok(!run.html.includes('rules#') && !run.html.includes('baseline.json#'), 'only the run folder is a source');
  // the legend lists the four flags and their limits even when none is raised
  const quiet = await prepare('load', { baseline: 1 });
  const legend = section(quiet.html, 'flags')!;
  assert.match(legend, /No automatic flags/);
  for (const code of ['ERRORS', 'CHECKS', 'P95_REGRESSION', 'DB_HOT']) assert.ok(legend.includes(code), `${code} in the legend`);
});

test('the step table colours p95 against the baseline and says so in words', async () => {
  const { html } = await prepare('load', {
    baseline: (s) => baselineFrom(s, 1, { 'analyst.grid_search': { p95: 600 }, 'analyst.grid_sort': { p95: 840 } }),
  });
  const body = section(html, 'steps')!;
  const rowHtml = (id: string): string => new RegExp(`<tr[^>]*>(?:(?!</tr>)[\\s\\S])*${id.replace('.', '\\.')}[\\s\\S]*?</tr>`).exec(body)![0];
  assert.match(rowHtml('analyst.grid_search'), /tone-bad/);
  assert.match(rowHtml('analyst.grid_open'), /tone-ok/);
  assert.match(rowHtml('analyst.grid_sort'), /tone-warn/, 'above the baseline, under the flag limit');
  const rows = htmlTable(body);
  const last = (id: string): string => rows.find((r) => r[0]!.includes(id))![rows[0]!.length - 1]!;
  assert.match(last('analyst.grid_search'), /^\+\d+% .*flag/i);
  assert.match(last('analyst.grid_open'), /^0% /);
  assert.match(last('analyst.grid_sort'), /^\+11% /);
});

test('Results per step lists every journey step, auth_token apart, and a step without requests says so', async () => {
  const { html } = await prepare('load', {
    baseline: 1,
    edit: (dir) => {
      const summary = readJson(join(dir, 'summary.json'));
      for (const key of Object.keys(summary.metrics)) if (key.includes('name:analyst.grid_export')) delete summary.metrics[key];
      writeJson(join(dir, 'summary.json'), summary);
    },
  });
  const body = section(html, 'steps')!;
  const rows = htmlTable(body);
  assert.deepEqual(
    rows.slice(1).map((r) => r[0]),
    STEP_IDS,
  );
  const exportRow = rows.find((r) => r[0] === 'analyst.grid_export')!;
  assert.equal(exportRow[exportRow.length - 1], 'no requests');
  assert.ok(!rows.some((r) => r[0]!.includes('auth_token')));
  assert.match(stripTags(body), /auth_token/, 'the token requests are reported below the table');
  assert.match(body, /data-src="summary\.json#metrics\[&quot;http_req_duration\{name:auth_token\}&quot;\]\.values\.count"/);
});

test('a step whose summary has no failure or check metric shows a dash, not a broken page', async () => {
  const { html, model } = await prepare('load', {
    baseline: 1,
    edit: (dir) => {
      const summary = readJson(join(dir, 'summary.json'));
      delete summary.metrics['http_req_failed{name:analyst.grid_sort}'];
      delete summary.metrics['checks{name:analyst.grid_sort}'];
      writeJson(join(dir, 'summary.json'), summary);
    },
  });
  const rows = htmlTable(section(html, 'steps')!);
  const sort = rows.find((r) => r[0] === 'analyst.grid_sort')!;
  assert.equal(sort[column(rows, 'Failed')], '–');
  assert.equal(sort[column(rows, 'Checks passed')], '–');
  assert.match(sort[column(rows, 'p95')]!, /^\d/, 'its response times are still there');
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
});

test('a soak run is worded and measured like a load run: the steady state', async () => {
  const { html, model } = await prepare('load', {
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.profile.type = 'soak';
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  assert.match(stripTags(section(html, 'load')!), /10 analysts working .* measured over the steady state/);
  assert.ok(!html.includes('Breaking point'));
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
});

test('Under what load words the load, using the steady state for a load run and the whole run for stress', async () => {
  const load = await prepare('load');
  const loadText = stripTags(section(load.html, 'load')!);
  assert.match(loadText, /10 analysts working \(pausing 2–6 s between actions\) ≈ \d+ grid actions\/min/);
  assert.match(loadText, /measured over the steady state, from 2 min to 12 min of the run/);
  assert.equal(section(load.html, 'load')!.match(/<svg\b/g)!.length, 3, 'users, requests/s and the database chart');
  assert.match(section(load.html, 'load')!, /class="band"/, 'the steady state is shaded');
  // the per-minute figure is the hold window's requests over the hold window, not the run's average
  const holdRequests = evaluate('sum(timeseries.json#buckets[t>=120&t<720].reqs)', load.model.sources);
  const perMin = Math.round((holdRequests * 60) / 600);
  assert.ok(loadText.includes(`≈ ${perMin} grid actions/min`), `expected ≈ ${perMin}: ${loadText}`);

  const stress = await prepare('stress');
  const stressText = stripTags(section(stress.html, 'load')!);
  assert.match(stressText, /arrival rate stepped up from 1 to 11 req\/s/);
  assert.ok(!/steady state/.test(stressText));
  assert.match(stressText, /measured over the whole run/);
});

test('the users chart caption uses the workload\'s own unit, never a role of some particular project', async () => {
  const { html } = await prepare('load', {
    edit: (runDir) => {
      const meta = readJson(join(runDir, 'meta.json'));
      meta.workload.businessUnit = 'pilots on duty';
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  const text = stripTags(section(html, 'load')!);
  assert.match(text, /How many virtual users were active at each moment; each stands for one of the "pilots on duty"/);
  assert.ok(!/analysts/.test(text), 'the fixture\'s own unit must not leak into a run that uses another');
});

// A run that k6 stopped early (a threshold with abortOnFail): the fixture's load run with an abort recorded and the tripped threshold in summary.json.
const abortedEarly = (runDir: string): void => {
  const meta = readJson(join(runDir, 'meta.json'));
  meta.k6.exitCode = 99;
  meta.k6.abortReason = 'thresholds';
  writeJson(join(runDir, 'meta.json'), meta);
  const summary = readJson(join(runDir, 'summary.json'));
  summary.metrics.http_req_duration.thresholds = { 'p(95)<15000': { ok: false } };
  summary.state.testRunDurationMs = 62_000; // stopped after 1 min 2 s of the planned 13 min
  writeJson(join(runDir, 'summary.json'), summary);
};

test('a FAIL from a threshold abort names the metric that tripped, in html and markdown', async () => {
  const { html, md } = await prepare('load', { edit: abortedEarly });
  assert.match(stripTags(section(html, 'verdict')!), /aborted by a k6 threshold: http_req_duration p\(95\)<15000 was crossed/);
  assert.match(mdSection(md, 'Verdict')!, /http_req_duration p\(95\)\\?<15000 was crossed/, 'markdown may escape the <');
});

test('Under what load says when the run stopped early and measures the whole run, not the planned steady state', async () => {
  const run = await prepare('load', { edit: abortedEarly });
  const text = stripTags(section(run.html, 'load')!);
  assert.match(text, /The run stopped early, aborted by a k6 threshold, after [\d.]+ (min|s)[^.]* of the [\d.]+ (min|s)[^.]* planned/);
  assert.match(text, /measured over the whole run/);
  assert.ok(!/steady state, from/.test(text), text);
  assert.ok(!/class="band"/.test(section(run.html, 'load')!), 'no shaded steady state that never happened');
  await renderRunReport(run.runDir, { project, feature: run.feature });
  assert.deepEqual((await verifyRunReport(run.runDir, { project, feature: run.feature })).mismatches, [], 'every number still traces');

  const whole = stripTags(section((await prepare('load')).html, 'load')!);
  assert.ok(!/stopped early/.test(whole), 'a run that finished says nothing about stopping');
});

test('a threshold abort that came at the very end is not "stopped early"; neither is a recorded stop with no summary to measure it', async () => {
  const atTheEnd = await prepare('load', {
    edit: (runDir) => {
      abortedEarly(runDir);
      const summary = readJson(join(runDir, 'summary.json'));
      summary.state.testRunDurationMs = readJson(join(runDir, 'meta.json')).profile.totalSec * 1000;
      writeJson(join(runDir, 'summary.json'), summary);
    },
  });
  assert.ok(!/stopped early/.test(stripTags(section(atTheEnd.html, 'load')!)), 'the run used its whole plan');
  const noSummary = await prepare('load', { edit: (runDir) => { abortedEarly(runDir); rmSync(join(runDir, 'summary.json')); } });
  assert.ok(!/stopped early/.test(stripTags(section(noSummary.html, 'load')!)));
});

test('a threshold abort needs exit code 99 to count as a stop; a stress run that stopped early has no steady state to mention', async () => {
  const notNinetyNine = await prepare('load', {
    edit: (runDir) => {
      abortedEarly(runDir);
      const meta = readJson(join(runDir, 'meta.json'));
      meta.k6.exitCode = 1;
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  assert.ok(!/stopped early/.test(stripTags(section(notNinetyNine.html, 'load')!)));

  const stress = await prepare('stress', {
    edit: (runDir) => {
      const meta = readJson(join(runDir, 'meta.json'));
      meta.k6.exitCode = 99;
      meta.k6.abortReason = 'thresholds';
      writeJson(join(runDir, 'meta.json'), meta);
      const summary = readJson(join(runDir, 'summary.json'));
      summary.state.testRunDurationMs = 100_000;
      writeJson(join(runDir, 'summary.json'), summary);
    },
  });
  const text = stripTags(section(stress.html, 'load')!);
  assert.match(text, /The run stopped early, aborted by a k6 threshold, after 1 min 40 s of the .* planned, so the figures cover the whole run\./);
  assert.ok(!/steady state/.test(text.replace(/measured over the whole run/, '')), text);
});

test('a feature that writes data does not claim cleanup without row counts', async () => {
  const writes = (runDir: string): void => {
    const meta = readJson(join(runDir, 'meta.json'));
    meta.workload.readOnly = false;
    delete meta.cleanup;
    writeJson(join(runDir, 'meta.json'), meta);
  };
  const none = stripTags(section((await prepare('load', { edit: writes })).html, 'what-ran')!);
  assert.match(none, /This feature writes data, but no row counts were collected, so nothing proves it was removed/);
  assert.ok(!/the runner deletes what it created/.test(none));

  const counted = await prepare('load', {
    edit: (runDir) => {
      writes(runDir);
      const meta = readJson(join(runDir, 'meta.json'));
      meta.cleanup = { before: { orders: 10 }, after: { orders: 10 }, ok: true };
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  const withCounts = stripTags(section(counted.html, 'what-ran')!);
  assert.match(withCounts, /This feature writes data; the row counts below show whether it was removed afterwards/);
  assert.match(withCounts, /orders/);
});

test('Breaking point names the stage, when it showed and what gave first; a stress run that held says so', async () => {
  const { html, model } = await prepare('stress');
  assert.ok(model.breakingPoint, 'the fixture plants a break');
  const body = section(html, 'breaking-point')!;
  const text = stripTags(body);
  assert.match(text, new RegExp(`${model.breakingPoint!.rps} req/s`));
  assert.match(text, /API errors|latency|database/);
  assert.match(body, /data-src="meta\.json#profile\.stages\[4\]\.rps"/, 'the stage number traces to the profile');
  const stages = htmlTable(body);
  assert.equal(stages.length - 1, 6, 'one row per stage');
  assert.match(stages.map((r) => r.join(' ')).join('\n'), /broke here/);
  assert.equal(body.match(/<svg\b/g)!.length, 1, 'p95 over time with the break marked');

  const held = await prepare('stress', {
    edit: (dir) => {
      const ts = readJson(join(dir, 'timeseries.json'));
      for (const b of ts.buckets) Object.assign(b, { errors: 0, dropped: 0, p95: 400 });
      writeJson(join(dir, 'timeseries.json'), ts);
    },
  });
  assert.equal(held.model.breakingPoint, null);
  assert.match(stripTags(section(held.html, 'breaking-point')!), /No breaking point/);
  assert.deepEqual(verifyHtml(held.html, held.model.sources).mismatches, []);
});

test('Compared with baseline lists baseline and now per step, or says there is no baseline', async () => {
  const none = await prepare('load');
  assert.match(stripTags(section(none.html, 'baseline')!), /No accepted baseline/);

  const { html } = await prepare('load', { baseline: (s) => baselineFrom(s, 0.5) });
  const rows = htmlTable(section(html, 'baseline')!);
  const search = rows.find((r) => r[0]!.includes('analyst.grid_search'))!;
  const base = Math.round(1240.66 * 0.5);
  assert.equal(search[column(rows, 'p95 baseline')], String(base));
  assert.equal(search[column(rows, 'p95 now')], '1,241');
  assert.equal(search[column(rows, 'p95 change %')], '+100%');
  assert.match(stripTags(section(html, 'baseline')!), /2026-10-01_2010_acme_forms_load/);
  assert.match(section(html, 'baseline')!, /data-src="meta\.json#baseline\.steps\[&quot;analyst\.grid_search&quot;\]\.p95"/);
});

test('accepting or changing baseline.json after a run changes neither its re-rendered report nor its verification', async () => {
  const run = await prepare('load', { baseline: 1 });
  const reportFile = join(run.runDir, 'report.html');
  const options = { project, feature: run.feature };
  assert.deepEqual(await renderRunReport(run.runDir, options), { ok: true });
  const first = readFileSync(reportFile, 'utf8');
  assert.match(section(first, 'verdict')!, /<span class="verdict-word">PASS<\/span>/);

  // a later `baseline accept` puts much faster numbers in the slot this run was judged against
  const summary = readJson(join(run.runDir, 'summary.json')) as K6Summary;
  writeJson(join(run.feature.dir, 'baseline.json'), { staging: { load: baselineFrom(summary, 0.2) } });
  assert.deepEqual(await renderRunReport(run.runDir, options), { ok: true });
  assert.equal(readFileSync(reportFile, 'utf8'), first, 'the re-rendered page is byte for byte the first one: same flags, same verdict');
  assert.deepEqual((await verifyRunReport(run.runDir, options)).mismatches, []);

  // a run recorded with no baseline stays NO BASELINE when a slot appears later
  const none = await prepare('load');
  assert.equal(none.model.meta.baseline, null);
  writeJson(join(none.feature.dir, 'baseline.json'), { staging: { load: baselineFrom(summary, 0.2) } });
  const later = await buildReportModel(none.runDir, { project, feature: none.feature });
  assert.equal(later.verdict.verdict, 'NO BASELINE');
  assert.equal(later.flags.length, 0);
});

test('changing the limits in code does not change or break the report of an existing run folder', async () => {
  const run = await prepare('stress', { baseline: 1 });
  const options = { project, feature: run.feature };
  assert.ok(run.model.flags.length > 0 && run.model.breakingPoint, 'the stress fixture raises flags and breaks');
  assert.deepEqual(await renderRunReport(run.runDir, options), { ok: true });
  const first = readFileSync(join(run.runDir, 'report.html'), 'utf8');
  const first_md = readFileSync(join(run.runDir, 'report.md'), 'utf8');

  const savedFlags = { ...FLAG_LIMITS };
  const savedBreaking = { ...BREAKING_LIMITS };
  Object.assign(FLAG_LIMITS, { errorRate: 0.9, checkFailureRate: 0.9, p95Factor: 9, dbPct: 5 });
  Object.assign(BREAKING_LIMITS, { errorRate: 0.9, latencyFactor: 99, dbPct: 99 });
  try {
    assert.deepEqual((await verifyRunReport(run.runDir, options)).mismatches, [], 'the limits are read from meta.json');
    assert.deepEqual(await renderRunReport(run.runDir, options), { ok: true });
    assert.equal(readFileSync(join(run.runDir, 'report.html'), 'utf8'), first, 'same flags, same breaking point');
    assert.equal(readFileSync(join(run.runDir, 'report.md'), 'utf8'), first_md);
  } finally {
    Object.assign(FLAG_LIMITS, savedFlags);
    Object.assign(BREAKING_LIMITS, savedBreaking);
  }
});

test('a run folder is enough: no project or feature file is read, and the workload terms come from meta.json', async () => {
  const run = await prepare('load', {
    baseline: 1,
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.project = 'gone'; // loadProject would refuse this name
      meta.workload.businessAction = 'saves';
      meta.workload.requests['analyst.grid_export'] = 'POST /somewhere/else';
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  const model = await buildReportModel(run.runDir); // no project, no feature
  assert.deepEqual(model.liveFallback, []);
  const html = renderHtml(model);
  assert.match(stripTags(section(html, 'what-ran')!), /recorded with the run/);
  assert.match(stripTags(section(html, 'what-ran')!), /POST \/somewhere\/else/, 'the request lines are the recorded ones');
  assert.match(stripTags(section(html, 'load')!), /Saves per minute \(steady state\)/, 'the label uses the recorded business action');
  assert.match(stripTags(section(html, 'load')!), /≈ \d+ saves\/min/);
  assert.ok(!/grid actions/i.test(stripTags(section(html, 'load')!)));
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
  assert.deepEqual(model.stepIds, STEP_IDS, 'the step ids come from k6-config.json');
});

test('an older run folder without the snapshot still renders, from the current files, and says so', async () => {
  const old = await prepare('load', { legacy: true, baseline: 1 });
  assert.deepEqual(old.model.liveFallback, ['baseline', 'limits', 'workload terms', 'journeys']);
  const text = stripTags(section(old.html, 'what-ran')!);
  assert.match(text, /predates the snapshot/);
  assert.match(text, /baseline, limits, workload terms, journeys/);
  assert.match(section(old.html, 'verdict')!, /<span class="verdict-word">PASS<\/span>/, 'judged against the live baseline');
  assert.match(text, /10 analysts working|analyst_forms_grid/);
  assert.deepEqual(verifyHtml(old.html, old.model.sources).mismatches, []);
  // with no k6-config.json the step ids come from the current feature's journeys, however many it has now
  assert.deepEqual(old.model.stepIds, feature.journeys.flatMap((j) => j.steps.map((st) => `${j.key}.${st.name}`)));
  assert.match(old.md, /predates the snapshot/);

  // without a live baseline slot it is NO BASELINE, and a folder with a complete snapshot never says "predates"
  const bare = await prepare('load', { legacy: true });
  assert.match(section(bare.html, 'verdict')!, /<span class="verdict-word">NO BASELINE<\/span>/);
  assert.ok(!(await prepare('load')).html.includes('predates'));
});

test('Database shows the tier, the load, the top statements without literals, and the missing indexes and caveat', async () => {
  const secret = 'hunter2-not-a-real-secret';
  const { html, md } = await prepare('load', {
    edit: (dir) => {
      const db = readJson(join(dir, 'db.json'));
      db.topStatements[0].text = `SELECT TOP (50) * FROM dbo.forms WHERE token = '${secret}' AND owner_id = 4242 AND note = N'it''s' AND f14 = 1 /* ${'x'.repeat(400)} */`;
      writeJson(join(dir, 'db.json'), db);
    },
  });
  const body = section(html, 'database')!;
  assert.match(stripTags(body), /S1/);
  assert.match(stripTags(body), /Shared database: other activity during the window is included\./);
  assert.ok(!html.includes(secret) && !md.includes(secret), 'string literals never reach the report');
  assert.ok(!html.includes('4242') && !md.includes('4242'), 'numeric literals never reach the report');
  assert.match(decode(body), /token = '…' AND owner_id = \?/);
  assert.match(decode(body), /f14 = \?/, 'digits inside identifiers survive');
  const statements = htmlTable(body);
  assert.ok(statements.length >= 3, 'a header and the statements');
  assert.match(body, /dbo\.forms/, 'missing index table');
  assert.match(body, /data-src="db\.json#missingIndexes\[0\]\.avgUserImpact"/);
  assert.match(body, /data-src="db\.json#topStatements\[0\]\.executions"/);
  const sql = [...body.matchAll(/<code class="sql">([^<]*)<\/code>/g)].map((m) => decode(m[1]!));
  assert.ok(sql.every((s) => s.length <= 301), 'a statement is cut to about 300 characters');
  // the hold-phase average is traced to the samples inside the hold window
  assert.match(body, /data-src="avg\(db\.json#resource\[t&gt;=120&amp;t&lt;=720\]\.cpu\)"/);
});

test('without db.json the Database section says there is no evidence, and the page still verifies', async () => {
  const { html, model } = await prepare('load', { edit: (dir) => rmSync(join(dir, 'db.json')) });
  assert.match(stripTags(section(html, 'database')!), /No database evidence/);
  assert.match(stripTags(section(html, 'database')!), /Shared database/, 'the caveat is printed regardless');
  assert.equal(section(html, 'load')!.match(/<svg\b/g)!.length, 2);
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
});

test('a run with no summary.json still gets a report: FAIL, with what is known', async () => {
  const { html, md, model } = await prepare('load', {
    edit: (dir) => {
      rmSync(join(dir, 'summary.json'));
      const meta = readJson(join(dir, 'meta.json'));
      meta.k6.exitCode = 1;
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  assert.match(section(html, 'verdict')!, /<span class="verdict-word">FAIL<\/span>/);
  assert.match(stripTags(section(html, 'steps')!), /k6 wrote no summary\.json/);
  assert.match(md, /k6 wrote no summary\.json/);
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
});

test('a smoke run is described as a check, not a load', async () => {
  const { html, model } = await prepare('load', {
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.profile = { type: 'smoke', totalSec: 0 };
      writeJson(join(dir, 'meta.json'), meta);
      const ts = readJson(join(dir, 'timeseries.json'));
      ts.buckets = ts.buckets.slice(0, 2);
      writeJson(join(dir, 'timeseries.json'), ts);
    },
  });
  assert.match(stripTags(section(html, 'load')!), /smoke check: each journey once, \d+ grid actions in \d+ s \(not a load\)/);
  assert.match(stripTags(section(html, 'verdict')!), /smoke run/i);
  assert.ok(!html.includes('class="band"'));
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
});

test('everything from the run folder is escaped', async () => {
  const { html, md } = await prepare('load', {
    edit: (dir) => {
      const meta = readJson(join(dir, 'meta.json'));
      meta.loadMachine.host = '<img src=x onerror=alert(1)>';
      meta.checks = [{ code: 'MISSING_STEP', journey: '<b>j</b>', step: 's' }];
      meta.k6.exitCode = 1;
      writeJson(join(dir, 'meta.json'), meta);
    },
  });
  assert.ok(!html.includes('<img') && !html.includes('<b>j</b>'));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.ok(!/(?<!\\)<img/.test(md), 'markdown viewers render inline HTML, so < and > are backslash-escaped');
  assert.ok(md.includes('\\<img src=x onerror=alert(1)\\>'));
});

test('What ran: environment profile, load machine, commit, build and the data left behind', async () => {
  const { html } = await prepare('load');
  const text = stripTags(section(html, 'what-ran')!);
  for (const needle of ['acme', 'forms', 'staging', 'analyst_forms_grid', 'S1', 'perf-laptop', 'darwin-arm64', '0123456789ab', 'main-FIXTURE1.js', '2.3.0']) {
    assert.ok(text.includes(needle), `What ran mentions ${needle}`);
  }
  const rows = htmlTable(section(html, 'what-ran')!.slice(section(html, 'what-ran')!.indexOf('Row counts')));
  assert.ok(rows.length >= 5, 'row counts before and after for each table');
  assert.match(text, /left no rows behind|row counts are equal/i);
});

// The abort limits the run applied (R34): a feature or run option can change them, so the report shows value, source and the
// project's default, each number traced to meta.json#abort.
test('What ran: "Limits applied" shows the abort limits with their source and the project default, traced to meta.json#abort', async () => {
  const { html, md, model } = await prepare('load'); // the fixture's p95 limit came from the feature (Forms: 45 s over the project's 15 s)
  const what = section(html, 'what-ran')!;
  assert.ok(what.indexOf('Limits applied') > what.indexOf('Guardrail overrides'), 'after the facts');
  assert.ok(what.indexOf('Limits applied') < what.indexOf('What the test does'), 'before the journeys');
  const rows = htmlTable(what.slice(what.indexOf('Limits applied')));
  assert.deepEqual(rows[0], ['Limit', 'Value', 'Source', 'Project default']);
  const byLabel = (prefix: string): string[] => rows.find((r) => r[0]!.startsWith(prefix))!;
  assert.deepEqual(byLabel('Error rate').slice(1), ['10%', 'project', '10%']);
  assert.deepEqual(byLabel('p95').slice(1), ['45,000 ms', 'feature', '15,000 ms'], 'the limit that came from the feature, next to the project default');
  assert.deepEqual(byLabel('Database').slice(1), ['95%', 'project', '95%']);
  assert.equal(rows.length, 4);

  for (const path of ['errorRate', 'p95Ms', 'dbCpuOrIoPct', 'projectDefault.errorRate', 'projectDefault.p95Ms', 'projectDefault.dbCpuOrIoPct']) {
    assert.ok(what.includes(`data-src="meta.json#abort.${path}"`), `${path} is a traced number`);
  }
  assert.ok(!what.slice(what.indexOf('Limits applied'), what.indexOf('What the test does')).match(/data-src="(?!meta\.json#abort\.)/), 'only meta.json#abort numbers in that table');
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);

  const mdLimits = mdSection(md, 'What ran')!;
  const mdRows = mdTable(mdLimits.slice(mdLimits.indexOf('### Limits applied'), mdLimits.indexOf('### What the test does')));
  assert.deepEqual(mdRows.map((r) => r.slice(1)), rows.map((r) => r.slice(1)), 'markdown shows the same values, sources and defaults');
});

test('What ran: no "Limits applied" for a run folder that recorded no abort limits', async () => {
  for (const options of [{ legacy: true }, {}] as const) {
    const run = await prepare(options.legacy ? 'load' : 'stress', options.legacy ? { legacy: true } : {}); // the stress fixture predates meta.abort
    assert.ok(!run.html.includes('Limits applied') && !run.md.includes('Limits applied'));
    assert.deepEqual(verifyHtml(run.html, run.model.sources).mismatches, []);
  }
});

/** A run of a project that has no database access at all (meta.database `none`, no db.json). */
const noDatabase = (runDir: string): void => {
  rmSync(join(runDir, 'db.json'));
  const meta = readJson(join(runDir, 'meta.json'));
  meta.database = 'none';
  writeJson(join(runDir, 'meta.json'), meta);
};

test('a project without database access: the report says so plainly, and the database limits are not applicable', async () => {
  const { html, md, model } = await prepare('load', { edit: noDatabase });
  const db = stripTags(section(html, 'database')!);
  assert.match(db, /No database evidence \(this project has no database access\)\./);
  assert.ok(!/Shared database/.test(db), 'no shared-database caveat for a project that reads no database');
  assert.match(stripTags(section(html, 'load')!), /This project has no database access, so there is no database chart/);

  const what = section(html, 'what-ran')!;
  const facts = stripTags(what);
  assert.match(facts, /Database\s*no database evidence \(this project has no database access\)/);
  const rows = htmlTable(what.slice(what.indexOf('Limits applied')));
  const byLabel = (prefix: string): string[] => rows.find((r) => r[0]!.startsWith(prefix))!;
  assert.deepEqual(byLabel('Database CPU').slice(1), ['not applicable', 'no database access', '–']);
  assert.deepEqual(byLabel('Busy check').slice(1), ['not applicable', 'no database access', '–']);
  assert.deepEqual(byLabel('Error rate').slice(1), ['10%', 'project', '10%'], 'the k6 limits are unchanged');
  assert.ok(!what.slice(what.indexOf('Limits applied'), what.indexOf('What the test does')).includes('data-src="meta.json#abort.dbCpuOrIoPct"'));
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);

  const mdWhat = mdSection(md, 'What ran')!;
  const mdRows = mdTable(mdWhat.slice(mdWhat.indexOf('### Limits applied'), mdWhat.indexOf('### What the test does')));
  assert.deepEqual(mdRows.map((r) => r.slice(1)), rows.map((r) => r.slice(1)));
  assert.match(mdSection(md, 'Database')!, /this project has no database access/);
});

test('a database that could not be reached keeps the old wording and the database limit rows', async () => {
  const { html } = await prepare('load', {
    edit: (runDir) => {
      rmSync(join(runDir, 'db.json'));
      const meta = readJson(join(runDir, 'meta.json'));
      meta.database = 'unavailable';
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  assert.match(stripTags(section(html, 'database')!), /No database evidence for this run/);
  assert.ok(!stripTags(section(html, 'what-ran')!).includes('not applicable'));
});

test('a feature whose writes the app prunes says exactly that, and claims no row counts', async () => {
  const { html, md } = await prepare('load', {
    edit: (runDir) => {
      const meta = readJson(join(runDir, 'meta.json'));
      meta.workload.readOnly = false;
      meta.workload.writes = [{ request: 'POST /analyst/grid', cleanup: 'app' }];
      delete meta.cleanup;
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  const what = stripTags(section(html, 'what-ran')!);
  assert.match(what, /This feature writes data \(POST \/analyst\/grid\): the app prunes these rows; nothing for the runner to clean up\./);
  assert.ok(!/row counts/i.test(what), 'no row-count claim either way');
  assert.match(mdSection(md, 'What ran')!, /the app prunes these rows; nothing for the runner to clean up/);
});

test('a static-header run says it sent no token request because its auth needs no login (from the run config, not a count)', async () => {
  const { html, md, model } = await prepare('load', {
    edit: (runDir) => {
      const summary = readJson(join(runDir, 'summary.json'));
      for (const key of Object.keys(summary.metrics)) if (key.includes('{name:auth_token}')) delete summary.metrics[key];
      writeJson(join(runDir, 'summary.json'), summary);
      const config = readJson(join(runDir, 'k6-config.json'));
      config.auth = { type: 'static_header', header: 'Authorization' };
      writeJson(join(runDir, 'k6-config.json'), config);
    },
  });
  const steps = stripTags(section(html, 'steps')!);
  assert.match(steps, /The run sent no token requests: it signs in with a static header, which needs no login\./);
  assert.ok(!/one per account/.test(steps));
  assert.match(mdSection(md, 'Results per step')!, /signs in with a static header/);
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);

  const ropc = stripTags(section((await prepare('load')).html, 'steps')!);
  assert.match(ropc, /Token requests \(auth_token\) are not in the table/, 'a password-grant run still counts its token requests');
});

test('How the flags work marks DB_HOT not applicable for a project without database access', async () => {
  const { html } = await prepare('load', { edit: noDatabase });
  const flags = section(html, 'flags')!;
  const rows = htmlTable(flags.slice(flags.indexOf('How the flags work')));
  assert.deepEqual(rows.find((r) => r[0] === 'DB_HOT')!.slice(2), ['not applicable (no database access)']);
  const withDb = section((await prepare('load')).html, 'flags')!;
  assert.match(htmlTable(withDb.slice(withDb.indexOf('How the flags work'))).find((r) => r[0] === 'DB_HOT')![2]!, /^80%$/);
});

test('What ran: a file the secret scan could not read is named apart from the files it cleaned', async () => {
  const { html } = await prepare('load', {
    edit: (runDir) => {
      const meta = readJson(join(runDir, 'meta.json'));
      meta.secretScan = { ok: false, files: ['k6.log', 'points.json.gz'], unscanned: [{ file: 'points.json.gz', reason: 'could not be decompressed, not scanned' }] };
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  assert.match(stripTags(section(html, 'what-ran')!), /Secret scan\s*tokens were found and removed from k6\.log; points\.json\.gz could not be decompressed, not scanned/);
});

test('Limits applied: a database limit the project left out shows "–" as its default, and the page still verifies', async () => {
  const { html, md, model } = await prepare('load', {
    edit: (runDir) => {
      const meta = readJson(join(runDir, 'meta.json'));
      delete meta.abort.projectDefault.dbCpuOrIoPct;
      meta.abort.dbCpuOrIoPct = 90;
      meta.abort.source.dbCpuOrIoPct = 'feature';
      writeJson(join(runDir, 'meta.json'), meta);
    },
  });
  const what = section(html, 'what-ran')!;
  const rows = htmlTable(what.slice(what.indexOf('Limits applied')));
  assert.deepEqual(rows.find((r) => r[0]!.startsWith('Database CPU'))!.slice(1), ['90%', 'feature', '–']);
  assert.ok(!what.includes('data-src="meta.json#abort.projectDefault.dbCpuOrIoPct"'));
  assert.deepEqual(verifyHtml(html, model.sources).mismatches, []);
  const mdWhat = mdSection(md, 'What ran')!;
  assert.ok(mdTable(mdWhat).some((r) => r[0]!.startsWith('Database CPU') && r[3] === '–'));
});

test('Files links the run folder files, relative and only those that exist', async () => {
  const { html, md } = await prepare('load', { findings: '# F\n\nok' });
  const body = section(html, 'files')!;
  for (const file of ['report.html', 'report.md', 'summary.json', 'timeseries.json', 'db.json', 'meta.json', 'findings.md']) {
    assert.ok(body.includes(`href="${file}"`), `${file} is linked`);
    assert.ok(md.includes(`](${file})`), `${file} is linked in markdown`);
  }
  assert.ok(!body.includes('k6.log'), 'a file the run folder does not have is not linked');
});

test('the page works offline and on a phone: inline styles, a viewport, dark mode, tables that scroll inside their box', async () => {
  const { html } = await prepare('load');
  assert.match(html, /^<!doctype html>/i);
  assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
  assert.match(html, /<style>[\s\S]*prefers-color-scheme:\s*dark[\s\S]*<\/style>/);
  assert.match(html, /\.scroll\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(html, /<div class="scroll"><table/);
  assert.match(html, /<title>[^<]*acme[^<]*forms[^<]*<\/title>/);
  assert.ok(!/font-family:[^;]*url\(/.test(html), 'no web fonts');
});

test('rendering twice gives the same page (no clock, no randomness)', async () => {
  const a = await prepare('stress', { baseline: 1 });
  assert.equal(renderHtml(a.model), a.html);
  assert.equal(renderMarkdown(a.model), a.md);
});

test('no number in a table cell or fact is left without a data-src', async () => {
  for (const kind of ['load', 'stress'] as const) {
    const { html } = await prepare(kind, { baseline: (s) => baselineFrom(s, 0.9), findings: '# F\n\nok' });
    const cells = [...html.matchAll(/<(td|dd)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => m[2]!);
    assert.ok(cells.length > 100);
    for (const cell of cells) {
      const rest = cell
        .replace(/<span class="num[ "][^>]*>[^<]*<\/span>/g, '')
        .replace(/<(code|span|a)\b[^>]*class="(?:id|sql)"[^>]*>[^<]*<\/\1>/g, '')
        .replace(/<[^>]*>/g, '');
      const text = decode(rest).replace(/\b(?:k6|p50|p95|p99)\b/g, ''); // names of the tool and of the percentiles, not quantities
      assert.ok(!/\d/.test(text), `${kind}: digits outside a traced number: ${stripTags(cell)}`);
    }
  }
});

test('maskSql replaces string and numeric literals and cuts the text to about 300 characters', () => {
  assert.equal(maskSql("SELECT * FROM t WHERE a = 'x' AND b = 12 AND c = 3.5e2"), "SELECT * FROM t WHERE a = '…' AND b = ? AND c = ?");
  assert.equal(maskSql("WHERE n = N'it''s' AND z = 0xDEADBEEF"), "WHERE n = '…' AND z = ?");
  assert.equal(maskSql('SELECT TOP (50) [f14].[id], @p0, t1.x FROM dbo.t1'), 'SELECT TOP (?) [f14].[id], @p0, t1.x FROM dbo.t1');
  assert.equal(maskSql("WHERE a = 'cut off here"), "WHERE a = '…'", 'an unterminated literal is masked to the end');
  assert.equal(maskSql('a\n  b\t\tc'), 'a b c', 'whitespace collapses');
  const columns = Array.from({ length: 30 }, (_, i) => `[t].[column_${i}]`).join(', ');
  assert.equal(maskSql(`SELECT TOP (5) ${columns} FROM [forms] AS [t] WHERE [t].[id] = 7`), 'SELECT TOP (?) … FROM [forms] AS [t] WHERE [t].[id] = ?', 'a long column list gives way to the part that tells statements apart');
  assert.equal(maskSql('SELECT COUNT(*) FROM [forms] AS [f]'), 'SELECT COUNT(*) FROM [forms] AS [f]', 'a short list stays');
  const long = maskSql(`SELECT a FROM t WHERE ${'column_name = other_name AND '.repeat(20)}b = c`);
  assert.ok(long.length <= 301 && long.endsWith('…'));
});

// ---------------------------------------------------------------------------------------------------------------
// the terms, writing the files, and the command
// ---------------------------------------------------------------------------------------------------------------

test('REPORT_TERMS lists every verdict, flag code and metric the report can show, and each appears on a page', async () => {
  for (const term of ['PASS', 'DEGRADED', 'FAIL', 'NO BASELINE', 'INVALID', 'ERRORS', 'CHECKS', 'P95_REGRESSION', 'DB_HOT']) {
    assert.ok(REPORT_TERMS.includes(term), `${term} is a report term`);
  }
  assert.equal(new Set(REPORT_TERMS).size, REPORT_TERMS.length, 'no duplicates');
  const pages = [(await prepare('load', { baseline: 1 })).html, (await prepare('stress', { baseline: 1 })).html].join('\n');
  for (const term of REPORT_TERMS) assert.ok(pages.includes(term), `${term} appears on a load or stress page`);
});

test('verifyRunReport names a number whose text was changed after the page was written', async () => {
  const { runDir, feature: scratchFeature } = await prepare('load', { baseline: 1 });
  await renderRunReport(runDir, { project, feature: scratchFeature });
  const html = readFileSync(join(runDir, 'report.html'), 'utf8');
  const tampered = html.replace(/(<span class="num"[^>]*data-fmt="int">)1,010(<\/span>)/, '$11,011$2');
  assert.notEqual(tampered, html, 'the fixture shows a 1,010');
  writeFileSync(join(runDir, 'report.html'), tampered, 'utf8');
  const result = await verifyRunReport(runDir, { project, feature: scratchFeature });
  assert.equal(result.mismatches.length, 1);
  assert.match(result.mismatches[0]!, /shows "1,011" but the file gives "1,010"/);

  // and a source file changed after the page was written
  writeFileSync(join(runDir, 'report.html'), html, 'utf8');
  const summary = readJson(join(runDir, 'summary.json'));
  summary.metrics['http_req_duration{name:analyst.grid_open}'].values['p(95)'] = 2000;
  writeJson(join(runDir, 'summary.json'), summary);
  assert.ok((await verifyRunReport(runDir, { project, feature: scratchFeature })).mismatches.length >= 1);
});

test('renderRunReport writes report.html and report.md and records ok in meta.json', async () => {
  const { runDir, feature: scratchFeature } = await prepare('load', { baseline: 1 });
  const before = readJson(join(runDir, 'meta.json'));
  const result = await renderRunReport(runDir, { project, feature: scratchFeature });
  assert.deepEqual(result, { ok: true });
  assert.ok(existsSync(join(runDir, 'report.html')) && existsSync(join(runDir, 'report.md')));
  const meta = readJson(join(runDir, 'meta.json'));
  assert.deepEqual(meta.report, { ok: true });
  assert.deepEqual({ ...meta, report: undefined }, { ...before, report: undefined }, 'nothing else in meta.json changed');
  assert.deepEqual((await verifyRunReport(runDir, { project, feature: scratchFeature })).mismatches, []);
});

test('a report that cannot be built never fails the run or loses meta.json: the error is recorded', async () => {
  const { runDir, feature: scratchFeature } = await prepare('load', { legacy: true });
  writeFileSync(join(scratchFeature.dir, 'baseline.json'), '{ not json', 'utf8');
  const before = readJson(join(runDir, 'meta.json'));
  const result = await renderRunReport(runDir, { project, feature: scratchFeature });
  assert.equal(result.ok, false);
  assert.match((result as { error: string }).error, /baseline\.json is not valid JSON/);
  assert.ok(!(result as { error: string }).error.includes('\n    at '), 'a message, not a stack');
  const meta = readJson(join(runDir, 'meta.json'));
  assert.equal(meta.report.ok, false);
  assert.match(meta.report.error, /baseline\.json/);
  assert.deepEqual({ ...meta, report: undefined }, { ...before, report: undefined });
  assert.ok(!existsSync(join(runDir, 'report.html')), 'no half-written report');
});

test('perf report writes the report; --verify-sources prints "all N numbers traced"', async () => {
  const root = mkdtempSync(join(tmpdir(), 'perf-report-cli-'));
  scratch.push(root);
  const runDir = join(root, 'run');
  cpSync(join(FIXTURES, 'load'), runDir, { recursive: true });
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    assert.equal(await main(['report', runDir, '--verify-sources']), 0);
    const traced = lines.find((l) => /all \d+ numbers traced/.test(l));
    assert.ok(traced, `output: ${lines.join(' | ')}`);
    const count = Number(/all (\d+) numbers traced/.exec(traced)![1]);
    assert.equal(count, numbers(readFileSync(join(runDir, 'report.html'), 'utf8')).length);

    // a run folder whose summary.json is garbage: the report cannot be built, the command says why and exits 1
    lines.length = 0;
    writeFileSync(join(runDir, 'summary.json'), '{ not json', 'utf8');
    assert.equal(await main(['report', runDir]), 1);
    assert.equal(readJson(join(runDir, 'meta.json')).report.ok, false);

    // a folder that is not a run folder is a usage problem
    assert.equal(await main(['report', join(root, 'nothing-here')]), 2);
  } finally {
    console.log = log;
  }
});
