import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkFindings, lintFindings, scanCitations } from './findings.js';
import type { Sources } from './sources.js';

const P95 = 'summary.json#metrics["http_req_duration{name:pizza.recommend}"].values["p(95)"]';
const RATE = 'summary.json#metrics.http_req_failed.values.rate';
const sources: Sources = {
  'summary.json': {
    metrics: {
      'http_req_duration{name:pizza.recommend}': { values: { 'p(95)': 433.2, med: 120 } },
      http_req_failed: { values: { rate: 0.01 } },
      http_reqs: { values: { count: 1446 } },
    },
    state: { testRunDurationMs: 781000 },
  },
};
const refs = new Set(['nielsen-response-times', 'sre-book-monitoring']);
const lint = (markdown: string): string[] => lintFindings(markdown, sources, refs);

test('a correct int citation passes, with and without a unit', () => {
  assert.deepEqual(lint(`The p95 of the recommend step was 433 ms[[int|${P95}]].`), []);
  assert.deepEqual(lint(`433[[int|${P95}]] is the p95.`), []);
  assert.deepEqual(lint(`It sent 1,446 requests[[int|summary.json#metrics.http_reqs.values.count]].`), []);
});

test('a number in another unit than the source fails (0.43 s against a p95 in ms)', () => {
  const problems = lint(`The p95 was 0.43 s[[int|${P95}]].`);
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /line 1/);
  assert.match(problems[0]!, /0\.43/);
  assert.match(problems[0]!, /433/);
});

test('a number that is only the tail of the formatted value does not pass', () => {
  assert.equal(lint(`The p95 was 33 ms[[int|${P95}]].`).length, 1);
  assert.equal(lint(`The p95 was 1433 ms[[int|${P95}]].`).length, 1);
});

test('pct reads a fraction, pctPoints a value that is already a percent', () => {
  assert.deepEqual(lint(`Errors were 1%[[pct|${RATE}]] of requests.`), []);
  const wrong = lint(`Errors were 1%[[pctPoints|${RATE}]] of requests.`);
  assert.equal(wrong.length, 1);
  assert.match(wrong[0]!, /line 1/);
});

test('a duration format owns its units', () => {
  assert.deepEqual(lint('The run took 13 min 1 s[[dur|summary.json#state.testRunDurationMs / 1000]].'), []);
  assert.equal(lint('The run took 13 min[[dur|summary.json#state.testRunDurationMs / 1000]].').length, 1);
});

test('a citation with an unknown format, an unreadable source or no number before it fails', () => {
  assert.match(lint(`It was 433 ms[[hex|${P95}]].`).join('\n'), /unknown format "hex".*line 1/);
  assert.match(lint('It was 433 ms[[int|summary.json#metrics.nothing.values.x]].').join('\n'), /line 1/);
  assert.match(lint(`It was fast [[int|${P95}]].`).join('\n'), /no number.*line 1/);
  assert.match(lint('It was 433 ms[[int|summary.json#metrics').join('\n'), /malformed citation.*line 1/);
});

test('two citations on a line, and one inside a table cell, are each checked', () => {
  assert.deepEqual(lint(`Median 120 ms[[int|summary.json#metrics["http_req_duration{name:pizza.recommend}"].values.med]], p95 433 ms[[int|${P95}]].`), []);
  assert.deepEqual(lint(`| step | p95 |\n| --- | --- |\n| recommend | 433 ms[[int|${P95}]] |`), []);
  const problems = lint(`Median 121 ms[[int|summary.json#metrics["http_req_duration{name:pizza.recommend}"].values.med]], p95 433 ms[[int|${P95}]].`);
  assert.equal(problems.length, 1);
});

test('a [ref:id] must name a reference in the knowledge base', () => {
  assert.deepEqual(lint('Under a second feels instant [ref:nielsen-response-times].'), []);
  const problems = lint('Under a second feels instant [ref:made-up-source].');
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /unknown reference "made-up-source".*line 1/);
  assert.match(lint('x [ref:x]').join('\n'), /unknown reference "x"/);
});

test('a number with no citation fails and the problem names the token and the line', () => {
  const problems = lint('# Findings\n\np95 is 433 ms');
  assert.deepEqual(problems, ['uncited number "433" in line 3']);
  assert.deepEqual(lint('About 12% of requests failed.'), ['uncited number "12%" in line 1']);
  assert.deepEqual(lint('Latency (433 ms) was high, 1,446 requests.'), ['uncited number "433" in line 1', 'uncited number "1,446" in line 1']);
  assert.deepEqual(lint('It rose +26%, then fell -80.'), ['uncited number "+26%" in line 1', 'uncited number "-80" in line 1']);
  assert.deepEqual(lint('It fell −12% overnight.'), ['uncited number "−12%" in line 1'], 'a Unicode minus is a sign too');
});

test('numbers in inline code, code blocks and headings pass', () => {
  assert.deepEqual(lint('Set `vus: 20` and `p(95)<500`.'), []);
  assert.deepEqual(lint('```\nvus: 20\nthreshold 433 ms\n```'), []);
  assert.deepEqual(lint('## Step 2 of 3\n\n### Top 3 findings'), []);
  assert.equal(lint('```\nvus: 20\n```\nthen 20 users').length, 1, 'a fence ends');
});

test('identifiers with letters before digits, and p(95), are not numbers', () => {
  assert.deepEqual(lint('p95 and p99 of k6 on S1 with UTF-8 at pizza.a2 in step a.b2 and p(95) too.'), []);
});

test('list markers are not numbers, the numbers after them are', () => {
  assert.deepEqual(lint('1. First\n2) Second\n- third\n* fourth\n  10. nested'), []);
  assert.deepEqual(lint('1. Latency was 433 ms'), ['uncited number "433" in line 1']);
});

test('dates and times on a Run: line pass, other numbers there do not', () => {
  assert.deepEqual(lint('Run: results/2026-10-30_1530_x started 2026-10-30 15:30:12 and ended 2026-10-30T15:43:13Z'), []);
  assert.deepEqual(lint('- Run: 2026-10-30 15:30'), []);
  assert.deepEqual(lint('Run: 2026-10-30 with 20 users'), ['uncited number "20" in line 1']);
  assert.deepEqual(lint('Started 2026-10-30'), ['uncited number "2026-10-30" in line 1']);
});

test('a citation inside inline code or a fence is not a citation', () => {
  assert.deepEqual(lint(`Write it as \`433 ms[[int|${P95}]]\` and never as 5 ms.`), ['uncited number "5" in line 1']);
  assert.deepEqual(lint(`\`\`\`\n433 ms[[int|${P95}]]\n\`\`\``), []);
});

test('checkFindings counts the citations that passed and the references', () => {
  const result = checkFindings(`p95 433 ms[[int|${P95}]] [ref:nielsen-response-times]\nerrors 1%[[pct|${RATE}]] [ref:sre-book-monitoring] [ref:nielsen-response-times]`, sources, refs);
  assert.deepEqual(result, { problems: [], numbers: 2, references: 3 });
});

test('scanCitations finds the expression through brackets and quotes inside it', () => {
  const [c] = scanCitations(`was 433 ms[[int|${P95}]] ok`);
  assert.equal(c!.fmt, 'int');
  assert.equal(c!.expr, P95);
  assert.equal(c!.number, '433');
  assert.equal(c!.unit, ' ms');
});
