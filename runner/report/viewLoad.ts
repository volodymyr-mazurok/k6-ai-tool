// Section 3 of the report: under what load. The load in the business's words, the figures behind it, and the charts
// (active users, requests per second, and the database under them on the same time axis).

import { businessLoad, type StepStat } from './model.js';
import { ALL, source, window } from './sources.js';
import { lineChart, type ChartSeries } from './svg.js';
import { cell, Ctx, DURATION_SEC, ruleRef, stepRef, type Block, type Cell, type Part, type Section } from './viewCore.js';

const CHART_WIDTH = 720;

/** The chart's x range: the longest of the buckets and the database samples, so stacked charts share one time axis. */
function timeAxisEnd(ctx: Ctx): number {
  const { timeseries, db } = ctx.model;
  const bucketEnd = timeseries.buckets.length > 0 ? timeseries.buckets[timeseries.buckets.length - 1]!.t + timeseries.bucketSec : 0;
  const dbEnd = Math.max(0, ...(db?.resource ?? []).map((s) => s.t ?? 0));
  return Math.max(bucketEnd, dbEnd, 1);
}

const STOP_CAUSE = { thresholds: 'aborted by a k6 threshold', db: 'stopped by the database guard', interrupted: 'interrupted' } as const;

/**
 * Why the run ended before its plan, or undefined when it ran to the end. It needs a recorded stop (the runner's abort or
 * an interrupt; a threshold abort also needs k6's exit code 99) and a measured length clearly under the planned one: a
 * threshold that failed only at the end exits 99 too, and a stop with no summary cannot be measured.
 */
function stoppedEarly(ctx: Ctx): (typeof STOP_CAUSE)[keyof typeof STOP_CAUSE] | undefined {
  const { meta, durationSec } = ctx.model;
  const reason = meta.k6.abortReason ?? (meta.interrupted ? 'interrupted' : undefined);
  if (!reason || (reason === 'thresholds' && meta.k6.exitCode !== 99)) return undefined;
  return durationSec > 0 && durationSec < meta.profile.totalSec - 1 ? STOP_CAUSE[reason] : undefined;
}

/**
 * The steady-state stretch of a load or soak run, when the run recorded one and reached it. A run that stopped early
 * may never have held the planned load, so its figures are counted over the whole run instead.
 */
function steadyState(ctx: Ctx): { fromSec: number; toSec: number } | undefined {
  const { meta, timeseries } = ctx.model;
  const hold = meta.profile.holdWindow;
  if (stoppedEarly(ctx)) return undefined;
  return (meta.profile.type === 'load' || meta.profile.type === 'soak') && hold && timeseries.buckets.length > 0 ? hold : undefined;
}

/** Requests of the steady state window as a source expression: buckets whose start is inside `[from, to)`. */
function holdBuckets(ctx: Ctx, field: string): string {
  const hold = ctx.model.meta.profile.holdWindow!;
  return source('timeseries.json', 'buckets', window('t', hold.fromSec, hold.toSec), field);
}

interface LoadFigures {
  /** The business sentence; absent when there is nothing to measure it from. */
  sentence?: string;
  /** What the figures are counted over, as parts ("from 2 min to 12 min of the run" / "the whole run"). */
  scope: Part[];
  facts: { label: string; value: Cell }[];
}

function loadFigures(ctx: Ctx): LoadFigures {
  const { meta, workload, steps, timeseries } = ctx.model;
  // "Grid actions", "item actions": the run's own word for what one unit of its work is
  const action = workload?.businessAction ?? 'actions';
  const perMinute = `${action.charAt(0).toUpperCase()}${action.slice(1)} per minute`;
  const hold = steadyState(ctx);
  const hasBuckets = timeseries.buckets.length > 0;
  const facts: { label: string; value: Cell }[] = [];

  // Users: the configured count for a load, k6's peak otherwise.
  if (meta.profile.users !== undefined) facts.push({ label: 'Virtual users', value: cell([ctx.num(source('meta.json', 'profile', 'users'), 'int')]) });
  if (hasBuckets) {
    facts.push({ label: 'Most active users at once', value: cell([ctx.num(`max(${source('timeseries.json', 'buckets', ALL, 'vus')})`, 'int')]) });
    facts.push({ label: 'Peak requests per second', value: cell([ctx.num(`max(${source('timeseries.json', 'buckets', ALL, 'rps')})`, 'dec2')]) });
  }

  if (hold) {
    const reqs = `sum(${holdBuckets(ctx, 'reqs')})`;
    const holdSec = `(${source('meta.json', 'profile', 'holdWindow', 'toSec')} - ${source('meta.json', 'profile', 'holdWindow', 'fromSec')})`;
    const requests = ctx.exact(reqs);
    if (requests > 0) {
      // The time series has no per-step counts, so the steady state's requests stand in as one step for businessLoad.
      const steadyStep: StepStat = { id: 'steady state', count: requests, rps: 0, p50: 0, p95: 0, p99: 0, errorRate: null, checkRate: null };
      facts.push({ label: 'Requests in the steady state', value: cell([ctx.num(reqs, 'int')]) });
      facts.push({ label: `${perMinute} (steady state)`, value: cell([ctx.num(`${reqs} * 60 / ${holdSec}`, 'int')]) });
      return {
        ...(workload ? { sentence: businessLoad(workload, meta.profile, [steadyStep], hold.toSec - hold.fromSec) } : {}),
        scope: ['the steady state, from ', ctx.num(source('meta.json', 'profile', 'holdWindow', 'fromSec'), 'dur'), ' to ', ctx.num(source('meta.json', 'profile', 'holdWindow', 'toSec'), 'dur'), ' of the run'],
        facts,
      };
    }
  }

  if (steps.length > 0 && ctx.model.durationSec > 0) {
    const counts = steps.map((s) => stepRef('http_req_duration', s.id, 'count'));
    facts.push({ label: 'Requests in the whole run (without token requests)', value: cell([ctx.num(`sum(${counts.join(', ')})`, 'int')]) });
    facts.push({ label: `${perMinute} (whole run)`, value: cell([ctx.num(`sum(${counts.join(', ')}) * 60 / (${DURATION_SEC})`, 'int')]) });
    return { ...(workload ? { sentence: businessLoad(workload, meta.profile, steps, ctx.model.durationSec) } : {}), scope: ['the whole run'], facts };
  }
  return { scope: ['the whole run'], facts };
}

