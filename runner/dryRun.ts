// `perf run --dry-run`: what a real run would do, up to the point where it would touch anything. It resolves the project, feature,
// env and profile with the same code a run uses (resolveRun, effectiveAbort), so every guardrail that can refuse a run before
// anything is sent refuses here too, and it prints the sizes and the k6 command line.
//
// It takes no lock, fetches no tokens, writes no secrets file, no run folder and no ledger entry, and does not start k6 (not even
// `k6 version`). What a real run checks after that (the journey against swagger, the standing data, the busy check, the k6
// version) is named in the output as not checked.

import { join } from 'node:path';
import { loadFeature, loadProject, type EnvConfig } from './config.js';
import { readSmokeLedger, resultsRoot, type ResolvedProfile } from './guardrails.js';
import { ignoredK6Variables, k6RunArgs, k6RunVariables } from './k6.js';
import { FORMATS } from './report/formats.js';
import { effectiveAbort, k6ExtraEnv, k6RpsOption, resolveRun, runSmokeKey, type RunAbort, type RunOptions } from './run.js';

/** Stands for the new run folder in the printed command; the real name carries the start time. */
const RUN_DIR = '<runDir>';
const SECRETS_FILE = '<secrets-file>';

export interface DryRunPlan {
  project: string;
  feature: string;
  env: string;
  envCfg: EnvConfig;
  profile: ResolvedProfile;
  /** The load window had to be overridden (`--override-window`). */
  windowOverride: boolean;
  /** `--allow-max`: sizes up to the caps, and a load or soak's rps option at max_rps instead of defaults.rps. */
  allowMax: boolean;
  abort: RunAbort;
  /** Load/stress/soak only: a smoke runs first unless the ledger holds a passing one for this script, config and env. */
  smoke?: { runsFirst: boolean; passedRunId?: string };
  /** Inherited K6_* variables that k6 will not get. */
  ignoredK6Variables: string[];
  k6: { args: string[]; variables: Record<string, string> };
  resultsDir: string;
}

/**
 * Resolve a run without starting it.
 * @throws {GuardrailError} ENV_NOT_ALLOWED | CAPS_EXCEEDED | ABOVE_DEFAULTS | OUTSIDE_WINDOW | ABORT_LOOSENED
 * @throws {ConfigError} when the project or feature is missing or invalid, or the workload has no profile of that type
 */
export async function planRun(opts: RunOptions): Promise<DryRunPlan> {
  const now = opts.now ?? (() => new Date());
  const project = typeof opts.project === 'string' ? await loadProject(opts.project) : opts.project;
  const feature = typeof opts.feature === 'string' ? await loadFeature(project, opts.feature) : opts.feature;
  const abort = effectiveAbort(project, feature, opts.abortOverride);
  const { envCfg, profile, windowOverride } = resolveRun(opts, project, feature, now);

  let smoke: DryRunPlan['smoke'];
  if (profile.type !== 'smoke') {
    const entry = (await readSmokeLedger())[await runSmokeKey(project, feature, opts.env)];
    smoke = entry ? { runsFirst: false, passedRunId: entry.runId } : { runsFirst: true };
  }
  return {
    project: project.name,
    feature: feature.name,
    env: opts.env,
    envCfg,
    profile,
    windowOverride,
    allowMax: opts.allowMax ?? false,
    abort,
    ...(smoke ? { smoke } : {}),
    ignoredK6Variables: ignoredK6Variables(),
    k6: {
      args: k6RunArgs(feature.script, RUN_DIR),
      variables: k6RunVariables({ runDir: RUN_DIR, configFile: join(RUN_DIR, 'k6-config.json'), secretsFile: SECRETS_FILE, env: k6ExtraEnv(profile) }),
    },
    resultsDir: resultsRoot(),
  };
}

const dur = (sec: number): string => FORMATS.dur(sec);

/** `Name:  value` with the values lined up. */
const field = (name: string, value: string): string => `${`${name}:`.padEnd(10)} ${value}`;

