// A small Markdown reader for findings.md, enough for what the perf-report agent writes: headings, paragraphs, bullet and
// numbered lists, tables, code, bold, italics, inline code. Everything is escaped first, so the agent's text can never
// add markup of its own; links and images become plain text (the page makes no external requests). A cited number,
// `433 ms[[int|summary.json#…]]`, becomes a number element the page check traces (findings.ts); `[ref:id]` becomes `[id]`.

import { rewriteLine } from './findings.js';
import { escapeHtml } from './html.js';

/** Inline markup on already-escaped text. */
function inline(escaped: string): string {
  return escaped
    .replace(/!\[([^\]]*)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>');
}

/** A list item: indent, marker, text. */
const ITEM = /^(\s*)([-*]|\d+[.)])\s+(.*)$/;

// A cited number is lifted out before the text is split into lines, cells and items (its source holds `|` and `]`) and put
// back as a number element once the rest is escaped. The placeholder is two private-use characters around its index.
const HOLD_OPEN = '\uE000';
const HOLD_CLOSE = '\uE001';
const HELD = new RegExp(`${HOLD_OPEN}(\\d+)${HOLD_CLOSE}`, 'g');

/** `source` with each cited number held as a placeholder (outside fenced code and inline code), and the elements to put back. */
function holdCitations(source: string): { text: string; elements: string[] } {
  const elements: string[] = [];
  let fenced = false;
  const text = source
    .split('\n')
    .map((line) => {
      if (line.startsWith('```')) fenced = !fenced;
      if (fenced || line.startsWith('```')) return line;
      return rewriteLine(
        line,
        (c) => {
          elements.push(`<span class="num" data-src="${escapeHtml(c.expr)}" data-fmt="${escapeHtml(c.fmt)}">${escapeHtml(c.number)}</span>`);
          return `${HOLD_OPEN}${elements.length - 1}${HOLD_CLOSE}`;
        },
        (id) => `[${id}]`,
      );
    })
    .join('\n');
  return { text, elements };
}

const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** findings.md as HTML. Headings drop to h3 and below, because the page's own sections use h2. */
export function markdownToHtml(source: string): string {
  const held = holdCitations(source.replace(/\r\n?/g, '\n').replace(/[\uE000\uE001]/g, '')); // the placeholder characters are ours alone
  const lines = held.text.split('\n');
  const rich = (raw: string): string => inline(escapeHtml(raw)).replace(HELD, (_, n: string) => held.elements[Number(n)]!);
  const out: string[] = [];
  let i = 0;
  const startsBlock = (line: string): boolean => /^(#{1,6}\s|\s*[-*]\s|\s*\d+[.)]\s|```|\|)/.test(line) || /^\s*---+\s*$/.test(line);

  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) body.push(lines[i++]!);
      i++;
      out.push(`<pre><code>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(6, heading[1]!.length + 2);
      out.push(`<h${level}>${rich(heading[2]!.trim())}</h${level}>`);
      i++;
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }
    if (line.startsWith('|') && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const head = cellsOf(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.startsWith('|')) rows.push(cellsOf(lines[i++]!));
      out.push(
        `<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${rich(c)}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${rich(c)}</td>`).join('')}</tr>`)
          .join('')}</tbody></table></div>`,
      );
      continue;
    }
    const first = ITEM.exec(line);
    if (first) {
      const ordered = /\d/.test(first[2]!);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i]!;
        const m = ITEM.exec(current);
        if (m) {
          if (m[1]!.length >= 2 && items.length > 0) items[items.length - 1] += `; ${m[3]}`; // a nested item is folded into its parent
          else if (/\d/.test(m[2]!) === ordered) items.push(m[3]!);
          else break;
          i++;
        } else if (current.trim() === '') {
          if (!ITEM.test(lines[i + 1] ?? '')) break; // a blank line continues the list only when an item follows
          i++;
        } else if (/^\s{2,}\S/.test(current)) {
          items[items.length - 1] += ` ${current.trim()}`; // a wrapped line of the item above
          i++;
        } else {
          break;
        }
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map((t) => `<li>${rich(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && (paragraph.length === 0 || !startsBlock(lines[i]!))) paragraph.push(lines[i++]!.trim());
    out.push(`<p>${rich(paragraph.join(' '))}</p>`);
  }
  return out.join('\n');
}

/**
 * findings.md for the Markdown twin: headings move down two levels under the report's own, raw HTML tags are neutralised, and a
 * cited number keeps only its number (the twin has no number elements to trace), a `[ref:id]` reads `[id]`.
 */
export function markdownForTwin(source: string): string {
  let fenced = false;
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((raw) => {
      if (raw.startsWith('```')) fenced = !fenced;
      const line = fenced || raw.startsWith('```') ? raw : rewriteLine(raw, (c) => c.number, (id) => `[${id}]`);
      const heading = /^(#{1,6})(\s.*)$/.exec(line);
      const shifted = heading ? `${'#'.repeat(Math.min(6, heading[1]!.length + 2))}${heading[2]}` : line;
      return shifted.replace(/<(?=[A-Za-z/!])/g, '\\<').replace(/(?<=[A-Za-z"'/])>/g, '\\>');
    })
    .join('\n')
    .trim();
}
