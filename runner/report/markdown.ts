// A small Markdown reader for findings.md, enough for what the perf-report agent writes: headings, paragraphs, bullet and
// numbered lists, tables, code, bold, italics, inline code. Everything is escaped first, so the agent's text can never
// add markup of its own; links and images become plain text (the page makes no external requests).

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

const cellsOf = (line: string): string[] => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

/** findings.md as HTML. Headings drop to h3 and below, because the page's own sections use h2. */
export function markdownToHtml(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
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
      out.push(`<h${level}>${inline(escapeHtml(heading[2]!.trim()))}</h${level}>`);
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
        `<div class="scroll"><table><thead><tr>${head.map((c) => `<th>${inline(escapeHtml(c))}</th>`).join('')}</tr></thead><tbody>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(escapeHtml(c))}</td>`).join('')}</tr>`)
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
      out.push(`<${tag}>${items.map((t) => `<li>${inline(escapeHtml(t))}</li>`).join('')}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== '' && (paragraph.length === 0 || !startsBlock(lines[i]!))) paragraph.push(lines[i++]!.trim());
    out.push(`<p>${inline(escapeHtml(paragraph.join(' ')))}</p>`);
  }
  return out.join('\n');
}

/** findings.md for the Markdown twin: headings move down two levels under the report's own, and raw HTML tags are neutralised. */
export function markdownForTwin(source: string): string {
  return source
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => {
      const heading = /^(#{1,6})(\s.*)$/.exec(line);
      const shifted = heading ? `${'#'.repeat(Math.min(6, heading[1]!.length + 2))}${heading[2]}` : line;
      return shifted.replace(/<(?=[A-Za-z/!])/g, '\\<').replace(/(?<=[A-Za-z"'/])>/g, '\\>');
    })
    .join('\n')
    .trim();
}
