// The known-answer self-test (`perf selftest`): the framework runs smoke -> load -> regression -> stress -> abort demos
// against the local mock (server.ts), which has a bottleneck planted in it, and must find exactly what was planted.
//
// The planted answer: slow-search serves 4 requests at a time for 400 ms each, so it carries 10 req/s. A stress run counts
// requests, and one items_grid iteration sends 2.05 of them (search, slow_search, export 5% of the time), so slow-search
// saturates at about 10 x 2.05 = 20.5 req/s of total traffic: the break must land near 20 req/s. A 300 ms delay planted on
// slow-search only must flag slow_search and nothing else.
//
// Everything stays on this machine and out of git: the runs go to results/selftest/ (git-ignored, with its own smoke ledger
// and lock), and the baseline the self-test accepts is written into a copy of the feature's journey/workload files under that
// folder, never into the repo's baseline.json. The copy is removed at the end; each run's meta.json keeps the baseline it was
// judged against.

import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { acceptBaseline } from '../baseline.js';
import { loadFeature, loadProject, REPO_ROOT, type Feature, type Project } from '../config.js';
import type { ProfileType } from '../guardrails.js';
import { buildReportModel, renderRunReport, verifyRunReport, type ReportModel } from '../report/build.js';
import { runFeature, RunInterruptedError, type RunOptions, type RunResult } from '../run.js';
import { startMockServer, type MockServer } from './server.js';

export interface SelftestCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelftestResult {
  passed: boolean;
  results: SelftestCheck[];
}

export interface SelftestOptions {
  /** Progress lines (default: the console). The k6 output itself stays in each run's k6.log. */
  log?: (line: string) => void;
}

const PROJECT = 'selftest';
const FEATURE = 'items';
const ENV = 'local';

/** The window the stress break must land in, req/s of total traffic (planted: about 20.5). */
const BREAK_MIN_RPS = 14;
const BREAK_MAX_RPS = 26;

/**
 * An abort demo must stop at least this long before its profile would have ended, so a run whose threshold failed only at
 * the end (also k6 exit 99) does not pass. Observed: 55 s and 23 s short of the 85 s load profile.
 */
const ABORT_MARGIN_SEC = 10;

const CHECKS = {
  smoke: 'smoke passes',
  loadA: 'load A accepted as baseline',
  loadB: 'load B unchanged → PASS with zero flags',
  regression: 'extra delay 300 ms → DEGRADED with P95_REGRESSION on items.slow_search and none on items.search',
  stress: `stress finds the break between ${BREAK_MIN_RPS} and ${BREAK_MAX_RPS} req/s`,
  errorAbort: 'fail rate 0.5 → FAIL, abortReason thresholds',
  p95Abort: 'abort p95Ms 300 with extra delay 500 ms → FAIL, abortReason thresholds',
  sources: 'report --verify-sources passes for every run above',
} as const;

/** The selftest project's env adapter reads these; the token endpoint is the mock's. */
const AUTH_ENV = {
  PERF_TOKEN_CLIENT_ID: 'perf',
  PERF_SCOPE: 'openid perf offline_access',
  PERF_USER_LOGIN: 'perf',
  PERF_USER_PASSWORD: 'perf',
};

/** Set `vars` in process.env; the returned function puts back what was there before. */
function setEnv(vars: Record<string, string>): () => void {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]));
  Object.assign(process.env, vars);
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

/**
 * The selftest feature, with its journey and workload files copied into a fresh folder under `root`, so the baseline the
 * self-test accepts lands there. The script stays where it is: its imports of core/ are relative to it.
 */
async function isolatedFeature(project: Project, root: string): Promise<{ feature: Feature; remove: () => Promise<void> }> {
  const original = await loadFeature(project, FEATURE);
  await mkdir(root, { recursive: true });
  const dir = await mkdtemp(join(root, `.feature-${FEATURE}-`));
  for (const name of ['journey.yaml', 'workload.yaml']) await copyFile(join(original.dir, name), join(dir, name));
  return { feature: { ...original, dir }, remove: () => rm(dir, { recursive: true, force: true }) };
}

const ms = (value: number | undefined): string => (value === undefined ? '–' : `${Math.round(value)} ms`);

/** `items.search 21 ms (baseline 20 ms), …` for the steps the run measured. */
function p95Line(model: ReportModel): string {
  return model.steps.map((s) => `${s.id} ${ms(s.p95)}${model.baseline?.steps[s.id] ? ` (baseline ${ms(model.baseline.steps[s.id]!.p95)})` : ''}`).join(', ');
}

/**
 * Run the known-answer self-test: start the mock, run the eight checks in order, stop the mock. A check that throws is a
 * failed check (its detail says why) and the next one still runs; after an interrupt (Ctrl+C) the rest are not run.
 */
