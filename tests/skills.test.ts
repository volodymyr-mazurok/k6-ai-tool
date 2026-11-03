// Lint for the agent skills in .claude/skills/<name>/: the rules every skill must keep, whatever it does.
// A skill is a shared file (it travels to every branch), so it names no project, only commands the CLI has, only paths
// that exist, and never hands out a guardrail override without saying it needs the owner.

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { referenceIds } from '../runner/knowledge.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const SKILLS = `${ROOT}/.claude/skills`;
const read = (file: string): string => readFileSync(`${ROOT}/${file}`, 'utf8');

/** The command names of the USAGE text in runner/cli.ts (each listed as a two-space-indented line). */
export function usageCommands(cliSource: string): Set<string> {
  const usage = /const USAGE = `([\s\S]*?)`;/.exec(cliSource)?.[1] ?? '';
  return new Set([...usage.matchAll(/^ {2}([a-z][a-z-]*)\b/gm)].map((m) => m[1]!));
}

/** The frontmatter of a SKILL.md (the YAML between the first two `---` lines), or undefined. */
export function frontmatter(text: string): Record<string, unknown> | undefined {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) return undefined;
  const parsed: unknown = parseYaml(m[1]!);
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
}

/** `npm run perf -- <cmd>` uses whose command the CLI does not list. */
export function unknownCommands(text: string, commands: Set<string>): string[] {
  return [...text.matchAll(/npm run perf -- ([a-z][a-z-]*)/g)].map((m) => m[1]!).filter((cmd) => !commands.has(cmd));
}

const OVERRIDE = /--(override-window|override-busy|allow-max)\b/;
/** Lines that name a guardrail override without `never` or `owner` on the same line. */
export function unguardedOverrides(text: string): string[] {
  return text.split('\n').filter((line) => OVERRIDE.test(line) && !/\bnever\b|\bowner/i.test(line));
}

