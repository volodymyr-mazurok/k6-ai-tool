// perf <command>: the runner's command line (`npm run perf -- <command> …`).
// Exit codes: 0 done, 1 the run failed (or `check` found problems, `doctor` a failing check, or a `selftest` check
// failed), 2 refused (guardrail, config, journey check, a baseline that cannot be accepted) or misused, 130 interrupted.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadAdapter } from './adapter.js';
import { acceptBaseline, BaselineRefusedError, compareRuns } from './baseline.js';
import { checkFeature, formatProblem, JourneyCheckError, SwaggerError } from './checks.js';
import { ConfigError, loadFeature, loadProject, type Project } from './config.js';
import { doctor, formatCheck } from './doctor.js';
import { formatDryRun, planRun } from './dryRun.js';
import { acquireEnvLock, checkEnv, GuardrailError, type ProfileType } from './guardrails.js';
import { summarizeHar } from './har.js';
import { NotARunFolderError, renderRunReport, verifyRunReport } from './report/build.js';
import { runFeature, RunInterruptedError } from './run.js';
import type { Verdict } from './report/model.js';
import { formatSelftest, runSelftest } from './selftest/selftest.js';
import { resolveStandingSpec } from './standing.js';

const PROFILES: ProfileType[] = ['smoke', 'load', 'stress', 'soak'];

const USAGE = `Usage: npm run perf -- <command> …

Commands:
  doctor [<project> --env <env>]
      Check that this machine can run tests: k6 (1.0 or newer), Node (22 or newer), the npm dependencies. With a project and an env
      also: the project loads and allows the env, its accounts resolve, swagger answers 200, one token per role works and the
      database answers with VIEW DATABASE STATE and its tier. Prints "✓ …", or "✗ … — how to fix it", one line per check; never a
      login, password or token. Sends at most one token request per role. Exits 1 when a check fails.
  run <project> <feature> --profile <smoke|load|stress|soak> --env <env> [--dry-run] [--allow-max] [--override-window] [--override-busy]
      Run a feature with k6 under the guardrails; a load/stress/soak run does a smoke first when none passed yet.
      --dry-run           resolve the run as a real one would (guardrails included) and print its users, req/s, duration and
                          the k6 command; takes no lock, fetches no tokens, writes nothing, starts no k6
      --allow-max         above the env defaults, up to the caps
      --override-window   outside the load window (recorded in the report; only with the owner's OK)
      --override-busy     even when the database is busy (makes the verdict INVALID; only with the owner's OK)
  check <project> <feature> --env <env>
      Check journey.yaml without running anything: every step cites evidence, its route and method exist in the env's
      swagger, and a read-only feature sends no write. Prints the problems, or "0 problems"; exits 1 when there are any.
  setup <project> --env <env> [--set <key>=<value> ...]
      Create the project's standing test data on the env (idempotent: a second run creates nothing). The project's adapter
      reads the settings: the standing_data of a feature workload of the project, with each --set key=value laid over it
      (a value that looks like a number becomes a number). Which keys exist is the project's business; the adapter says what it needs.
  teardown <project> --env <env>
      Remove the standing test data the setup created (only rows the project's own naming marks as its own).
  report <runDir> [--verify-sources]
      Write report.html and report.md for a run folder (a run writes them itself at its end; use this to redo them after a
      change to findings.md or to the report code). --verify-sources then checks every number on the page against the folder's
      files and prints "all N numbers traced", or the numbers that differ (exit code 1).
  har-summary <har> --api <url> --out <json>
      Write the scrubbed summary of a recorded HAR (method, path, status, ms, request body, response top-level keys of the
      calls under --api; no headers, cookies or tokens) as evidence for a journey. Delete the raw HAR afterwards. Exits 1 with
      a warning when no call is under --api (the url is probably wrong).
  baseline accept <runDir>
      Make a run the reference for its feature, env and profile: its per-step p50/p95/p99, error rate and req/s go to that slot
      of the feature's baseline.json (other slots stay; an earlier baseline of the slot is replaced). Refuses a smoke, FAIL or
      INVALID run (exit code 2). Reports already written are not changed, and a re-render with \`report\` keeps the baseline the
      run was judged against (meta.json holds it); later runs are judged by the new one.
  compare <runDirA> <runDirB>
      Print a Markdown table of the two runs' p95 per step with the change from A to B in percent.
  selftest
      Known-answer test of the framework itself (about 10 minutes, nothing leaves this machine): smoke, load, a planted
      regression, stress and two abort demos against a local mock with a planted bottleneck, each checked against the answer.
      Run folders go to results/selftest/; the repo's files are not changed. Prints "selftest: N/N passed"; exits 1 when any
      check fails.
`;

class UsageError extends Error {}

/** The last line of `perf run`: the report's verdict and why, so nobody stops at the exit code. */
export function verdictLine(verdict: Verdict | undefined): string {
  if (!verdict) return 'perf: verdict unknown — the report could not be built (see meta.json)';
  return `perf: verdict ${verdict.verdict} — ${verdict.reasons.join('; ')}`;
}

