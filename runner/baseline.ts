// A feature's accepted baseline: `<feature dir>/baseline.json`, keyed by env and then profile. Each slot holds the run it
// came from and the per-step numbers later runs are compared with. The report reads it here (loadBaseline); `perf baseline
// accept` writes it (acceptBaseline) and `perf compare` sets two runs side by side (compareRuns).
//
//   { "staging": { "load": { "runId": …, "acceptedAt": …, "steps": { "analyst.grid_open": { "p50": …, "p95": …, "p99": …, "errorRate": …, "rps": … } } } } }

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadFeature, loadProject, type Feature } from './config.js';
import { buildReportModel, writeAtomic, type BuildOptions, type ReportModel } from './report/build.js';
import { FORMATS } from './report/formats.js';
import type { BaselineSlot } from './report/model.js';

export const BASELINE_FILE = 'baseline.json';

const STEP_FIELDS = ['p50', 'p95', 'p99', 'errorRate', 'rps'] as const;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The parsed baseline.json of a feature folder, or undefined when it has none.
 * @throws {Error} when the file is not valid JSON
 */
export async function readBaselineFile(featureDir: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(join(featureDir, BASELINE_FILE), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${BASELINE_FILE} is not valid JSON in ${featureDir}: ${(err as Error).message}`);
  }
}

/** The slot's shape, field by field, with the slot named in every message. */
function checkSlot(slot: unknown, where: string): BaselineSlot {
  if (!isObject(slot)) throw new Error(`${BASELINE_FILE}: ${where} must be an object`);
  for (const field of ['runId', 'acceptedAt'] as const) {
    if (typeof slot[field] !== 'string') throw new Error(`${BASELINE_FILE}: ${where} has no ${field} (a string)`);
  }
  const steps = slot.steps;
  if (!isObject(steps)) throw new Error(`${BASELINE_FILE}: ${where}.steps must be an object keyed by step id`);
  for (const [id, entry] of Object.entries(steps)) {
    if (!isObject(entry)) throw new Error(`${BASELINE_FILE}: ${where}.steps[${JSON.stringify(id)}] must be an object`);
    for (const field of STEP_FIELDS) {
      if (typeof entry[field] !== 'number' || !Number.isFinite(entry[field])) {
        throw new Error(`${BASELINE_FILE}: ${where}.steps[${JSON.stringify(id)}].${field} must be a number`);
      }
    }
  }
  return slot as unknown as BaselineSlot;
}

/**
 * The slot for an env and profile in an already-read baseline.json, or undefined when there is none.
 * @throws {Error} when the file or the slot is malformed (the message names the slot)
 */
export function pickBaselineSlot(file: unknown, env: string, profile: string): BaselineSlot | undefined {
  if (file === undefined) return undefined;
  if (!isObject(file)) throw new Error(`${BASELINE_FILE} must be an object keyed by env`);
  const byProfile = Object.hasOwn(file, env) ? file[env] : undefined;
  if (byProfile === undefined) return undefined;
  if (!isObject(byProfile)) throw new Error(`${BASELINE_FILE}: [${JSON.stringify(env)}] must be an object keyed by profile`);
  if (!Object.hasOwn(byProfile, profile)) return undefined;
  return checkSlot(byProfile[profile], `[${JSON.stringify(env)}][${JSON.stringify(profile)}]`);
}

/**
 * The baseline slot for an env and profile, or undefined when the feature has no baseline.json or no slot there.
 * @throws {Error} when baseline.json is not valid JSON, or the slot is malformed (the message names the slot)
 */
export async function loadBaseline(featureDir: string, env: string, profile: string): Promise<BaselineSlot | undefined> {
  return pickBaselineSlot(await readBaselineFile(featureDir), env, profile);
}

// ---------------------------------------------------------------------------------------------------------------
// accept
// ---------------------------------------------------------------------------------------------------------------

/** The run cannot be a baseline (the command line reports it as a refusal, exit code 2). */
export class BaselineRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineRefusedError';
  }
}

export interface AcceptOptions extends BuildOptions {
  /** The time recorded as `acceptedAt` (tests). */
  now?: () => Date;
}

/**
 * Make a run the reference for its feature, env and profile: the numbers of its own folder (via the report model, so they are
 * the ones its report shows) go to `[env][profile]` of the feature's baseline.json. The other slots stay as they are; the file
 * is replaced atomically. A step with no data (no requests, or no error rate) is left out.
 *
 * Refuses a smoke run (single samples) and a FAIL or INVALID run. A DEGRADED run is accepted (the message names the verdict).
 * No report is re-rendered: each run's report keeps the baseline it was judged against (meta.baseline).
 * @returns one line that says what was written and where
 * @throws {BaselineRefusedError} `cannot accept a smoke run as baseline`, `cannot accept a <VERDICT> run as baseline` for FAIL
 *   and INVALID, or when the run has no step numbers
 * @throws {Error} when baseline.json is not valid JSON or not shaped as env -> profile -> slot (nothing is written)
 * @throws {ConfigError} when the run's project or feature no longer exists
 */
export async function acceptBaseline(runDir: string, opts: AcceptOptions = {}): Promise<string> {
  const model = await buildReportModel(runDir, opts);
  const { meta, verdict } = model;
  if (meta.profile.type === 'smoke') {
    throw new BaselineRefusedError(`cannot accept a smoke run as baseline: its timings are single samples (run ${meta.runId}); accept a load run`);
  }
  if (verdict.verdict === 'FAIL' || verdict.verdict === 'INVALID') {
    throw new BaselineRefusedError(`cannot accept a ${verdict.verdict} run as baseline (${verdict.reasons.join('; ')})`);
  }
  const steps: BaselineSlot['steps'] = {};
  for (const s of model.steps) {
    if (s.errorRate === null) continue;
    steps[s.id] = { p50: s.p50, p95: s.p95, p99: s.p99, errorRate: s.errorRate, rps: s.rps };
  }
  const count = Object.keys(steps).length;
  if (count === 0) throw new BaselineRefusedError(`run ${meta.runId} has no per-step numbers to accept as baseline`);

  const feature: Feature = opts.feature ?? (await loadFeature(opts.project ?? (await loadProject(meta.project)), meta.feature));
  const file = join(feature.dir, BASELINE_FILE);
  const existing = (await readBaselineFile(feature.dir)) ?? {};
  if (!isObject(existing)) throw new Error(`${BASELINE_FILE} must be an object keyed by env`);
  const env = meta.env;
  const profile = meta.profile.type;
  const byProfile = Object.hasOwn(existing, env) ? existing[env] : undefined;
  if (byProfile !== undefined && !isObject(byProfile)) {
    throw new Error(`${BASELINE_FILE}: [${JSON.stringify(env)}] must be an object keyed by profile`);
  }
  const previous = byProfile !== undefined && Object.hasOwn(byProfile, profile) ? byProfile[profile] : undefined;
  const replaced = isObject(previous) && typeof previous.runId === 'string' ? previous.runId : undefined;

  const slot: BaselineSlot = { runId: meta.runId, acceptedAt: (opts.now?.() ?? new Date()).toISOString(), steps };
  // Spread and computed keys define own properties, so an env or profile named like an Object.prototype key is plain data.
  const next = { ...existing, [env]: { ...byProfile, [profile]: slot } };
  await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);

  return (
    `baseline for ${env}/${profile} of ${meta.project}/${meta.feature} is now run ${meta.runId} ` +
    `(verdict ${verdict.verdict}, ${count} step${count === 1 ? '' : 's'})${replaced ? `, replacing ${replaced}` : ''}: ${file}`
  );
}

// ---------------------------------------------------------------------------------------------------------------
// compare
// ---------------------------------------------------------------------------------------------------------------

const NO_VALUE = '–';

/** `+25.0%`, `-3.2%`, `0.0%`; a dash when A has no positive p95 to compare with. */
function deltaPct(a: number, b: number): string {
  if (!(a > 0)) return NO_VALUE;
  const delta = Math.round(((b - a) / a) * 1000) / 10 + 0; // + 0: no negative zero
  return `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;
}

const runLine = (label: string, model: ReportModel): string =>
  `${label}: ${model.meta.runId} (${model.meta.project}/${model.meta.feature}, ${model.meta.env}, ${model.meta.profile.type}, verdict ${model.verdict.verdict})`;

/** What differs between the two runs that makes their numbers unlike (empty when they are alike). */
function unlike(a: ReportModel, b: ReportModel): string[] {
  const fields: [string, (m: ReportModel) => string][] = [
    ['project', (m) => m.meta.project],
    ['feature', (m) => m.meta.feature],
    ['env', (m) => m.meta.env],
    ['profile', (m) => m.meta.profile.type],
  ];
  return fields.filter(([, pick]) => pick(a) !== pick(b)).map(([name, pick]) => `${name} (${pick(a)}, ${pick(b)})`);
}

/**
 * Two runs side by side: a Markdown table `step | p95 A | p95 B | Δ%` (Δ% = (B - A) / A, one decimal, from the p95 values the
 * reports show), headed by one line per run, and a note when the runs differ in project, feature, env or profile. A step only one
 * run measured has a dash for the other. Steps come in A's journey order, then B's own.
 * @throws {NotARunFolderError} when a folder has no meta.json
 */
export async function compareRuns(dirA: string, dirB: string, opts: BuildOptions = {}): Promise<string> {
  const [a, b] = [await buildReportModel(dirA, opts), await buildReportModel(dirB, opts)];
  const p95A = new Map(a.steps.map((s) => [s.id, s.p95]));
  const p95B = new Map(b.steps.map((s) => [s.id, s.p95]));
  const ids = [...new Set([...a.steps.map((s) => s.id), ...b.steps.map((s) => s.id)])];

  const ms = (value: number | undefined): string => (value === undefined ? NO_VALUE : `${FORMATS.int(value)} ms`);
  const lines = [runLine('A', a), runLine('B', b)];
  const differences = unlike(a, b);
  if (differences.length > 0) lines.push(`note: the runs differ in ${differences.join(', ')}; the numbers are not like for like`);
  lines.push('', '| step | p95 A | p95 B | Δ% |', '| --- | ---: | ---: | ---: |');
  for (const id of ids) {
    const [x, y] = [p95A.get(id), p95B.get(id)];
    lines.push(`| ${id} | ${ms(x)} | ${ms(y)} | ${x === undefined || y === undefined ? NO_VALUE : deltaPct(x, y)} |`);
  }
  return lines.join('\n');
}
