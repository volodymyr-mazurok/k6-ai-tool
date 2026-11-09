// HAR summaries: the evidence behind a journey. A raw HAR (recorded by a browser or test run) holds tokens, cookies and
// whole static assets, so it never enters this repo; a summary keeps only what a journey is written from: method, path,
// status, time, the request body and the top-level keys of the response.
// Headers and cookies are never read: only the fields below are picked out of an entry. Credential-looking query
// parameters, body fields, login identities (user name, e-mail, login, phone), e-mail addresses, JWTs and long opaque
// tokens are redacted on top of that (tests/recordings.test.ts gates the
// committed summaries). Delete the raw HAR once it is summarised: it holds the login traffic.

import { readFileSync } from 'node:fs';

export interface HarEntrySummary {
  /** Position of the entry in the HAR, so a summary line can be traced back to the recording. */
  index: number;
  method: string;
  /** Relative to the API url, query kept (secret parameters redacted). */
  path: string;
  status: number;
  /** Whole request time in ms, rounded. */
  ms: number;
  /** The JSON body that was sent, without credential-like fields or secret-looking values. Left out when there is none or it is not JSON. */
  requestBody?: unknown;
  /** Top-level keys of a JSON object response. Left out for anything else. */
  responseKeys?: string[];
}

interface HarEntry {
  time?: number;
  request?: { method?: string; url?: string; postData?: { text?: string } };
  response?: { status?: number; content?: { text?: string; encoding?: string } };
}

/**
 * Names (body keys, query parameters) whose values are credentials or a person's login identity (user name, e-mail, login,
 * phone). Deliberately broad: over-dropping a field costs little. `userId` and the like are identifiers and stay.
 */
const SENSITIVE_NAME =
  /pass|pwd|token|secret|authori[sz]ation|cookie|bearer|api[-_]?key|jwt|otp|code|credential|signature|session|^(sig|key|auth|sas|user)$|user[-_]?name|e-?mail|login|phone/i;
/** An e-mail address anywhere in a string. */
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 40+ characters of base64/hex/url-safe alphabet with no spaces. */
const OPAQUE = /^[A-Za-z0-9_+/=.-]{40,}$/;
const REDACTED = '[redacted]';

/**
 * A JWT, a long opaque string with letters and digits (a token or session id), or a value holding an e-mail address.
 * A GUID is an identifier, not a secret.
 */
function looksSecret(value: string): boolean {
  if (JWT.test(value)) return true;
  if (new RegExp(EMAIL.source).test(value)) return true;
  return !GUID.test(value) && OPAQUE.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Request-body value: credential- and identity-named keys are dropped, secret-looking strings replaced, e-mail addresses inside a string redacted. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'string') {
    const withoutEmail = value.replace(EMAIL, REDACTED);
    if (withoutEmail !== value) return withoutEmail.trim() === REDACTED ? REDACTED : withoutEmail;
    return looksSecret(value) ? REDACTED : value;
  }
  if (value && typeof value === 'object') {
    const clean: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (!SENSITIVE_NAME.test(key)) clean[key] = scrub(inner);
    }
    return clean;
  }
  return value;
}

/** Query string: a credential-named parameter or a secret-looking value keeps its name and loses its value. */
function scrubQuery(query: string): string {
  return query
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return pair;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      return SENSITIVE_NAME.test(decode(name)) || looksSecret(decode(value)) ? `${name}=${REDACTED}` : pair;
    })
    .join('&');
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

/**
 * The path below `base` (leading slash, fragment dropped), or undefined when `url` is not under it.
 * Secret-looking path segments and secret query parameters are redacted; the rest of the query is kept.
 */
function relativePath(url: string, base: string): string | undefined {
  if (!url.startsWith(base)) return undefined;
  const rest = url.slice(base.length).split('#')[0]!;
  if (rest !== '' && rest[0] !== '/' && rest[0] !== '?') return undefined; // …/apix is not under …/api

  const queryAt = rest.indexOf('?');
  const pathPart = queryAt < 0 ? rest : rest.slice(0, queryAt);
  const query = queryAt < 0 ? '' : rest.slice(queryAt + 1);
  const path =
    pathPart === ''
      ? '/'
      : pathPart
          .split('/')
          .map((segment) => (looksSecret(decode(segment)) ? REDACTED : segment))
          .join('/');
  return query === '' ? path : `${path}?${scrubQuery(query)}`;
}

function responseKeys(content: { text?: string; encoding?: string } | undefined): string[] | undefined {
  if (!content?.text) return undefined;
  const text = content.encoding === 'base64' ? Buffer.from(content.text, 'base64').toString('utf8') : content.text;
  const parsed = parseJson(text);
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return undefined;
  return Object.keys(parsed.value);
}

function requestBody(text: string | undefined): { body: unknown } | undefined {
  if (!text) return undefined;
  const parsed = parseJson(text);
  return parsed.ok ? { body: scrub(parsed.value) } : undefined;
}

/**
 * Summarise the API calls of a HAR: every entry whose URL is under `apiUrl`, in recorded order.
 * Entries that never got a response (cancelled while the page navigated) are left out.
 */
