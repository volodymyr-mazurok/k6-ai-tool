// The report as one self-contained HTML page (inline CSS and SVG, no scripts, no network) and as a Markdown twin. Both are
// written from the same view (view.ts), so the numbers are the same text in both; in the HTML every number is a
// <span class="num" data-src="…" data-fmt="…"> that `perf report --verify-sources` checks against the run folder's files.

import type { ReportModel } from './build.js';
import { escapeHtml as esc, escapeMdCell } from './html.js';
import { markdownForTwin, markdownToHtml } from './markdown.js';
import { buildView } from './view.js';
import { isNum, plain, type Block, type Cell, type Head, type Part, type ReportView } from './viewCore.js';

export { maskSql } from './view.js';

/**
 * Every metric name, verdict and flag code the report can display, as written on the page. The README must explain each of
 * them (design R2); the self-test checks that it does.
 */
export const REPORT_TERMS: string[] = [
  // verdicts
  'PASS',
  'DEGRADED',
  'FAIL',
  'NO BASELINE',
  'INVALID',
  // automatic flags
  'ERRORS',
  'CHECKS',
  'P95_REGRESSION',
  'DB_HOT',
  // k6 metrics and the figures built from them
  'http_req_duration',
  'http_req_failed',
  'http_reqs',
  'checks',
  'auth_token',
  'vus',
  'dropped_iterations',
  'p50',
  'p95',
  'p99',
  'req/s',
  // ideas the page leans on
  'baseline',
  'steady state',
  'Breaking point',
];

// ---------------------------------------------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------------------------------------------

const CSS = `
:root{color-scheme:light dark;--bg:#f9f9f7;--surface:#fcfcfb;--ink:#0b0b0b;--ink-2:#52514e;--ink-3:#6b6a65;--grid:#e1e0d9;--axis:#c3c2b7;--line:rgba(11,11,11,.12);--series-0:#2a78d6;--series-1:#eb6834;--ok-bg:#e1f3e1;--ok-ink:#0b5a0b;--warn-bg:#fdefc9;--warn-ink:#6b4500;--bad-bg:#fbe1e1;--bad-ink:#8c1b1b;--info-bg:#e1ebf8;--info-ink:#17477f;--invalid-bg:#ebe5f7;--invalid-ink:#44327f;--muted-ink:#6b6a65}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d0d;--surface:#1a1a19;--ink:#f0efec;--ink-2:#c3c2b7;--ink-3:#a09e97;--grid:#2c2c2a;--axis:#383835;--line:rgba(255,255,255,.14);--series-0:#3987e5;--series-1:#d95926;--ok-bg:#14301a;--ok-ink:#8fe08f;--warn-bg:#3a2d0a;--warn-ink:#f3c969;--bad-bg:#3d1717;--bad-ink:#f5a5a5;--info-bg:#142a44;--info-ink:#9cc6f7;--invalid-bg:#2b2342;--invalid-ink:#c9bdf6;--muted-ink:#a09e97}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}
main{max-width:980px;margin:0 auto;padding:16px}
h1{font-size:22px;line-height:1.25;margin:8px 0 2px}
h2{font-size:18px;margin:0 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
h3{font-size:15px;margin:18px 0 6px}
h4,h5,h6{font-size:14px;margin:14px 0 4px}
section{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:14px 0}
p{margin:6px 0}
.sub{color:var(--ink-2);margin:0 0 4px}
.lead{font-size:16px}
.note{color:var(--ink-2);font-size:13px}
.warn{background:var(--warn-bg);color:var(--warn-ink);padding:6px 10px;border-radius:6px}
.scroll{overflow-x:auto;max-width:100%;margin:8px 0}
table{border-collapse:collapse;width:100%;font-size:14px}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-size:12px;color:var(--ink-2);font-weight:600;white-space:nowrap}
td.r,th.r{text-align:right;font-variant-numeric:tabular-nums}
code,.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.92em}
td:first-child code.id{white-space:nowrap}
code.sql{display:block;white-space:pre-wrap;word-break:break-word;min-width:16rem}
a{color:var(--info-ink)}
.tone-ok{background:var(--ok-bg);color:var(--ok-ink)}
.tone-warn{background:var(--warn-bg);color:var(--warn-ink)}
.tone-bad{background:var(--bad-bg);color:var(--bad-ink)}
.tone-info{background:var(--info-bg);color:var(--info-ink)}
.tone-invalid{background:var(--invalid-bg);color:var(--invalid-ink)}
.tone-muted{color:var(--muted-ink)}
.verdict{display:inline-flex;align-items:center;gap:10px;padding:8px 16px;border-radius:8px;font-weight:700;font-size:24px;line-height:1.1}
.verdict .mark{font-size:22px}
.v-pass{background:var(--ok-bg);color:var(--ok-ink)}
.v-degraded{background:var(--warn-bg);color:var(--warn-ink)}
.v-fail{background:var(--bad-bg);color:var(--bad-ink)}
.v-nobaseline{background:var(--info-bg);color:var(--info-ink)}
.v-invalid{background:var(--invalid-bg);color:var(--invalid-ink)}
dl.facts{display:grid;grid-template-columns:minmax(0,13rem) minmax(0,1fr);gap:4px 16px;margin:8px 0}
dl.facts dt{color:var(--ink-2)}
dl.facts dd{margin:0}
summary{cursor:pointer;color:var(--ink-2);margin:8px 0}
figure.chart-box{margin:12px 0}
figcaption{font-weight:600;font-size:14px;margin-bottom:2px}
svg.chart{display:block;width:100%;height:auto}
.findings pre{overflow-x:auto;background:var(--bg);padding:8px;border-radius:6px}
footer{color:var(--ink-3);font-size:12px;margin:18px 0 8px}
@media (max-width:560px){main{padding:10px}section{padding:12px}dl.facts{grid-template-columns:minmax(0,1fr)}dl.facts dt{margin-top:6px}.verdict{font-size:20px}}
@media print{body{background:#fff;color:#000}section{break-inside:avoid;border-color:#bbb}.scroll{overflow:visible}}
`;

