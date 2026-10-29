// The pure parts of step() (core/request.js), kept apart so the Node test runner can test them without k6.

/**
 * The checks with every predicate guarded: one that throws (`res.json()` on an error page) answers false instead of
 * ending the iteration before its think time, which would make the loop hammer the server.
 * @param {Record<string, (res: any) => unknown>} checks name -> predicate
 * @returns {Record<string, (res: any) => unknown>} the same names, in the same order
 */
export function guardChecks(checks) {
  /** @type {Record<string, (res: any) => unknown>} */
  const guarded = {};
  for (const name of Object.keys(checks)) {
    const predicate = checks[name];
    guarded[name] = (res) => {
      try {
        return predicate(res);
      } catch (_err) {
        return false;
      }
    };
  }
  return guarded;
}

/**
 * The request headers: a copy of `headers`, with `Content-Type: application/json` added for a JSON body unless the caller
 * set a content type already, in any letter case (HTTP header names are case-insensitive, so `content-type` counts).
 * @param {Record<string, string> | undefined} headers
 * @param {boolean} hasBody
 * @returns {Record<string, string>}
 */
export function jsonHeaders(headers, hasBody) {
  const out = Object.assign({}, headers);
  if (hasBody && !Object.keys(out).some((name) => name.toLowerCase() === 'content-type')) out['Content-Type'] = 'application/json';
  return out;
}