export function summarizeHar(harPath: string, apiUrl: string): HarEntrySummary[] {
  const har = JSON.parse(readFileSync(harPath, 'utf8')) as { log?: { entries?: HarEntry[] } };
  const entries = har.log?.entries;
  if (!Array.isArray(entries)) throw new Error(`${harPath} is not a HAR (no log.entries)`);

  const base = apiUrl.replace(/\/+$/, '');
  const out: HarEntrySummary[] = [];
  entries.forEach((entry, index) => {
    const url = entry.request?.url;
    const status = entry.response?.status;
    if (!url || status === undefined || status <= 0) return;
    const path = relativePath(url, base);
    if (path === undefined) return;

    const summary: HarEntrySummary = {
      index,
      method: entry.request?.method ?? 'GET',
      path,
      status,
      ms: Math.round(entry.time ?? 0),
    };
    const body = requestBody(entry.request?.postData?.text);
    if (body) summary.requestBody = body.body;
    const keys = responseKeys(entry.response?.content);
    if (keys) summary.responseKeys = keys;
    out.push(summary);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// authSummary: how the app signs its calls, as a shape
// ---------------------------------------------------------------------------------------------------------------

/** How the app authenticated its API calls. Describes a shape (scheme, header name, length/kind of the value); never holds a value. */
export interface AuthSummary {
  scheme: 'bearer' | 'token' | 'basic' | 'api-key-header' | 'cookie' | 'none';
  /** The header that carried the credential (`Authorization`, `X-Api-Key`, `Cookie`); null for none. */
  header: string | null;
  /** What the value looked like, e.g. `JWT`, `16 letters and digits`, `2 cookies`. Never the value. */
  valueShape: string;
  /** POSTs to a token or login route, to any host, anywhere in the recording. */
  tokenRequests: number;
}

interface AuthEntry {
  request?: {
    method?: string;
    url?: string;
    headers?: Array<{ name?: string; value?: string }>;
    cookies?: unknown[];
  };
}

/** Header names that carry an API key or token on their own (a CSRF token does not authenticate). */
const API_KEY_HEADER = /^(x-)?api[-_]?(key|token)$|^ocp-apim-subscription-key$|^x-[\w-]*(key|token|auth)[\w-]*$/i;
const CSRF_HEADER = /csrf|xsrf/i;
/** A route that issues a token or signs in: …/token, …/login, …/signin, …/authenticate. */
const TOKEN_ROUTE = /\/(token|login|sign-?in|authenticate)\/?$/i;

/** `JWT`, or the length and kind of an opaque value. Never the value itself. */
function valueShape(value: string): string {
  if (JWT.test(value)) return 'JWT';
  if (/^[A-Za-z0-9]+$/.test(value)) {
    const letters = /[A-Za-z]/.test(value);
    const digits = /\d/.test(value);
    const kind = letters && digits ? 'letters and digits' : digits ? 'digits' : 'letters';
    return `${value.length} ${kind}`;
  }
  return `${value.length} characters`;
}

function headerValue(entry: AuthEntry, wanted: (name: string) => boolean): { name: string; value: string } | undefined {
  for (const h of entry.request?.headers ?? []) {
    if (h.name && h.value !== undefined && wanted(h.name)) return { name: h.name, value: h.value };
  }
  return undefined;
}

function underApi(url: string | undefined, base: string): boolean {
  if (!url || !url.startsWith(base)) return false;
  const next = url.slice(base.length)[0];
  return next === undefined || next === '/' || next === '?' || next === '#';
}

/**
 * How the API calls in a HAR (every entry under `apiUrl`) were authenticated, from the first call that carries a credential:
 * an Authorization header (bearer, token, basic), else an API-key style header, else cookies; `none` when there is none.
 * Only the scheme, the header NAME and the shape of the value come out. The raw HAR holds the real values: delete it.
 */
export function authSummary(harPath: string, apiUrl: string): AuthSummary {
  const har = JSON.parse(readFileSync(harPath, 'utf8')) as { log?: { entries?: AuthEntry[] } };
  const entries = har.log?.entries;
  if (!Array.isArray(entries)) throw new Error(`${harPath} is not a HAR (no log.entries)`);

  const base = apiUrl.replace(/\/+$/, '');
  const tokenRequests = entries.filter((e) => {
    if ((e.request?.method ?? '').toUpperCase() !== 'POST') return false;
    try {
      return TOKEN_ROUTE.test(new URL(e.request?.url ?? '').pathname);
    } catch {
      return false;
    }
  }).length;
  const none: AuthSummary = { scheme: 'none', header: null, valueShape: 'no credentials sent', tokenRequests };
  const calls = entries.filter((e) => underApi(e.request?.url, base));

  for (const call of calls) {
    const auth = headerValue(call, (n) => n.toLowerCase() === 'authorization');
    if (!auth) continue;
    const parts = /^(\S+)\s+(\S.*)$/.exec(auth.value.trim());
    const word = parts?.[1]?.toLowerCase();
    const rest = (parts?.[2] ?? auth.value).trim();
    if (word === 'bearer' || word === 'token') return { scheme: word, header: 'Authorization', valueShape: valueShape(rest), tokenRequests };
    if (word === 'basic') {
      const pair = Buffer.from(rest, 'base64').toString('utf8').includes(':');
      return { scheme: 'basic', header: 'Authorization', valueShape: pair ? 'base64 user:password pair' : valueShape(rest), tokenRequests };
    }
    return { scheme: 'api-key-header', header: 'Authorization', valueShape: valueShape(rest), tokenRequests };
  }
  for (const call of calls) {
    const key = headerValue(call, (n) => API_KEY_HEADER.test(n) && !CSRF_HEADER.test(n));
    if (key) return { scheme: 'api-key-header', header: key.name, valueShape: valueShape(key.value.trim()), tokenRequests };
  }
  for (const call of calls) {
    const cookie = headerValue(call, (n) => n.toLowerCase() === 'cookie');
    const count = cookie ? cookie.value.split(';').filter((p) => p.trim() !== '').length : (call.request?.cookies?.length ?? 0);
    if (count > 0) return { scheme: 'cookie', header: 'Cookie', valueShape: `${count} cookie${count === 1 ? '' : 's'}`, tokenRequests };
  }
  return none;
}