const VERDICT_CLASS: Record<string, string> = { PASS: 'v-pass', DEGRADED: 'v-degraded', FAIL: 'v-fail', 'NO BASELINE': 'v-nobaseline', INVALID: 'v-invalid' };
const VERDICT_MARK: Record<string, string> = { PASS: '✓', DEGRADED: '▲', FAIL: '✕', 'NO BASELINE': '○', INVALID: '!' };

function partHtml(part: Part): string {
  return isNum(part) ? `<span class="num" data-src="${esc(part.src)}" data-fmt="${part.fmt}">${esc(part.text)}</span>` : esc(part);
}

const partsHtml = (parts: Part[]): string => parts.map(partHtml).join('');

function cellHtml(c: Cell, tag: 'td' | 'dd', right = false): string {
  let inner = partsHtml(c.parts);
  if (c.href) inner = `<a class="id" href="${esc(c.href)}">${inner}</a>`;
  else if (c.cls === 'id') inner = `<code class="id">${inner}</code>`;
  else if (c.cls === 'sql') inner = `<code class="sql">${inner}</code>`;
  const classes = [right ? 'r' : '', c.tone ? `tone-${c.tone}` : ''].filter(Boolean).join(' ');
  return `<${tag}${classes ? ` class="${classes}"` : ''}>${inner}</${tag}>`;
}

function tableHtml(head: Head[], rows: Cell[][], note?: Part[]): string {
  const header = head.map((h) => `<th${h.right ? ' class="r"' : ''}>${esc(h.label)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.map((c, i) => cellHtml(c, 'td', head[i]?.right)).join('')}</tr>`).join('');
  return `<div class="scroll"><table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>${note ? `<p class="note">${partsHtml(note)}</p>` : ''}`;
}

