// Guardrails that protect a shared, weak test environment: env allowlist, caps, load window, busy check, DB abort
// rule, smoke ledger and the per-env run lock. Everything here is a pure function except the smoke ledger and the
// env lock, which keep one small file each under the results folder. The run orchestrator calls these in order.

import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ConfigError, REPO_ROOT, type EnvConfig, type HoldProfile, type Project, type StressProfile, type Workload } from './config.js';

export type GuardrailCode =
  | 'ENV_NOT_ALLOWED'
  | 'CAPS_EXCEEDED'
  | 'ABOVE_DEFAULTS'
  | 'OUTSIDE_WINDOW'
  | 'SMOKE_REQUIRED'
  | 'ENV_BUSY'
  | 'DB_UNREACHABLE'
  | 'RUN_IN_PROGRESS'
  | 'ABORT_LOOSENED';

/** A refused run. `code` says which rule refused it; the message says what to change or which flag lifts it. */
export class GuardrailError extends Error {
  constructor(
    readonly code: GuardrailCode,
    message: string,
  ) {
    super(message);
    this.name = 'GuardrailError';
  }
}

/** Where run folders, the smoke ledger and the env locks live. `PERF_RESULTS_DIR` moves it (tests do). */
export function resultsRoot(): string {
  const fromEnv = process.env.PERF_RESULTS_DIR;
  return fromEnv ? resolve(fromEnv) : join(REPO_ROOT, 'results');
}

// ---------------------------------------------------------------------------------------------------------------
// env allowlist
// ---------------------------------------------------------------------------------------------------------------

/** The env's config, or `ENV_NOT_ALLOWED` when the project does not list the env. */
export function checkEnv(project: Project, env: string): EnvConfig {
  const config = Object.hasOwn(project.envs, env) ? project.envs[env] : undefined;
  if (!config) {
    throw new GuardrailError(
      'ENV_NOT_ALLOWED',
      `env ${env} is not allowed for project ${project.name} (allowed: ${Object.keys(project.envs).join(', ')})`,
    );
  }
  return config;
}

// ---------------------------------------------------------------------------------------------------------------
// profile sizes
// ---------------------------------------------------------------------------------------------------------------

export type ProfileType = 'smoke' | 'load' | 'stress' | 'soak';

/** A profile with every number decided, in seconds. `core/lib/profiles.js` `buildScenarios` has no defaults of its own. */
export interface ResolvedProfile {
  type: ProfileType;
  users?: number;
  rampSec?: number;
  holdSec?: number;
  rampDownSec?: number;
  /** Stress: the target req/s from `fromSec` on; the last level runs until `totalSec`. */
  stages?: { fromSec: number; rps: number }[];
  totalSec: number;
  /** Load/soak: the hold phase, where the report takes its steady-state numbers. */
  holdWindow?: { fromSec: number; toSec: number };
}

const EPS = 1e-9;
const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

function formatSec(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round((sec % 60) * 1000) / 1000;
  return [h ? `${h}h` : '', m ? `${m}m` : '', s || (!h && !m) ? `${s}s` : ''].filter(Boolean).join(' ');
}

/**
 * Caps first (they never move), then the defaults (`--allow-max` lifts only these).
 * `amount` is users or req/s; `what` and `unit` only shape the message.
 */
function checkSize(args: {
  what: string;
  amount: number;
  unit: string;
  cap: number;
  dflt: number;
  totalSec: number;
  maxDurationSec: number;
  allowMax: boolean;
}): void {
  const { what, amount, unit, cap, dflt, totalSec, maxDurationSec, allowMax } = args;
  if (amount > cap) {
    throw new GuardrailError('CAPS_EXCEEDED', `${what} of ${amount} ${unit} is above the env cap of ${cap} ${unit}; no flag lifts the cap`);
  }
  if (totalSec > maxDurationSec) {
    throw new GuardrailError(
      'CAPS_EXCEEDED',
      `${what} would run ${formatSec(totalSec)}, above the env cap of ${formatSec(maxDurationSec)}; shorten the profile`,
    );
  }
  if (amount > dflt && !allowMax) {
    throw new GuardrailError(
      'ABOVE_DEFAULTS',
      `${what} of ${amount} ${unit} is above the env default of ${dflt} ${unit}; pass --allow-max to go up to the cap of ${cap} ${unit}`,
    );
  }
}

