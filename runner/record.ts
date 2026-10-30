// perf record: a real browser session of the app, saved as a scrubbed recording (the evidence a journey is written from).
//
// Chromium runs with HAR recording into a private temp folder. When the session is over the context is closed (that is what
// writes the HAR), the HAR is summarised by the same scrubber `har-summary` uses (summarizeHar: method, path, status, time,
// request body, response keys; no header, cookie or token), the way the app authenticates is described as a shape
// (authSummary), and the raw HAR is deleted in a `finally`, whatever happened. Nothing but the two scrubbed JSON files leaves.
//
// Two ways to drive the browser:
//   - headed (default): a window opens at the start url; the PERSON drives it, logs in themselves, and closes the window.
//   - `drive` (library) or `--actions <file.json>` (CLI): headless, a small list of actions, then the browser closes. The agent
//     never types a password: an action list may not fill a password field.

import { mkdirSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from 'playwright';
import { ConfigError } from './config.js';
import { authSummary, summarizeHar, type AuthSummary } from './har.js';

export interface RecordOptions {
  /** Where the browser starts. */
  startUrl: string;
  /** The env's API base: only calls under it are summarised. */
  apiUrl: string;
  /** The recording (the `har-summary` JSON). The auth summary goes next to it as `<out minus .json>.auth.json`. */
  out: string;
  /** Default false: a visible window the person drives. With `headless` a `drive` function is required. */
  headless?: boolean;
  /** Drives the page, then returns; the browser closes after it. Without it the person closes the window to finish. */
  drive?: (page: Page) => Promise<void>;
  /** Where the temporary HAR folder is made (default: the system temp folder). It is empty again when `record` returns or throws. */
  tmpDir?: string;
  /** Where the one instruction line goes (default console.log). */
  log?: (message: string) => void;
}

export interface RecordResult {
  /** API calls (under apiUrl) in the recording. 0 means nothing was written. */
  calls: number;
  auth: AuthSummary;
}

/** The auth summary's path for a recording path. */
export function authPath(out: string): string {
  return `${out.replace(/\.json$/i, '')}.auth.json`;
}

/** Why a browser cannot be started here (message only); undefined when Chromium launches. Used to skip browser tests, never to hide a failure. */
export async function browserUnavailable(): Promise<string | undefined> {
  if (process.env.PERF_SKIP_BROWSER) return 'PERF_SKIP_BROWSER is set';
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return undefined;
  } catch (err) {
    return `Chromium cannot start here: ${(err as Error).message.split('\n')[0]}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// the action list
// ---------------------------------------------------------------------------------------------------------------

export type RecordAction =
  | { goto: string }
  | { click: string }
  | { fill: [string, string] }
  | { wait: number };

const ACTION_KEYS = ['goto', 'click', 'fill', 'wait'];
const MAX_ACTIONS = 200;
const MAX_WAIT_MS = 30_000;
const ACTION_TIMEOUT_MS = 15_000;

/**
 * Check an action list strictly and resolve each `goto` against the start url. Unknown keys, wrong types, two actions in one
 * element and a `goto` that leaves the start url's origin are refused (ConfigError, exit code 2). Messages never quote a `fill` text.
 * @throws {ConfigError}
 */
export function parseActions(json: unknown, startUrl: string): RecordAction[] {
  const start = new URL(startUrl);
  if (!Array.isArray(json)) throw new ConfigError('--actions: the file must hold a JSON array of actions');
  if (json.length === 0) throw new ConfigError('--actions: the list is empty');
  if (json.length > MAX_ACTIONS) throw new ConfigError(`--actions: ${json.length} actions; the most is ${MAX_ACTIONS}`);

  return json.map((raw: unknown, i): RecordAction => {
    const at = `--actions[${i}]`;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new ConfigError(`${at}: must be an object with one key of ${ACTION_KEYS.join(', ')}`);
    }
    const keys = Object.keys(raw);
    const unknown = keys.find((key) => !ACTION_KEYS.includes(key));
    if (unknown !== undefined) throw new ConfigError(`${at}: unknown key ${JSON.stringify(unknown)} (allowed: ${ACTION_KEYS.join(', ')})`);
    if (keys.length !== 1) throw new ConfigError(`${at}: must have exactly one key of ${ACTION_KEYS.join(', ')}, has ${keys.length}`);
    const action = raw as Record<string, unknown>;

    if ('goto' in action) {
      if (typeof action.goto !== 'string' || action.goto === '') throw new ConfigError(`${at}.goto: must be a non-empty string`);
      let target: URL;
      try {
        target = new URL(action.goto, start);
      } catch {
        throw new ConfigError(`${at}.goto: ${JSON.stringify(action.goto)} is not a url`);
      }
      if (!/^https?:$/.test(target.protocol) || target.origin !== start.origin) {
        throw new ConfigError(`${at}.goto: ${JSON.stringify(action.goto)} leaves the start url's origin ${start.origin}; the recording stays on the app`);
      }
      return { goto: target.href };
    }
    if ('click' in action) {
      if (typeof action.click !== 'string' || action.click === '') throw new ConfigError(`${at}.click: must be a non-empty selector string`);
      return { click: action.click };
    }
    if ('fill' in action) {
      const pair = action.fill;
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || pair[0] === '' || typeof pair[1] !== 'string') {
        throw new ConfigError(`${at}.fill: must be ["<selector>", "<text>"]`);
      }
      return { fill: [pair[0], pair[1]] };
    }
    const wait = action.wait;
    if (typeof wait !== 'number' || !Number.isInteger(wait) || wait < 0 || wait > MAX_WAIT_MS) {
      throw new ConfigError(`${at}.wait: must be a whole number of milliseconds, 0..${MAX_WAIT_MS}`);
    }
    return { wait };
  });
}

