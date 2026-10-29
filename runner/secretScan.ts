// Backstop for "secrets never reach disk": after a run, look through the files that are shared in reports for tokens.
// core/summary.js already drops k6's setup_data (which holds the bearer and refresh tokens); this catches a project
// script with its own handleSummary, a console.log of a token, or a URL with a token that reached a result file.

import { createReadStream, createWriteStream } from 'node:fs';
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { createGunzip, createGzip } from 'node:zlib';

/**
 * What the scan found, as recorded in meta.json. `files` holds names only, never the secret: the files that held something
 * (now redacted) and the files that could not be scanned. `unscanned` says why for the latter; a file that could not be
 * scanned is not proven clean, so it makes the scan not ok.
 */
export type SecretScan = { ok: true } | { ok: false; files: string[]; unscanned?: { file: string; reason: string }[] };

export interface ScanOptions {
  /** A decompressed line of a .gz file longer than this is not scanned (default 64 MiB: far below V8's string limit). */
  maxLineBytes?: number;
}

const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** The run-folder files that carry text and are linked from reports. meta.json comes last: it also records the result. */
const SCANNED = ['summary.json', 'k6.log', 'k6-config.json', 'timeseries.json', 'meta.json'];

/** A known secret shorter than this is not looked for: it would match ordinary text (auth.ts refuses a shorter header key). */
export const MIN_SECRET_CHARS = 4;

/** A JWT: header and payload start with base64url of `{"`, then the signature. Replaced as a whole. */
export const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]*/g;

