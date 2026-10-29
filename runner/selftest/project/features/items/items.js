// Self-test journey against the mock server (runner/selftest/server.ts): search, slow_search and an occasional export.
// Step names and optional shares come from journey.yaml via the run config. The routes are written here, in each step()
// call (the run config carries none); `perf check` proves journey.yaml against the swagger and every smoke compares the
// requests sent here with journey.yaml. The script also adds the bodies and the checks.
import { loadRunConfig, loadSecrets, buildOptions } from '../../../../../core/config.js';
import { fetchTokens, bearer } from '../../../../../core/auth/ropc.js';
import { step, think, shouldRun } from '../../../../../core/request.js';

export { handleSummary } from '../../../../../core/summary.js';

const cfg = loadRunConfig();
const secrets = loadSecrets();

export const options = buildOptions(cfg);

export function setup() {
  return { tokens: fetchTokens(cfg.auth, secrets.accounts) };
}

const SEARCH_BODY = { currentPage: 1, currentSize: 20 };

/** The step's share of iterations, from journey.yaml (through the run config). A name that is not there is a script bug. */
function optionalShare(journeyName, stepName) {
  const journey = cfg.journeys.find((j) => j.name === journeyName);
  if (!journey) throw new Error('items.js: journey ' + journeyName + ' is not in journey.yaml');
  const found = journey.steps.find((s) => s.name === stepName);
  if (!found) throw new Error('items.js: journey ' + journeyName + ' has no step ' + stepName + ' in journey.yaml');
  return found.optionalShare;
}
const EXPORT_SHARE = optionalShare('items_grid', 'export');

/** Parsed JSON body, or null when the answer is not JSON (an error page must fail the check, not crash it). */
function json(res) {
  try {
    return res.json();
  } catch (_err) {
    return null;
  }
}

const hasTwentyItems = (res) => {
  const body = json(res);
  return body !== null && Array.isArray(body.items) && body.items.length === 20;
};
const totalIs500 = (res) => {
  const body = json(res);
  return body !== null && body.totalCount === 500;
};
const SEARCH_CHECKS = { 'has 20 items': hasTwentyItems, 'total count is 500': totalIs500 };

export function itemsGrid(data) {
  step('items.search', {
    method: 'POST',
    url: cfg.apiUrl + '/items/search',
    body: SEARCH_BODY,
    token: bearer(data.tokens, 'User'),
    checks: SEARCH_CHECKS,
  });
  think(cfg);
  step('items.slow_search', {
    method: 'POST',
    url: cfg.apiUrl + '/items/slow-search',
    body: SEARCH_BODY,
    token: bearer(data.tokens, 'User'),
    checks: SEARCH_CHECKS,
  });
  think(cfg);
  if (shouldRun(cfg, EXPORT_SHARE)) {
    step('items.export', {
      method: 'POST',
      url: cfg.apiUrl + '/items/export',
      body: SEARCH_BODY,
      token: bearer(data.tokens, 'User'),
      checks: { 'body is not empty': (res) => Boolean(res.body) && res.body.length > 0 },
    });
  }
}
