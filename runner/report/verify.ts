// The check behind `perf report --verify-sources`: every number element of a page is evaluated again against the run
// folder's files and compared with the text shown.

import { formatNumber, isFormat } from './formats.js';
import { evaluate, SourceError, type Sources } from './sources.js';

const ENTITIES: [RegExp, string][] = [
  [/&quot;/g, '"'],
  [/&#39;/g, "'"],
  [/&lt;/g, '<'],
  [/&gt;/g, '>'],
  [/&amp;/g, '&'],
];
const decode = (text: string): string => ENTITIES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);

/** A number element: `<span class="num …" data-src="…" data-fmt="…">text</span>`. */
const NUMBER_ELEMENT = /<span\b([^>]*\bclass="num[ "][^>]*)>([^<]*)<\/span>/g;

/**
 * Evaluate the `data-src` of every number element of a page against the files and compare it with the text shown.
 * @returns how many numbers were checked, and a line for each that is missing a source, has an unknown format, cannot be
 *   resolved or shows another text than the file gives
 */
export function verifyHtml(html: string, sources: Sources): { checked: number; mismatches: string[] } {
  const mismatches: string[] = [];
  let checked = 0;
  for (const match of html.matchAll(NUMBER_ELEMENT)) {
    checked++;
    const attrs = match[1]!;
    const shown = decode(match[2]!);
    const src = /\bdata-src="([^"]*)"/.exec(attrs)?.[1];
    const fmt = /\bdata-fmt="([^"]*)"/.exec(attrs)?.[1];
    if (src === undefined) {
      mismatches.push(`a number without a source: "${shown}" has no data-src`);
      continue;
    }
    const expression = decode(src);
    if (fmt === undefined || !isFormat(fmt)) {
      mismatches.push(`${expression}: unknown format "${fmt ?? ''}" (shows "${shown}")`);
      continue;
    }
    try {
      const expected = formatNumber(fmt, evaluate(expression, sources));
      if (expected !== shown) mismatches.push(`${expression} shows "${shown}" but the file gives "${expected}"`);
    } catch (err) {
      if (!(err instanceof SourceError)) throw err;
      mismatches.push(`${expression}: ${err.message} (shows "${shown}")`);
    }
  }
  return { checked, mismatches };
}