async function runCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      profile: { type: 'string' },
      env: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      'allow-max': { type: 'boolean', default: false },
      'override-window': { type: 'boolean', default: false },
      'override-busy': { type: 'boolean', default: false },
    },
  });
  const [project, feature, ...extra] = positionals;
  if (!project || !feature || extra.length > 0) throw new UsageError('run needs <project> <feature>');
  if (!values.env) throw new UsageError('run needs --env <env>');
  if (!values.profile || !PROFILES.includes(values.profile as ProfileType)) {
    throw new UsageError(`run needs --profile ${PROFILES.join('|')}`);
  }

  const options = {
    project,
    feature,
    env: values.env,
    profile: values.profile as ProfileType,
    allowMax: values['allow-max'],
    overrideWindow: values['override-window'],
    overrideBusy: values['override-busy'],
  };
  if (values['dry-run']) {
    for (const line of formatDryRun(await planRun(options))) console.log(line);
    return 0;
  }

  const result = await runFeature(options);
  const { meta } = result;
  console.log(`perf: run folder ${result.runDir}`);
  if (meta.interrupted) {
    console.log('perf: interrupted — the run folder holds what k6 measured until it stopped');
    console.log(verdictLine(result.verdict));
    return 130;
  }
  if (meta.k6.abortReason) console.log(`perf: aborted by ${meta.k6.abortReason}`);
  if (meta.k6.scriptErrors > 0) console.log(`perf: ${meta.k6.scriptErrors} script error(s) — see k6.log`);
  if (meta.fingerprint.changed) console.log('perf: the build changed during the run — its numbers mix two builds');
  console.log(result.ok ? 'perf: done' : 'perf: the run failed');
  console.log(verdictLine(result.verdict));
  return result.ok ? 0 : 1;
}

async function doctorCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { env: { type: 'string' } } });
  const [project, ...extra] = positionals;
  if (extra.length > 0) throw new UsageError('doctor needs at most one <project>');
  if (project && !values.env) throw new UsageError('doctor needs --env <env> with a project');
  if (!project && values.env) throw new UsageError('doctor needs a <project> with --env');

  const checks = await doctor(project, values.env, { onCheck: (check) => console.log(formatCheck(check)) });
  const failed = checks.filter((check) => !check.ok).length;
  if (!project) console.log('perf: to check access to an env too: npm run perf -- doctor <project> --env <env>');
  if (failed > 0) console.log(`perf: ${failed} of ${checks.length} checks failed`);
  return failed === 0 ? 0 : 1;
}

