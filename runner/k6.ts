// The k6 process: version check, start with the run's files, output tee'd to k6.log, graceful stop.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The installed k6 version, e.g. `2.3.0`.
 * @throws when k6 is not on PATH (with the install command) or older than 1.0
 */
export async function k6Version(): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync('k6', ['version'], { timeout: 30_000 }));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('k6 not found — install with: brew install k6');
    throw new Error(`k6 version failed: ${(err as Error).message}`);
  }
  const match = /v?(\d+)\.(\d+)\.(\d+)/.exec(stdout);
  if (!match) throw new Error(`could not read the k6 version from "${stdout.trim().split('\n')[0]}"`);
  const version = `${match[1]}.${match[2]}.${match[3]}`;
  if (Number(match[1]) < 1) throw new Error(`k6 1.0 or newer required (found ${version})`);
  return version;
}

/** The arguments of the k6 command line for a run (`k6 <args>`). */
export function k6RunArgs(script: string, runDir: string): string[] {
  return ['run', `--out`, `json=${join(runDir, 'points.json.gz')}`, script];
}

export interface StartK6Options {
  script: string;
  runDir: string;
  /** RunConfig JSON (`<runDir>/k6-config.json`). */
  configFile: string;
  /** Temp secrets file; only its path reaches k6. */
  secretsFile: string;
  /** Extra environment for k6 (e.g. a dashboard period). */
  env?: Record<string, string>;
  /** Also print k6's output on this process's stdout/stderr (default true). k6.log gets it either way. */
  echo?: boolean;
}

export interface K6Exit {
  exitCode: number | null;
  signal: string | null;
}

export interface K6Process {
  /** Resolves when k6 has exited and k6.log is flushed. */
  done: Promise<K6Exit>;
  /** Ask k6 to stop gracefully (SIGINT): it ends the iterations, then writes its summary. A second call aborts it. */
  stop(): void;
}

/**
 * Inherited K6_* variables k6 may still see: they only change where the live dashboard is served. Every other K6_*
 * variable would beat the script's options (k6 ranks env above script), e.g. K6_VUS + K6_DURATION replace the
 * scenarios, K6_RPS lifts the rate cap, K6_NO_THRESHOLDS drops the abort rules, K6_HTTP_DEBUG prints the token
 * request body (password included), K6_OUT adds outputs and K6_LOG_FORMAT hides script errors from the log scan.
 */
const INHERITED_K6_ALLOWED = new Set(['K6_WEB_DASHBOARD_PORT', 'K6_WEB_DASHBOARD_HOST']);

const isK6Variable = (key: string): boolean => /^k6_/i.test(key);

/** Names of the K6_* variables in `source` that k6 will not get (names only; values may be secret). Sorted. */
export function ignoredK6Variables(source: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(source)
    .filter((key) => isK6Variable(key) && !INHERITED_K6_ALLOWED.has(key))
    .sort();
}

/**
 * k6's environment: `source` without its PERF_* variables (account logins and passwords among them) and without the
 * K6_* variables that would override the run's options, plus `extra`, which wins.
 */
export function k6Environment(source: NodeJS.ProcessEnv, extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('PERF_')) continue;
    if (isK6Variable(key) && !INHERITED_K6_ALLOWED.has(key)) continue;
    env[key] = value;
  }
  return Object.assign(env, extra);
}

/**
 * The variables k6 gets besides the inherited environment: the web dashboard export and the run's files. `perf run --dry-run`
 * prints them (with placeholder paths), so what it shows is what startK6 sets. The live dashboard listens on 127.0.0.1 only
 * (k6's own default is every interface), unless `source` (the runner's environment) sets K6_WEB_DASHBOARD_HOST.
 */
export function k6RunVariables(
  opts: Pick<StartK6Options, 'runDir' | 'configFile' | 'secretsFile' | 'env'>,
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    K6_NO_USAGE_REPORT: 'true',
    K6_WEB_DASHBOARD: 'true',
    ...(source.K6_WEB_DASHBOARD_HOST ? {} : { K6_WEB_DASHBOARD_HOST: '127.0.0.1' }),
    K6_WEB_DASHBOARD_EXPORT: join(opts.runDir, 'k6-dashboard.html'),
    ...opts.env,
    PERF_CONFIG_FILE: opts.configFile,
    PERF_SECRETS_FILE: opts.secretsFile,
    PERF_RUN_DIR: opts.runDir,
  };
}

/**
 * Start `k6 run --out json=<runDir>/points.json.gz <script>` with the web dashboard exported to
 * `<runDir>/k6-dashboard.html` and the run's files in PERF_CONFIG_FILE / PERF_SECRETS_FILE / PERF_RUN_DIR.
 *
 * k6 runs in its own process group, so a Ctrl+C in the terminal reaches only the runner, which forwards exactly one
 * SIGINT through stop(); two SIGINTs would make k6 abort without its summary. If the runner dies, k6 dies too:
 * on exit the runner kills it, and otherwise k6's next progress line hits a closed pipe.
 *
 * k6 gets this process's environment through k6Environment(): no PERF_* variable (account logins and passwords
 * among them) and no inherited K6_* variable that could override the run's options.
 */
export function startK6(opts: StartK6Options): K6Process {
  const { script, runDir, configFile, secretsFile, echo = true } = opts;
  const env = k6Environment(process.env, k6RunVariables({ runDir, configFile, secretsFile, env: opts.env }));

  const log = createWriteStream(join(runDir, 'k6.log'));
  const child = spawn('k6', k6RunArgs(script, runDir), { env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  child.stdout.on('data', (chunk: Buffer) => {
    log.write(chunk);
    if (echo) process.stdout.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    log.write(chunk);
    if (echo) process.stderr.write(chunk);
  });

  const running = (): boolean => child.exitCode === null && child.signalCode === null;
  const killOnExit = (): void => {
    if (running()) child.kill('SIGKILL');
  };
  process.on('exit', killOnExit);

  const done = new Promise<K6Exit>((resolve, reject) => {
    let settled = false;
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      process.off('exit', killOnExit);
      log.end(() => reject(err));
    });
    child.once('close', (exitCode, signal) => {
      if (settled) return;
      settled = true;
      process.off('exit', killOnExit);
      log.end(() => resolve({ exitCode, signal }));
    });
  });

  return {
    done,
    stop: () => {
      if (running()) child.kill('SIGINT');
    },
  };
}

/** k6 logs an exception thrown inside an iteration (or setup) as an error line with hint "script exception". */
export function countScriptErrors(logText: string): number {
  return logText
    .split('\n')
    .filter((line) => line.includes('level=error') && (line.includes('hint="script exception"') || line.includes('source=stacktrace')))
    .length;
}