/** The `drive` function for an action list. Refuses to fill a password field (a person types those, never the agent). */
export function driveActions(actions: RecordAction[]): (page: Page) => Promise<void> {
  return async (page) => {
    page.setDefaultTimeout(ACTION_TIMEOUT_MS);
    for (const [i, action] of actions.entries()) {
      if ('goto' in action) await page.goto(action.goto, { waitUntil: 'load' });
      else if ('click' in action) await page.locator(action.click).first().click();
      else if ('wait' in action) await page.waitForTimeout(action.wait);
      else {
        const field = page.locator(action.fill[0]).first();
        const isPassword = await field.evaluate(
          (el) => el instanceof HTMLInputElement && (el.type === 'password' || /password/.test(el.autocomplete)),
        );
        if (isPassword) {
          throw new ConfigError(`--actions[${i}].fill: ${JSON.stringify(action.fill[0])} is a password field; log in yourself in a headed recording (leave out --actions)`);
        }
        await field.fill(action.fill[1]);
      }
    }
    await page.waitForLoadState('networkidle').catch(() => {}); // let the last call finish
  };
}

// ---------------------------------------------------------------------------------------------------------------
// record
// ---------------------------------------------------------------------------------------------------------------

/**
 * Record a browser session and write the scrubbed recording. Writes nothing when no call under `apiUrl` was made (calls: 0).
 * The raw HAR never leaves the temp folder, which is removed in every case, including Ctrl-C.
 * @throws {Error} the browser could not start, or closed before the HAR was saved
 */
export async function record(opts: RecordOptions): Promise<RecordResult> {
  const { startUrl, apiUrl, out } = opts;
  const headless = opts.headless ?? false;
  if (headless && !opts.drive) throw new Error('a headless recording needs a drive function (nobody can close the window)');
  const log = opts.log ?? ((message: string) => console.log(message));

  const { chromium } = await import('playwright');
  const dir = mkdtempSync(join(opts.tmpDir ?? tmpdir(), 'perf-record-'));
  const harPath = join(dir, 'session.har');
  const onSigint = (): void => {
    rmSync(dir, { recursive: true, force: true });
    process.exit(130);
  };
  process.once('SIGINT', onSigint);

  let browser;
  try {
    browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      recordHar: { path: harPath, content: 'embed' },
      serviceWorkers: 'block', // a service worker's requests would not reach the HAR
    });
    const page = await context.newPage();
    await page.goto(startUrl);

    if (opts.drive) {
      await opts.drive(page);
    } else {
      log('drive the app in the browser window; log in yourself if asked; close the window when done');
      await new Promise<void>((resolve) => {
        const check = (): void => {
          if (context.pages().length === 0) resolve();
        };
        const watch = (p: Page): void => void p.on('close', check);
        context.pages().forEach(watch);
        context.on('page', watch);
        browser!.on('disconnected', () => resolve());
        check();
      });
    }

    await context.close().catch((err: unknown) => {
      throw new Error(`the browser closed before the recording was saved (${(err as Error).message.split('\n')[0]})`);
    });
    if (!existsSync(harPath)) throw new Error('the browser closed before the recording was saved');

    const summary = summarizeHar(harPath, apiUrl);
    const auth = authSummary(harPath, apiUrl);
    if (summary.length === 0) return { calls: 0, auth };

    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(authPath(out), `${JSON.stringify(auth, null, 2)}\n`);
    return { calls: summary.length, auth };
  } finally {
    process.off('SIGINT', onSigint);
    await browser?.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}
