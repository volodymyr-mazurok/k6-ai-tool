// A run folder -> the report: read the files, compute the verdict (report/model.ts), render report.html and report.md
// (report/render.ts), write them, and record the outcome in meta.json. Also the check that every number on the page
// traces back to a file (`perf report <dir> --verify-sources`).
//
// A report is built from its run folder alone: meta.json carries the baseline slot the run was judged against, the limits
// that decide its flags and breaking point, and the workload terms (all copied there when the run finished, see run.ts);
// k6-config.json carries the journeys. Only a folder recorded before that snapshot existed falls back to the current feature
// files, and its report says so under "What ran".

import { randomUUID } from 'node:crypto';
import { readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadBaseline } from '../baseline.js';
import { ConfigError, loadFeature, loadProject, type Feature, type Project, type Workload } from '../config.js';
import type { DbEvidence } from '../dbPhase.js';
import type { RunConfig, RunMeta } from '../run.js';
import type { Timeseries } from '../timeseries.js';
import {
  BREAKING_LIMITS,
  FLAG_LIMITS,
  computeFlags,
  computeVerdict,
  crossedThresholds,
  dbHoldAverage,
  findBreakingPoint,
  stepStats,
  targetsMissed,
  type BaselineSnapshot,
  type BreakingPoint,
  type DbHoldAvg,
  type Flag,
  type K6Summary,
  type ReportRules,
  type RunWorkload,
  type StepStat,
  type Verdict,
} from './model.js';
import { renderHtml, renderMarkdown } from './render.js';
import type { Sources } from './sources.js';
import { verifyHtml } from './verify.js';

/** The folder has no meta.json, so it is not a run folder (the command line reports it as a usage problem). */
export class NotARunFolderError extends Error {
  constructor(runDir: string) {
    super(`${runDir} is not a run folder: it has no meta.json`);
    this.name = 'NotARunFolderError';
  }
}

export interface BuildOptions {
  /**
   * The current project and feature. Read only for an older run folder that lacks the snapshot (the runner passes the ones it
   * ran; otherwise they are loaded by the names in meta.json).
   */
  project?: Project;
  feature?: Feature;
}

export interface ReportJourney {
  name: string;
  key: string;
  role: string;
  steps: { name: string; /** `<journey key>.<step>` */ id: string; /** `METHOD /route`, when known */ request?: string }[];
}

/** What an older run folder took from the current files, in the order the report lists them. */
export type LiveFallback = 'baseline' | 'limits' | 'workload terms' | 'journeys';

export interface ReportModel {
  runDir: string;
  /** meta.json as recorded, with whatever an older folder lacked filled in from the current files (see `liveFallback`). */
  meta: RunMeta;
  /** The parsed files every `data-src` of the page points into: the run folder's own, nothing else. */
  sources: Sources;
  summary?: K6Summary;
  timeseries: Timeseries;
  db?: DbEvidence;
  /** The baseline slot the run was judged against (`meta.baseline`); absent when it had none. */
  baseline?: BaselineSnapshot;
  /** The limits that decide the flags and the breaking point (`meta.rules`). */
  rules: ReportRules;
  /** The workload terms and request lines (`meta.workload`); absent only for an older folder whose feature cannot be found. */
  workload?: RunWorkload;
  journeys: ReportJourney[];
  /** What this folder lacked and the current files had to supply; empty for a folder recorded with the snapshot. */
  liveFallback: LiveFallback[];
  /** How the script signed in (k6-config.json `auth.type`); absent for a folder without k6-config.json. */
  authType?: RunConfig['auth']['type'];
  findings?: string;
  /** Files of the run folder worth linking, in a fixed order. */
  files: string[];
  /** The span the summary's counts cover, seconds; 0 when k6 wrote no summary. */
  durationSec: number;
  /** `<journey key>.<step>` for every journey step, in journey order. */
  stepIds: string[];
  steps: StepStat[];
  targets: Workload['targets'];
  dbHoldAvg?: DbHoldAvg;
  flags: Flag[];
  targetsMissed: string[];
  verdict: Verdict;
  /** Stress runs only: null when every stage held. */
  breakingPoint?: BreakingPoint | null;
}

/** The files a run folder can hold, in the order the report lists them. */
const FILE_ORDER = ['report.html', 'report.md', 'findings.md', 'summary.json', 'timeseries.json', 'points.json.gz', 'k6-dashboard.html', 'k6-config.json', 'k6.log', 'db.json', 'meta.json'];

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
}

