// k6 script of the example feature. Step names and optional shares come from journey.yaml through the run config
// (PERF_CONFIG_FILE). The routes are written here, in each step() call: the run config carries none. They must be the
// routes journey.yaml names: `perf check` proves journey.yaml against the swagger, and every smoke run compares the
// requests this script really sent with journey.yaml (a mismatch fails the smoke). This file also adds the request
// bodies and the content checks. Start it only through `npm run perf -- run <project> example ...`, never with a plain
// `k6 run`.
//
// A static_header project (project.yaml auth.type: static_header) logs in nowhere: drop setup() and bearer(), build the
// header once at the top level and pass it to every step:
//   import { staticHeaders } from '../../../../core/auth/static.js';
//   const AUTH = staticHeaders(secrets);
//   step('analyst.list_open', { method: 'POST', url: cfg.apiUrl + '/items/search', body: LIST_BODY, headers: AUTH, checks });
//
// Copy to projects/<project>/features/<feature>/<feature>.js. The relative paths below climb to the repo root:
// features/<feature> -> features -> <project> -> projects -> root.
import { loadRunConfig, loadSecrets, buildOptions } from '../../../../core/config.js';
import { fetchTokens, bearer } from '../../../../core/auth/ropc.js';
import { step, think, shouldRun } from '../../../../core/request.js';

export { handleSummary } from '../../../../core/summary.js';

const cfg = loadRunConfig();
const secrets = loadSecrets();

export const options = buildOptions(cfg);

// Once per run: one token per account (never one per iteration).
export function setup() {
  return { tokens: fetchTokens(cfg.auth, secrets.accounts) };
}

const LIST_BODY = { currentPage: 1, currentSize: 20 };

/** Parsed JSON body, or null for an answer that is not JSON: an error page must fail a check, not crash the script. */
function json(res) {
  try {
    return res.json();
  } catch (_err) {
    return null;
  }
}

/** A check answers true or false and never throws. A 200 can still carry an error or an empty list, so look inside. */
const hasItems = (res) => {
  const body = json(res);
  return body !== null && Array.isArray(body.items) && body.items.length > 0;
};

/** The step's share of iterations, from journey.yaml (through the run config). A name that is not there is a script bug. */
function optionalShare(journeyName, stepName) {
  const journey = cfg.journeys.find((j) => j.name === journeyName);
  if (!journey) throw new Error('example.js: journey ' + journeyName + ' is not in journey.yaml');
  const found = journey.steps.find((s) => s.name === stepName);
  if (!found) throw new Error('example.js: journey ' + journeyName + ' has no step ' + stepName + ' in journey.yaml');
  return found.optionalShare;
}
const EXPORT_SHARE = optionalShare('analyst_example_list', 'export');

// The function name is journey.yaml `exec`. The step id passed to step() is <journey key>.<step name>.
export function analystExampleList(data) {
  const token = bearer(data.tokens, 'Analyst');

  step('analyst.list_open', {
    method: 'POST',
    url: cfg.apiUrl + '/items/search',
    body: LIST_BODY,
    token,
    checks: { 'has items': hasItems },
  });
  think(cfg);

  step('analyst.list_search', {
    method: 'POST',
    url: cfg.apiUrl + '/items/search',
    body: { ...LIST_BODY, search: 'a' },
    token,
    checks: { 'has items': hasItems },
  });
  think(cfg);

  if (shouldRun(cfg, EXPORT_SHARE)) {
    step('analyst.export', {
      method: 'POST',
      url: cfg.apiUrl + '/items/export',
      body: LIST_BODY,
      token,
      checks: { 'body is not empty': (res) => Boolean(res.body) && res.body.length > 0 },
    });
  }
}
