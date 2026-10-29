// Used only by static.test.ts: every VU sends a few requests with the static header of core/auth/static.js, and says which
// VU it is, so the test can see that each VU made its own value once.
import http from 'k6/http';
import exec from 'k6/execution';
import { loadRunConfig, loadSecrets } from '../../core/config.js';
import { staticHeaders } from '../../core/auth/static.js';

const cfg = loadRunConfig();
const AUTH = staticHeaders(loadSecrets());

export const options = { scenarios: { each: { executor: 'per-vu-iterations', vus: 3, iterations: 3 } } };

export default function () {
  http.get(cfg.apiUrl + '/seen', { headers: Object.assign({ 'X-Vu': String(exec.vu.idInTest) }, AUTH) });
}
