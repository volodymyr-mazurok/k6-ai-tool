// HAR summaries: the evidence behind a journey. A raw HAR (recorded by a browser or test run) holds tokens, cookies and
// whole static assets, so it never enters this repo; a summary keeps only what a journey is written from: method, path,
// status, time, the request body and the top-level keys of the response.
// Headers and cookies are never read: only the fields below are picked out of an entry. Credential-looking query
// parameters, body fields, JWTs and long opaque tokens are redacted on top of that (tests/recordings.test.ts gates the
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

/** Names (body keys, query parameters) whose values are credentials. Deliberately broad: over-dropping a field costs little. */
const SENSITIVE_NAME =
  /pass|pwd|token|secret|authori[sz]ation|cookie|bearer|api[-_]?key|jwt|otp|code|credential|signature|session|^(sig|key|auth|sas)$/i;
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 40+ characters of base64/hex/url-safe alphabet with no spaces. */
const OPAQUE = /^[A-Za-z0-9_+/=.-]{40,}$/;
const REDACTED = '[redacted]';

/** A JWT, or a long opaque string with letters and digits (a token or session id). A GUID is an identifier, not a secret. */
function looksSecret(value: string): boolean {
  if (JWT.test(value)) return true;
  return !GUID.test(value) && OPAQUE.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Request-body value: credential-named keys are dropped, secret-looking strings replaced. */
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (typeof value === 'string') return looksSecret(value) ? REDACTED : value;
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