export function loadSection(ctx: Ctx): Section {
  const { meta, timeseries, db, workload } = ctx.model;
  const figures = loadFigures(ctx);
  const blocks: Block[] = [];

  if (figures.sentence) {
    // A smoke's sentence already says how long it ran; the other profiles say what the figures are counted over.
    blocks.push({ kind: 'text', cls: 'lead', parts: meta.profile.type === 'smoke' ? [figures.sentence] : [figures.sentence, ' – measured over ', ...figures.scope] });
  } else {
    blocks.push({
      kind: 'text',
      cls: 'warn',
      parts: [
        workload
          ? 'No load figures: k6 wrote no summary.json or no requests were recorded.'
          : 'The workload terms of this run were not recorded and its feature files cannot be found, so the load cannot be put in business terms.',
      ],
    });
  }
  const cause = stoppedEarly(ctx);
  if (cause) {
    const hasSteadyState = meta.profile.type === 'load' || meta.profile.type === 'soak';
    blocks.push({
      kind: 'text',
      cls: 'warn',
      parts: [
        `The run stopped early, ${cause}, after `,
        ctx.num(DURATION_SEC, 'dur'),
        ' of the ',
        ctx.num(source('meta.json', 'profile', 'totalSec'), 'dur'),
        hasSteadyState ? ' planned, so the figures cover the whole run, not the planned steady state.' : ' planned, so the figures cover the whole run.',
      ],
    });
  }
  if (timeseries.warning) blocks.push({ kind: 'text', cls: 'warn', parts: [`Time series: ${timeseries.warning}`] });
  if (figures.facts.length > 0) blocks.push({ kind: 'facts', rows: figures.facts });

  if (timeseries.buckets.length > 0) {
    const xMax = timeAxisEnd(ctx);
    const hold = steadyState(ctx);
    const bands = hold ? [{ from: hold.fromSec, to: hold.toSec, label: 'steady state' }] : [];
    const at = (pick: (b: (typeof timeseries.buckets)[number]) => number): [number, number][] => timeseries.buckets.map((b) => [b.t, pick(b)]);
    blocks.push({
      kind: 'chart',
      title: 'Active users (vus)',
      caption: `How many virtual users were active at each moment${workload ? `; each stands for one of the "${workload.businessUnit}"` : ''}. Source: timeseries.json.`,
      svg: lineChart([{ name: 'users', points: at((b) => b.vus) }], { width: CHART_WIDTH, height: 150, yLabel: 'users', title: 'Active users (vus)', xMax, bands }),
    });
    blocks.push({
      kind: 'chart',
      title: 'Requests per second (req/s)',
      caption: 'Requests k6 sent each second, averaged over 15-second slices. Source: timeseries.json.',
      svg: lineChart([{ name: 'req/s', points: at((b) => b.rps) }], { width: CHART_WIDTH, height: 150, yLabel: 'req/s', title: 'Requests per second (req/s)', xMax, bands }),
    });
  }
  if (db) {
    const samples = db.resource.filter((s): s is typeof s & { t: number } => s.t !== null);
    const series: ChartSeries[] = [
      { name: 'CPU', points: samples.map((s) => [s.t, s.cpu]) },
      { name: 'Data IO', points: samples.map((s) => [s.t, s.dataIo]) },
    ];
    const hold = steadyState(ctx);
    blocks.push({
      kind: 'chart',
      title: 'Database load (%)',
      caption: 'CPU and data IO of the shared database, one sample every 15 seconds. The dashed line is where the report raises a flag. Source: db.json.',
      svg: lineChart(series, {
        width: CHART_WIDTH,
        height: 170,
        yLabel: '% of the tier limit',
        title: 'Database load (%)',
        xLabel: 'time since the run started (min:s)',
        xMax: timeAxisEnd(ctx),
        yMax: 100,
        hlines: [{ y: ctx.exact(ruleRef('flags', 'dbPct')), label: 'flag limit' }],
        bands: hold ? [{ from: hold.fromSec, to: hold.toSec, label: 'steady state' }] : [],
      }),
    });
  } else if (meta.profile.type !== 'smoke') {
    const why = meta.database === 'none' ? 'This project has no database access' : 'No database evidence for this run';
    blocks.push({ kind: 'text', cls: 'note', parts: [`${why}, so there is no database chart.`] });
  }
  return { id: 'load', title: 'Under what load', blocks };
}
