// The consultant's knowledge base: knowledge/references.md is a list of cited sources, one `## <id>` entry each with the
// four bullet lines Title, URL, Read and Claim. Other files cite an entry as `[ref:<id>]`; referenceIds() is what a
// findings checker uses to tell a real citation from an invented one.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { REPO_ROOT } from './config.js';

export interface Reference {
  id: string;
  title: string;
  url: string;
  /** The date the source was read, YYYY-MM-DD. */
  read: string;
  /** The one claim this source supports, in our words. */
  claim: string;
}

const ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const LINES = ['Title', 'URL', 'Read', 'Claim'] as const;

function isRealDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

/**
 * The entries of a references.md text. Anything before the first `## ` heading is introduction and ignored.
 * @throws {Error} naming the id (or the heading) and what is wrong: a bad or duplicate id, a missing or repeated line,
 * a line that is not one of the four, a URL that is not https, a read date that is not a real YYYY-MM-DD date
 */
export function parseReferences(text: string): Reference[] {
  const refs: Reference[] = [];
  const seen = new Set<string>();
  const sections = text.split(/^## /m).slice(1);
  for (const section of sections) {
    const [heading, ...body] = section.split('\n');
    const id = heading.trim();
    if (!ID.test(id)) throw new Error(`reference "${id}": the id must be lower-case words joined by "-"`);
    if (seen.has(id)) throw new Error(`reference "${id}": duplicate id`);
    seen.add(id);
    const found = new Map<string, string>();
    for (const raw of body) {
      const line = raw.trim();
      if (line === '') continue;
      const m = /^- (Title|URL|Read|Claim):\s*(.*)$/.exec(line);
      if (!m) throw new Error(`reference "${id}": unexpected line "${line}" (only - Title:, - URL:, - Read:, - Claim: are allowed)`);
      if (found.has(m[1])) throw new Error(`reference "${id}": "- ${m[1]}:" appears twice`);
      found.set(m[1], m[2].trim());
    }
    for (const name of LINES) {
      if (!found.get(name)) throw new Error(`reference "${id}": missing or empty "- ${name}:" line`);
    }
    const url = found.get('URL') as string;
    const read = found.get('Read') as string;
    if (!url.startsWith('https://')) throw new Error(`reference "${id}": the URL must start with https:// (got "${url}")`);
    if (!isRealDate(read)) throw new Error(`reference "${id}": "- Read:" must be a real date as YYYY-MM-DD (got "${read}")`);
    refs.push({ id, title: found.get('Title') as string, url, read, claim: found.get('Claim') as string });
  }
  return refs;
}

/** The references of `<root>/knowledge/references.md` (root defaults to the repo root, whatever the current directory). */
export async function loadReferences(root: string = REPO_ROOT): Promise<Reference[]> {
  return parseReferences(await readFile(join(root, 'knowledge', 'references.md'), 'utf8'));
}

/** The ids a `[ref:<id>]` citation may name. */
export async function referenceIds(root: string = REPO_ROOT): Promise<Set<string>> {
  return new Set((await loadReferences(root)).map((r) => r.id));
}
