// OAuth2 resource-owner password grant (ROPC). k6 only.
// Tokens are fetched once per account in setup() and handed to the VUs as setup data. Each VU works on its own
// copy and refreshes it lazily, only when it is within 300 s of expiry, or half its life when that is shorter (see
// tokenTiming). The expiry is the JWT's exp claim, or `expires_in` for an opaque token (or a JWT whose exp the local clock
// already sees as past). Every token request is tagged
// name:auth_token. Error text never contains passwords or tokens.

import http from 'k6/http';
import { needsRefresh, tokenTiming } from '../lib/tokens.js';

/**
 * @typedef {object} AuthConfig
 * @property {'ropc'} type
 * @property {string} tokenUrl
 * @property {string} clientId
 * @property {string} scope
 *
 * @typedef {object} TokenState
 * @property {string} access access token (a JWT, or opaque)
 * @property {string} refresh refresh token
 * @property {number} exp expiry of the access token, epoch seconds
 * @property {number} marginSec refresh this many seconds before exp: the smaller of 300 and half the token's life
 * @property {AuthConfig} auth where and how to refresh; setup data is plain JSON, so the state carries it along
 */

/**
 * POST to the token endpoint, tagged auth_token. Returns the parsed body of a 200 answer, otherwise throws.
 * @param {AuthConfig} auth
 * @param {Record<string, string>} form
 * @param {string} role
 * @param {string} what text for the error when the endpoint does not answer 200
 * @returns {{ access_token: string, refresh_token?: string }}
 */
function tokenRequest(auth, form, role, what) {
  const res = http.post(auth.tokenUrl, form, { tags: { name: 'auth_token' } });
  if (res.status !== 200) throw new Error(what + ' returned ' + res.status + ' for ' + role);
  let body;
  try {
    body = res.json();
  } catch (_err) {
    throw new Error(what + ' for ' + role + ' did not return JSON');
  }
  if (!body || typeof body.access_token !== 'string') {
    throw new Error(what + ' for ' + role + ' returned no access_token');
  }
  return body;
}

/** @returns {TokenState} */
function toState(body, auth, previousRefresh, role) {
  let timing;
  try {
    timing = tokenTiming(body, Date.now());
  } catch (err) {
    throw new Error('token for ' + role + ': ' + err.message);
  }
  return {
    access: body.access_token,
    refresh: body.refresh_token || previousRefresh,
    exp: timing.exp,
    marginSec: timing.marginSec,
    auth,
  };
}

/**
 * Password grant for every account. Call it once, from setup().
 * @param {AuthConfig} auth
 * @param {Record<string, { login: string, password: string }>} accounts role -> credentials
 * @returns {Record<string, TokenState>}
 * @throws {Error} `token endpoint returned <status> for <role>` when the endpoint does not answer 200
 */
export function fetchTokens(auth, accounts) {
  /** @type {Record<string, TokenState>} */
  const tokens = {};
  for (const role of Object.keys(accounts)) {
    const body = tokenRequest(
      auth,
      {
        grant_type: 'password',
        client_id: auth.clientId,
        scope: auth.scope,
        username: accounts[role].login,
        password: accounts[role].password,
      },
      role,
      'token endpoint',
    );
    tokens[role] = toState(body, auth, '', role);
  }
  return tokens;
}

/**
 * The Authorization header value for a role, refreshing the token first when it expires within its margin (the smaller
 * of 300 s and half the token's life).
 * Updates the caller's copy of `state` in place, so later calls of the same VU reuse the new token.
 * @param {Record<string, TokenState>} state setup data from fetchTokens
 * @param {string} role
 * @returns {string} `Bearer <access token>`
 */
export function bearer(state, role) {
  const token = state[role];
  if (!token) throw new Error('no token for role ' + role + '; known roles: ' + Object.keys(state).join(', '));
  if (needsRefresh(token.exp, Date.now(), token.marginSec === undefined ? 300 : token.marginSec)) {
    const body = tokenRequest(
      token.auth,
      {
        grant_type: 'refresh_token',
        client_id: token.auth.clientId,
        scope: token.auth.scope,
        refresh_token: token.refresh,
      },
      role,
      'token refresh',
    );
    state[role] = toState(body, token.auth, token.refresh, role);
  }
  return 'Bearer ' + state[role].access;
}