export async function runSelftest(opts: SelftestOptions = {}): Promise<SelftestResult> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const root = join(REPO_ROOT, 'results', 'selftest');
  const mock: MockServer = await startMockServer();
  const restoreEnv = setEnv({
    ...AUTH_ENV,
    PERF_SELFTEST_URL: mock.url,
    PERF_TOKEN_URL: `${mock.url}/oauth/token`,
    PERF_RESULTS_DIR: root,
    // No live dashboard server: port 5665 stays free for any other k6 on this machine. The exported page is still written.
    K6_WEB_DASHBOARD_PORT: '-1',
  });

  const results: SelftestCheck[] = [];
  const runDirs: string[] = [];
  const total = Object.keys(CHECKS).length;
  let interrupted = false;
  let removeFeature: (() => Promise<void>) | undefined;

  try {
    // project.yaml expands PERF_SELFTEST_URL when it is loaded, so only now.
    const project = await loadProject(PROJECT);
    const isolated = await isolatedFeature(project, root);
    const feature = isolated.feature;
    removeFeature = isolated.remove;
    log(`selftest: mock ${mock.url}; run folders in ${root}; baseline in ${feature.dir} (removed at the end)`);

    const run = async (profile: ProfileType, extra: Partial<RunOptions> = {}): Promise<{ result: RunResult; model: ReportModel }> => {
      const result = await runFeature({
        project,
        feature,
        env: ENV,
        profile,
        quiet: true,
        log: (message) => log(`  perf: ${message}`),
        ...extra,
      });
      runDirs.push(result.runDir);
      if (result.meta.interrupted) interrupted = true;
      return { result, model: await buildReportModel(result.runDir, { project, feature }) };
    };

    /** A load run with the mock changed for its duration only. */
    const plantedLoad = async (plant: { extraDelayMs?: number; failRate?: number }, extra: Partial<RunOptions> = {}) => {
      mock.setExtraDelay(plant.extraDelayMs ?? 0);
      mock.setFailRate(plant.failRate ?? 0);
      try {
        return await run('load', extra);
      } finally {
        mock.setExtraDelay(0);
        mock.setFailRate(0);
      }
    };

    const check = async (name: string, fn: () => Promise<{ ok: boolean; detail: string }>): Promise<void> => {
      const n = results.length + 1;
      if (interrupted) {
        results.push({ name, ok: false, detail: 'not run: the self-test was interrupted' });
        return;
      }
      log(`selftest: ${n}/${total} ${name}`);
      let outcome: { ok: boolean; detail: string };
      try {
        outcome = await fn();
      } catch (err) {
        if (err instanceof RunInterruptedError) interrupted = true;
        outcome = { ok: false, detail: `error: ${(err as Error).message}` };
      }
      results.push({ name, ...outcome });
      log(`selftest: ${n}/${total} ${outcome.ok ? 'ok' : 'FAILED'}: ${outcome.detail}`);
    };

    /**
     * The run was cut short by an abortOnFail threshold on `metric`: verdict FAIL with abortReason `thresholds`, k6 says in
     * k6.log that it stopped early because of that metric, and the run lasted clearly less than its profile. Exit 99 alone is
     * not proof: a threshold that fails only at the end of the run also exits 99. `p95Ms` is the abort limit the run must have
     * applied, from the run option.
     */
    const thresholdAbort = async (
      { result, model }: { result: RunResult; model: ReportModel },
      expect: { metric: 'http_req_failed' | 'http_req_duration'; p95Ms?: number },
    ) => {
      const { abortReason } = result.meta.k6;
      const logText = await readFile(join(result.runDir, 'k6.log'), 'utf8').catch(() => '');
      const tripped = /thresholds on metrics '([^']*)' were crossed; at least one has abortOnFail enabled/.exec(logText)?.[1];
      const metrics = tripped?.split(',').map((m) => m.trim()) ?? [];
      const totalSec = result.meta.profile.totalSec;
      const early = model.durationSec > 0 && model.durationSec <= totalSec - ABORT_MARGIN_SEC;
      const abort = result.meta.abort;
      const limitOk =
        expect.p95Ms === undefined || (abort?.p95Ms === expect.p95Ms && abort?.source.p95Ms === 'override');
      return {
        ok: model.verdict.verdict === 'FAIL' && abortReason === 'thresholds' && metrics.includes(expect.metric) && early && limitOk,
        detail:
          `verdict ${model.verdict.verdict}, abortReason ${abortReason ?? 'none'}, k6 exit ${result.exitCode ?? '-'}, ` +
          `aborted on ${tripped ?? 'no metric (k6.log has no early stop)'}, ` +
          `stopped after ${Math.round(model.durationSec)} s of ${totalSec} s (must be <= ${totalSec - ABORT_MARGIN_SEC} s)` +
          (expect.p95Ms === undefined ? '' : `, p95 limit ${abort?.p95Ms ?? '-'} ms from ${abort?.source.p95Ms ?? '-'}`) +
          ` — ${result.meta.runId}`,
      };
    };

    await check(CHECKS.smoke, async () => {
      const { result, model } = await run('smoke');
      return {
        ok: result.ok && result.exitCode === 0 && model.verdict.verdict === 'NO BASELINE',
        detail: `k6 exit ${result.exitCode ?? '-'}, verdict ${model.verdict.verdict} — ${result.meta.runId}`,
      };
    });

    await check(CHECKS.loadA, async () => {
      const { result, model } = await run('load');
      const message = await acceptBaseline(result.runDir, { project, feature });
      return { ok: true, detail: `verdict ${model.verdict.verdict}; ${message}` };
    });

    await check(CHECKS.loadB, async () => {
      const { result, model } = await run('load');
      const { verdict } = model.verdict;
      return {
        ok: verdict === 'PASS' && model.flags.length === 0,
        detail: `verdict ${verdict}, ${model.flags.length} flag(s); p95 ${p95Line(model)} — ${result.meta.runId}`,
      };
    });

    await check(CHECKS.regression, async () => {
      const { result, model } = await plantedLoad({ extraDelayMs: 300 });
      const regressed = (step: string): boolean => model.flags.some((f) => f.code === 'P95_REGRESSION' && f.step === step);
      const flags = model.flags.map((f) => `${f.code}${f.step ? ` ${f.step}` : ''}`).join(', ') || 'none';
      return {
        ok: model.verdict.verdict === 'DEGRADED' && regressed('items.slow_search') && !regressed('items.search'),
        detail: `verdict ${model.verdict.verdict}; flags: ${flags}; p95 ${p95Line(model)} — ${result.meta.runId}`,
      };
    });

    await check(CHECKS.stress, async () => {
      const { result, model } = await run('stress', { allowMax: true });
      const bp = model.breakingPoint;
      const planted = 'planted: slow-search 10 req/s x 2.05 requests per iteration ≈ 20.5 req/s';
      if (!bp) return { ok: false, detail: `no stage broke (k6 exit ${result.exitCode ?? '-'}); ${planted} — ${result.meta.runId}` };
      return {
        ok: bp.rps >= BREAK_MIN_RPS && bp.rps <= BREAK_MAX_RPS,
        detail: `broke at the ${bp.rps} req/s stage, ${bp.gaveFirst} first, at ${bp.atSec} s; ${planted} — ${result.meta.runId}`,
      };
    });

    await check(CHECKS.errorAbort, async () => thresholdAbort(await plantedLoad({ failRate: 0.5 }), { metric: 'http_req_failed' }));

    await check(CHECKS.p95Abort, async () =>
      thresholdAbort(await plantedLoad({ extraDelayMs: 500 }, { abortOverride: { p95Ms: 300 } }), { metric: 'http_req_duration', p95Ms: 300 }),
    );

    // What `perf report <dir> --verify-sources` does: rebuild the report from the folder alone, then trace every number.
    await check(CHECKS.sources, async () => {
      if (runDirs.length === 0) return { ok: false, detail: 'no run folders to check' };
      const problems: string[] = [];
      let traced = 0;
      for (const dir of runDirs) {
        const rendered = await renderRunReport(dir);
        if (!rendered.ok) {
          problems.push(`${dir}: the report could not be built (${rendered.error})`);
          continue;
        }
        const { checked, mismatches } = await verifyRunReport(dir);
        traced += checked;
        if (checked === 0) problems.push(`${dir}: no numbers to check`);
        for (const mismatch of mismatches) problems.push(`${dir}: ${mismatch}`);
      }
      return problems.length === 0
        ? { ok: true, detail: `${runDirs.length} run folders, all ${traced} numbers traced` }
        : { ok: false, detail: problems.join('; ') };
    });
  } catch (err) {
    // Setup failed (mock, project, feature copy): every check not yet run fails with the reason.
    for (const name of Object.values(CHECKS).slice(results.length)) {
      results.push({ name, ok: false, detail: `not run: ${(err as Error).message}` });
    }
  } finally {
    await removeFeature?.().catch(() => {});
    restoreEnv();
    await mock.stop();
  }

  return { passed: results.length === total && results.every((r) => r.ok), results };
}

/** The result table and the closing `selftest: N/M passed` line. */
export function formatSelftest({ results }: SelftestResult): string[] {
  const lines = results.map((r, i) => `  ${r.ok ? 'ok    ' : 'FAILED'} ${i + 1}. ${r.name}\n           ${r.detail}`);
  return ['selftest: results', ...lines, `selftest: ${results.filter((r) => r.ok).length}/${results.length} passed`];
}
