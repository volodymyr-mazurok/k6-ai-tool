#!/usr/bin/env bash
# Proves the shared files are a complete, green, project-agnostic boilerplate: checks out HEAD into a scratch worktree,
# deletes every project except projects/_template and the docs/ folder (they live on a project's own branch), then runs
# npm ci, npm test, tsc --noEmit and a grep for the forbidden words: scripts/forbidden-words.txt plus the
# projects/*/forbidden-words.txt of the projects that were there (read before they are deleted).
#
#   scripts/check-shared.sh              full check (needs the npm registry or a warm npm cache)
#   scripts/check-shared.sh --grep-only  only the word grep, over the tracked files as they are now in the working tree
#                                        (uncommitted edits included; the full mode checks HEAD only)
#
# The words are extended regular expressions, one per line (lines starting with # are comments). The same lists are
# read by tests/readme.test.ts. A project's own list is excluded from the grep with the rest of its folder.
#
# The full mode checks committed files only; commit first. Exit code 0 means all gates passed.
set -u
root="$(cd "$(dirname "$0")/.." && pwd)"
# Files that belong to a particular project: anything under projects/ except the template, and docs/.
exclude='^(projects/[^_]|docs/)'

# The words to look for: the shared list plus the list of every project present, without comment and blank lines.
# Collected into $1 from the checkout $2 (the full mode does it before it deletes the projects).
collect_words() {
  cat "$2/scripts/forbidden-words.txt" "$2"/projects/*/forbidden-words.txt 2>/dev/null | grep -v -e '^#' -e '^[[:space:]]*$' >"$1"
  return 0
}

# Printed instead of an "ok" when the lists hold no word: an empty list proves nothing about the shared files.
no_words='0 project words: nothing to grep (only a branch that holds a private project can prove the shared files clean)'

# Tracked files that are not a project's own or docs/ and contain one of the words in $1; prints their names.
grep_words() {
  if [ ! -s "$1" ]; then return 0; fi
  git ls-files | grep -v -E "$exclude" | xargs grep -I -i -l -E -f "$1"
}

if [ "${1:-}" = "--grep-only" ]; then
  cd "$root" || exit 2
  words="$(mktemp "${TMPDIR:-/tmp}/perf-words.XXXXXX")"
  collect_words "$words" "$root"
  if [ ! -s "$words" ]; then rm -f "$words"; echo "$no_words"; exit 0; fi
  hits="$(grep_words "$words")"; rm -f "$words"
  if [ -n "$hits" ]; then echo "$hits"; echo "FAIL: project words in shared files"; exit 1; fi
  echo "ok: no project words in shared files"
  exit 0
fi

scratch="$(mktemp -d "${TMPDIR:-/tmp}/perf-check-shared.XXXXXX")"
tree="$scratch/main-check"
cleanup() { git -C "$root" worktree remove --force "$tree" >/dev/null 2>&1; rm -rf "$scratch"; git -C "$root" worktree prune; }
trap cleanup EXIT

git -C "$root" worktree add --detach "$tree" HEAD >/dev/null || exit 2
cd "$tree" || exit 2
words="$scratch/words.txt"
collect_words "$words" "$tree" # before the projects are deleted below
for dir in projects/*/; do
  case "$(basename "$dir")" in _*) ;; *) rm -rf "$dir" ;; esac
done
rm -rf docs

status=0
echo "== npm ci"
npm ci --prefer-offline --no-audit --no-fund >"$scratch/ci.out" 2>&1 || { cat "$scratch/ci.out"; echo "FAIL: npm ci"; exit 1; }
echo "== npm test"
npm test >"$scratch/test.full" 2>&1; test_status=$?
tail -n 9 "$scratch/test.full"
# both must agree: a non-zero exit (a crash before the summary) and a summary with failures each fail the gate
if [ "$test_status" -ne 0 ] || ! grep -q '^# fail 0$' "$scratch/test.full"; then echo "FAIL: npm test (exit $test_status)"; status=1; fi
echo "== npx tsc --noEmit"; npx tsc --noEmit || { echo "FAIL: tsc"; status=1; }
echo "== project words in shared files (expect no output)"
if [ ! -s "$words" ]; then
  echo "$no_words"
  [ "$status" -eq 0 ] && echo "ok: shared files are green (the word grep had nothing to look for)"
  exit "$status"
fi
hits="$(grep_words "$words")"; if [ -n "$hits" ]; then echo "$hits"; echo "FAIL: project words in shared files"; status=1; fi
[ "$status" -eq 0 ] && echo "ok: shared files are project-agnostic and green"
exit "$status"
