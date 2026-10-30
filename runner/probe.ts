// perf probe: one authenticated request to the env's API, and what came back as status, timing, content type, size and
// SHAPE (keys, types, array lengths) — never a value (only a count-like number), never a token, a password or a header.
// It exists so a person or an agent can fill a gap ("does this route answer? how big is the list?") without seeing a secret.
//
// What it will send: a GET; a POST to a route project.yaml lists in read_only_post_routes; any request the given feature
// declares in `writes:`. Everything else is PROBE_REFUSED before a single byte leaves the machine.

import { randomBytes } from 'node:crypto';
import { loadAdapter, type ResolvedEnv } from './adapter.js';
import { loadDotEnv } from './adapters/envAdapter.js';
import { resolveStaticHeader } from './auth.js';
import { routeMatches } from './checks.js';
import { ConfigError, type EnvConfig, type Feature, type Project } from './config.js';
import { checkEnv } from './guardrails.js';
import { JWT } from './secretScan.js';
import { requestToken } from './token.js';

export interface ProbeOptions {
  project: Project;
  feature?: Feature;
  env: string;
  method: string;
  /** The request path, with or without the API base's own path (`/api/items/count` and `/items/count` are one request). */
  path: string;
  body?: unknown;
  /** A role of the project (ropc); default the first. Ignored by a static_header project. */
  role?: string;
  /** Tests answer for the API here; the token request always goes to the network. */
  fetchImpl?: typeof fetch;
}

export interface ProbeResult {
  status: number;
  ms: number;
  /** The media type only (`application/json`), lower-case; empty when the answer had none. */
  contentType: string;
  bytes: number;
  /** One line per top-level key (or one line for a body that is not an object). */
  shape: string[];
  /** Present on 401 and 403. */
  hint?: string;
}

/** A request the probe will not send. Exit code 2. */
export class ProbeRefusedError extends Error {
  readonly code = 'PROBE_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'ProbeRefusedError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** A body is read up to this many bytes; beyond it the probe counts what it read and parses nothing. */
const MAX_READ_BYTES = 32 * 1024 * 1024;
/** How many elements of an array are looked at to name its element type. */
const ELEMENT_SAMPLE = 1000;
const MAX_KEY_CHARS = 40;
/** Only a number under a key like this is printed; every other number is just `number`. */
const COUNT_KEY = /count|total|size|length|page/i;
const GUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_SHAPED = new RegExp(JWT.source);

const number = (n: number): string => n.toLocaleString('en-US');

// ---------------------------------------------------------------------------------------------------------------
// shape
// ---------------------------------------------------------------------------------------------------------------

/** A key that is itself data (a map keyed by e-mail, id or date) is not printed: `<key>`. */
function dataLikeKey(key: string): boolean {
  if (key.includes('@') || GUID_KEY.test(key)) return true;
  const digits = key.replace(/\D/g, '').length;
  return key.length >= 3 && digits / key.length > 0.5;
}

function showKey(key: string): string {
  if (TOKEN_SHAPED.test(key)) return '<token-like key>';
  if (dataLikeKey(key)) return '<key>';
  // eslint-disable-next-line no-control-regex
  const clean = key.replace(/[\u0000-\u001f\u007f]/g, '?');
  return clean.length > MAX_KEY_CHARS ? `${clean.slice(0, MAX_KEY_CHARS)}…` : clean;
}

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value === 'object' ? 'object' : typeof value;
}

/** `{a: string, b: array(3) of object}`; `levels` is how many more containers may be opened. */
function describeKeys(obj: Record<string, unknown>, levels: number, maxKeys: number): string {
  const keys = Object.keys(obj);
  const parts = keys.slice(0, maxKeys).map((key) => `${showKey(key)}: ${describeValue(obj[key], levels, maxKeys, key)}`);
  if (keys.length > maxKeys) parts.push(`… ${keys.length - maxKeys} more`);
  return `{${parts.join(', ')}}`;
}

function describeValue(value: unknown, levels: number, maxKeys: number, key?: string): string {
  const kind = kindOf(value);
  if (kind === 'number') return key !== undefined && COUNT_KEY.test(key) ? String(value) : 'number';
  if (kind === 'array') {
    const items = value as unknown[];
    if (items.length === 0) return 'array(0)';
    const sample = items.slice(0, ELEMENT_SAMPLE);
    const kinds = new Set(sample.map(kindOf));
    const head = `array(${items.length}) of ${kinds.size === 1 ? [...kinds][0]! : 'mixed'}`;
    // The first element stands for the others: its keys, one level down. Never the elements themselves.
    if (levels > 0 && kinds.size === 1 && kinds.has('object')) return `${head} ${describeKeys(items[0] as Record<string, unknown>, levels - 1, maxKeys)}`;
    return head;
  }
  if (kind === 'object') {
    const count = Object.keys(value as object).length;
    if (levels > 0) return `object ${describeKeys(value as Record<string, unknown>, levels - 1, maxKeys)}`;
    return `object(${count} key${count === 1 ? '' : 's'})`;
  }
  return kind; // string, boolean, null: never the value
}

