// The run orchestrator: project + feature + profile -> a guarded k6 run and a run folder.
//
// runFeature is a sequence of named phases so later tasks can slot in theirs (journey checks, DB evidence, report):
//   (start)        config, sweep of stale secrets files, env lock
//   preflight      guardrails (env, caps, window at start and projected end), k6 version, smoke key (files + env)
//   journey check  journey.yaml against the env's swagger and the read-only rule; problems refuse the run (nothing sent)
//   prepareEnv     adapter: resolve the env, verify standing data, run data for the script
//   openDb         the database side (runner/dbPhase.ts): the busy check refuses a load on a busy shared DB
//   ensureSmoke    a non-smoke run whose script/config has no passing smoke runs one first and stops if it fails
//   runOnce        row counts + query-stats snapshot -> run folder -> fingerprint -> config + secrets -> k6 (the DB watch
//                  can stop it) -> fingerprint -> time series -> db.json -> meta
//                  (a smoke also compares the requests k6 sent with the journey: meta.checks, a mismatch fails the smoke)
// Secrets reach k6 only through a mode-0600 temp file that is deleted as soon as k6 exits, and never reach the
// run folder, the console or an error message.

import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { arch, hostname, platform, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { loadAdapter, type ProjectAdapter, type ResolvedEnv } from './adapter.js';
import { loadDotEnv } from './adapters/envAdapter.js';
import { resolveStaticHeader, type StaticHeader } from './auth.js';
import { checkScriptMatchesJourney, formatProblem, requireJourneyChecks, type Problem } from './checks.js';
import {
  checkAbortLimits,
  ConfigError,
  featureLoosenedMessage,
  loadFeature,
  loadProject,
  loosenedLimits,
  REPO_ROOT,
  type AbortLimits,
  type EnvConfig,
  type Feature,
  type Journey,
  type Project,
  type Workload,
} from './config.js';
import { DbPhase, type CleanupResult, type DbGuardStatus, type DbRun } from './dbPhase.js';
import { buildFingerprint, fingerprintChanged, type Fingerprint } from './fingerprint.js';
import {
  acquireEnvLock,
  checkEnv,
  checkWindow,
  GuardrailError,
  isAlive,
  readSmokeLedger,
  recordSmoke,
  resolveProfile,
  resultsRoot,
  smokeKey,
  type ProfileType,
  type ResolvedProfile,
  type ResourceSample,
} from './guardrails.js';
import { countScriptErrors, ignoredK6Variables, k6Version, startK6, type K6Exit, type K6Process } from './k6.js';
import { loadBaseline } from './baseline.js';
import { buildReportModel, renderRunReport } from './report/build.js';
import { BREAKING_LIMITS, cleanupReason, FLAG_LIMITS, type BaselineSnapshot, type ReportRules, type RunWorkload, type Verdict } from './report/model.js';
import { describeSecretScan, scanRunFolder, type SecretScan } from './secretScan.js';
import { buildTimeseries, type ObservedRequest } from './timeseries.js';

const execFileAsync = promisify(execFile);

export interface RunOptions {
  /** Project name, or a loaded Project (tests add envs this way). */
  project: string | Project;
  /** Feature name, or a loaded Feature (tests shorten its profiles this way; the files still decide the smoke key). */
  feature: string | Feature;
  env: string;
  profile: ProfileType;
  /** Lets sizes go above the env defaults, never above the caps. */
  allowMax?: boolean;
  /** Lets load/stress/soak run outside the load window; recorded in meta when it was needed. */
  overrideWindow?: boolean;
  /** Lets a load/stress/soak run on a busy (or unreadable) shared DB; recorded in meta when it was needed. */
  overrideBusy?: boolean;
  /**
   * Abort limits for this run only, over the feature's and the project's (the self-test uses it to force an abort). Checked
   * against the same ranges as the YAML files; errorRate and dbCpuOrIoPct may only be tightened (above the project's is refused
   * with ABORT_LOOSENED), p95Ms may be raised. Recorded in meta.abort with the source `override`.
   */
  abortOverride?: Partial<AbortLimits>;
  now?: () => Date;
  /** DB resource samples in place of the project's database (tests): the busy check, the abort watch and db.json read them. */
  resourceSource?: () => Promise<ResourceSample[]>;
  /** How often the DB abort watch polls, in ms (default 15 000, the rate of the samples). Tests shorten it. */
  dbPollMs?: number;
  /** The longest any one DB evidence step may take, in ms (default 20 000). Tests shorten it. */
  dbStepTimeoutMs?: number;
  /** Nothing on the console: no k6 output (k6.log still has it) and no runner messages. */
  quiet?: boolean;
  /** Receives the runner's messages (the text after `perf: `) in place of the console, whatever `quiet` says (tests read them this way). */
  log?: (message: string) => void;
}

export interface RunResult {
  runDir: string;
  /** k6's exit code; null when k6 did not start (interrupted first) or was killed by a signal. */
  exitCode: number | null;
  /**
   * k6 exited 0, the run was not interrupted and the row counts (when the project counts any) are equal; a smoke also
   * needs zero script errors and a journey match.
   */
  ok: boolean;
  meta: RunMeta;
  /** The report's verdict and its reasons; absent when the report could not be built (meta.report says why). */
  verdict?: Verdict;
}

export type AbortReason = 'thresholds' | 'db' | 'interrupted';
/** Where an abort limit came from: project.yaml, the feature's workload.yaml, or RunOptions.abortOverride. */
export type AbortSource = 'project' | 'feature' | 'override';
/** The abort limits a run applied (see effectiveAbort) and where each came from. */
export interface RunAbort extends AbortLimits {
  /** Where each limit came from; a limit nobody set (db_cpu_or_io_pct of a project without a database) has no source. */
  source: Partial<Record<keyof AbortLimits, AbortSource>>;
  /** The project's own limits, so the report can show what a feature or run option changed. */
  projectDefault: AbortLimits;
}
export type DatabaseAccess = 'connected' | 'unavailable' | 'none';

/** What a run's DB phase says about the project's database (see RunMeta.database). */
export function databaseAccess(db: DbPhase | null | undefined): DatabaseAccess {
  if (db?.readsLoad) return 'connected';
  return db?.hasEvidence ? 'unavailable' : 'none';
}

/** Why the runner itself stopped k6. */
export type StopReason = 'db' | 'interrupted';

export interface RunMeta {
  runId: string;
  project: string;
  feature: string;
  profile: ResolvedProfile;
  env: string;
  startedAt: string;
  endedAt: string;
  k6Version: string;
  git: { commit: string | null; dirty: boolean | null };
  loadMachine: { host: string; platform: string };
  fingerprint: { before: Fingerprint; after: Fingerprint; changed: boolean };
  guardrails: { allowMax: boolean; windowOverride: boolean; busyOverride: boolean };
  k6: { exitCode: number | null; signal: string | null; abortReason?: AbortReason; scriptErrors: number };
  interrupted: boolean;
  /** Where the script's traffic disagrees with journey.yaml (smoke only); empty means it matches. Any entry fails the smoke. */
  checks: Problem[];
  /** Row counts before and after the run; absent when the project counts no tables or its adapter cannot count. */
  cleanup?: CleanupResult;
  /** How the DB abort watch fared; present only when a poll failed (a guard that cannot read the DB is noted here). */
  dbGuard?: DbGuardStatus;
  /**
   * The project's database access: `connected` (the evidence, the busy check and the DB guard ran), `unavailable` (the
   * adapter has a database but it could not be reached) or `none` (the project reads no database, so none of them apply).
   * Absent in run folders recorded before it existed.
   */
  database?: DatabaseAccess;
  /** Whether the shared files held a token (removed) or a setup_data key; set by the scan after meta.json is first written. */
  secretScan?: SecretScan;
  /** The workload's targets when the run started: `baseline`, or a p95 limit per step id. The report judges the steps against these. */
  targets?: Workload['targets'];
  /** The abort limits the run applied (k6 thresholds and DB guard) and where each came from; absent in runs recorded before feature-level limits existed. */
  abort?: RunAbort;
  /**
   * The baseline slot the report is judged against, copied from the feature's baseline.json when the run finished (null: the
   * feature had none for this env and profile). With `rules` and `workload` below it makes the report reproducible from this
   * folder alone: a later `baseline accept` or a change to the limits in code does not change this run's verdict. Absent in
   * run folders recorded before the snapshot existed, and when baseline.json could not be read (the report then says why it failed).
   */
  baseline?: BaselineSnapshot | null;
  /** The flag and breaking-point limits the report applied. */
  rules?: ReportRules;
  /** The workload terms the report words the load with, and the request of every step. */
  workload?: RunWorkload;
  /** Whether report.html and report.md were written; set after meta.json is complete. A failed render never fails the run. */
  report?: { ok: true } | { ok: false; error: string };
}

/** What the k6 script reads from PERF_CONFIG_FILE (see core/config.js). Never holds secrets. */
export interface RunConfig {
  runId: string;
  apiUrl: string;
  profile: ResolvedProfile;
  caps: { maxVus: number; maxRps: number };
  /** k6's rps option (the ceiling on requests per second): see k6RpsOption. */
  rps: number;
  mix: Record<string, number>;
  thinkTime: { min: number; max: number };
  stepsPerIteration: Record<string, number>;
  journeys: { name: string; key: string; role: string; exec: string; steps: { name: string; optionalShare: number }[] }[];
  abort: { errorRate: number; p95Ms: number };
  auth: RunAuth;
  data?: unknown;
}

/**
 * How the script signs in, as the run config tells it: the token endpoint of the password grant, or the name of the static
 * header (its value reaches k6 only in the secrets file).
 */
export type RunAuth =
  | { type: 'ropc'; tokenUrl: string; clientId: string; scope: string }
  | { type: 'static_header'; header: string };

/** The run was interrupted before its main k6 run could start (e.g. Ctrl+C during the smoke that comes first). */
export class RunInterruptedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunInterruptedError';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** Requests one iteration of the journey sends on average: the sum of its steps' optional shares. */
export function stepsPerIteration(journey: Journey): number {
  const sum = journey.steps.reduce((total, step) => total + step.optionalShare / 100, 0);
  return Math.round(sum * 1e6) / 1e6;
}

/**
 * The abort limits of a run: the project's, with the feature's `abort:` over them and `override` over both, key by key.
 * `errorRate` and `dbCpuOrIoPct` may only be tightened (at most the project's value): a feature or run option that loosens
 * them would quietly weaken a guard. `p95Ms` may be raised.
 * @throws {ConfigError} when `override` has a key that is not a limit or a value that is not a finite number in range, or the
 *   feature loosens a tighten-only limit (a feature loaded from workload.yaml was checked already; this covers one built in code)
 * @throws {GuardrailError} ABORT_LOOSENED when `override` loosens a tighten-only limit
 */
export function effectiveAbort(project: Project, feature: Feature, override: Partial<AbortLimits> = {}): RunAbort {
  checkAbortLimits(override, 'abortOverride');
  const [featureLoosened] = loosenedLimits(feature.workload.abort ?? {}, project.abort);
  if (featureLoosened) {
    throw new ConfigError(`${join(feature.dir, 'workload.yaml')}: abort.${featureLoosened.yaml} ${featureLoosenedMessage(featureLoosened)}`);
  }
  const [overrideLoosened] = loosenedLimits(override, project.abort);
  if (overrideLoosened) {
    throw new GuardrailError(
      'ABORT_LOOSENED',
      `abortOverride.${overrideLoosened.key} ${overrideLoosened.value} is above the project's ${overrideLoosened.max}: ` +
        'a run option may only tighten errorRate and dbCpuOrIoPct (p95Ms may be raised)',
    );
  }
  const layers: Array<[AbortSource, Partial<AbortLimits>]> = [
    ['project', project.abort],
    ['feature', feature.workload.abort ?? {}],
    ['override', override],
  ];
  const limits = {} as AbortLimits;
  const source = {} as RunAbort['source'];
  for (const key of ['errorRate', 'p95Ms', 'dbCpuOrIoPct'] as const) {
    for (const [from, layer] of layers) {
      const value = layer[key];
      if (value === undefined) continue;
      limits[key] = value;
      source[key] = from; // a later layer wins
    }
  }
  return { ...limits, source, projectDefault: { ...project.abort } };
}

/**
 * One line per abort limit that does not come from the project, for the log at run start: a limit changed by the feature or
 * by a run option is a deliberate departure from the project default and should be visible on the console.
 */
export function abortLimitNotes(abort: RunAbort, featureName: string): string[] {
  const labels = {
    errorRate: (n: number) => `error rate ${n}`,
    p95Ms: (n: number) => `p95 ${n} ms`,
    dbCpuOrIoPct: (n: number) => `database CPU/IO ${n}%`,
  } satisfies Record<keyof AbortLimits, (n: number) => string>;
  const unit = { errorRate: '', p95Ms: ' ms', dbCpuOrIoPct: '%' } satisfies Record<keyof AbortLimits, string>;
  const notes: string[] = [];
  for (const key of ['errorRate', 'p95Ms', 'dbCpuOrIoPct'] as const) {
    const from = abort.source[key];
    const value = abort[key];
    if (from === 'project' || from === undefined || value === undefined) continue;
    const projectValue = abort.projectDefault[key];
    const projectDefault = projectValue === undefined ? 'none' : `${projectValue}${unit[key]}`;
    notes.push(`abort limit ${labels[key](value)} from ${from === 'feature' ? `feature ${featureName}` : 'run option'} (project default ${projectDefault})`);
  }
  return notes;
}

/**
 * Why the run ended early, if it did. A runner stop wins; a threshold abort is k6's exit 99 on a non-smoke run
 * (a smoke with exit 99 simply failed its checks).
 */
export function abortReasonFor(profileType: ProfileType, exitCode: number | null, stopReason?: StopReason): AbortReason | undefined {
  if (stopReason) return stopReason;
  if (exitCode === 99 && profileType !== 'smoke') return 'thresholds';
  return undefined;
}

const hhmm = (d: Date): string => d.toISOString().slice(11, 16);

/**
 * The load window must hold at the start and at the projected end (start + totalSec): a 30 min load started at
 * 05:50 would run into working hours. `overridden` is true when the override was needed at either end.
 * @throws {GuardrailError} OUTSIDE_WINDOW
 */
export function checkRunWindow(
  start: Date,
  window: EnvConfig['windowUtc'],
  profile: ResolvedProfile,
  override: boolean,
): { overridden: boolean } {
  const atStart = checkWindow(start, window, profile.type, override);
  const end = new Date(start.getTime() + profile.totalSec * 1000);
  try {
    const atEnd = checkWindow(end, window, profile.type, override);
    return { overridden: atStart.overridden || atEnd.overridden };
  } catch (err) {
    if (!(err instanceof GuardrailError) || !window) throw err;
    throw new GuardrailError(
      'OUTSIDE_WINDOW',
      `a ${profile.type} run of ${Math.ceil(profile.totalSec / 60)} min started at ${hhmm(start)} UTC would still be running at ` +
        `${hhmm(end)} UTC, outside the load window (${window.weekdays} UTC on weekdays). Start earlier, shorten the ` +
        'profile, or pass --override-window (the report records it)',
    );
  }
}

/**
 * Create `<results>/<yyyy-mm-dd_HHmm>_<project>_<feature>_<profile>` (UTC minute); `_2`, `_3`... when it exists.
 * @returns the absolute path of the new, empty folder
 */
export function newRunDir(project: string, feature: string, profile: string, now: Date): string {
  const root = resultsRoot();
  mkdirSync(root, { recursive: true });
  const iso = now.toISOString();
  const base = `${iso.slice(0, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}_${project}_${feature}_${profile}`;
  for (let n = 1; ; n++) {
    const dir = join(root, n === 1 ? base : `${base}_${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
}

/** Every file under `dir`, recursively. A missing folder is an error unless `optional`, which gives no files. */
async function filesUnder(dir: string, optional = false): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir, { recursive: true });
  } catch (err) {
    if (optional && (err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const file = join(dir, entry);
    if ((await stat(file)).isFile()) files.push(file);
  }
  return files;
}

/** A script the k6 run may import: a .js (.mjs, .cjs) file that is not a test. */
const isScriptFile = (file: string): boolean => /\.[cm]?js$/.test(file) && !/\.test\.[cm]?js$/.test(file);

/**
 * The files whose content decides whether a smoke is still valid: the script, all of core/, journey, workload, the
 * feature's `fixtures/**` (request bodies the script sends), every other script file of the feature folder, the project's
 * project.yaml and adapter.ts (when present) and every script file under the project folder (helpers the script may
 * import), tests left out. Editing any of them asks for a fresh smoke.
 */
export async function smokeFiles(project: Project, feature: Feature): Promise<string[]> {
  const coreFiles = await filesUnder(join(REPO_ROOT, 'core'));
  const fixtures = await filesUnder(join(feature.dir, 'fixtures'), true);
  const featureScripts = (await filesUnder(feature.dir, true)).filter(isScriptFile);
  const projectScripts = (await filesUnder(project.dir, true)).filter(isScriptFile);
  const projectFiles = ['project.yaml', 'adapter.ts'].map((name) => join(project.dir, name)).filter((file) => existsSync(file));
  return [
    ...new Set([
      feature.script,
      ...coreFiles,
      join(feature.dir, 'journey.yaml'),
      join(feature.dir, 'workload.yaml'),
      ...fixtures,
      ...featureScripts,
      ...projectFiles,
      ...projectScripts,
    ]),
  ];
}

/**
 * The smoke ledger key of a run: the files' key (smokeFiles) bound to `<project>/<feature>/<env>`, so a smoke that
 * passed on one env (or for another project or feature with the same files) never unlocks a load elsewhere.
 */
export async function runSmokeKey(project: Project, feature: Feature, env: string): Promise<string> {
  const filesKey = await smokeKey(await smokeFiles(project, feature));
  return createHash('sha256').update(`${project.name}/${feature.name}/${env}\0${filesKey}`).digest('hex');
}

/**
 * k6's rps option, the ceiling on requests per second for the whole run: a load or soak is held at the env's defaults.rps,
 * or at caps.max_rps with --allow-max (users pace themselves by think time; the ceiling stops a script that does not). A
 * smoke sends one iteration per journey and a stress sets its own arrival rate (checked against the defaults when it is
 * resolved), so both keep the cap.
 */
export function k6RpsOption(profileType: ProfileType, envCfg: EnvConfig, allowMax: boolean): number {
  if ((profileType === 'load' || profileType === 'soak') && !allowMax) return envCfg.defaults.rps;
  return envCfg.caps.maxRps;
}

function buildRunConfig(args: {
  runId: string;
  profile: ResolvedProfile;
  feature: Feature;
  envCfg: EnvConfig;
  env: PreparedEnv;
  abort: RunAbort;
  allowMax: boolean;
}): RunConfig {
  const { runId, profile, feature, envCfg, env, abort, allowMax } = args;
  const cfg: RunConfig = {
    runId,
    apiUrl: env.apiUrl,
    profile,
    caps: { maxVus: envCfg.caps.maxVus, maxRps: envCfg.caps.maxRps },
    rps: k6RpsOption(profile.type, envCfg, allowMax),
    mix: feature.workload.mix,
    thinkTime: feature.workload.thinkTime,
    stepsPerIteration: Object.fromEntries(feature.journeys.map((j) => [j.name, stepsPerIteration(j)])),
    journeys: feature.journeys.map((j) => ({
      name: j.name,
      key: j.key,
      role: j.role,
      exec: j.exec,
      steps: j.steps.map((s) => ({ name: s.name, optionalShare: s.optionalShare })),
    })),
    abort: { errorRate: abort.errorRate, p95Ms: abort.p95Ms },
    auth: env.auth,
  };
  if (env.data !== undefined) cfg.data = env.data;
  return cfg;
}

/** The accounts of the roles the feature's journeys use (the adapter may know more roles). Errors name roles only. */
function accountsFor(feature: Feature, accounts: ResolvedEnv['accounts']): ResolvedEnv['accounts'] {
  const picked: ResolvedEnv['accounts'] = {};
  for (const role of new Set(feature.journeys.map((j) => j.role))) {
    const account = Object.hasOwn(accounts, role) ? accounts[role] : undefined;
    if (!account) {
      throw new Error(`the project adapter has no account for role ${role} (it has: ${Object.keys(accounts).join(', ') || 'none'})`);
    }
    picked[role] = account;
  }
  return picked;
}

/**
 * The account passwords as known secrets for the run-folder scan (a script may log one). A password that a public setting of
 * the run holds (a login, the client id, the scope, the token or API url: they are written to k6-config.json and the log)
 * cannot be told apart from that setting, so it is left out: redacting it would garble the run's own files on every run.
 */
export function accountSecrets(accounts: ResolvedEnv['accounts'], auth: ResolvedEnv['auth'], apiUrl: string): string[] {
  const publicValues = [auth.tokenUrl, auth.clientId, auth.scope, apiUrl, ...Object.values(accounts).map((a) => a.login)];
  const passwords = Object.values(accounts).map((a) => a.password);
  return [...new Set(passwords)].filter((password) => !publicValues.some((value) => value.includes(password)));
}

async function gitInfo(): Promise<RunMeta['git']> {
  try {
    const { stdout: commit } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT });
    const { stdout: status } = await execFileAsync('git', ['status', '--porcelain'], { cwd: REPO_ROOT });
    return { commit: commit.trim(), dirty: status.trim().length > 0 };
  } catch {
    return { commit: null, dirty: null };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// secrets file
// ---------------------------------------------------------------------------------------------------------------

const SECRETS_PREFIX = 'perf-secrets-';
/** `perf-secrets-<pid of the runner>-<uuid>.json` */
const SECRETS_NAME = /^perf-secrets-(\d+)-[0-9a-f-]{36}\.json$/;
/**
 * A secrets file older than this is stale even when a process with its pid is alive (the pid was reused). Far above
 * the longest run the caps allow (max_duration 30m, plus setup and graceful stop), so a live run's file is never hit.
 */
const SECRETS_MAX_AGE_MS = 6 * 3600 * 1000;

/**
 * Delete secrets files left in `dir` by runs that ended without cleaning up (SIGKILL, crash, power loss): those whose
 * runner pid is gone, and any older than SECRETS_MAX_AGE_MS. A concurrent live run's file is kept.
 * @returns the names removed
 */
export async function sweepStaleSecrets(dir: string = tmpdir()): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names.filter((n) => n.startsWith(SECRETS_PREFIX))) {
    const file = join(dir, name);
    const st = await stat(file).catch(() => null);
    if (!st?.isFile()) continue;
    const pid = SECRETS_NAME.exec(name)?.[1];
    const ownerGone = pid !== undefined && !isAlive(Number(pid));
    const ancient = Date.now() - st.mtimeMs > SECRETS_MAX_AGE_MS;
    if (!ownerGone && !ancient) continue;
    try {
      await rm(file, { force: true });
      removed.push(name);
    } catch {
      // not ours to delete (another user's file in a shared tmp): leave it
    }
  }
  return removed;
}

/**
 * A mode-0600 temp file with `{ accounts }` (and the static header, `header: { name, value }`, when the project uses one), named after this process's pid so a later run can tell a stale file from
 * a live run's. Also removed when the process exits before `remove()` runs.
 */
async function writeSecretsFile(accounts: ResolvedEnv['accounts'], header?: StaticHeader): Promise<{ file: string; remove: () => Promise<void> }> {
  const file = join(tmpdir(), `${SECRETS_PREFIX}${process.pid}-${randomUUID()}.json`);
  const onExit = (): void => {
    try {
      unlinkSync(file);
    } catch {
      // already gone
    }
  };
  process.on('exit', onExit);
  try {
    await writeFile(file, JSON.stringify(header ? { accounts, header } : { accounts }), { mode: 0o600, flag: 'wx' });
  } catch (err) {
    process.off('exit', onExit);
    await rm(file, { force: true });
    throw err;
  }
  return {
    file,
    remove: async () => {
      await rm(file, { force: true });
      process.off('exit', onExit);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// stopping k6: Ctrl+C, SIGTERM or a closed terminal (SIGHUP) now, the DB abort rule later
// ---------------------------------------------------------------------------------------------------------------

/** The k6 run in progress, and why the runner stopped it if it did. */
export class K6Control {
  stopReason: StopReason | undefined;

  constructor(private readonly proc: K6Process) {}

  stop(reason: StopReason): void {
    this.stopReason ??= reason;
    this.proc.stop();
  }
}

/** Signals that stop the run gracefully. Without a handler Node dies at once and skips its exit hooks. */
const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const ignoreError = (): void => {};

/**
 * Turns SIGINT/SIGTERM/SIGHUP into a graceful stop of the k6 run in progress (a second signal aborts it), so the run
 * still writes its meta and deletes its secrets file. k6 is in its own process group, so a closed terminal does not
 * reach it directly.
 */
class Interrupter {
  interrupted = false;
  active: K6Control | null = null;

  private readonly onSignal = (signal: NodeJS.Signals): void => {
    if (signal === 'SIGHUP') {
      // The terminal is gone: writes to it fail from now on, and must not crash the clean-up.
      process.stdout.on('error', ignoreError);
      process.stderr.on('error', ignoreError);
    }
    this.interrupted = true;
    this.log(`${signal}: stopping k6 gracefully (press Ctrl+C again to abort it at once)`);
    this.active?.stop('interrupted');
  };

  constructor(private readonly log: (message: string) => void) {
    for (const signal of STOP_SIGNALS) process.on(signal, this.onSignal);
  }

  dispose(): void {
    for (const signal of STOP_SIGNALS) process.off(signal, this.onSignal);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// phases
// ---------------------------------------------------------------------------------------------------------------

/** The env as a run uses it: where the API is, how the script signs in, the secrets for the secrets file, the run data. */
interface PreparedEnv {
  apiUrl: string;
  auth: RunAuth;
  /** The accounts of the roles the journeys use (none for a static header). Secrets: only the secrets file holds them. */
  accounts: ResolvedEnv['accounts'];
  /** The static header with `${env:NAME}` replaced. A secret, like the accounts. */
  header?: StaticHeader;
  /**
   * Secret strings the runner knows and a script might leak (the values `${env:NAME}` put into the header, the account
   * passwords: see accountSecrets); the scan redacts them.
   */
  secrets: string[];
  data: unknown;
}

interface RunContext {
  opts: RunOptions;
  project: Project;
  feature: Feature;
  /** The abort limits of every k6 run of this call (smoke and main): project, feature and run option merged. */
  abort: RunAbort;
  envCfg: EnvConfig;
  now: () => Date;
  log: (message: string) => void;
  interrupter: Interrupter;
  k6Version: string;
  git: RunMeta['git'];
  smokeKey: string;
  windowOverride: boolean;
  /** Filled by openDb: the busy check was needed and overridden. */
  busyOverride: boolean;
  /** Filled by prepareEnv. */
  env?: PreparedEnv;
  /** Filled by openDb; null when the project has no database to read. */
  db?: DbPhase | null;
}

/** What one k6 run left behind, for the phases after it. */
interface RunOutcome {
  result: RunResult;
  /** Requests the script sent (name, method, url): the journey check compares them with journey.yaml. */
  observed: ObservedRequest[];
  /** Why a smoke failed; empty when it passed (or for other profiles). */
  smokeProblems: string[];
}

/**
 * The guardrails that need neither the network nor a file: the env allowlist, the size caps and defaults (`--allow-max`), and
 * the load window at the start and the projected end (`--override-window`). `perf run --dry-run` stops here.
 * @throws {GuardrailError} ENV_NOT_ALLOWED | CAPS_EXCEEDED | ABOVE_DEFAULTS | OUTSIDE_WINDOW
 * @throws {ConfigError} when the workload has no profile of the requested type
 */
export function resolveRun(
  opts: RunOptions,
  project: Project,
  feature: Feature,
  now: () => Date,
): { envCfg: EnvConfig; profile: ResolvedProfile; windowOverride: boolean } {
  const envCfg = checkEnv(project, opts.env);
  const profile = resolveProfile(opts.profile, feature.workload, envCfg, { allowMax: opts.allowMax ?? false });
  const { overridden } = checkRunWindow(now(), envCfg.windowUtc, profile, opts.overrideWindow ?? false);
  return { envCfg, profile, windowOverride: overridden };
}

/** Guardrails and everything that must hold before any request is sent. */
async function preflight(
  opts: RunOptions,
  project: Project,
  feature: Feature,
  now: () => Date,
): Promise<{ envCfg: EnvConfig; profile: ResolvedProfile; windowOverride: boolean; version: string; key: string }> {
  const { envCfg, profile, windowOverride } = resolveRun(opts, project, feature, now);
  const version = await k6Version();
  const key = await runSmokeKey(project, feature, opts.env);
  return { envCfg, profile, windowOverride, version, key };
}

/** Extra environment for k6 by profile: a smoke lasts seconds, and with k6's default 10 s period its dashboard would always be empty. */
export function k6ExtraEnv(profile: ResolvedProfile): Record<string, string> {
  return profile.type === 'smoke' ? { K6_WEB_DASHBOARD_PERIOD: '1s' } : {};
}

/**
 * The env as the run uses it: URLs, auth, accounts (in memory only), standing data check, run data. A password-grant project
 * asks its adapter (`resolveEnv`); a static_header project needs no login, so its API url comes from project.yaml and its
 * header from project.yaml with `${env:NAME}` read from the environment (`.env` fills it): resolveEnv is not called.
 */
async function prepareEnv(ctx: RunContext, adapter: ProjectAdapter): Promise<void> {
  const { project, feature, opts } = ctx;
  let env: Omit<PreparedEnv, 'data'>;
  if (project.auth.type === 'static_header') {
    loadDotEnv();
    const { header, secretParts } = resolveStaticHeader(project.auth);
    env = { apiUrl: ctx.envCfg.apiUrl, auth: { type: 'static_header', header: header.name }, accounts: {}, header, secrets: secretParts };
  } else {
    const resolved = await adapter.resolveEnv(opts.env);
    const { tokenUrl, clientId, scope } = resolved.auth;
    const accounts = accountsFor(feature, resolved.accounts);
    env = {
      apiUrl: resolved.apiUrl,
      auth: { type: 'ropc', tokenUrl, clientId, scope },
      accounts,
      secrets: accountSecrets(accounts, resolved.auth, resolved.apiUrl),
    };
  }
  if (adapter.verifyStandingData) await adapter.verifyStandingData(opts.env, feature);
  const data = adapter.runData ? await adapter.runData(opts.env, feature) : undefined;
  ctx.env = { ...env, data };
}

/**
 * The database side of the run: its connection, and for a load/stress/soak the busy check, which refuses a run on a
 * shared DB that somebody else is already using (unless --override-busy). Nothing has been sent to the env's load yet.
 */
async function openDb(ctx: RunContext, adapter: ProjectAdapter, profile: ResolvedProfile): Promise<void> {
  ctx.db = await DbPhase.open(adapter, {
    env: ctx.opts.env,
    project: ctx.project,
    dbCpuOrIoPct: ctx.abort.dbCpuOrIoPct,
    resourceSource: ctx.opts.resourceSource,
    pollMs: ctx.opts.dbPollMs,
    stepTimeoutMs: ctx.opts.dbStepTimeoutMs,
    log: ctx.log,
  });
  // Fails closed (R45): a project may leave db_cpu_or_io_pct out only when it has no database. One that has a database (or
  // whose database could not be reached) must say when the guard stops the run, or nothing would protect the shared DB.
  if (ctx.db?.hasEvidence && ctx.abort.dbCpuOrIoPct === undefined) {
    throw new ConfigError(
      `${join(ctx.project.dir, 'project.yaml')}: abort.db_cpu_or_io_pct is required for a project with a database ` +
        '(the runner stops a run when the database CPU or data IO stays at this percent); no load was sent',
    );
  }
  const busy = await ctx.db?.busyCheck(profile.type, ctx.opts.overrideBusy ?? false);
  ctx.busyOverride = busy?.overridden ?? false;
}

/**
 * Problems that make a smoke fail; empty means it passed. `checks` are the journey-check problems of the smoke's traffic;
 * `cleanup` the row counts (a smoke that left rows behind, or whose counts could not be read after it, fails).
 */
async function smokeProblems(
  runDir: string,
  exit: K6Exit,
  scriptErrors: number,
  interrupted: boolean,
  checks: Problem[],
  cleanup: CleanupResult | undefined,
): Promise<string[]> {
  const problems: string[] = [];
  if (interrupted) problems.push('it was interrupted');
  if (exit.exitCode !== 0) problems.push(`k6 exited with ${exit.exitCode ?? exit.signal ?? 'no exit code'}`);
  if (scriptErrors > 0) problems.push(`${scriptErrors} script error(s) in k6.log`);
  if (!existsSync(join(runDir, 'summary.json'))) problems.push('k6 wrote no summary.json');
  for (const check of checks) problems.push(`the script does not match the journey: ${formatProblem(check)}`);
  if (cleanup && !cleanup.ok) problems.push(cleanupReason(cleanup));
  return problems;
}

/** Start k6 and wait for it; the secrets file lives exactly as long as k6 does. */
async function executeK6(
  ctx: RunContext,
  runDir: string,
  profile: ResolvedProfile,
  configFile: string,
  dbRun: DbRun | null,
): Promise<{ exit: K6Exit; stopReason?: StopReason }> {
  if (ctx.interrupter.interrupted) return { exit: { exitCode: null, signal: null }, stopReason: 'interrupted' };
  const secrets = await writeSecretsFile(ctx.env!.accounts, ctx.env!.header);
  try {
    const proc = startK6({
      script: ctx.feature.script,
      runDir,
      configFile,
      secretsFile: secrets.file,
      env: k6ExtraEnv(profile),
      echo: !ctx.opts.quiet,
    });
    const control = new K6Control(proc);
    ctx.interrupter.active = control;
    const endWatch = dbRun?.watch(control);
    try {
      const exit = await proc.done;
      return { exit, stopReason: control.stopReason };
    } finally {
      endWatch?.();
      ctx.interrupter.active = null;
    }
  } finally {
    await secrets.remove();
  }
}

/** k6 skips its dashboard export for very short runs; leave a page that says so, so the run folder stays complete. */
async function ensureDashboard(runDir: string, logText: string, exit: K6Exit): Promise<void> {
  const file = join(runDir, 'k6-dashboard.html');
  if (existsSync(file)) return;
  const why = logText.includes('report generation was skipped')
    ? 'the run was too short for k6 to build its dashboard (k6: "not enough data").'
    : exit.exitCode === null && exit.signal === null
      ? 'k6 did not run.'
      : `k6 ended (${exit.exitCode !== null ? `exit code ${exit.exitCode}` : `signal ${exit.signal}`}) without exporting it.`;
  await writeFile(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><title>k6 dashboard</title></head>` +
      `<body><p>No k6 dashboard for this run: ${why} The numbers are in summary.json and timeseries.json.</p></body></html>\n`,
    'utf8',
  );
}

/**
 * What the report needs from files outside the run folder, copied into meta.json when the run finishes: the baseline slot
 * it is judged against, the limits that decide its flags and breaking point, and the workload terms. The report is rendered
 * from the run folder alone, so a later `baseline accept`, an edit of workload.yaml or a change to the limits in code never
 * changes what this run's report says. A baseline.json that cannot be read leaves `baseline` out: the report then falls back
 * to the live file, fails the same way, and says so in meta.report.
 */
async function reportSnapshot(ctx: RunContext, profile: ResolvedProfile): Promise<Pick<RunMeta, 'baseline' | 'rules' | 'workload'>> {
  const { feature, opts } = ctx;
  const snapshot: Pick<RunMeta, 'baseline' | 'rules' | 'workload'> = {
    rules: { flags: { ...FLAG_LIMITS }, breaking: { ...BREAKING_LIMITS } },
    workload: {
      businessUnit: feature.workload.businessUnit,
      businessAction: feature.workload.businessAction,
      thinkTime: { ...feature.workload.thinkTime },
      readOnly: feature.readOnly,
      ...(feature.writes ? { writes: feature.writes.map((w) => ({ request: `${w.method} ${w.route}`, cleanup: w.cleanup })) } : {}),
      requests: Object.fromEntries(feature.journeys.flatMap((j) => j.steps.map((s) => [`${j.key}.${s.name}`, `${s.method} ${s.route}`]))),
    },
  };
  try {
    const slot = await loadBaseline(feature.dir, opts.env, profile.type);
    snapshot.baseline = slot ? { env: opts.env, profile: profile.type, ...slot } : null;
  } catch (err) {
    ctx.log(`WARNING: the baseline could not be read (${(err as Error).message}); the report will not be built`);
  }
  return snapshot;
}

/** One k6 run in a new run folder, from fingerprint to meta.json. */
async function runOnce(ctx: RunContext, profile: ResolvedProfile): Promise<RunOutcome> {
  const { project, feature, envCfg, opts } = ctx;
  if (ctx.interrupter.interrupted) throw new RunInterruptedError(`interrupted before the ${profile.type} run started`);
  // Row counts and the query-stats snapshot come first: counts that cannot be read refuse the run before it has a folder.
  const dbRun = ctx.db ? await ctx.db.begin() : null;
  const startedAt = ctx.now();
  const runDir = newRunDir(project.name, feature.name, profile.type, startedAt);
  const runId = basename(runDir);
  ctx.log(`${profile.type} run: ${runDir}`);

  const before = await buildFingerprint(envCfg);

  const configFile = join(runDir, 'k6-config.json');
  const config = buildRunConfig({ runId, profile, feature, envCfg, env: ctx.env!, abort: ctx.abort, allowMax: opts.allowMax ?? false });
  await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  const { exit, stopReason } = await executeK6(ctx, runDir, profile, configFile, dbRun);

  const after = await buildFingerprint(envCfg);

  const { timeseries, observed } = await buildTimeseries(join(runDir, 'points.json.gz'));
  await writeFile(join(runDir, 'timeseries.json'), `${JSON.stringify(timeseries, null, 2)}\n`, 'utf8');
  const { cleanup, guard } = dbRun ? await dbRun.finish(runDir, timeseries.origin) : {};
  const logText = await readFile(join(runDir, 'k6.log'), 'utf8').catch(() => '');
  const scriptErrors = countScriptErrors(logText);
  await ensureDashboard(runDir, logText, exit);

  const interrupted = stopReason === 'interrupted';
  const abortReason = abortReasonFor(profile.type, exit.exitCode, stopReason);
  // Only a smoke that ran to the end sent the whole journey; after a k6 failure or an interrupt its traffic is partial
  // and the missing steps would only repeat what the smoke already reports.
  const checks =
    profile.type === 'smoke' && exit.exitCode === 0 && !interrupted
      ? checkScriptMatchesJourney(feature, observed, ctx.env!.apiUrl)
      : [];
  const meta: RunMeta = {
    runId,
    project: project.name,
    feature: feature.name,
    profile,
    env: opts.env,
    startedAt: startedAt.toISOString(),
    endedAt: ctx.now().toISOString(),
    k6Version: ctx.k6Version,
    git: ctx.git,
    loadMachine: { host: hostname(), platform: `${platform()}-${arch()}` },
    fingerprint: { before, after, changed: fingerprintChanged(before, after) },
    guardrails: {
      allowMax: opts.allowMax ?? false,
      windowOverride: profile.type === opts.profile ? ctx.windowOverride : false,
      // like the window override: only the run that was checked records it, not the smoke that came first
      busyOverride: profile.type === opts.profile ? ctx.busyOverride : false,
    },
    k6: { exitCode: exit.exitCode, signal: exit.signal, ...(abortReason ? { abortReason } : {}), scriptErrors },
    interrupted,
    checks,
    ...(cleanup ? { cleanup } : {}),
    ...(guard ? { dbGuard: guard } : {}),
    database: databaseAccess(ctx.db),
    targets: feature.workload.targets,
    abort: ctx.abort,
    ...(await reportSnapshot(ctx, profile)),
  };
  await writeFile(join(runDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  meta.secretScan = await scanRunFolder(runDir, ctx.env!.secrets); // backstop: nothing token-like stays in the shared files; also rewrites meta.json
  if (!meta.secretScan.ok) ctx.log(`WARNING: secret scan of ${runDir}: ${describeSecretScan(meta.secretScan)}`);

  // The report is the last thing written: it reads the finished run folder. A report that cannot be built is recorded in
  // meta.report and logged; it never fails the run (renderRunReport does not throw).
  meta.report = await renderRunReport(runDir, { project, feature });
  ctx.log(meta.report.ok ? `report: ${join(runDir, 'report.html')}` : `WARNING: the report could not be built (${meta.report.error}); see meta.json`);
  // The verdict the report shows, for the command line's last line (the model is rebuilt from the finished folder).
  const verdict = meta.report.ok ? (await buildReportModel(runDir, { project, feature }).catch(() => undefined))?.verdict : undefined;

  const problems = profile.type === 'smoke' ? await smokeProblems(runDir, exit, scriptErrors, interrupted, checks, cleanup) : [];
  // Leftover rows (or counts that could not be read after the run) fail any run, like the report's verdict says.
  const ok = exit.exitCode === 0 && !interrupted && problems.length === 0 && cleanup?.ok !== false;
  ctx.log(
    `${profile.type} run ended: k6 exit ${exit.exitCode ?? exit.signal ?? '-'}` +
      `${abortReason ? `, aborted (${abortReason})` : ''}, ${scriptErrors} script error(s)`,
  );
  return { result: { runDir, exitCode: exit.exitCode, ok, meta, ...(verdict ? { verdict } : {}) }, observed, smokeProblems: problems };
}

/** A non-smoke run needs a passing smoke of the same files; run one now if the ledger has none. */
async function ensureSmoke(ctx: RunContext, profile: ResolvedProfile): Promise<void> {
  if (profile.type === 'smoke') return;
  const ledger = await readSmokeLedger();
  if (Object.hasOwn(ledger, ctx.smokeKey)) return;
  ctx.log('no passing smoke of this script and config yet: running the smoke first');
  const smoke = await runOnce(ctx, resolveProfile('smoke', ctx.feature.workload, ctx.envCfg, { allowMax: false }));
  if (ctx.interrupter.interrupted) throw new RunInterruptedError(`interrupted during the smoke run (${smoke.result.runDir})`);
  if (smoke.smokeProblems.length > 0) {
    throw new GuardrailError(
      'SMOKE_REQUIRED',
      `the smoke run failed (${smoke.smokeProblems.join('; ')}); see ${smoke.result.runDir}. ` +
        `Fix it before a ${profile.type} run`,
    );
  }
  await recordSmoke(ctx.smokeKey, smoke.result.meta.runId);
}

/**
 * Run a feature: guardrails, the smoke when one is due, then the k6 run, leaving a complete run folder.
 * @throws {GuardrailError} when a guardrail refuses the run (nothing was sent), or SMOKE_REQUIRED when the smoke that
 *   had to come first failed
 * @throws {JourneyCheckError} when journey.yaml fails its checks against the env's swagger (nothing was sent)
 * @throws {SwaggerError} when the env's swagger cannot be fetched or read (the journey cannot be checked)
 * @throws {ConfigError} when the env has no swagger_url
 * @throws {RunInterruptedError} when Ctrl+C came before the requested run started
 */
export async function runFeature(opts: RunOptions): Promise<RunResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (opts.quiet ? () => {} : (message: string) => console.log(`perf: ${message}`));

  const project = typeof opts.project === 'string' ? await loadProject(opts.project) : opts.project;
  const feature = typeof opts.feature === 'string' ? await loadFeature(project, opts.feature) : opts.feature;
  const abort = effectiveAbort(project, feature, opts.abortOverride); // a bad override refuses the run before anything starts

  const swept = await sweepStaleSecrets();
  if (swept.length > 0) log(`removed ${swept.length} secrets file(s) left in ${tmpdir()} by runs that did not finish`);
  const ignored = ignoredK6Variables();
  if (ignored.length > 0) log(`not passed to k6 (the runner sets k6's options itself): ${ignored.join(', ')}`);

  const release = await acquireEnvLock(opts.env);
  const interrupter = new Interrupter(log);
  let adapter: ProjectAdapter | undefined;
  let ctx: RunContext | undefined;
  try {
    const { envCfg, profile, windowOverride, version, key } = await preflight(opts, project, feature, now);
    ctx = {
      opts,
      project,
      feature,
      abort,
      envCfg,
      now,
      log,
      interrupter,
      k6Version: version,
      git: await gitInfo(),
      smokeKey: key,
      windowOverride,
      busyOverride: false,
    };
    for (const note of abortLimitNotes(abort, feature.name)) log(note);
    await requireJourneyChecks(project, feature, opts.env);
    adapter = await loadAdapter(project);
    await prepareEnv(ctx, adapter);
    await openDb(ctx, adapter, profile);
    await ensureSmoke(ctx, profile);
    const main = await runOnce(ctx, profile);
    if (profile.type === 'smoke' && main.result.ok) await recordSmoke(key, main.result.meta.runId);
    if (profile.type === 'smoke' && main.smokeProblems.length > 0) log(`smoke failed: ${main.smokeProblems.join('; ')}`);
    return main.result;
  } finally {
    interrupter.dispose();
    // The connection and the adapter's pools; a failure here must not hide the run's own error or skip the lock release.
    try {
      await ctx?.db?.release();
      await adapter?.close?.();
    } catch {
      // nothing left to do with a connection that will not close
    }
    await release();
  }
}