function holdProfile(
  type: 'load' | 'soak',
  profile: HoldProfile | undefined,
  envCfg: EnvConfig,
  allowMax: boolean,
): ResolvedProfile {
  if (!profile) throw new ConfigError(`workload.yaml: profiles.${type} is not defined, so a ${type} run has nothing to resolve`);
  const users = profile.users ?? envCfg.defaults.vus;
  const totalSec = profile.rampSec + profile.holdSec + profile.rampDownSec;
  checkSize({
    what: `${type} profile`,
    amount: users,
    unit: 'users',
    cap: envCfg.caps.maxVus,
    dflt: envCfg.defaults.vus,
    totalSec,
    maxDurationSec: envCfg.caps.maxDurationSec,
    allowMax,
  });
  return {
    type,
    users,
    rampSec: profile.rampSec,
    holdSec: profile.holdSec,
    rampDownSec: profile.rampDownSec,
    totalSec,
    holdWindow: { fromSec: profile.rampSec, toSec: profile.rampSec + profile.holdSec },
  };
}

function stressProfile(profile: StressProfile | undefined, envCfg: EnvConfig, allowMax: boolean): ResolvedProfile {
  if (!profile) throw new ConfigError('workload.yaml: profiles.stress is not defined, so a stress run has nothing to resolve');
  const { startRps, stepRps, stepEverySec } = profile;
  if (!(stepRps > 0) || !(stepEverySec > 0)) {
    throw new ConfigError(`profiles.stress: step_rps and step_every must be above 0 (got ${stepRps} and ${stepEverySec}s)`);
  }
  // The top rate is the workload's, else the env default. A start above it means the run really begins higher.
  const top = Math.max(profile.maxRps ?? envCfg.defaults.rps, startRps);
  // Levels start, start+step, ... while they fit under the top; when the steps skip past it, one last level sits at the top.
  const steps = Math.floor((top - startRps) / stepRps + EPS);
  const landsOnTop = Math.abs(startRps + steps * stepRps - top) < EPS;
  const totalSec = (steps + 1 + (landsOnTop ? 0 : 1)) * stepEverySec;
  checkSize({
    what: 'stress profile',
    amount: top,
    unit: 'req/s',
    cap: envCfg.caps.maxRps,
    dflt: envCfg.defaults.rps,
    totalSec,
    maxDurationSec: envCfg.caps.maxDurationSec,
    allowMax,
  });
  const levels: number[] = [];
  for (let i = 0; i <= steps; i++) levels.push(round6(startRps + i * stepRps));
  if (!landsOnTop) levels.push(round6(top));
  return {
    type: 'stress',
    stages: levels.map((rps, i) => ({ fromSec: i * stepEverySec, rps })),
    totalSec,
  };
}

/**
 * Turn the workload's profile for `type` into concrete numbers and refuse what the env cannot take.
 * Load/soak users default to the env's `defaults.vus`; the stress top rate defaults to `defaults.rps`.
 * Above the caps is `CAPS_EXCEEDED` always; above the defaults but within the caps is `ABOVE_DEFAULTS` unless `allowMax`.
 * A run longer than the env's max duration is `CAPS_EXCEEDED`.
 * @throws {GuardrailError} CAPS_EXCEEDED | ABOVE_DEFAULTS
 * @throws {ConfigError} when the workload has no profile of that type
 */
