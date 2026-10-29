// Sections 1 and 2 of the report: the verdict, and what ran.

import type { RunWorkload, VerdictName } from './model.js';
import { describeSecretScan } from '../secretScan.js';
import { source } from './sources.js';
import { cell, Ctx, DASH, DURATION_SEC, ident, text, utcMinute, type Block, type Cell, type Part, type Section, type Tone } from './viewCore.js';

const VERDICT_TONE: Record<VerdictName, Tone> = { PASS: 'ok', DEGRADED: 'warn', FAIL: 'bad', 'NO BASELINE': 'info', INVALID: 'invalid' };

/** One line per verdict: what it says about the run. */
export const VERDICT_MEANING: Record<VerdictName, string> = {
  PASS: 'No automatic flag was raised and the run completed cleanly.',
  DEGRADED: 'Worse than the baseline: at least one automatic flag was raised.',
  FAIL: 'k6 failed or was stopped, the run was aborted or interrupted, cleanup left rows behind, or an explicit target was missed.',
  'NO BASELINE': 'First run for this environment and profile: numbers only, nothing to compare with yet.',
  INVALID: 'The app was redeployed mid-run, or the busy check was overridden: the numbers may mix two builds or other people’s load.',
};

const VERDICT_LEAD: Record<VerdictName, string> = {
  PASS: 'Nothing here is worse than the accepted baseline, and the run completed cleanly.',
  DEGRADED: 'Some numbers are worse than the baseline. Automatic flags below say which.',
  FAIL: 'The run did not finish cleanly, or a target was missed. The reasons are listed here.',
  'NO BASELINE': 'There is no accepted baseline for this environment and profile yet, so these numbers stand alone.',
  INVALID: 'Do not rely on these numbers: something outside the test changed them.',
};

const VERDICT_ORDER: VerdictName[] = ['PASS', 'DEGRADED', 'FAIL', 'NO BASELINE', 'INVALID'];

/**
 * What the step table says about data: a feature that writes only claims cleanup when row counts follow below, or when it
 * declared that the app removes what it writes (then it says exactly that, and makes no row-count claim).
 */
function writesNote(workload: RunWorkload, hasRowCounts: boolean): string {
  if (workload.readOnly) return 'Read-only: the journeys only read; they create, change or delete nothing.';
  const pruned = workload.writes ?? [];
  if (!hasRowCounts && pruned.length > 0 && pruned.every((w) => w.cleanup === 'app')) {
    return `This feature writes data (${pruned.map((w) => w.request).join(', ')}): the app prunes these rows; nothing for the runner to clean up.`;
  }
  return hasRowCounts
    ? 'This feature writes data; the row counts below show whether it was removed afterwards.'
    : 'This feature writes data, but no row counts were collected, so nothing proves it was removed afterwards.';
}

export function verdictSection(ctx: Ctx): Section {
  const { meta, verdict } = ctx.model;
  const notes: string[] = [];
  if (meta.profile.type === 'smoke') {
    notes.push('This is a smoke run: each journey ran once to prove the script works. Its timings are single samples, not a measurement of the system.');
  }
  if (meta.guardrails.windowOverride) {
    notes.push('The load window was overridden (--override-window): this run may have shared the environment with working-hours traffic.');
  }
  const legend: Block = {
    kind: 'details',
    summary: 'What each verdict means',
    blocks: [
      {
        kind: 'table',
        head: [{ label: 'Verdict' }, { label: 'What it means' }],
        rows: VERDICT_ORDER.map((name) => [
          { parts: [name], cls: 'id', ...(name === verdict.verdict ? { tone: VERDICT_TONE[name] } : {}) },
          text(VERDICT_MEANING[name], name === verdict.verdict ? VERDICT_TONE[name] : undefined),
        ]),
      },
    ],
  };
  return {
    id: 'verdict',
    title: 'Verdict',
    blocks: [{ kind: 'verdict', verdict: verdict.verdict, lead: VERDICT_LEAD[verdict.verdict], reasons: verdict.reasons, notes }, legend],
  };
}

export const verdictTone = (name: VerdictName): Tone => VERDICT_TONE[name];