function blockHtml(block: Block): string {
  switch (block.kind) {
    case 'text':
      return `<p${block.cls ? ` class="${block.cls}"` : ''}>${partsHtml(block.parts)}</p>`;
    case 'sub':
      return `<h3>${esc(block.title)}</h3>`;
    case 'list':
      return `<ul>${block.items.map((item) => `<li>${partsHtml(item)}</li>`).join('')}</ul>`;
    case 'table':
      return tableHtml(block.head, block.rows, block.note);
    case 'facts':
      return `<dl class="facts">${block.rows.map((r) => `<dt>${esc(r.label)}</dt>${cellHtml(r.value, 'dd')}`).join('')}</dl>`;
    case 'chart':
      return `<figure class="chart-box"><figcaption>${esc(block.title)}</figcaption>${block.svg}<p class="note">${esc(block.caption)}</p></figure>`;
    case 'verdict':
      return [
        `<div class="verdict ${VERDICT_CLASS[block.verdict]}" role="status"><span class="mark" aria-hidden="true">${VERDICT_MARK[block.verdict]}</span><span class="verdict-word">${esc(block.verdict)}</span></div>`,
        `<p class="lead">${esc(block.lead)}</p>`,
        block.reasons.length > 0 ? `<ul class="reasons">${block.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '',
        ...block.notes.map((n) => `<p class="warn">${esc(n)}</p>`),
      ].join('');
    case 'details':
      return `<details><summary>${esc(block.summary)}</summary>${block.blocks.map(blockHtml).join('')}</details>`;
    case 'markdown':
      return `<div class="findings">${markdownToHtml(block.text)}</div>`;
  }
}

function renderView(view: ReportView): string {
  const sections = view.sections.map((s) => `<section id="${s.id}"><h2>${esc(s.title)}</h2>${s.blocks.map(blockHtml).join('')}</section>`).join('\n');
  return [
    '<!doctype html>',
    '<html lang="en">',
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(view.title)}</title><style>${CSS}</style></head>`,
    '<body><main>',
    `<header><h1>${esc(view.title)}</h1><p class="sub"><code class="id">${esc(plain(view.subtitle.parts))}</code></p></header>`,
    sections,
    '<footer>Written by the perf runner from the files in this folder. Every number on this page carries its source (data-src); check them with <code>perf report &lt;this folder&gt; --verify-sources</code>.</footer>',
    '</main></body></html>',
    '',
  ].join('\n');
}

/** The report as a self-contained HTML page: no scripts, no external files; light by default, dark when the viewer prefers it. */
export function renderHtml(model: ReportModel): string {
  return renderView(buildView(model));
}

// ---------------------------------------------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------------------------------------------

/** Text in a Markdown line or table cell: no pipes, and no characters a viewer could take for HTML or code. */
const mdText = (s: string): string => escapeMdCell(s).replace(/[<>`]/g, (c) => `\\${c}`);
const mdParts = (parts: Part[]): string => parts.map((p) => (isNum(p) ? p.text : mdText(p))).join('');

function mdCell(c: Cell): string {
  if (c.cls === 'id' || c.cls === 'sql') {
    const code = escapeMdCell(plain(c.parts)).replaceAll('`', "'");
    if (/[<>]/.test(code)) return mdText(plain(c.parts)); // a code span is safe in a viewer, but the raw text should not look like markup
    return c.href ? `[${code}](${c.href})` : `\`${code}\``;
  }
  return mdParts(c.parts);
}

function blockMd(block: Block): string {
  switch (block.kind) {
    case 'text':
      return block.cls === 'note' || block.cls === 'warn' ? `> ${mdParts(block.parts)}` : mdParts(block.parts);
    case 'sub':
      return `### ${mdText(block.title)}`;
    case 'list':
      return block.items.map((item) => `- ${mdParts(item)}`).join('\n');
    case 'table': {
      const head = `| ${block.head.map((h) => mdText(h.label)).join(' | ')} |`;
      const rule = `| ${block.head.map((h) => (h.right ? '---:' : '---')).join(' | ')} |`;
      const rows = block.rows.map((row) => `| ${row.map(mdCell).join(' | ')} |`);
      return [head, rule, ...rows, ...(block.note ? ['', `> ${mdParts(block.note)}`] : [])].join('\n');
    }
    case 'facts':
      return block.rows.map((r) => `- **${mdText(r.label)}:** ${mdCell(r.value)}`).join('\n');
    case 'chart':
      return `*Chart “${mdText(block.title)}”: see report.html.*`;
    case 'verdict':
      return [
        `**${block.verdict}**: ${mdText(block.lead)}`,
        ...(block.reasons.length > 0 ? ['', ...block.reasons.map((r) => `- ${mdText(r)}`)] : []),
        ...block.notes.flatMap((n) => ['', `> ${mdText(n)}`]),
      ].join('\n');
    case 'details':
      return [`### ${mdText(block.summary)}`, '', ...block.blocks.flatMap((b) => [blockMd(b), ''])].join('\n').trimEnd();
    case 'markdown':
      return markdownForTwin(block.text);
  }
}

/** The report as Markdown: the same sections, the same numbers; charts are left to report.html. */
export function renderMarkdown(model: ReportModel): string {
  const view = buildView(model);
  const lines = [`# ${mdText(view.title)}`, '', plain(view.subtitle.parts), ''];
  for (const section of view.sections) {
    lines.push(`## ${section.title}`, '');
    for (const block of section.blocks) lines.push(blockMd(block), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
