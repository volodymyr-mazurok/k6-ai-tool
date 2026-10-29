// Sections 4, 7 and 8 of the report: results per step, the comparison with the baseline, and the automatic flags.

import type { Flag, StepStat } from './model.js';
import { source, window } from './sources.js';
import { baselineRef, cell, Ctx, DASH, DURATION_SEC, ident, medianField, rateRef, ruleRef, stepRef, text, type Block, type Cell, type Num, type Section, type Tone } from './viewCore.js';

/** A p95 more than this far above the baseline is amber before it is red (the flag needs +20% and +100 ms). */
const WARN_FACTOR = 1.1;

const dash = (tone?: Tone): Cell => text(DASH, tone);

const p95Ref = (id: string): string => stepRef('http_req_duration', id, 'p(95)');

const isFlagged = (flags: Flag[], id: string): boolean => flags.some((f) => f.code === 'P95_REGRESSION' && f.step === id);

/** The explicit p95 target of a step, if the run was judged by targets. */
function targetOf(ctx: Ctx, id: string): number | undefined {
  const { targets } = ctx.model;
  return targets !== 'baseline' && Object.hasOwn(targets, id) ? targets[id]!.p95Ms : undefined;
}

/** The last column of the step table: the step against its target, or against the baseline; its tone also colours the p95 cell. */
function versus(ctx: Ctx, stat: StepStat): Cell {
  const { baseline, flags } = ctx.model;
  const target = targetOf(ctx, stat.id);
  if (target !== undefined) {
    const missed = stat.p95 > target;
    return cell([missed ? 'missed – target ' : 'met – target ', ctx.num(source('meta.json', 'targets', stat.id, 'p95Ms'), 'int'), ' ms'], missed ? 'bad' : 'ok');
  }
  const base = baseline?.steps[stat.id];
  if (!base) return text(baseline ? 'no baseline for this step' : 'no baseline', 'muted');
  const change = ctx.numOrDash(`(${p95Ref(stat.id)} - ${baselineRef(stat.id, 'p95')}) / ${baselineRef(stat.id, 'p95')}`, 'signedPct');
  if (isFlagged(flags, stat.id)) return cell([change, ' vs baseline – flagged'], 'bad');
  return cell([change, ' vs baseline'], stat.p95 > base.p95 * WARN_FACTOR ? 'warn' : 'ok');
}

function stepRow(ctx: Ctx, id: string, stat: StepStat | undefined): Cell[] {
  if (!stat) return [ident(id), ...Array.from({ length: 7 }, () => dash()), text('no requests', 'muted')];
  const vs = versus(ctx, stat);
  const failedTone: Tone | undefined = stat.errorRate === null ? undefined : stat.errorRate > ctx.model.rules.flags.errorRate ? 'bad' : 'ok';
  const checkFailure = stat.checkRate === null ? null : Math.round((1 - stat.checkRate) * 1e6) / 1e6;
  const checksTone: Tone | undefined = checkFailure === null ? undefined : checkFailure > ctx.model.rules.flags.checkFailureRate ? 'bad' : 'ok';
  const count = stepRef('http_req_duration', id, 'count');
  const pct = (part: Num | string, tone?: Tone): Cell => (typeof part === 'string' ? dash() : cell([part], tone));
  return [
    ident(id),
    cell([ctx.num(count, 'int')]),
    cell([ctx.num(`${count} / (${DURATION_SEC})`, 'dec2')]),
    cell([ctx.num(stepRef('http_req_duration', id, medianField(ctx, id)), 'int')]),
    cell([ctx.num(p95Ref(id), 'int')], vs.tone === 'muted' ? undefined : vs.tone),
    cell([ctx.num(stepRef('http_req_duration', id, 'p(99)'), 'int')]),
    stat.errorRate === null ? dash() : pct(ctx.numOrDash(rateRef('http_req_failed', id), 'pct'), failedTone),
    stat.checkRate === null ? dash() : pct(ctx.numOrDash(rateRef('checks', id), 'pct'), checksTone),
    vs,
  ];
}