/**
 * The shape of a parsed JSON value as lines: an object gives one line per key (`data: object {entities: array(10) of object,
 * totalCount: 1000}`), anything else one line. Keys and types, array lengths, a number's value only under a count-like key,
 * never a string. `depth` is how many levels of objects (and first elements of arrays) are opened, counting the top one.
 */
export function describeShape(value: unknown, depth = 2, maxKeys = 20): string[] {
  const levels = Math.max(depth - 1, 0);
  if (kindOf(value) !== 'object') return [describeValue(value, levels, maxKeys)];
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj);
  const lines = keys.slice(0, maxKeys).map((key) => `${showKey(key)}: ${describeValue(obj[key], levels, maxKeys, key)}`);
  if (keys.length > maxKeys) lines.push(`… ${keys.length - maxKeys} more keys`);
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// output
// ---------------------------------------------------------------------------------------------------------------

/** The lines `perf probe` prints: the status line, the shape, and the hint when there is one. */
export function formatProbe(method: string, path: string, result: ProbeResult): string[] {
  const line = `${result.status} ${method.toUpperCase()} ${path} ${Math.round(result.ms)} ms ${result.contentType || 'no content type'} ${number(result.bytes)} bytes`;
  return [line, ...result.shape, ...(result.hint ? [`hint: ${result.hint}`] : [])];
}

// ---------------------------------------------------------------------------------------------------------------
// the request
// ---------------------------------------------------------------------------------------------------------------

/** What a failed fetch tells without echoing anything the library might quote: a code or a name. */
function networkReason(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string }; code?: string } | undefined;
  return e?.cause?.code ?? e?.code ?? (e?.name === 'TimeoutError' ? 'timeout after 30 s' : (e?.name ?? 'unknown error'));
}

/**
 * Where the request goes, and its route relative to the API base (what read_only_post_routes and writes: are written in).
 * Only a path on the API host and under the API base's path is accepted: the token must not travel anywhere else.
 */
