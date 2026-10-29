// Build fingerprint: what version of the app was deployed. Taken before and after a run; if it moved, somebody
// deployed mid-run and the numbers mix two builds (the report marks the run INVALID).

import { createHash } from 'node:crypto';
import type { EnvConfig } from './config.js';

/** Fields are absent when the env has no such URL or it did not answer. */
export interface Fingerprint {
  /** sha256 (hex) of the swagger document. */
  swaggerSha256?: string;
  /**
   * Name of the app's hashed bundle from its index page (see appBundle), e.g. `main-ABCD1234.js` or `index-D4f5aB9c.js`.
   * A new build gets a new hash, so a changed name means a deploy.
   */
  appMain?: string;
}

const FETCH_TIMEOUT_MS = 15_000;
/** Angular's `main-<HASH>.js` (upper-case hash): preferred when the page has one. */
const MAIN_BUNDLE = /main-[A-Z0-9]+\.js/;
/** Any `<name>-<hash>.js` or `<name>.<hash>.js` whose hash has 8 or more letters and digits, at least one a digit (Vite, webpack, Next.js). */
const HASHED_BUNDLE = /[A-Za-z0-9_]+[-.](?=[A-Za-z0-9]*\d)[A-Za-z0-9]{8,}\.js\b/i;
const HASHED_BUNDLE_ALL = new RegExp(HASHED_BUNDLE.source, 'gi');
/** The src of every `<script>` tag, in page order. */
const SCRIPT_SRC = /<script\b[^>]*?(?<![\w-])src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;

/** Whether a script src is served by the app itself: a relative path, or an absolute url on the app's origin. */
function sameOrigin(src: string, appUrl: string | undefined): boolean {
  if (!/^([a-z][a-z0-9+.-]*:)?\/\//i.test(src)) return true; // relative: /assets/x.js, ./x.js, x.js
  if (!appUrl) return false;
  try {
    return new URL(src, appUrl).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/**
 * The name of the app's build bundle in its index page. Only the app's own script tags count (a relative src, or one on
 * the origin of `appUrl`), so a versioned third-party script never reads as a deploy: their `main-<HASH>.js` when there
 * is one, else the last hashed bundle among them (`<name>-<hash>.js` or `<name>.<hash>.js`, hash of 8+ letters and digits
 * with a digit, any letter case; the app's entry script comes last). With none, a `main-<HASH>.js` anywhere in the page
 * (an Angular app served from a CDN). Undefined when there is none: the report's App build line then says "not readable"
 * and only the swagger hash can show a redeploy.
 */
export function appBundle(html: string, appUrl?: string): string | undefined {
  const own = [...html.matchAll(SCRIPT_SRC)].map((m) => m[1] ?? m[2] ?? m[3] ?? '').filter((src) => sameOrigin(src, appUrl));
  for (const src of own) {
    const main = MAIN_BUNDLE.exec(src);
    if (main) return main[0];
  }
  const hashed = own.flatMap((src) => [...src.matchAll(HASHED_BUNDLE_ALL)].map((m) => m[0]));
  return hashed.at(-1) ?? MAIN_BUNDLE.exec(html)?.[0];
}

/** The body of a 2xx answer, or undefined (no URL, network error, timeout, non-2xx). */
async function fetchBody(url: string | undefined): Promise<Buffer | undefined> {
  if (!url) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: 'follow' });
    if (!res.ok) return undefined;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Swagger hash and main bundle name of the env. Never throws: what cannot be read is left out. */
export async function buildFingerprint(env: Pick<EnvConfig, 'appUrl' | 'swaggerUrl'>): Promise<Fingerprint> {
  const [swagger, index] = await Promise.all([fetchBody(env.swaggerUrl), fetchBody(env.appUrl)]);
  const fp: Fingerprint = {};
  if (swagger) fp.swaggerSha256 = createHash('sha256').update(swagger).digest('hex');
  const bundle = index ? appBundle(index.toString('utf8'), env.appUrl) : undefined;
  if (bundle) fp.appMain = bundle;
  return fp;
}

/**
 * Did the build change? Only a field read both times and different counts: a fingerprint that could not be read
 * (network blip) is unknown, not a deploy.
 */
export function fingerprintChanged(before: Fingerprint, after: Fingerprint): boolean {
  return (['swaggerSha256', 'appMain'] as const).some(
    (field) => before[field] !== undefined && after[field] !== undefined && before[field] !== after[field],
  );
}