export function stepsSection(ctx: Ctx): Section {
  const { summary, stepIds, steps } = ctx.model;
  if (!summary) {
    return { id: 'steps', title: 'Results per step', blocks: [{ kind: 'text', cls: 'warn', parts: ['No per-step numbers: k6 wrote no summary.json (it was probably stopped before it could).'] }] };
  }
  const head = ['Step', 'Requests (http_reqs)', 'req/s', 'p50 (ms)', 'p95 (ms)', 'p99 (ms)', 'Failed (http_req_failed)', 'Checks passed (checks)', 'vs target or baseline'];
  const blocks: Block[] = [
    {
      kind: 'table',
      head: head.map((label, i) => ({ label, right: i >= 1 && i <= 7 })),
      rows: stepIds.map((id) => stepRow(ctx, id, steps.find((s) => s.id === id))),
      note: [
        'p50 is the typical response time. p95 means 95 out of 100 requests were faster than this; p99, 99 out of 100. Failed is the share of requests that returned an error. Checks passed is the share of content checks that held (a 200 with an error body fails its check). req/s counts the whole run, ramps included.',
      ],
    },
  ];
  if (ctx.model.authType === 'static_header') {
    blocks.push({ kind: 'text', cls: 'note', parts: ['The run sent no token requests: it signs in with a static header, which needs no login.'] });
  } else if (summary.metrics['http_req_duration{name:auth_token}']?.values?.count !== undefined) {
    blocks.push({
      kind: 'text',
      cls: 'note',
      parts: ['Token requests (auth_token) are not in the table. The run sent ', ctx.num(stepRef('http_req_duration', 'auth_token', 'count'), 'int'), ' of them: one per account, plus a refresh when a token was about to expire.'],
    });
  }
  return { id: 'steps', title: 'Results per step', blocks };
}

// ---------------------------------------------------------------------------------------------------------------
// comparison with the baseline
// ---------------------------------------------------------------------------------------------------------------

