// Named, tagged requests with content checks, plus the per-iteration helpers of a journey. k6 only.
// A step id is the metric `name` tag; it is also the key in summary.json (`http_req_duration{name:<id>}`).

import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';
import { guardChecks, jsonHeaders } from './lib/stepParts.js';

/**
 * The path of an absolute URL, without host and query (`/api/items/search`).
 * k6 overwrites the `url` tag of a request with its `name` tag, so the request's `path` tag is the only place the
 * runner's journey check can read the route a step really called.
 * @param {string} url
 * @returns {string}
 */
function pathOf(url) {
  const path = String(url).replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/, '').replace(/[?#].*$/, '');
  return path === '' ? '/' : path;
}

/**
 * Send one named request and check its answer. The request is tagged `name: <id>` and `path: <url path>`, its checks `name: <id>`.
 * `checks` must hold at least one content check: a bare status check cannot tell a real answer from an error page.
 * A `status 2xx` check is always added. A check that throws counts as failed (false); it does not end the iteration.
 * A JSON body gets `Content-Type: application/json` unless `headers` sets a content type (in any letter case).
 *
 * Without a content check the step throws `step <id> has no content check`. A plain exception would only end the
 * current iteration (k6 logs it and still exits 0), so the run is aborted as well: a step without a content check
 * is a script bug, not load-test data.
 *
 * @param {string} id step id, `<journey.key>.<step.name>`
 * @param {object} spec
 * @param {string} spec.method
 * @param {string} spec.url
 * @param {unknown} [spec.body] sent as JSON (a string is sent as is)
 * @param {Record<string, string>} [spec.headers]
 * @param {string} [spec.token] Authorization header value, as returned by bearer()
 * @param {Record<string, (res: any) => boolean>} spec.checks content checks, name -> predicate
 * @returns {{ res: any, ok: boolean }} ok is true when every check passed
 */
export function step(id, { method, url, body, headers, token, checks }) {
  if (!checks || Object.keys(checks).length === 0) {
    const message = 'step ' + id + ' has no content check';
    exec.test.abort(message);
    throw new Error(message); // abort() already stops this VU; this keeps the contract if it ever returns
  }
  const hasBody = body !== undefined && body !== null;
  const payload = hasBody ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
  const hdrs = jsonHeaders(headers, hasBody);
  if (token) hdrs.Authorization = token;
  const res = http.request(method, url, payload, { headers: hdrs, tags: { name: id, path: pathOf(url) } });
  const sets = guardChecks(Object.assign({ 'status 2xx': (r) => r.status >= 200 && r.status < 300 }, checks));
  const ok = check(res, sets, { name: id });
  return { res, ok };
}

/**
 * Pause like a user would: a uniform random time between thinkTime.min and thinkTime.max seconds.
 * Smoke and stress do not think (smoke is one quick pass; stress sets the request rate itself).
 * @param {any} cfg RunConfig
 * @returns {number} seconds slept
 */
export function think(cfg) {
  if (cfg.profile.type === 'smoke' || cfg.profile.type === 'stress') return 0;
  const { min, max } = cfg.thinkTime;
  const seconds = min + Math.random() * (max - min);
  sleep(seconds);
  return seconds;
}

/**
 * Whether an optional step runs in this iteration: always in smoke, otherwise with probability `share` percent.
 * @param {any} cfg RunConfig
 * @param {number} share percent, 0..100
 * @returns {boolean}
 */
export function shouldRun(cfg, share) {
  if (cfg.profile.type === 'smoke') return true;
  return Math.random() * 100 < share;
}