export function resolveProfile(
  type: ProfileType,
  workload: Workload,
  envCfg: EnvConfig,
  opts: { allowMax: boolean },
): ResolvedProfile {
  switch (type) {
    case 'smoke':
      return { type: 'smoke', totalSec: 0 };
    case 'load':
      return holdProfile('load', workload.profiles.load, envCfg, opts.allowMax);
    case 'soak':
      return holdProfile('soak', workload.profiles.soak, envCfg, opts.allowMax);
    case 'stress':
      return stressProfile(workload.profiles.stress, envCfg, opts.allowMax);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// load window
// ---------------------------------------------------------------------------------------------------------------

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function minuteOfDay(hh: string, mm: string): number {
  return Number(hh) * 60 + Number(mm);
}

function inWindow(now: Date, window: NonNullable<EnvConfig['windowUtc']>): boolean {
  const range = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window.weekdays);
  if (!range) throw new ConfigError(`window_utc.weekdays must look like 17:00-06:00 (got "${window.weekdays}")`);
  const start = minuteOfDay(range[1]!, range[2]!);
  const end = minuteOfDay(range[3]!, range[4]!);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const wraps = start > end;
  // A night that runs past midnight belongs to the day it began on: Monday 02:00 is the tail of Sunday's night.
  const inTail = wraps && minutes < end;
  const day = (now.getUTCDay() + (inTail ? 6 : 0)) % 7;
  if (day === 0 || day === 6) return window.weekends === 'all-day';
  return wraps ? minutes >= start || minutes < end : minutes >= start && minutes < end;
}

/**
 * Load/stress/soak run only inside the env's UTC window; smoke runs any time and an env without a window has no limit.
 * `overridden` is true only when the override was actually needed, so the report can record it.
 * @throws {GuardrailError} OUTSIDE_WINDOW
 */
export function checkWindow(
  now: Date,
  window: EnvConfig['windowUtc'],
  type: ProfileType,
  override: boolean,
): { overridden: boolean } {
  if (type === 'smoke' || !window || inWindow(now, window)) return { overridden: false };
  if (override) return { overridden: true };
  const weekend = window.weekends === 'all-day' ? 'all day on weekends' : 'not on weekends';
  throw new GuardrailError(
    'OUTSIDE_WINDOW',
    `${type} runs are allowed only ${window.weekdays} UTC on weekdays and ${weekend}; it is ${DAY_NAMES[now.getUTCDay()]} ` +
      `${now.toISOString().slice(11, 16)} UTC. Wait for the window, or pass --override-window (the report records it)`,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// shared DB: busy check and abort rule
// ---------------------------------------------------------------------------------------------------------------

/** One `sys.dm_db_resource_stats` row (15 s apart): percentages of the DB's limits. */
export interface ResourceSample {
  endTime: Date;
  cpu: number;
  dataIo: number;
  logWrite: number;
}

/**
 * Is somebody else loading the DB? True when the average CPU or data IO of `samples` (the last 5 minutes) is above `limitPct`.
 * No samples gives "not busy" with averages 0, which proves nothing: the caller (DbPhase.busyCheck) refuses a run whose
 * samples are missing before it asks, because idleness is then not shown.
 */
export function checkBusy(samples: ResourceSample[], limitPct = 20): { busy: boolean; avgCpu: number; avgIo: number } {
  const avg = (pick: (s: ResourceSample) => number): number =>
    samples.length === 0 ? 0 : samples.reduce((sum, s) => sum + pick(s), 0) / samples.length;
  const avgCpu = avg((s) => s.cpu);
  const avgIo = avg((s) => s.dataIo);
  return { busy: avgCpu > limitPct || avgIo > limitPct, avgCpu, avgIo };
}

/**
 * Stop the run? True when `consecutive` samples in a row (by time) each have CPU or data IO at or above `pct`.
 * Samples may arrive in any order.
 */
export function dbAbortDecision(samples: ResourceSample[], pct: number, consecutive = 4): boolean {
  const needed = Math.max(1, consecutive);
  const ordered = [...samples].sort((a, b) => a.endTime.getTime() - b.endTime.getTime());
  let run = 0;
  for (const s of ordered) {
    run = s.cpu >= pct || s.dataIo >= pct ? run + 1 : 0;
    if (run >= needed) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// smoke ledger
// ---------------------------------------------------------------------------------------------------------------

export interface SmokeEntry {
  runId: string;
  /** ISO time the smoke passed. */
  at: string;
}

/** Smoke key -> the run that passed it. */
export type SmokeLedger = Record<string, SmokeEntry>;

const ledgerFile = (): string => join(resultsRoot(), '.smoke-ledger.json');

/**
 * sha256 over the listed files (paths and contents), independent of the order they are listed in.
 * The caller (run.ts smokeFiles) lists the k6 script, `core/**`, the feature's and the project's files, so any edit asks
 * for a fresh smoke.
 */
export async function smokeKey(files: string[]): Promise<string> {
  const sorted = [...files].sort();
  const contents = await Promise.all(sorted.map((file) => readFile(file)));
  const hash = createHash('sha256');
  sorted.forEach((file, i) => {
    hash.update(`${file}\0${contents[i]!.length}\0`).update(contents[i]!);
  });
  return hash.digest('hex');
}

/** The ledger on disk. A missing or unreadable file is an empty ledger, so the safe outcome is a fresh smoke. */
export async function readSmokeLedger(): Promise<SmokeLedger> {
  let text: string;
  try {
    text = await readFile(ledgerFile(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === 'object' && data !== null && !Array.isArray(data)) return data as SmokeLedger;
  } catch {
    // fall through: not JSON
  }
  return {};
}

/** Remember that `runId` passed the smoke for `key`. Written through a temp file so a crash never leaves half a ledger. */
export async function recordSmoke(key: string, runId: string): Promise<void> {
  const ledger = await readSmokeLedger();
  ledger[key] = { runId, at: new Date().toISOString() };
  const file = ledgerFile();
  await mkdir(resultsRoot(), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

// ---------------------------------------------------------------------------------------------------------------
// env lock
// ---------------------------------------------------------------------------------------------------------------

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === 'ENOENT';
}

/** The pid in a lock file; `null` when the content is not a pid; `undefined` when the file is gone. */
async function lockHolder(file: string): Promise<number | null | undefined> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
  const trimmed = text.trim();
  return /^\d+$/.test(trimmed) && Number(trimmed) >= 1 ? Number(trimmed) : null;
}

/** A process is alive unless `kill(pid, 0)` says ESRCH (EPERM means it exists but belongs to someone else). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/**
 * Take the run lock of `env`: `<results>/.lock-<env>` holding this process's pid. One run per env at a time.
 * A lock whose process is gone (or whose content is not a pid) is stale and replaced. The returned function releases
 * the lock; it deletes the file only while the file still holds this process's pid, and a second call does nothing.
 * @throws {GuardrailError} RUN_IN_PROGRESS when a live process holds the lock
 */
export async function acquireEnvLock(env: string): Promise<() => Promise<void>> {
  if (!/^[A-Za-z0-9_-]+$/.test(env)) throw new Error(`invalid env name ${JSON.stringify(env)} for the run lock`);
  const dir = resultsRoot();
  await mkdir(dir, { recursive: true });
  const lock = join(dir, `.lock-${env}`);
  // The pid is written to a private file first and hard-linked into place, so the lock never exists without its pid
  // and link() fails atomically when somebody else holds it.
  const staging = join(dir, `.lock-${env}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(staging, `${process.pid}\n`, 'utf8');
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await link(staging, lock);
        return releaser(lock);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const holder = await lockHolder(lock);
      if (holder !== undefined) {
        if (holder !== null && isAlive(holder)) {
          throw new GuardrailError(
            'RUN_IN_PROGRESS',
            `another run is in progress on ${env} (pid ${holder}); if no run is going on this machine, delete ${lock}`,
          );
        }
        await unlink(lock).catch((err: unknown) => {
          if (!isMissing(err)) throw err;
        });
      }
    }
    throw new Error(`could not take the run lock ${lock}: it kept changing hands`);
  } finally {
    await unlink(staging).catch(() => {});
  }
}

function releaser(lock: string): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    if ((await lockHolder(lock)) !== process.pid) return;
    await unlink(lock).catch((err: unknown) => {
      if (!isMissing(err)) throw err;
    });
  };
}