function locate(apiUrl: string, path: string): { url: URL; route: string } {
  const base = new URL(apiUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  if (!path.startsWith('/') || path.startsWith('//') || /[\\\s]/.test(path)) {
    throw new ProbeRefusedError(`path ${JSON.stringify(path)} must be a path on the API host that starts with a single / (e.g. ${basePath}/items)`);
  }
  const underBase = basePath !== '' && (path === basePath || /^[/?#]/.test(path.slice(basePath.length)) && path.startsWith(basePath));
  const url = new URL(underBase ? path : `${basePath}${path}`, base.origin);
  if (url.origin !== base.origin || (basePath !== '' && url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`))) {
    throw new ProbeRefusedError(`path ${JSON.stringify(path)} leaves the API base ${base.origin}${basePath}; the probe stays under it`);
  }
  return { url, route: url.pathname.slice(basePath.length) || '/' };
}

function checkMethod(project: Project, feature: Feature | undefined, method: string, route: string): void {
  if (method === 'GET') return;
  if (method === 'POST' && project.readOnlyPostRoutes.some((listed) => routeMatches(listed, route))) return;
  if (feature?.writes?.some((w) => w.method === method && routeMatches(w.route, route))) return;
  throw new ProbeRefusedError(
    `${method} ${route} is not a request the probe sends: it sends GET, a POST to a route in read_only_post_routes of project ${project.name}, ` +
      `or a request the --feature declares in writes:`,
  );
}

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** The `${random:N}` parts filled with N lower-case letters and digits each, the way the k6 side fills them. */
function fillRandom(value: string): string {
  return value.replace(/\$\{random:(\d+)\}/g, (_all, n: string) =>
    Array.from(randomBytes(Number(n)), (byte) => ALPHABET[byte % ALPHABET.length]).join(''),
  );
}

/** How the request signs in, worked out without sending anything. */
interface Auth {
  apiUrl: string;
  hint: string;
  /** The headers to send (static_header), or a token request to make first (ropc). Secrets either way: never print. */
  headers?: Record<string, string>;
  token?: { auth: ResolvedEnv['auth']; account: { login: string; password: string }; role: string };
}

async function prepareAuth(project: Project, env: string, config: EnvConfig, role: string | undefined): Promise<Auth> {
  if (project.auth.type === 'static_header') {
    loadDotEnv();
    const { header } = resolveStaticHeader(project.auth);
    return {
      apiUrl: config.apiUrl,
      headers: { [header.name]: fillRandom(header.value) },
      hint: `check the project's auth (auth.type static_header, header ${header.name}); the token itself is never shown`,
    };
  }
  const adapter = await loadAdapter(project);
  let resolved: ResolvedEnv;
  try {
    resolved = await adapter.resolveEnv(env);
  } finally {
    await adapter.close?.().catch(() => {});
  }
  const roles = Object.keys(resolved.accounts);
  const chosen = role ?? roles[0];
  if (chosen === undefined || !Object.hasOwn(resolved.accounts, chosen)) {
    throw new ConfigError(`role ${role ?? '(none)'} is not a role of project ${project.name} (roles: ${roles.join(', ')})`);
  }
  return {
    apiUrl: resolved.apiUrl,
    hint: `check the project's auth (auth.type ropc, role ${chosen}); the token itself is never shown`,
    token: { auth: resolved.auth, account: resolved.accounts[chosen]!, role: chosen },
  };
}

/** The headers to send: the static header, or a bearer token from one password-grant request. */
async function signIn(auth: Auth): Promise<Record<string, string>> {
  if (auth.headers) return auth.headers;
  const { token } = auth;
  let answer;
  try {
    answer = await requestToken(token!.auth, token!.account);
  } catch (err) {
    throw new Error(`no answer from the token endpoint (${networkReason(err)}); check the network and the VPN`);
  }
  if (answer.status !== 200 || answer.accessToken === undefined) {
    const what = answer.status === 200 ? 'answered 200 without an access token' : `answered ${answer.status}`;
    throw new Error(`the token request for role ${token!.role} ${what}; no API request was sent; ${auth.hint}`);
  }
  return { authorization: `Bearer ${answer.accessToken}` };
}

/** The body as bytes, read up to MAX_READ_BYTES. `truncated` when there was more. */
async function readBody(res: Response): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { bytes: Buffer.concat(chunks), truncated: false };
    chunks.push(Buffer.from(value));
    total += value.byteLength;
    if (total > MAX_READ_BYTES) {
      await reader.cancel().catch(() => {});
      return { bytes: Buffer.concat(chunks), truncated: true };
    }
  }
}

function shapeOf(contentType: string, bytes: Buffer, truncated: boolean): string[] {
  const size = number(bytes.length);
  if (truncated) return [`[${contentType || 'no content type'}, at least ${size} bytes, too large to read]`];
  if (bytes.length === 0) return ['[empty body]'];
  if (!/json/.test(contentType)) return [`[${contentType || 'no content type'}, ${size} bytes]`];
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    return [`[${contentType}, ${size} bytes, not valid JSON]`];
  }
  return describeShape(parsed);
}

/**
 * Send one request and describe the answer. The env must be one project.yaml lists; the method and route must pass the
 * rules in the file header; redirects are not followed (the token must not travel on). Nothing returned or thrown holds a
 * token, a password or a header value.
 * @throws {GuardrailError} ENV_NOT_ALLOWED
 * @throws {ProbeRefusedError} the request is not one the probe sends
 * @throws {ConfigError} unknown role, a body on a GET
 * @throws {Error} the token request failed, or the API did not answer
 */
export async function probe(opts: ProbeOptions): Promise<ProbeResult> {
  const { project, feature, env, body } = opts;
  const method = opts.method.toUpperCase();
  const config = checkEnv(project, env);
  if (!/^[A-Z]+$/.test(method)) throw new ProbeRefusedError(`${JSON.stringify(opts.method)} is not an HTTP method`);
  if (body !== undefined && method === 'GET') throw new ConfigError('a GET has no body; drop --body');
  const auth = await prepareAuth(project, env, config, opts.role);
  const { url, route } = locate(auth.apiUrl, opts.path);
  checkMethod(project, feature, method, route);

  const requestHeaders: Record<string, string> = { ...(await signIn(auth)), accept: 'application/json, */*' };
  if (body !== undefined) requestHeaders['content-type'] = 'application/json';

  const started = performance.now();
  let res: Response;
  try {
    res = await (opts.fetchImpl ?? fetch)(url.href, {
      method,
      headers: requestHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`no answer from ${url.host} (${networkReason(err)}); check the VPN and that the env is up`);
  }
  let read;
  try {
    read = await readBody(res);
  } catch (err) {
    throw new Error(`the answer from ${url.host} broke off (${networkReason(err)})`);
  }
  const ms = performance.now() - started;
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  const result: ProbeResult = {
    status: res.status,
    ms,
    contentType,
    bytes: read.bytes.length,
    shape: shapeOf(contentType, read.bytes, read.truncated),
  };
  if (res.status === 401 || res.status === 403) result.hint = auth.hint;
  return result;
}