async function readJson(runDir: string, name: string): Promise<unknown> {
  const text = await readText(join(runDir, name));
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${name} is not valid JSON (${(err as Error).message})`);
  }
}

/** The current feature of the run, or undefined when the project or feature no longer exists. */
async function currentFeature(meta: RunMeta, opts: BuildOptions): Promise<Feature | undefined> {
  if (opts.feature) return opts.feature;
  try {
    return await loadFeature(opts.project ?? (await loadProject(meta.project)), meta.feature);
  } catch (err) {
    if (err instanceof ConfigError) return undefined;
    throw err;
  }
}

const requestsOf = (feature: Feature): Record<string, string> =>
  Object.fromEntries(feature.journeys.flatMap((j) => j.steps.map((s) => [`${j.key}.${s.name}`, `${s.method} ${s.route}`])));

/** The run's journeys: k6-config.json (written with the run), else the current feature, else nothing to build a report on. */
function journeysOf(config: unknown, requests: Record<string, string> | undefined): ReportJourney[] | undefined {
  const list = (config as Partial<RunConfig> | undefined)?.journeys;
  if (!Array.isArray(list)) return undefined;
  return list.map((j) => ({
    name: j.name,
    key: j.key,
    role: j.role,
    steps: j.steps.map((s) => ({ name: s.name, id: `${j.key}.${s.name}`, ...(requests?.[`${j.key}.${s.name}`] ? { request: requests[`${j.key}.${s.name}`] } : {}) })),
  }));
}

/**
 * The run's files, parsed. `meta` is the recorded meta.json plus, for an older folder only, what the current files supply
 * for the baseline, the limits and the workload terms (listed in `liveFallback`); it is also what `data-src` points into,
 * so the build and the check (`verifyRunReport`) see the same numbers.
 */
async function loadRun(runDir: string, opts: BuildOptions) {
  const recorded = await readJson(runDir, 'meta.json');
  if (recorded === undefined) throw new NotARunFolderError(runDir);
  const meta = structuredClone(recorded) as RunMeta;
  const [summaryRaw, timeseriesRaw, dbRaw, configRaw] = await Promise.all([
    readJson(runDir, 'summary.json'),
    readJson(runDir, 'timeseries.json'),
    readJson(runDir, 'db.json'),
    readJson(runDir, 'k6-config.json'),
  ]);

  const liveFallback: LiveFallback[] = [];
  let live: Feature | undefined;
  let liveLoaded = false;
  const feature = async (): Promise<Feature | undefined> => {
    if (!liveLoaded) {
      live = await currentFeature(meta, opts);
      liveLoaded = true;
    }
    return live;
  };

  if (meta.baseline === undefined) {
    liveFallback.push('baseline');
    const current = await feature();
    const slot = current ? await loadBaseline(current.dir, meta.env, meta.profile.type) : undefined;
    meta.baseline = slot ? { env: meta.env, profile: meta.profile.type, ...slot } : null;
  }
  if (meta.rules === undefined) {
    liveFallback.push('limits');
    meta.rules = { flags: { ...FLAG_LIMITS }, breaking: { ...BREAKING_LIMITS } };
  }
  if (meta.workload === undefined) {
    liveFallback.push('workload terms');
    const current = await feature();
    if (current) {
      const { businessUnit, businessAction, thinkTime } = current.workload;
      meta.workload = { businessUnit, businessAction, thinkTime, readOnly: current.readOnly, requests: requestsOf(current) };
      if (current.writes) meta.workload.writes = current.writes.map((w) => ({ request: `${w.method} ${w.route}`, cleanup: w.cleanup }));
    }
  }
  let journeys = journeysOf(configRaw, meta.workload?.requests);
  if (!journeys) {
    liveFallback.push('journeys');
    const current = await feature();
    if (!current) throw new Error('the journeys of this run are unknown: it has no k6-config.json and its feature files cannot be found');
    journeys = journeysOf({ journeys: current.journeys }, requestsOf(current))!;
  }

  const sources: Sources = { 'meta.json': meta };
  if (summaryRaw !== undefined) sources['summary.json'] = summaryRaw;
  if (timeseriesRaw !== undefined) sources['timeseries.json'] = timeseriesRaw;
  if (dbRaw !== undefined) sources['db.json'] = dbRaw;
  const authType = (configRaw as Partial<RunConfig> | undefined)?.auth?.type;
  return { meta, sources, summaryRaw, timeseriesRaw, dbRaw, journeys, liveFallback, authType };
}

/**
 * Everything the report shows, computed from the run folder. A run that left no summary.json (k6 killed) still gets a model:
 * no steps, and a FAIL verdict from what meta.json records.
 * @throws {NotARunFolderError} when the folder has no meta.json
 * @throws {Error} when a file is not valid JSON, baseline.json (read only for an older folder) holds a malformed slot, a step
 *   lacks p50/p95/p99, or the journeys of the run cannot be found
 */
export async function buildReportModel(runDir: string, opts: BuildOptions = {}): Promise<ReportModel> {
  const { meta, sources, summaryRaw, timeseriesRaw, dbRaw, journeys, liveFallback, authType } = await loadRun(runDir, opts);
  const summary = summaryRaw as K6Summary | undefined;
  const timeseries = (timeseriesRaw as Timeseries | undefined) ?? { bucketSec: 15, origin: null, buckets: [] };
  const db = dbRaw as DbEvidence | undefined;
  const baseline = meta.baseline ?? undefined;
  const rules = meta.rules!;
  const findings = await readText(join(runDir, 'findings.md'));
  const targets = meta.targets ?? 'baseline';

  const durationMs = summary?.state?.testRunDurationMs;
  const durationSec = durationMs !== undefined && durationMs > 0 ? durationMs / 1000 : 0;
  const stepIds = journeys.flatMap((j) => j.steps.map((s) => s.id));
  const steps = summary && durationSec > 0 ? stepStats(summary, stepIds, durationSec) : [];

  const dbHoldAvg = dbHoldAverage(db, meta.profile.holdWindow);
  const flags = computeFlags({ steps, baseline, dbHoldAvg, limits: rules.flags });
  const missed = targetsMissed(steps, targets);
  // Explicit targets are the yardstick when there is no baseline, so a run judged by them is not "NO BASELINE".
  const verdict = computeVerdict({ meta, flags, hasBaseline: baseline !== undefined || targets !== 'baseline', targetsMissed: missed, crossed: crossedThresholds(summary) });
  const stages = meta.profile.stages;
  const breakingPoint =
    meta.profile.type === 'stress' && stages?.length ? findBreakingPoint(timeseries.buckets, stages, db, timeseries.bucketSec, rules.breaking) : undefined;

  const present = new Set(await readdir(runDir));
  const files = FILE_ORDER.filter((name) => present.has(name) || name === 'report.html' || name === 'report.md');

  return {
    runDir,
    meta,
    sources,
    summary,
    timeseries,
    db,
    baseline,
    rules,
    workload: meta.workload,
    journeys,
    liveFallback,
    ...(authType ? { authType } : {}),
    findings,
    files,
    durationSec,
    stepIds,
    steps,
    targets,
    dbHoldAvg,
    flags,
    targetsMissed: missed,
    verdict,
    breakingPoint,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// writing
// ---------------------------------------------------------------------------------------------------------------

export type ReportResult = { ok: true } | { ok: false; error: string };

/** Write through a temp file so a crash never leaves half a file under the real name. */
export async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmp, text, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

const MAX_ERROR = 500;
const messageOf = (err: unknown): string => String((err as Error)?.message ?? err).split('\n')[0]!.slice(0, MAX_ERROR);

/** Set `meta.report` in meta.json (atomically, everything else untouched). A meta.json that cannot be read or written is left alone. */
async function recordReport(runDir: string, result: ReportResult): Promise<void> {
  try {
    const file = join(runDir, 'meta.json');
    const meta = JSON.parse(await readFile(file, 'utf8')) as RunMeta;
    await writeAtomic(file, `${JSON.stringify({ ...meta, report: result }, null, 2)}\n`);
  } catch {
    // nothing to record into; the caller still has the result
  }
}

/**
 * Build the report of a run folder and write report.html and report.md next to its other files, then record
 * `meta.report` (`{ ok: true }`, or `{ ok: false, error }` with the message only). Never throws: a failed render must not
 * fail the run or lose its meta.json. Nothing is written when the report cannot be built.
 */
export async function renderRunReport(runDir: string, opts: BuildOptions = {}): Promise<ReportResult> {
  let result: ReportResult;
  try {
    const model = await buildReportModel(runDir, opts);
    const html = renderHtml(model);
    const md = renderMarkdown(model);
    await writeAtomic(join(runDir, 'report.html'), html);
    await writeAtomic(join(runDir, 'report.md'), md);
    result = { ok: true };
  } catch (err) {
    result = { ok: false, error: messageOf(err) };
  }
  await recordReport(runDir, result);
  return result;
}

/**
 * Check every number of the folder's report.html against the folder's files: its `data-src` is evaluated again and must
 * give the text shown. Nothing outside the run folder is read (an older folder without the snapshot aside, see loadRun).
 * @throws {Error} when the folder has no report.html
 */
export async function verifyRunReport(runDir: string, opts: BuildOptions = {}): Promise<{ checked: number; mismatches: string[] }> {
  const { sources } = await loadRun(runDir, opts);
  const html = await readText(join(runDir, 'report.html'));
  if (html === undefined) throw new Error(`${join(runDir, 'report.html')} does not exist: write it with \`perf report\` first`);
  return verifyHtml(html, sources);
}
