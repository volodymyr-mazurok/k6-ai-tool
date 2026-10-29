import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { REPORT_TERMS } from '../runner/report/render.js';

const read = (file: string): string => readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

test('README explains every report term', () => {
  const readme = read('README.md');
  const missing = REPORT_TERMS.filter((term) => !readme.includes(term));
  assert.deepEqual(missing, [], 'a term the report shows is missing from README.md (section 7 walks the report)');
});

/** The words of scripts/forbidden-words.txt and every projects/<name>/forbidden-words.txt present (the lists scripts/check-shared.sh greps with). */
function forbiddenWords(): RegExp[] {
  const lists = ['scripts/forbidden-words.txt'];
  const projects = fileURLToPath(new URL('../projects', import.meta.url));
  for (const entry of readdirSync(projects, { withFileTypes: true })) {
    if (entry.isDirectory() && existsSync(`${projects}/${entry.name}/forbidden-words.txt`)) lists.push(`projects/${entry.name}/forbidden-words.txt`);
  }
  return lists
    .flatMap((file) => read(file).split('\n'))
    .filter((line) => line.trim() !== '' && !line.startsWith('#'))
    .map((line) => new RegExp(line, 'i'));
}

// The branches share these two files: main is a project-agnostic boilerplate, other branches add a project.
// Neither file may name a particular project, its env or its roles.
test('README.md and CLAUDE.md stay project-agnostic', () => {
  for (const file of ['README.md', 'CLAUDE.md']) {
    const text = read(file);
    for (const word of forbiddenWords()) {
      assert.ok(!word.test(text), `${file} matches /${word.source}/, which belongs to a particular project`);
    }
  }
});

test('every `npm run perf -- <command>` in README.md is a command the CLI lists', () => {
  const readme = read('README.md');
  const cli = read('runner/cli.ts');
  const used = new Set([...readme.matchAll(/npm run perf -- ([a-z-]+)/g)].map((m) => m[1]!));
  used.delete('help');
  assert.ok(used.size > 0, 'README shows the commands');
  for (const command of used) assert.ok(cli.includes(`'${command}'`) || cli.includes(`"${command}"`) || cli.includes(`case ${command}`), `README uses "perf ${command}", which cli.ts does not mention`);
});

// A boilerplate checkout has no docs/ and no real project, so a path the two shared documents name must be a file or
// folder that is in the shared tree: committed (or staged), present on disk, and not under docs/ or a project other than
// the template. In a git checkout the tree is `git ls-files`, so an untracked or git-ignored local file (.env, a scratch
// note, results/) never counts. Without git (a zip download) the folders are walked instead, pruning the ones that are
// never shared (node_modules, .git, .superpowers, results, .tmp, docs, real projects) before descending into them.
const NOT_SHARED = /^(docs|projects\/[^_][^/]*)(\/|$)/;
const NEVER_WALKED = new Set(['node_modules', '.git', '.superpowers', 'results', '.tmp']);
/** Paths the documents may name although they live only on another branch (README section 11 describes the demo branch). */
const OTHER_BRANCH_PATHS = ['projects/quickpizza'];

function sharedTree(root: string): string[] {
  try {
    const listed = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return listed.split('\0').filter((file) => file !== '' && !NOT_SHARED.test(file) && existsSync(`${root}/${file}`));
  } catch {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(`${root}/${dir}`, { withFileTypes: true })) {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (NOT_SHARED.test(path) || (dir === '' && NEVER_WALKED.has(entry.name)) || entry.name === '.env' || entry.name.endsWith('.har')) continue;
        if (entry.isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk('');
    return files;
  }
}

test('every repo path README.md and CLAUDE.md name exists in the shared tree', () => {
  const root = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
  const files = sharedTree(root);
  const exists = (path: string): boolean => files.some((file) => file === path.replace(/\/$/, '') || file.startsWith(`${path.replace(/\/$/, '')}/`));
  const named = /`((?:projects|runner|core|scripts|tests|examples|docs|results|node_modules)\/[^`\s<>*|]*|(?:README|CLAUDE)\.md|\.env\.example|package\.json)`/g;
  const missing: string[] = [];
  for (const file of ['README.md', 'CLAUDE.md']) {
    for (const match of read(file).matchAll(named)) {
      const path = match[1]!;
      if (/^(results|node_modules)\//.test(path)) continue; // created on use, git-ignored
      if (OTHER_BRANCH_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) continue; // on the demo branch
      if (!exists(path)) missing.push(`${file}: ${path}`);
    }
  }
  assert.deepEqual(missing, [], 'these paths are not in the shared tree (docs/ and real projects live on other branches)');
});
