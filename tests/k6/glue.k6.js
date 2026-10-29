// Two-step journey against the mock server (runner/selftest/server.ts). Used only by glue.test.ts.
// cfg.data switches (set by the test, never by a real run):
//   noChecks: true      -> the first step is called with an empty `checks` object
//   expireTokens: true  -> setup() marks every token as expired, so the first bearer() call must refresh it
//   optionalShare: N    -> percent of iterations that run the second step (default 100); smoke ignores it
//   throwingCheck: true -> the first step carries a check that throws
import { loadRunConfig, loadSecrets, buildOptions } from '../../core/config.js';
import { fetchTokens, bearer } from '../../core/auth/ropc.js';
import { step, think, shouldRun } from '../../core/request.js';

export { handleSummary } from '../../core/summary.js';

const cfg = loadRunConfig();
const secrets = loadSecrets();

export const options = buildOptions(cfg);

export function setup() {
  const tokens = fetchTokens(cfg.auth, secrets.accounts);
  if (cfg.data && cfg.data.expireTokens) {
    for (const role of Object.keys(tokens)) tokens[role].exp = 0;
  }
  return { tokens };
}

const SEARCH_BODY = { currentPage: 1, currentSize: 20 };
const optionalShare = cfg.data && cfg.data.optionalShare !== undefined ? cfg.data.optionalShare : 100;
const hasTwentyItems = (res) => res.json().items.length === 20;

export function itemsGrid(data) {
  const noChecks = Boolean(cfg.data && cfg.data.noChecks);
  step('items.search', {
    method: 'POST',
    url: cfg.apiUrl + '/items/search',
    body: SEARCH_BODY,
    token: bearer(data.tokens, 'User'),
    checks: noChecks
      ? {}
      : Object.assign(
          { 'has 20 items': hasTwentyItems },
          cfg.data && cfg.data.throwingCheck
            ? {
                throws: () => {
                  throw new Error('planted check error');
                },
              }
            : {},
        ),
  });
  think(cfg);
  if (shouldRun(cfg, optionalShare)) {
    step('items.slow_search', {
      method: 'POST',
      url: cfg.apiUrl + '/items/slow-search',
      body: SEARCH_BODY,
      token: bearer(data.tokens, 'User'),
      checks: { 'has 20 items': hasTwentyItems },
    });
  }
}
