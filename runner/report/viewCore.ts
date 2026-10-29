// The shape of the report before it is HTML or Markdown: sections of blocks, whose numbers are traced values. One view
// feeds both writers, so report.html and report.md cannot disagree.

import type { ReportModel } from './build.js';
import { formatNumber, type FormatName } from './formats.js';
import { evaluate, source, SourceError, type Sources } from './sources.js';
import type { VerdictName } from './model.js';

/** How a cell or fact reads: `ok` / `warn` / `bad` colour a result against its target or baseline; `info` and `muted` are neutral. */
export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'invalid' | 'muted';

/** A number on the page, with the expression that gives it. */
export interface Num {
  n: true;
  text: string;
  src: string;
  fmt: FormatName;
}

export type Part = string | Num;

export interface Cell {
  parts: Part[];
  tone?: Tone;
  /** `id`: a name, path or code (monospace, exempt from the traced-number rule); `sql`: a masked statement. */
  cls?: 'id' | 'sql';
  /** A relative link to a file of the run folder. */
  href?: string;
}

export interface Head {
  label: string;
  right?: boolean;
}

export type Block =
  | { kind: 'text'; parts: Part[]; cls?: 'lead' | 'note' | 'warn' }
  | { kind: 'sub'; title: string }
  | { kind: 'list'; items: Part[][] }
  | { kind: 'table'; head: Head[]; rows: Cell[][]; note?: Part[] }
  | { kind: 'facts'; rows: { label: string; value: Cell }[] }
  | { kind: 'chart'; title: string; svg: string; caption: string }
  | { kind: 'verdict'; verdict: VerdictName; lead: string; reasons: string[]; notes: string[] }
  | { kind: 'details'; summary: string; blocks: Block[] }
  | { kind: 'markdown'; text: string };

export interface Section {
  id: string;
  title: string;
  blocks: Block[];
}

export interface ReportView {
  title: string;
  subtitle: Cell;
  verdict: VerdictName;
  sections: Section[];
}

export const DASH = '–';

/** Helpers shared by the section builders: every number goes through `num`, which evaluates the expression it records. */
export class Ctx {
  constructor(readonly model: ReportModel) {}

  get sources(): Sources {
    return this.model.sources;
  }

  /** A traced number: `fmt(evaluate(src))`, carrying `src` so the page can be checked against the files. */
  num(src: string, fmt: FormatName): Num {
    return { n: true, text: formatNumber(fmt, evaluate(src, this.sources)), src, fmt };
  }

  /** The unrounded value of an expression (for the model's functions, which round themselves). */
  exact(src: string): number {
    return evaluate(src, this.sources);
  }

  /** `num`, or a dash when the expression has nothing to compute (a rate over no requests). A broken expression still throws. */
  numOrDash(src: string, fmt: FormatName): Num | string {
    try {
      return this.num(src, fmt);
    } catch (err) {
      if (err instanceof SourceError && err.kind === 'empty') return DASH;
      throw err;
    }
  }
}

export const text = (value: string, tone?: Tone): Cell => ({ parts: [value], ...(tone ? { tone } : {}) });
export const ident = (value: string): Cell => ({ parts: [value], cls: 'id' });
export const cell = (parts: Part[], tone?: Tone): Cell => ({ parts, ...(tone ? { tone } : {}) });
export const isNum = (part: Part): part is Num => typeof part !== 'string';

/** The text of parts as plain text (numbers as shown). */
export const plain = (parts: Part[]): string => parts.map((p) => (isNum(p) ? p.text : p)).join('');

/** A date for people: `2026-10-22 20:10 UTC`. */
export function utcMinute(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

// ---------------------------------------------------------------------------------------------------------------
// expressions for k6's per-step sub-metrics
// ---------------------------------------------------------------------------------------------------------------


/** `summary.json#metrics["<metric>{name:<id>}"].values.<field>` (the metric alone when `id` is null). */
export function stepRef(metric: string, id: string | null, field: string): string {
  return source('summary.json', 'metrics', id === null ? metric : `${metric}{name:${id}}`, 'values', field);
}

/** passes / (passes + fails) of a k6 rate: the share of failed requests (`http_req_failed`) or of passed checks (`checks`). */
export function rateRef(metric: string, id: string): string {
  const passes = stepRef(metric, id, 'passes');
  return `${passes} / (${passes} + ${stepRef(metric, id, 'fails')})`;
}

/** The trend field holding the median: k6 calls it `med`; an export that kept `p(50)` is read too. */
export function medianField(ctx: Ctx, id: string): string {
  const values = (ctx.sources['summary.json'] as { metrics?: Record<string, { values?: Record<string, number> }> } | undefined)?.metrics?.[`http_req_duration{name:${id}}`]?.values;
  return values && values.med === undefined && values['p(50)'] !== undefined ? 'p(50)' : 'med';
}

/** `meta.json#rules.<group>.<key>`: a limit the run applied, as recorded in its meta.json. */
export const ruleRef = (group: 'flags' | 'breaking', key: string): string => source('meta.json', 'rules', group, key);

/** `meta.json#baseline.steps["<id>"].<field>`: the baseline slot the run was judged against, as recorded in its meta.json. */
export const baselineRef = (id: string, field: string): string => source('meta.json', 'baseline', 'steps', id, field);

/** The span the summary's counts cover, in seconds, as an expression. */
export const DURATION_SEC = `${source('summary.json', 'state', 'testRunDurationMs')} / 1000`;