function profileParts(ctx: Ctx): Part[] {
  const { profile } = ctx.model.meta;
  const at = (...path: (string | number)[]): string => source('meta.json', 'profile', ...path);
  switch (profile.type) {
    case 'smoke':
      return ['smoke: each journey once'];
    case 'stress': {
      const parts: Part[] = ['stress: arrival rate stages of '];
      (profile.stages ?? []).forEach((_, i) => {
        if (i > 0) parts.push(', ');
        parts.push(ctx.num(at('stages', i, 'rps'), 'dec2'));
      });
      parts.push(' req/s');
      return parts;
    }
    default: {
      const parts: Part[] = [`${profile.type}: `];
      if (profile.users !== undefined) parts.push(ctx.num(at('users'), 'int'), ' users');
      if (profile.rampSec !== undefined) parts.push(', ramp-up ', ctx.num(at('rampSec'), 'dur'));
      if (profile.holdSec !== undefined) parts.push(', steady state ', ctx.num(at('holdSec'), 'dur'));
      if (profile.rampDownSec !== undefined) parts.push(', ramp-down ', ctx.num(at('rampDownSec'), 'dur'));
      return parts;
    }
  }
}

function overrides(ctx: Ctx): Cell {
  const { guardrails } = ctx.model.meta;
  const used = [
    guardrails.allowMax ? '--allow-max (sizes above the environment defaults)' : null,
    guardrails.windowOverride ? '--override-window (outside the load window)' : null,
    guardrails.busyOverride ? '--override-busy (database was busy)' : null,
  ].filter((o): o is string => o !== null);
  return used.length === 0 ? text('none') : text(used.join('; '), guardrails.busyOverride || guardrails.windowOverride ? 'bad' : 'warn');
}

/** `meta.json#abort.<path>`: an abort limit the run applied, or the project's default for it, as recorded in its meta.json. */
const abortRef = (...path: string[]): string => source('meta.json', 'abort', ...path);

const LIMITS = [
  { key: 'errorRate', label: 'Error rate (k6 threshold)', fmt: 'pct', unit: '' },
  { key: 'p95Ms', label: 'p95 of all requests (k6 threshold)', fmt: 'int', unit: ' ms' },
  { key: 'dbCpuOrIoPct', label: 'Database CPU or data IO (the runner stops the run)', fmt: 'pctPoints', unit: '' },
] as const;

const LIMITS_NOTE =
  'A limit from the feature or from a run option is a deliberate change from the project default. They can only tighten the error-rate and database limits; the p95 limit can be raised.';
const NO_DATABASE_NOTE = 'This project has no database access, so nothing watches a database: no busy check before a load run and no database abort.';

/**
 * The limits that would have aborted the run, with where each came from and what the project's default is. A feature or a run
 * option can change them (R34), so a limit that is not the project's is marked. Nothing for a run folder that recorded none.
 */
function limitsApplied(ctx: Ctx): Block[] {
  const abort = ctx.model.meta.abort;
  if (!abort?.projectDefault) return [];
  // Without database access nothing watches the database: its abort limit and the busy check do not apply to this run.
  const noDatabase = ctx.model.meta.database === 'none';
  const notApplicable = (label: string): Cell[] => [text(label), text('not applicable'), text('no database access'), text(DASH)];
  const rows: Cell[][] = LIMITS.map(({ key, label, fmt, unit }) => {
    if (noDatabase && key === 'dbCpuOrIoPct') return notApplicable(label);
    const from = abort.source[key];
    if (from === undefined || abort[key] === undefined) return [text(label), text('not set'), text(DASH), text(DASH)];
    return [
      text(label),
      cell([ctx.num(abortRef(key), fmt), unit]),
      from === 'project' ? text(from) : text(from, 'warn'),
      // R45: a project may leave the database limit out and let a feature or a run option set it.
      abort.projectDefault[key] === undefined ? text(DASH) : cell([ctx.num(abortRef('projectDefault', key), fmt), unit]),
    ];
  });
  if (noDatabase) rows.push(notApplicable('Busy check before a load run (database CPU or data IO)'));
  return [
    { kind: 'sub', title: 'Limits applied' },
    {
      kind: 'table',
      head: [{ label: 'Limit' }, { label: 'Value', right: true }, { label: 'Source' }, { label: 'Project default', right: true }],
      rows,
      note: [noDatabase ? `${LIMITS_NOTE} ${NO_DATABASE_NOTE}` : LIMITS_NOTE],
    },
  ];
}

