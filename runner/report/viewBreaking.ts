// Section 5 of the report (stress runs only): the load at which errors or p95 jumped, and what gave first.

import type { BreakingPoint } from './model.js';
import { source, SourceError, window } from './sources.js';
import { lineChart } from './svg.js';
import { cell, Ctx, DASH, ruleRef, text, type Block, type Cell, type Part, type Section } from './viewCore.js';

const CAUSE: Record<BreakingPoint['gaveFirst'], string> = {
  'api-errors': 'API errors: requests started failing before anything else showed',
  latency: 'latency: responses got slow (or k6 could not start iterations in time) before anything else showed',
  db: 'the database: its CPU or data IO was saturated before the API showed trouble',
};

/**
 * Where the breaking point's time comes from in the files: the start of a 15 s bucket, the start of the stage (the signal
 * is never placed before it), or a database sample's end minus its length. Undefined when none matches.
 */
function atSource(ctx: Ctx, atSec: number): string | undefined {
  const { timeseries, meta, db } = ctx.model;
  const bucket = timeseries.buckets.findIndex((b) => b.t === atSec);
  if (bucket >= 0) return source('timeseries.json', 'buckets', bucket, 't');
  const stage = (meta.profile.stages ?? []).findIndex((s) => s.fromSec === atSec);
  if (stage >= 0) return source('meta.json', 'profile', 'stages', stage, 'fromSec');
  const sample = (db?.resource ?? []).findIndex((s) => s.t !== null && s.t - timeseries.bucketSec === atSec);
  if (sample >= 0) return `${source('db.json', 'resource', sample, 't')} - ${timeseries.bucketSec}`;
  return undefined;
}

export function breakingSection(ctx: Ctx): Section {
  const { meta, timeseries, breakingPoint } = ctx.model;
  const stages = meta.profile.stages ?? [];
  const half = timeseries.bucketSec / 2;
  const blocks: Block[] = [];

  // A bucket belongs to the stage its middle falls in (the same rule that finds the breaking point).
  const bucketsOf = (i: number, field: string): string =>
    source('timeseries.json', 'buckets', window('t', stages[i]!.fromSec - half, i + 1 < stages.length ? stages[i + 1]!.fromSec - half : null), field);

  const brokenAt = breakingPoint ? stages.findIndex((s) => s.rps === breakingPoint.rps) : -1;
  if (breakingPoint && brokenAt >= 0) {
    const at = atSource(ctx, breakingPoint.atSec);
    const parts: Part[] = [
      'The system stopped keeping up at ',
      ctx.num(source('meta.json', 'profile', 'stages', brokenAt, 'rps'), 'dec2'),
      ' req/s',
      ...(at ? [', about ', ctx.num(at, 'dur'), ' into the run'] : []),
      '. What gave first: ',
      CAUSE[breakingPoint.gaveFirst],
      '.',
    ];
    blocks.push({ kind: 'text', cls: 'lead', parts });
  } else {
    blocks.push({ kind: 'text', cls: 'lead', parts: ['No breaking point: every load stage held, so the system carried the highest rate tried.'] });
  }
  blocks.push({
    kind: 'text',
    cls: 'note',
    parts: [
      'A stage counts as broken when more than ',
      ctx.num(ruleRef('breaking', 'errorRate'), 'pct'),
      ' of its requests failed, its p95 was over ',
      ctx.num(ruleRef('breaking', 'latencyFactor'), 'ratio'),
      ' the first stage’s, or k6 dropped iterations because answers were too slow to keep the rate. The database is blamed when its CPU or data IO reached ',
      ctx.num(ruleRef('breaking', 'dbPct'), 'pctPoints'),
      ' first.',
    ],
  });

  const rows: Cell[][] = stages.map((_, i) => {
    const tone = brokenAt < 0 ? undefined : i < brokenAt ? 'ok' : i === brokenAt ? 'bad' : 'muted';
    const requests = `sum(${bucketsOf(i, 'reqs')})`;
    const failed = ctx.numOrDash(`sum(${bucketsOf(i, 'errors')}) / ${requests}`, 'pct');
    const p95 = ctx.numOrDash(`wavg(${bucketsOf(i, 'p95')}, ${bucketsOf(i, 'reqs')})`, 'int');
    const label = brokenAt < 0 ? 'held' : i < brokenAt ? 'held' : i === brokenAt ? 'broke here' : 'after the break';
    return [
      cell([ctx.num(source('meta.json', 'profile', 'stages', i, 'rps'), 'dec2')]),
      cell([ctx.num(source('meta.json', 'profile', 'stages', i, 'fromSec'), 'dur')]),
      cell([ctx.num(requests, 'int')]),
      typeof failed === 'string' ? text(DASH) : cell([failed], tone),
      typeof p95 === 'string' ? text(DASH) : cell([p95], tone),
      cell([ctx.num(`sum(${bucketsOf(i, 'dropped')})`, 'int')], tone),
      text(label, tone),
    ];
  });
  const heads = ['Stage (req/s)', 'Starts at', 'Requests', 'Failed (http_req_failed)', 'p95 (ms)', 'Dropped (dropped_iterations)', 'Result'];
  blocks.push({ kind: 'table', head: heads.map((label, i) => ({ label, right: i >= 1 && i <= 5 })), rows });

  if (timeseries.buckets.length > 0 && stages.length > 0) {
    const points = timeseries.buckets.filter((b) => b.p95 !== null).map((b): [number, number] => [b.t, b.p95!]);
    let limit = NaN; // the first stage's p95 times the factor; unknown when the first stage sent nothing
    try {
      limit = ctx.exact(`wavg(${bucketsOf(0, 'p95')}, ${bucketsOf(0, 'reqs')})`) * ctx.exact(ruleRef('breaking', 'latencyFactor'));
    } catch (err) {
      if (!(err instanceof SourceError && err.kind === 'empty')) throw err;
    }
    const lastT = timeseries.buckets[timeseries.buckets.length - 1]!.t + timeseries.bucketSec;
    blocks.push({
      kind: 'chart',
      title: 'p95 response time over time (ms)',
      caption: 'Slowest 5% of requests in each slice. The dashed horizontal line is the latency limit for a stage; the vertical one is where the break showed. Source: timeseries.json.',
      svg: lineChart([{ name: 'p95', points }], {
        width: 720,
        height: 190,
        yLabel: 'ms',
        title: 'p95 response time over time (ms)',
        xLabel: 'time since the run started (min:s)',
        xMax: lastT,
        hlines: Number.isFinite(limit) ? [{ y: limit, label: 'latency limit' }] : [],
        vlines: breakingPoint ? [{ x: breakingPoint.atSec, label: 'breaking point' }] : [],
      }),
    });
  }
  return { id: 'breaking-point', title: 'Breaking point', blocks };
}
