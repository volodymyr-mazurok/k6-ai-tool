// Cited numbers in findings.md. A number the writer quotes is followed, with no space, by the source it came from:
//
//   p95 was 433 ms[[int|summary.json#metrics["http_req_duration{name:a.b}"].values["p(95)"]]] on the slowest step
//
// `<fmt>` is a format of formats.ts and `<expr>` a source expression of sources.ts, so the number is traced the way every
// number of the report is. The page shows `433` as a number element (markdown.ts) and `perf report --verify-sources` evaluates
// the expression again; `lintFindings` is the check behind `--verify-findings`, which also refuses a number without a citation.
// A knowledge-base reference is cited as `[ref:<id>]` (an id of knowledge/references.md).

import { formatNumber, isFormat } from './formats.js';
import { evaluate, SourceError, type Sources } from './sources.js';

/** A citation found in a line of text. Offsets are into that line. */
export interface Citation {
  fmt: string;
  expr: string;
  /** Where the number starts (its first character) and where the citation ends (after the closing `]]`). `null` number: none stands before it. */
  start: number;
  end: number;
  /** The number as written, without its unit: `433`, `1%`, `13 min 1 s`; null when no number stands before the citation. */
  number: string | null;
  /** What stands between the number and the citation (` ms`, `req/s`), kept outside the number element. */
  unit: string;
}

export interface Reference {
  id: string;
  start: number;
  end: number;
}

export interface ScannedLine {
  citations: Citation[];
  refs: Reference[];
  /** Offsets of `[[fmt|` openings whose closing `]]` is missing. */
  malformed: number[];
  /** The line's text outside inline code, citations (numbers included) and references. */
  plain: string;
}

/** A duration as the `dur` format writes it: `20 s`, `13 min 1 s`, `1 h 2 min`. */
const DURATION_BEFORE = /(?<![\w.,+-])(\d+ h(?: \d+ min)?|\d+ min(?: \d+ s)?|\d+ s)$/;
/** A number, then an optional unit word (`ms`, `s`, `req/s`, `MB`), at the end of the text. */
const NUMBER_BEFORE = /(?<![\w.,+-])([+-]?\d[\d,]*(?:\.\d+)?(?:%|×)?)(\s?[A-Za-zµ]+(?:\/[A-Za-z]+)?)?$/;

/** The number (and the unit after it) at the end of `prefix`, or undefined. The `dur` format writes its own units. */
function numberBefore(prefix: string, fmt: string): { index: number; number: string; unit: string } | undefined {
  if (fmt === 'dur') {
    const m = DURATION_BEFORE.exec(prefix);
    return m ? { index: m.index, number: m[1]!, unit: '' } : undefined;
  }
  const m = NUMBER_BEFORE.exec(prefix);
  return m ? { index: m.index, number: m[1]!, unit: m[2] ?? '' } : undefined;
}

const OPENING = /^\[\[([A-Za-z][A-Za-z0-9]*)\|/;
const REFERENCE = /^\[ref:([^\]\s]*)\]/;

/** The end (after `]]`) of a citation whose expression starts at `from`, or -1. Brackets and quoted keys inside the expression nest. */
function citationEnd(line: string, from: number): number {
  let depth = 0;
  for (let k = from; k < line.length; k++) {
    const c = line[k]!;
    if (c === '"') {
      for (k++; k < line.length && line[k] !== '"'; k++) if (line[k] === '\\') k++;
      if (k >= line.length) return -1;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      if (depth > 0) depth--;
      else return line[k + 1] === ']' ? k + 2 : -1;
    }
  }
  return -1;
}

/** Find the citations and references of one line of findings.md; inline code is skipped. */
export function scanLine(line: string): ScannedLine {
  const citations: Citation[] = [];
  const refs: Reference[] = [];
  const malformed: number[] = [];
  let plain = '';
  let i = 0;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === '`') {
      const close = line.indexOf('`', i + 1);
      if (close < 0) {
        plain += line.slice(i);
        break;
      }
      plain += ' ';
      i = close + 1;
      continue;
    }
    if (ch === '[') {
      const opening = OPENING.exec(line.slice(i, i + 40));
      if (opening) {
        const exprStart = i + opening[0].length;
        const end = citationEnd(line, exprStart);
        if (end < 0) {
          malformed.push(i);
        } else {
          const fmt = opening[1]!;
          const found = numberBefore(line.slice(0, i), fmt);
          const taken = found ? found.number.length + found.unit.length : 0;
          citations.push({ fmt, expr: line.slice(exprStart, end - 2), start: found ? found.index : i, end, number: found?.number ?? null, unit: found?.unit ?? '' });
          plain = plain.slice(0, plain.length - taken) + (found?.unit ?? '');
          i = end;
          continue;
        }
      }
      const ref = REFERENCE.exec(line.slice(i));
      if (ref) {
        refs.push({ id: ref[1]!, start: i, end: i + ref[0].length });
        plain += ' ';
        i += ref[0].length;
        continue;
      }
    }
    plain += ch;
    i++;
  }
  return { citations, refs, malformed, plain };
}

