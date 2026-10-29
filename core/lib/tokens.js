// Token timing helpers: the expiry of a JWT, or of an opaque token from the answer's expires_in, and when to refresh.
// Pure ES module with no k6 or Node imports, so the same file runs inside k6 (goja has no Buffer) and under the Node
// test runner. Tokens are never put in error text.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** @param {string} str base64 or base64url text, padding optional */
function base64ToBytes(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error('bad base64');
  const bytes = [];
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | B64.indexOf(s[i]);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((acc >> bits) & 0xff);
      acc &= (1 << bits) - 1;
    }
  }
  return bytes;
}

/** @param {number[]} bytes */
function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b = bytes[i++];
    let cp;
    let extra;
    if (b < 0x80) {
      cp = b;
      extra = 0;
    } else if (b >= 0xc2 && b < 0xe0) {
      cp = b & 0x1f;
      extra = 1;
    } else if (b >= 0xe0 && b < 0xf0) {
      cp = b & 0x0f;
      extra = 2;
    } else if (b >= 0xf0 && b < 0xf5) {
      cp = b & 0x07;
      extra = 3;
    } else {
      throw new Error('bad utf8');
    }
    for (let k = 0; k < extra; k++) {
      const c = bytes[i++];
      if (c === undefined || (c & 0xc0) !== 0x80) throw new Error('bad utf8');
      cp = (cp << 6) | (c & 0x3f);
    }
    out += String.fromCodePoint(cp);
  }
  return out;
}

/**
 * Read the `exp` claim of a JWT without verifying the signature.
 * @param {string} token
 * @returns {number} expiry as epoch seconds
 */
export function jwtExp(token) {
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 3) throw new Error('invalid JWT: expected three dot-separated parts');
  let payload;
  try {
    payload = JSON.parse(utf8Decode(base64ToBytes(parts[1])));
  } catch (_err) {
    throw new Error('invalid JWT: payload is not base64url-encoded JSON');
  }
  if (payload === null || typeof payload !== 'object' || typeof payload.exp !== 'number' || !isFinite(payload.exp)) {
    throw new Error('invalid JWT: no numeric exp claim');
  }
  return payload.exp;
}

/**
 * True when the token is already expired or expires within `marginSec` seconds.
 * @param {number} exp expiry, epoch seconds
 * @param {number} nowMs current time, epoch milliseconds
 * @param {number} [marginSec=300]
 * @returns {boolean}
 */
export function needsRefresh(exp, nowMs, marginSec = 300) {
  return exp * 1000 - nowMs <= marginSec * 1000;
}

/** The refresh margin: a token is refreshed this many seconds before it expires (global constraint: 300 s). */
export const REFRESH_MARGIN_SEC = 300;

/** `expires_in` as a positive number of seconds (a number or digits), or NaN. */
function expiresIn(body) {
  const raw = body.expires_in;
  const life = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
  return life > 0 && isFinite(life) ? life : NaN;
}

/**
 * When an access token expires and how long before that to refresh it. The expiry is the JWT's `exp` claim; a token that is
 * not a JWT (an opaque token) expires `expires_in` seconds after `nowMs`, and so does a JWT whose exp already looks past by
 * this machine's clock (clock skew) when the answer has expires_in. The margin is the smaller of `marginSec` and half the
 * token's life, so a short-lived token is refreshed at half its life, never on every call, with no jump at the margin.
 * @param {{ access_token: string, expires_in?: number | string }} body the token endpoint's answer
 * @param {number} nowMs when the answer arrived, epoch milliseconds
 * @param {number} [marginSec=REFRESH_MARGIN_SEC]
 * @returns {{ exp: number, marginSec: number }} expiry (epoch seconds) and the margin for needsRefresh
 * @throws {Error} when the token is not a JWT with an exp claim and the answer has no positive expires_in
 */
export function tokenTiming(body, nowMs, marginSec = REFRESH_MARGIN_SEC) {
  const nowSec = nowMs / 1000;
  const life = expiresIn(body);
  let exp;
  try {
    exp = jwtExp(body.access_token);
    if (exp <= nowSec && !isNaN(life)) exp = nowSec + life; // the claim is past by our clock: trust the answer's own life
  } catch (_err) {
    if (isNaN(life)) throw new Error('the access token is not a JWT with an exp claim, and the answer has no expires_in to date it');
    exp = nowSec + life;
  }
  const lifeSec = exp - nowSec;
  return { exp, marginSec: Math.max(0, Math.min(marginSec, lifeSec / 2)) };
}