export function baselineSection(ctx: Ctx): Section {
  const { baseline, meta, stepIds, steps, flags } = ctx.model;
  const title = 'Compared with baseline';
  if (!baseline) {
    return {
      id: 'baseline',
      title,
      blocks: [
        {
          kind: 'text',
          parts: [
            `No accepted baseline for ${meta.env} / ${meta.profile.type} yet, so this run’s numbers stand alone. Accept a run as the baseline (perf baseline accept <run folder>) and later runs are compared with it.`,
          ],
        },
      ],
    };
  }
  const rows: Cell[][] = [];
  for (const id of stepIds) {
    const stat = steps.find((s) => s.id === id);
    const base = baseline.steps[id];
    if (!base) {
      if (stat) rows.push([ident(id), text('no baseline for this step', 'muted'), ...Array.from({ length: 7 }, () => dash())]);
      continue;
    }
    if (!stat) {
      rows.push([ident(id), ...Array.from({ length: 7 }, () => dash()), text('no requests', 'muted')]);
      continue;
    }
    const flagged = isFlagged(flags, id);
    const tone: Tone = flagged ? 'bad' : stat.p95 > base.p95 * WARN_FACTOR ? 'warn' : 'ok';
    const diff = `${p95Ref(id)} - ${baselineRef(id, 'p95')}`;
    rows.push([
      ident(id),
      cell([ctx.num(baselineRef(id, 'p95'), 'int')]),
      cell([ctx.num(p95Ref(id), 'int')], tone),
      cell([ctx.num(diff, 'signedInt')], tone),
      cell([ctx.numOrDash(`(${diff}) / ${baselineRef(id, 'p95')}`, 'signedPct')], tone),
      cell([ctx.num(baselineRef(id, 'p99'), 'int')]),
      cell([ctx.num(stepRef('http_req_duration', id, 'p(99)'), 'int')]),
      cell([ctx.num(baselineRef(id, 'errorRate'), 'pct')]),
      stat.errorRate === null ? dash() : cell([ctx.numOrDash(rateRef('http_req_failed', id), 'pct')]),
    ]);
  }
  const heads = ['Step', 'p95 baseline (ms)', 'p95 now (ms)', 'p95 change (ms)', 'p95 change %', 'p99 baseline (ms)', 'p99 now (ms)', 'Failed baseline', 'Failed now'];
  return {
    id: 'baseline',
    title,
    blocks: [
      { kind: 'text', parts: [`Baseline: run ${baseline.runId}, accepted ${baseline.acceptedAt.slice(0, 10)}, as copied into this run’s meta.json when it finished. Red is a regression the flags catch; amber is slower but inside the flag limits.`] },
      { kind: 'table', head: heads.map((label, i) => ({ label, right: i > 0 })), rows },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// automatic flags
// ---------------------------------------------------------------------------------------------------------------

const FLAG_MEANING: Record<Flag['code'], string> = {
  ERRORS: 'Too many requests failed.',
  CHECKS: 'Too many responses did not have the expected content.',
  P95_REGRESSION: 'The step got slower than the accepted baseline.',
  DB_HOT: 'The database was busy during the steady state.',
};

function flagRows(ctx: Ctx, flag: Flag): Cell[][] {
  const { baseline } = ctx.model;
  const code = ident(flag.code);
  const meaning = text(FLAG_MEANING[flag.code]);
  const id = flag.step!;
  const base = (field: string, fmt: 'pct' | 'int'): Cell => (baseline?.steps[id] ? cell([ctx.num(baselineRef(id, field), fmt)]) : dash());
  switch (flag.code) {
    case 'ERRORS':
      return [[code, ident(id), text('failed requests (http_req_failed)'), cell([ctx.num(rateRef('http_req_failed', id), 'pct')], 'bad'), base('errorRate', 'pct'), cell([ctx.num(ruleRef('flags', 'errorRate'), 'pct')]), meaning]];
    case 'CHECKS':
      return [[code, ident(id), text('failed checks (checks)'), cell([ctx.num(`1 - ${rateRef('checks', id)}`, 'pct')], 'bad'), dash(), cell([ctx.num(ruleRef('flags', 'checkFailureRate'), 'pct')]), meaning]];
    case 'P95_REGRESSION': {
      const b = baselineRef(id, 'p95');
      return [[code, ident(id), text('p95 (http_req_duration)'), cell([ctx.num(p95Ref(id), 'int')], 'bad'), base('p95', 'int'), cell([ctx.num(`max(${ruleRef('flags', 'p95Factor')} * ${b}, ${b} + ${ruleRef('flags', 'p95AddMs')})`, 'int')]), meaning]];
    }
    case 'DB_HOT': {
      const { dbHoldAvg, meta } = ctx.model;
      const hold = meta.profile.holdWindow!;
      const rows: Cell[][] = [];
      for (const [field, label, average] of [['cpu', 'database CPU, average over the steady state', dbHoldAvg?.cpu], ['dataIo', 'database data IO, average over the steady state', dbHoldAvg?.dataIo]] as const) {
        if (average === undefined || !(average > ctx.model.rules.flags.dbPct)) continue;
        const samples = source('db.json', 'resource', window('t', hold.fromSec, hold.toSec, true), field);
        rows.push([code, dash(), text(label), cell([ctx.num(`avg(${samples})`, 'pctPoints')], 'bad'), dash(), cell([ctx.num(ruleRef('flags', 'dbPct'), 'pctPoints')]), meaning]);
      }
      return rows;
    }
  }
}

export function flagsSection(ctx: Ctx): Section {
  const { flags } = ctx.model;
  const blocks: Block[] = [];
  if (flags.length === 0) {
    blocks.push({ kind: 'text', parts: ['No automatic flags were raised.'] });
  } else {
    blocks.push({
      kind: 'table',
      head: ['Flag', 'Step', 'Measure', 'Value', 'Baseline', 'Limit', 'What it means'].map((label, i) => ({ label, right: i >= 3 && i <= 5 })),
      rows: flags.flatMap((flag) => flagRows(ctx, flag)),
    });
  }
  blocks.push({ kind: 'sub', title: 'How the flags work' });
  const limit = (...parts: Cell['parts']): Cell => cell(parts);
  blocks.push({
    kind: 'table',
    head: [{ label: 'Flag' }, { label: 'Raised when' }, { label: 'Limit' }],
    rows: [
      [ident('ERRORS'), text('a step’s share of failed requests (http_req_failed) is above the limit'), limit(ctx.num(ruleRef('flags', 'errorRate'), 'pct'))],
      [ident('CHECKS'), text('a step’s share of failed content checks (checks) is above the limit'), limit(ctx.num(ruleRef('flags', 'checkFailureRate'), 'pct'))],
      [
        ident('P95_REGRESSION'),
        text('a step’s p95 is above its baseline by more than both limits'),
        limit(ctx.num(`${ruleRef('flags', 'p95Factor')} - 1`, 'pct'), ' and ', ctx.num(ruleRef('flags', 'p95AddMs'), 'int'), ' ms'),
      ],
      [
        ident('DB_HOT'),
        text('database CPU or data IO averages above the limit over the steady state'),
        ctx.model.meta.database === 'none' ? text('not applicable (no database access)') : limit(ctx.num(ruleRef('flags', 'dbPct'), 'pctPoints')),
      ],
    ],
  });
  return { id: 'flags', title: 'Automatic flags', blocks };
}
