import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface K6RunResult {
  /** k6 exit code; -1 when k6 was killed (timeout) or could not be started. */
  code: number;
  stdout: string;
  stderr: string;
  /** Temp run folder (holds k6-config.json and whatever the script writes, e.g. summary.json). The caller removes it. */
  runDir: string;
}

const K6_TIMEOUT_MS = 120_000;
const PERF_ENV_KEYS = ['PERF_CONFIG_FILE', 'PERF_SECRETS_FILE', 'PERF_RUN_DIR'];

/**
 * Run `k6 run <script>` the way the runner does: the config goes to `<runDir>/k6-config.json`, the secrets to
 * a mode-0600 temp file that is deleted as soon as k6 exits, and both paths reach the script as env vars.
 * Pass `null` for `cfg` / `secrets` to leave the matching env var unset.
 * The caller must `rm` the returned `runDir` when it is done with it.
 */
export async function runK6Script(script: string, cfg: object | null, secrets: object | null): Promise<K6RunResult> {
  const runDir = await mkdtemp(join(tmpdir(), 'perf-run-'));
  const secretsDir = await mkdtemp(join(tmpdir(), 'perf-secrets-'));
  try {
    // Never inherit the PERF_* variables of the parent process: a test must control them completely.
    const env: NodeJS.ProcessEnv = { ...process.env, K6_NO_USAGE_REPORT: 'true', PERF_RUN_DIR: runDir };
    for (const key of PERF_ENV_KEYS.filter((k) => k !== 'PERF_RUN_DIR')) delete env[key];

    if (cfg !== null) {
      const cfgFile = join(runDir, 'k6-config.json');
      await writeFile(cfgFile, JSON.stringify(cfg), 'utf8');
      env.PERF_CONFIG_FILE = cfgFile;
    }
    if (secrets !== null) {
      const secretsFile = join(secretsDir, 'secrets.json');
      await writeFile(secretsFile, JSON.stringify(secrets), { encoding: 'utf8', mode: 0o600 });
      env.PERF_SECRETS_FILE = secretsFile;
    }

    return await new Promise<K6RunResult>((resolve) => {
      const child = spawn('k6', ['run', '--no-color', script], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: K6_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: `${stderr}\ncould not run k6: ${err.message}`, runDir }));
      child.on('close', (code, signal) =>
        resolve({ code: code ?? -1, stdout, stderr: signal ? `${stderr}\nk6 killed by ${signal}` : stderr, runDir }),
      );
    });
  } catch (err) {
    await rm(runDir, { recursive: true, force: true });
    throw err;
  } finally {
    await rm(secretsDir, { recursive: true, force: true });
  }
}