// Repo paths in backticks. A path with a placeholder (`projects/<name>/…`, `<runDir>/findings.md`) never matches,
// because `<` ends the match before the closing backtick.
const NAMED_PATH = /`((?:\.claude|knowledge|projects|runner|core|scripts|tests|examples|docs|results|node_modules)\/[^`\s<>*|]*|(?:README|CLAUDE)\.md|\.env\.example|package\.json)`/g;
/** Not in the shared tree: docs/ and real projects live on a project's own branch. */
const NOT_SHARED = /^(docs|projects\/[^_][^/]*)(\/|$)/;

/** Paths a text names that are not in the shared tree on disk (created-on-use folders excepted). */
export function missingPaths(text: string, exists: (path: string) => boolean): string[] {
  const missing: string[] = [];
  for (const m of text.matchAll(NAMED_PATH)) {
    const path = m[1]!;
    if (/^(results|node_modules)\//.test(path)) continue; // created on use, git-ignored
    if (NOT_SHARED.test(path) || !exists(path)) missing.push(path);
  }
  return missing;
}

/** The `[ref:<id>]` citations of a text whose id is not in `ids` (the placeholders `[ref:id]` and `[ref:<id>]` excepted). */
export function unknownRefs(text: string, ids: Set<string>): string[] {
  return [...text.matchAll(/\[ref:([^\]\s]*)\]/g)].map((m) => m[1]!).filter((id) => id !== 'id' && !/^<.*>$/.test(id) && !ids.has(id));
}

/** The words of scripts/forbidden-words.txt and every projects/<name>/forbidden-words.txt present. */
function forbiddenWords(): RegExp[] {
  const lists = ['scripts/forbidden-words.txt'];
  for (const entry of readdirSync(`${ROOT}/projects`, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(`${ROOT}/projects/${entry.name}/forbidden-words.txt`)) lists.push(`projects/${entry.name}/forbidden-words.txt`);
  }
  return lists
    .flatMap((file) => read(file).split('\n'))
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => new RegExp(line, 'i'));
}

/** Every skill folder and the Markdown files in it (SKILL.md and its supporting files). */
function skills(): { name: string; files: { path: string; text: string }[] }[] {
  if (!existsSync(SKILLS)) return [];
  return readdirSync(SKILLS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      files: readdirSync(`${SKILLS}/${entry.name}`)
        .filter((file) => file.endsWith('.md'))
        .map((file) => {
          const path = `.claude/skills/${entry.name}/${file}`;
          return { path, text: read(path) };
        }),
    }));
}

// --- the lint functions themselves, on made-up text, so a lint that matches nothing cannot pass by accident

test('lint: the USAGE text yields the CLI commands', () => {
  const commands = usageCommands(read('runner/cli.ts'));
  for (const cmd of ['run', 'check', 'report', 'probe', 'record', 'har-summary', 'baseline', 'compare', 'selftest']) assert.ok(commands.has(cmd), cmd);
  assert.ok(!commands.has('help'));
});

test('lint: each rule catches its own violation', () => {
  assert.deepEqual(unknownCommands('`npm run perf -- run x` then `npm run perf -- launch x`', new Set(['run'])), ['launch']);
  assert.deepEqual(unguardedOverrides('pass --allow-max to go higher\nnever pass --override-busy\nonly with the owner: --override-window'), ['pass --allow-max to go higher']);
  assert.deepEqual(missingPaths('`knowledge/references.md`, `knowledge/nope.md`, `projects/<name>/README.md`, `projects/some-app/x`', (p) => p === 'knowledge/references.md'), ['knowledge/nope.md', 'projects/some-app/x']);
  assert.deepEqual(unknownRefs('[ref:littles-law], [ref:id], [ref:<id>] and [ref:made-up]', new Set(['littles-law'])), ['made-up']);
  assert.equal(frontmatter('---\nname: a\ndescription: Use when b\n---\n# A\n')?.name, 'a');
  assert.equal(frontmatter('# no frontmatter\n'), undefined);
});

// --- the skills

test('the perf-consult skill exists', () => {
  assert.ok(existsSync(`${SKILLS}/perf-consult/SKILL.md`), '.claude/skills/perf-consult/SKILL.md is missing');
});

test('every skill has frontmatter: name = its folder, a "Use when" description of at most 1024 characters', () => {
  for (const skill of skills()) {
    const main = skill.files.find((f) => f.path.endsWith('/SKILL.md'));
    assert.ok(main, `${skill.name}: no SKILL.md`);
    const fm = frontmatter(main.text);
    assert.ok(fm, `${main.path}: no YAML frontmatter`);
    assert.equal(fm.name, skill.name, `${main.path}: name must equal the folder`);
    assert.equal(typeof fm.description, 'string', `${main.path}: description missing`);
    const description = fm.description as string;
    assert.ok(description.startsWith('Use when'), `${main.path}: description must start "Use when"`);
    assert.ok(description.length <= 1024, `${main.path}: description is ${description.length} characters (max 1024)`);
  }
});

test('every `npm run perf -- <command>` in a skill is a command of the CLI', () => {
  const commands = usageCommands(read('runner/cli.ts'));
  for (const { files } of skills()) for (const f of files) assert.deepEqual(unknownCommands(f.text, commands), [], `${f.path} uses a command cli.ts USAGE does not list`);
});

test('every repo path a skill names exists in the shared tree', () => {
  const exists = (path: string): boolean => existsSync(`${ROOT}/${path.replace(/\/$/, '')}`);
  for (const { files } of skills()) for (const f of files) assert.deepEqual(missingPaths(f.text, exists), [], `${f.path} names paths that are not there`);
});

test('a skill names a guardrail override only together with "never" or "owner"', () => {
  for (const { files } of skills()) for (const f of files) assert.deepEqual(unguardedOverrides(f.text), [], `${f.path}: say on the same line that it is never used without the owner's OK`);
});

test('every [ref:id] a skill cites is in knowledge/references.md', async () => {
  const ids = await referenceIds(ROOT);
  for (const { files } of skills()) for (const f of files) assert.deepEqual(unknownRefs(f.text, ids), [], `${f.path} cites unknown references`);
});

test('skills stay project-agnostic (no forbidden word)', () => {
  const words = forbiddenWords();
  for (const { files } of skills()) {
    for (const f of files) for (const word of words) assert.ok(!word.test(f.text), `${f.path} matches /${word.source}/, which belongs to a particular project`);
  }
});
