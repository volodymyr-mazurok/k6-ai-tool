// Run configuration for k6 scripts. k6 only: uses the init-context globals `open` and `__ENV`.
// The runner writes the RunConfig and a secrets file for every run and passes their absolute paths in env vars,
// so a script started without them (a raw `k6 run`) refuses to run and cannot bypass the caps.

import { buildScenarios } from './lib/profiles.js';
import { buildThresholds } from './lib/thresholds.js';

const SUMMARY_TREND_STATS = ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)', 'count'];

/** Env var name -> text of the error when it is missing. */
function requireEnv(name) {
  const value = __ENV[name];
  if (!value) throw new Error(name + ' not set — start runs with: npm run perf -- run …');
  return value;
}

/**
 * Read the RunConfig JSON written by the runner. Call it at the top level of the script (init context).
 * @returns {any} RunConfig
 */
export function loadRunConfig() {
  return JSON.parse(open(requireEnv('PERF_CONFIG_FILE')));
}

/**
 * Read the secrets file `{ accounts: { <role>: { login, password } } }`. Init context only.
 * @returns {{ accounts: Record<string, { login: string, password: string }> }}
 */
export function loadSecrets() {
  return JSON.parse(open(requireEnv('PERF_SECRETS_FILE')));
}

/**
 * The k6 `options` for a run: scenarios from the profile and caps, k6's rps option (cfg.rps, else the cap), thresholds for
 * every step id.
 * Step ids are `<journey.key>.<step.name>`, plus `auth_token` for the token requests (not for a static header).
 * @param {any} cfg RunConfig
 */
export function buildOptions(cfg) {
  const { scenarios, rps } = buildScenarios({
    profile: cfg.profile,
    journeys: cfg.journeys,
    mix: cfg.mix,
    caps: cfg.caps,
    stepsPerIteration: cfg.stepsPerIteration,
    rps: cfg.rps,
  });
  // A static header sends no token request, so it gets no auth_token threshold (which would leave an empty metric).
  const stepIds = cfg.auth && cfg.auth.type === 'static_header' ? [] : ['auth_token'];
  for (const journey of cfg.journeys) {
    for (const s of journey.steps) stepIds.push(journey.key + '.' + s.name);
  }
  return {
    scenarios,
    rps,
    thresholds: buildThresholds({ stepIds, profileType: cfg.profile.type, abort: cfg.abort }),
    summaryTrendStats: SUMMARY_TREND_STATS,
    setupTimeout: '2m',
  };
}