/** summary.json without k6's setup_data key; the text itself when it has none (or is not JSON). */
function withoutSetupData(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== 'object' || !Object.hasOwn(parsed, 'setup_data')) return text;
  delete (parsed as Record<string, unknown>).setup_data;
  return JSON.stringify(parsed);
}

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Each secret, and its JSON-escaped form when that differs (a value holding `"` or `\` sits escaped in a JSON file). */
function forms(secrets: string[]): string[] {
  const all = secrets.flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1)]);
  return [...new Set(all)].sort((a, b) => b.length - a.length);
}

/** `text` with every occurrence of each form replaced by `[redacted]`. */
function withoutSecrets(text: string, secretForms: string[]): string {
  let out = text;
  for (const secret of secretForms) out = out.split(secret).join('[redacted]');
  return out;
}

/**
 * The scan result in words, as the report's "Secret scan" line and the run's console warning say it: the files that held a
 * token (now redacted) apart from the files that could not be scanned, which are not proven clean but were not changed.
 */
export function describeSecretScan(scan: SecretScan): string {
  if (scan.ok) return 'no token found';
  const unscanned = scan.unscanned ?? [];
  const removed = scan.files.filter((file) => !unscanned.some((u) => u.file === file));
  return [
    ...(removed.length > 0 ? [`tokens were found and removed from ${removed.join(', ')}`] : []),
    ...unscanned.map((u) => `${u.file} ${u.reason}`),
  ].join('; ');
}

class LineTooLong extends Error {}

/**
 * Redact the secrets in a gzipped file as a stream, line by line, into a temporary file that replaces it only when something
 * was found. A file of any length is scanned without holding it in memory; a single line longer than `maxLineBytes` is not.
 * @returns whether the file held a secret, or why it could not be scanned
 */
async function scanGzip(file: string, secretForms: string[], maxLineBytes: number): Promise<{ hit: boolean } | { reason: string }> {
  const tmp = `${file}.scan-tmp`;
  let hit = false;
  async function* redactLines(source: AsyncIterable<Buffer>): AsyncGenerator<string> {
    let rest = '';
    const decoder = new StringDecoder('utf8'); // a character split across two chunks stays whole
    for await (const chunk of source) {
      rest += decoder.write(chunk);
      const end = rest.lastIndexOf('\n');
      const lines = end < 0 ? '' : rest.slice(0, end + 1);
      rest = rest.slice(end + 1);
      // The unfinished line is what grows in memory; a finished one is checked too, so the limit means the same either way.
      if (Buffer.byteLength(rest) > maxLineBytes || lines.split('\n').some((line) => Buffer.byteLength(line) > maxLineBytes)) {
        throw new LineTooLong();
      }
      if (lines === '') continue;
      const cleaned = withoutSecrets(lines, secretForms);
      if (cleaned !== lines) hit = true;
      yield cleaned;
    }
    rest += decoder.end();
    if (Buffer.byteLength(rest) > maxLineBytes) throw new LineTooLong();
    const cleaned = withoutSecrets(rest, secretForms);
    if (cleaned !== rest) hit = true;
    yield cleaned;
  }
  try {
    await pipeline(createReadStream(file), createGunzip(), redactLines, createGzip(), createWriteStream(tmp));
  } catch (err) {
    await rm(tmp, { force: true });
    return { reason: err instanceof LineTooLong ? `has a line longer than ${maxLineBytes} bytes, not scanned` : 'could not be decompressed, not scanned' };
  }
  if (hit) await rename(tmp, file);
  else await rm(tmp, { force: true });
  return { hit };
}

/**
 * Scan the run folder for tokens and for the secrets the runner knows, remove what it finds and say so. Drops the
 * `setup_data` key from summary.json and replaces every JWT-shaped string in summary.json, k6.log, k6-config.json,
 * timeseries.json and meta.json with `[redacted]`. Each of `secrets` (for example the value a static header took from
 * `${env:NAME}`; at least 4 characters) is replaced as a literal in every file of the folder, a gzipped one included,
 * because a script may log it or write it from its own handleSummary. Files without a finding are left byte for byte.
 * The result is also written into meta.json as `secretScan` (when meta.json exists), so a run folder always says whether
 * it was clean.
 * @returns ok, or the names of the files that held something
 */
export async function scanRunFolder(runDir: string, secrets: string[] = [], options: ScanOptions = {}): Promise<SecretScan> {
  const known = forms(secrets.filter((s) => s.length >= MIN_SECRET_CHARS));
  const maxLineBytes = options.maxLineBytes ?? MAX_LINE_BYTES;
  // The fixed files first, in their order, then (when there are known secrets) every other file of the folder, sorted;
  // meta.json last: it also records the result below.
  const extra: string[] = [];
  if (known.length > 0) {
    for (const name of (await readdir(runDir)).sort()) {
      if (!SCANNED.includes(name) && (await stat(join(runDir, name))).isFile()) extra.push(name);
    }
  }
  const order = [...SCANNED.filter((n) => n !== 'meta.json'), ...extra, 'meta.json'];
  const files: string[] = [];
  const unscanned: { file: string; reason: string }[] = [];
  // Fail safe: a file that cannot be read or scanned is recorded and the scan goes on, so meta.json always gets the result.
  for (const name of order) {
    const file = join(runDir, name);
    if (name.endsWith('.gz')) {
      const result = await scanGzip(file, known, maxLineBytes);
      if ('reason' in result) {
        files.push(name);
        unscanned.push({ file: name, reason: result.reason });
      } else if (result.hit) {
        files.push(name);
      }
      continue;
    }
    let original: string | null;
    try {
      original = await readIfPresent(file);
    } catch {
      files.push(name);
      unscanned.push({ file: name, reason: 'could not be read, not scanned' });
      continue;
    }
    if (original === null) continue;
    let cleaned = withoutSecrets(original, known);
    if (SCANNED.includes(name)) cleaned = (name === 'summary.json' ? withoutSetupData(cleaned) : cleaned).replace(JWT, '[redacted]');
    if (cleaned === original) continue;
    files.push(name);
    await writeFile(file, cleaned, 'utf8');
  }
  const scan: SecretScan =
    files.length === 0 ? { ok: true } : unscanned.length === 0 ? { ok: false, files } : { ok: false, files, unscanned };

  const metaFile = join(runDir, 'meta.json');
  const metaText = await readIfPresent(metaFile);
  if (metaText !== null) {
    try {
      await writeFile(metaFile, `${JSON.stringify({ ...JSON.parse(metaText), secretScan: scan }, null, 2)}\n`, 'utf8');
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err; // meta.json that is not JSON cannot carry the record
    }
  }
  return scan;
}
