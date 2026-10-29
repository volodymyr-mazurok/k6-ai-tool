// A static auth header (project.yaml `auth.type: static_header`): the same header on every request, no login, no token
// request. k6 only. The runner hands the header over in the secrets file as `header: { name, value }`, with `${env:NAME}`
// already replaced; `${random:N}` is made here.
//
// Call staticHeaders() once, at the top level of the script. The top level (k6's init context) runs once per virtual
// user, so each VU makes its own random value and keeps it for all its requests:
//   const AUTH = staticHeaders(loadSecrets());
//   step('shop.quotes', { method: 'GET', url, headers: AUTH, checks: { ... } });

import { expandRandom } from '../lib/headerValue.js';

/**
 * The header as a `headers` object for step() or http.request().
 * @param {{ header?: { name: string, value: string } }} secrets the parsed secrets file (loadSecrets())
 * @returns {Record<string, string>}
 * @throws {Error} when the secrets file holds no header: the project's auth is not static_header
 */
export function staticHeaders(secrets) {
  const header = secrets && secrets.header;
  if (!header || typeof header.name !== 'string' || typeof header.value !== 'string') {
    throw new Error('no static header in the secrets file: project.yaml auth.type must be static_header');
  }
  return { [header.name]: expandRandom(header.value) };
}