export function whatRanSection(ctx: Ctx): Section {
  const { meta, db, journeys, workload, liveFallback, summary } = ctx.model;
  const k6 = meta.k6;
  const dbLine = db
    ? [db.tier, db.edition].filter(Boolean).join(' ') || 'database (tier not reported)'
    : meta.database === 'none'
      ? 'no database evidence (this project has no database access)'
      : 'no database evidence';
  const exit: Part[] =
    k6.exitCode === null
      ? [k6.signal ? `k6 was stopped by ${k6.signal}` : 'k6 did not finish']
      : ['exit code ', ctx.num(source('meta.json', 'k6', 'exitCode'), 'int')];
  const fingerprint = meta.fingerprint.changed
    ? text(`${meta.fingerprint.before.appMain ?? 'unknown'} → ${meta.fingerprint.after.appMain ?? 'unknown'}: the app or API was redeployed during the run`, 'bad')
    : { parts: [meta.fingerprint.after.appMain ?? 'not readable'], cls: 'id' as const };

  const facts: { label: string; value: Cell }[] = [
    { label: 'Project', value: ident(meta.project) },
    { label: 'Feature', value: ident(meta.feature) },
    { label: 'Environment', value: ident(meta.env) },
    { label: 'Database', value: ident(dbLine) },
    { label: 'Load machine', value: ident(`${meta.loadMachine.host} (${meta.loadMachine.platform})`) },
    { label: 'k6 version', value: ident(meta.k6Version) },
    { label: 'Profile', value: cell(profileParts(ctx)) },
    { label: 'Duration', value: summary ? cell([ctx.num(DURATION_SEC, 'dur')]) : text(`${DASH} (k6 wrote no summary.json)`) },
    { label: 'Started', value: ident(utcMinute(meta.startedAt)) },
    { label: 'Git commit', value: ident(`${meta.git.commit?.slice(0, 12) ?? 'unknown'}${meta.git.dirty ? ' + uncommitted changes' : ''}`) },
    { label: 'App build', value: fingerprint },
    { label: 'k6 result', value: cell(exit) },
    { label: 'Script errors', value: cell([ctx.num(source('meta.json', 'k6', 'scriptErrors'), 'int')]) },
    { label: 'Guardrail overrides', value: overrides(ctx) },
    {
      label: 'Report built from',
      value:
        liveFallback.length === 0
          ? text('this run folder alone: the baseline slot, flag limits and workload terms were recorded with the run')
          : text(
              `this run folder, and the current files for ${liveFallback.join(', ')}: the folder predates the snapshot, so this report can differ from the one written when the run finished`,
              'warn',
            ),
    },
  ];
  if (meta.secretScan && !meta.secretScan.ok) {
    facts.push({ label: 'Secret scan', value: text(describeSecretScan(meta.secretScan), 'bad') });
  }
  if (meta.dbGuard) {
    facts.push({
      label: 'Database guard',
      value: text(`the abort watch had trouble reading the database${meta.dbGuard.blindStop ? ' and stopped the run' : ''}${meta.dbGuard.lastError ? ` (${meta.dbGuard.lastError})` : ''}`, 'warn'),
    });
  }

  const blocks: Block[] = [
    { kind: 'facts', rows: facts },
    ...limitsApplied(ctx),
    { kind: 'sub', title: 'What the test does' },
    {
      kind: 'table',
      head: [{ label: 'Journey' }, { label: 'Role' }, { label: 'Step' }, { label: 'Request' }],
      rows: journeys.flatMap((j) => j.steps.map((s) => [ident(j.name), text(j.role), ident(s.id), s.request ? ident(s.request) : text(DASH)])),
      ...(workload
        ? { note: [writesNote(workload, meta.cleanup !== undefined)] }
        : {}),
    },
  ];

  const cleanup = meta.cleanup;
  if (cleanup) {
    const tables = [...new Set([...Object.keys(cleanup.before), ...Object.keys(cleanup.after ?? {})])];
    blocks.push({ kind: 'sub', title: 'Row counts before and after' });
    blocks.push({
      kind: 'table',
      head: [{ label: 'Table' }, { label: 'Before', right: true }, { label: 'After', right: true }],
      rows: tables.map((table) => {
        const same = cleanup.after !== null && cleanup.before[table] === cleanup.after[table];
        const tone: Tone | undefined = cleanup.after === null ? 'bad' : same ? 'ok' : 'bad';
        return [
          ident(table),
          Object.hasOwn(cleanup.before, table) ? cell([ctx.num(source('meta.json', 'cleanup', 'before', table), 'int')], tone) : text(DASH, tone),
          cleanup.after !== null && Object.hasOwn(cleanup.after, table) ? cell([ctx.num(source('meta.json', 'cleanup', 'after', table), 'int')], tone) : text(DASH, tone),
        ];
      }),
      note: [
        cleanup.ok
          ? 'Row counts are equal before and after: the run left no rows behind.'
          : `Row counts differ or could not be read after the run, so cleanup is not proven${cleanup.error ? ` (${cleanup.error})` : ''}.`,
      ],
    });
  }
  return { id: 'what-ran', title: 'What ran', blocks };
}