/** The citations of a line (see `scanLine`). */
export const scanCitations = (line: string): Citation[] => scanLine(line).citations;

/**
 * A line with each citation (number included) and each `[ref:id]` replaced; the unit after a number stays. A citation with no
 * number before it is left as written.
 */
export function rewriteLine(line: string, citation: (c: Citation & { number: string }) => string, ref: (id: string) => string): string {
  const { citations, refs } = scanLine(line);
  const edits = [
    ...citations.filter((c): c is Citation & { number: string } => c.number !== null).map((c) => ({ from: c.start, to: c.end, text: citation(c) + c.unit })),
    ...refs.map((r) => ({ from: r.start, to: r.end, text: ref(r.id) })),
  ].sort((a, b) => a.from - b.from);
  let out = '';
  let at = 0;
  for (const e of edits) {
    out += line.slice(at, e.from) + e.text;
    at = e.to;
  }
  return out + line.slice(at);
}

// ---------------------------------------------------------------------------------------------------------------
// the check
// ---------------------------------------------------------------------------------------------------------------

const LIST_MARKER = /^\s*(?:[-*+]|\d+[.)])\s+/;
const HEADING = /^#{1,6}\s/;
const RUN_LINE = /^[\s*_]*Run:/;
const LEADING = /^[[("'*_~≈<>≥≤={:]+/;
const TRAILING = /[.,;:!?)\]"'*_}]+$/;
/** A token that is a number: an optional sign, then a digit. Words like p95, k6, S1 or UTF-8 start with a letter and are not. */
const NUMBER_TOKEN = /^[+-]?\d/;
/** What a `Run:` line may hold without a citation: a date (with a run id's time after it) or a time of day. */
const DATE_OR_TIME = /^(\d{4}-\d{2}-\d{2}([T_]\S*)?|\d{1,2}:\d{2}(:\d{2})?(\.\d+)?Z?)$/;

function uncitedNumbers(plain: string, runLine: boolean): string[] {
  const out: string[] = [];
  for (const raw of plain.split(/[\s|]+/)) {
    const token = raw.replace(LEADING, '').replace(TRAILING, '');
    if (!NUMBER_TOKEN.test(token)) continue;
    if (runLine && DATE_OR_TIME.test(token)) continue;
    out.push(token);
  }
  return out;
}

export interface FindingsCheck {
  /** One line for each problem, each naming its line number. */
  problems: string[];
  /** Citations that passed. */
  numbers: number;
  references: number;
}

/**
 * Check findings.md: every citation `N[[fmt|expr]]` has a known format and a source that gives N once formatted, every
 * `[ref:id]` is in `refs`, and no number stands without one of them. Inline code, fenced code and headings are free text;
 * so are identifiers with letters before the digits (p95, k6, S1, a.b2), list markers, and dates and times on a `Run:` line.
 */
export function checkFindings(markdown: string, sources: Sources, refs: Set<string>): FindingsCheck {
  const problems: string[] = [];
  let numbers = 0;
  let references = 0;
  let fenced = false;
  markdown.replace(/\r\n?/g, '\n').split('\n').forEach((line, index) => {
    const n = index + 1;
    if (line.startsWith('```')) {
      fenced = !fenced;
      return;
    }
    if (fenced) return;
    const body = line.replace(LIST_MARKER, '');
    const scanned = scanLine(body);
    for (const at of scanned.malformed) problems.push(`malformed citation "${body.slice(at, at + 30)}…" in line ${n}: it must end with ]]`);
    for (const c of scanned.citations) {
      if (c.number === null) {
        problems.push(`no number before the citation [[${c.fmt}|…]] in line ${n}: write the number first, with no space before [[`);
      } else if (!isFormat(c.fmt)) {
        problems.push(`unknown format "${c.fmt}" in line ${n}`);
      } else {
        try {
          const expected = formatNumber(c.fmt, evaluate(c.expr, sources));
          if (expected === c.number) numbers++;
          else problems.push(`"${c.number}" in line ${n} does not match its source: ${c.fmt} of ${c.expr} is "${expected}"`);
        } catch (err) {
          if (!(err instanceof SourceError)) throw err;
          problems.push(`${c.expr}: ${err.message} in line ${n}`);
        }
      }
    }
    for (const r of scanned.refs) {
      references++;
      if (!refs.has(r.id)) problems.push(`unknown reference "${r.id}" in line ${n}: it is not an entry of knowledge/references.md`);
    }
    if (!HEADING.test(body)) {
      for (const token of uncitedNumbers(scanned.plain, RUN_LINE.test(body))) problems.push(`uncited number "${token}" in line ${n}`);
    }
  });
  return { problems, numbers, references };
}

/** The problems `checkFindings` finds, one line each (empty when findings.md is clean). */
export const lintFindings = (markdown: string, sources: Sources, refs: Set<string>): string[] => checkFindings(markdown, sources, refs).problems;