async function checkCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { env: { type: 'string' } } });
  const [projectName, featureName, ...extra] = positionals;
  if (!projectName || !featureName || extra.length > 0) throw new UsageError('check needs <project> <feature>');
  if (!values.env) throw new UsageError('check needs --env <env>');

  const project = await loadProject(projectName);
  const feature = await loadFeature(project, featureName);
  const problems = await checkFeature(project, feature, values.env);
  for (const problem of problems) console.log(formatProblem(problem));
  console.log(`${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  return problems.length === 0 ? 0 : 1;
}

/** The arguments setup and teardown share: <project> --env <env>, checked against the project's env allowlist. */
async function dataArgs(
  command: 'setup' | 'teardown',
  args: string[],
  options: Record<string, { type: 'string'; multiple?: boolean }>,
): Promise<{ values: Record<string, string | string[] | undefined>; project: Project; env: string }> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { env: { type: 'string' }, ...options } });
  const [projectName, ...extra] = positionals;
  if (!projectName || extra.length > 0) throw new UsageError(`${command} needs <project>`);
  if (!values.env) throw new UsageError(`${command} needs --env <env>`);
  const project = await loadProject(projectName);
  checkEnv(project, values.env);
  return { values: values as Record<string, string | string[] | undefined>, project, env: values.env };
}

async function setupCommand(args: string[]): Promise<number> {
  const { values, project, env } = await dataArgs('setup', args, {
    set: { type: 'string', multiple: true },
  });
  const log = (message: string) => console.log(`perf: ${message}`);
  const adapter = await loadAdapter(project);
  if (!adapter.setup) throw new ConfigError(`project ${project.name} has no standing data to set up (its adapter defines no setup)`);
  const { spec, source } = await resolveStandingSpec(project, (values.set as string[] | undefined) ?? []);
  const release = await acquireEnvLock(env);
  try {
    log(`setup ${project.name} on ${env} (settings from ${source})`);
    const summary = await adapter.setup(env, spec, log);
    if (summary) log(`standing data ready: ${summary}`);
  } finally {
    await adapter.close?.();
    await release();
  }
  return 0;
}

async function teardownCommand(args: string[]): Promise<number> {
  const { project, env } = await dataArgs('teardown', args, {});
  const log = (message: string) => console.log(`perf: ${message}`);
  const adapter = await loadAdapter(project);
  if (!adapter.teardown) throw new ConfigError(`project ${project.name} has no standing data to tear down (its adapter defines no teardown)`);
  const release = await acquireEnvLock(env);
  try {
    await adapter.teardown(env, log);
  } finally {
    await adapter.close?.();
    await release();
  }
  return 0;
}

async function reportCommand(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { 'verify-sources': { type: 'boolean', default: false } } });
  const [dir, ...extra] = positionals;
  if (!dir || extra.length > 0) throw new UsageError('report needs <runDir>');
  const runDir = resolve(dir);
  if (!existsSync(join(runDir, 'meta.json'))) throw new UsageError(`${dir} is not a run folder: it has no meta.json`);

  const result = await renderRunReport(runDir);
  if (!result.ok) {
    console.error(`perf: the report could not be built: ${result.error}`);
    return 1;
  }
  console.log(`perf: report written: ${join(runDir, 'report.html')} (and report.md)`);
  if (!values['verify-sources']) return 0;

  const { checked, mismatches } = await verifyRunReport(runDir);
  if (mismatches.length > 0) {
    for (const mismatch of mismatches) console.log(`perf: ${mismatch}`);
    console.log(`perf: ${mismatches.length} of ${checked} numbers do not match their source`);
    return 1;
  }
  console.log(`perf: all ${checked} numbers traced`);
  return 0;
}

async function baselineCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  if (subcommand !== 'accept') throw new UsageError('baseline needs a subcommand: baseline accept <runDir>');
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  const [dir, ...extra] = positionals;
  if (!dir || extra.length > 0) throw new UsageError('baseline accept needs <runDir>');
  console.log(`perf: ${await acceptBaseline(resolve(dir))}`);
  return 0;
}

async function compareCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [a, b, ...extra] = positionals;
  if (!a || !b || extra.length > 0) throw new UsageError('compare needs <runDirA> <runDirB>');
  console.log(await compareRuns(resolve(a), resolve(b)));
  return 0;
}

async function selftestCommand(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  if (positionals.length > 0) throw new UsageError('selftest takes no arguments');
  const result = await runSelftest();
  for (const line of formatSelftest(result)) console.log(line);
  return result.passed ? 0 : 1;
}

function harSummaryCommand(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { api: { type: 'string' }, out: { type: 'string' } },
  });
  const [har, ...extra] = positionals;
  if (!har || extra.length > 0) throw new UsageError('har-summary needs <har>');
  if (!values.api) throw new UsageError('har-summary needs --api <url>');
  if (!values.out) throw new UsageError('har-summary needs --out <json>');

  const summary = summarizeHar(har, values.api);
  mkdirSync(dirname(values.out), { recursive: true });
  writeFileSync(values.out, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`perf: ${summary.length} API call${summary.length === 1 ? '' : 's'} summarised into ${values.out}`);
  console.log(`perf: delete the raw HAR now (${har}): it holds the login traffic, tokens and credentials`);
  if (summary.length === 0) {
    console.error(`perf: WARNING: no request in the HAR is under --api ${values.api}; check the API base url (it is probably wrong)`);
    return 1;
  }
  return 0;
}

/** Run the CLI with `argv` (without node and the script); returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (!command || command === '--help' || command === '-h' || command === 'help') {
      console.log(USAGE);
      return command ? 0 : 2;
    }
    if (command === 'doctor') return await doctorCommand(rest);
    if (command === 'run') return await runCommand(rest);
    if (command === 'check') return await checkCommand(rest);
    if (command === 'setup') return await setupCommand(rest);
    if (command === 'teardown') return await teardownCommand(rest);
    if (command === 'report') return await reportCommand(rest);
    if (command === 'baseline') return await baselineCommand(rest);
    if (command === 'compare') return await compareCommand(rest);
    if (command === 'har-summary') return harSummaryCommand(rest);
    if (command === 'selftest') return await selftestCommand(rest);
    throw new UsageError(`unknown command ${command}`);
  } catch (err) {
    if (err instanceof UsageError || (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')) {
      console.error(`perf: ${(err as Error).message}\n\n${USAGE}`);
      return 2;
    }
    if (err instanceof GuardrailError) {
      console.error(`perf: refused (${err.code}): ${err.message}`);
      return 2;
    }
    if (err instanceof JourneyCheckError || err instanceof SwaggerError) {
      console.error(`perf: refused (journey check): ${err.message}`);
      return 2;
    }
    if (err instanceof ConfigError || err instanceof BaselineRefusedError || err instanceof NotARunFolderError) {
      console.error(`perf: ${err.message}`);
      return 2;
    }
    if (err instanceof RunInterruptedError) {
      console.error(`perf: ${err.message}`);
      return 130;
    }
    console.error(`perf: ${(err as Error).message}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