/** A script path that needs quoting in a shell is quoted; the placeholders are left as they are. */
const shellWord = (word: string): string => (/^[\w./:@%+=,<>-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`);

function usersLine(plan: DryRunPlan): string {
  const { profile, envCfg } = plan;
  if (profile.type === 'smoke') return '1 per journey, one iteration each';
  if (profile.type === 'stress') return `up to ${envCfg.caps.maxVus} virtual users (the env's max_vus); the arrival rate sets the load`;
  return `${profile.users} (ramp up ${dur(profile.rampSec!)}, hold ${dur(profile.holdSec!)}, ramp down ${dur(profile.rampDownSec!)})`;
}

function rateLine(plan: DryRunPlan): string {
  const { profile, envCfg, allowMax } = plan;
  const rps = k6RpsOption(profile.type, envCfg, allowMax);
  const heldAtDefault = (profile.type === 'load' || profile.type === 'soak') && !allowMax;
  const source = heldAtDefault
    ? `the env's defaults.rps of ${rps}; --allow-max raises it to max_rps ${envCfg.caps.maxRps}`
    : `the env's max_rps of ${envCfg.caps.maxRps}`;
  const option = `k6's rps option, set to ${source}`;
  if (profile.type === 'stress') {
    const levels = profile.stages!.map((s) => s.rps);
    const each = profile.stages!.length > 1 ? profile.stages![1]!.fromSec - profile.stages![0]!.fromSec : profile.totalSec;
    return `${levels.join(', ')} req/s, each level ${dur(each)} (${option})`;
  }
  return `at most ${rps} req/s (${option})${profile.type === 'smoke' ? '' : '; the users pace themselves by think time'}`;
}

function windowLine(plan: DryRunPlan): string {
  const { envCfg, profile } = plan;
  if (profile.type === 'smoke') return 'a smoke runs any time';
  if (!envCfg.windowUtc) return 'this env has no load window';
  const window = `${envCfg.windowUtc.weekdays} UTC on weekdays, ${envCfg.windowUtc.weekends === 'all-day' ? 'all day' : 'not'} on weekends`;
  return plan.windowOverride ? `OUTSIDE ${window}: --override-window is needed and the report will record it` : `inside ${window}`;
}

function abortLine(abort: RunAbort): string {
  const part = (label: string, value: string, key: keyof RunAbort['source']): string =>
    `${label} ${value}${abort.source[key] === 'project' ? '' : ` (${abort.source[key]})`}`;
  return [
    part('error rate', String(abort.errorRate), 'errorRate'),
    part('p95', `${abort.p95Ms} ms`, 'p95Ms'),
    abort.dbCpuOrIoPct === undefined
      ? 'no database limit (a project that has a database is refused without one)'
      : part('database CPU or IO', `${abort.dbCpuOrIoPct}%`, 'dbCpuOrIoPct') + ' (applies only to a project that reads its database)',
  ].join(', ');
}

/** The lines `perf run --dry-run` prints. */
export function formatDryRun(plan: DryRunPlan): string[] {
  const { profile } = plan;
  const lines = [
    `perf: dry run of ${plan.project}/${plan.feature} on ${plan.env}: nothing is sent, no lock is taken, no tokens are fetched, no file is written, k6 is not started`,
    field('profile', profile.type),
    field('users', usersLine(plan)),
    field('req/s', rateLine(plan)),
    field('duration', profile.type === 'smoke' ? 'a few seconds (one iteration of each journey)' : dur(profile.totalSec)),
    field('window', windowLine(plan)),
    field('abort', abortLine(plan.abort)),
  ];
  if (plan.smoke) {
    lines.push(
      field(
        'smoke',
        plan.smoke.runsFirst
          ? `runs first (no passing smoke of this script and config on ${plan.env} yet), with this command line in a run folder of its own`
          : `passed already (${plan.smoke.passedRunId})`,
      ),
    );
  }
  lines.push(
    '',
    `k6 command (<runDir> is the new run folder under ${plan.resultsDir}; <secrets-file> a mode-0600 temp file that exists only while k6 runs):`,
    `  k6 ${plan.k6.args.map(shellWord).join(' ')}`,
    'variables k6 gets besides the inherited environment (which loses PERF_* and the K6_* options that would override the run):',
    ...Object.entries(plan.k6.variables).map(([name, value]) => `  ${name}=${shellWord(value)}`),
  );
  if (plan.ignoredK6Variables.length > 0) {
    lines.push(`not passed to k6 (the runner sets k6's options itself): ${plan.ignoredK6Variables.join(', ')}`);
  }
  lines.push('', 'not checked in a dry run: the journey against the env\'s swagger, the standing data, the database busy check, the k6 version');
  return lines;
}
