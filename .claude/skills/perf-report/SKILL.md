---
name: perf-report
description: Use when a run folder under results/ needs findings for the team (findings.md, "Findings and recommendations", "write up the run", "what did the load show", "is it a regression"), when a run should be compared with its baseline or an earlier run, or when `report --verify-findings` prints an uncited number, a number that does not match its source, or an unknown reference.
---

# perf-report

Writes `<runDir>/findings.md` for one run folder, re-renders the report and proves every number in it. It reads the run
folder (`meta.json`, `summary.json`, `timeseries.json`, `db.json` when present, `report.md`, `k6.log`), the baseline the
run was judged against (`meta.json` → `baseline`) and, when asked, one earlier run folder. It writes only `findings.md`
and the re-rendered `report.html` / `report.md` (through the runner, never by hand). It never accepts a baseline and runs
nothing but `report` and `compare`.

**Core rule: part 1 says what the run folder shows, and nothing it does not.** Every number is cited
`N[[fmt|expr]]` to this folder's files, every finding names its evidence (file → field) and a confidence, and causes,
reference points and advice stay out of part 1. They are part 2, which is perf-consult's.

**Violating the letter of these rules is violating the spirit.** The runner's rules in `CLAUDE.md` apply unchanged.

## The flow

1. **Read** `projects/<name>/README.md` first when the run belongs to a project under `projects/` (the self-test
   project lives in `runner/selftest/project/`). Then the run folder: `report.md` top to bottom for orientation,
   `meta.json` for the facts, `summary.json` and `timeseries.json` for the numbers you will cite.
2. **Is the run worth findings?** Check `meta.json` → `profile.totalSec` against the reached duration
   (`summary.json` → `state.testRunDurationMs`) and the verdict. A smoke (single samples), an aborted, interrupted or
   INVALID run gets findings that say what it can and cannot tell, by `findings-rules.md` section 3; a FAIL from a
   script or env problem is perf-run's classification first.
3. **Pick the comparison** by `findings-rules.md` section 2: the baseline recorded in `meta.json` → `baseline`, or one
   earlier run that differs from this one in one thing. Several differences, or none to compare with: numbers stand alone.
4. **Write part 1, "What the run shows"**, by `findings-rules.md` section 1: verdict and reason, load reached, flags,
   slowest steps, errors and checks, what the run cannot tell. Each finding with its evidence and confidence.
5. **Part 2, "Compared with reference points, and suggestions"**. **REQUIRED SUB-SKILL:** perf-consult, its
   `analysis.md` (reference points from `knowledge/references.md`, labelled assumptions, ranked leads). Part 2 may use
   only part 1's facts and the folder; it never changes part 1.
6. **Verify:** `npm run perf -- report <runDir> --verify-findings`. It re-renders the report, traces every number on
   the page and in `findings.md`, and must print `findings: N numbers traced, M references` with exit 0. Each problem
   line names the line and the fix (`"23" … is "22"` → write `22`). Fix, run again. Citation pitfalls: the list in
   perf-consult's `analysis.md`, "Citing numbers".
7. **Done** when `--verify-findings` passes. Tell the person the verdict and the main finding in one sentence each, with
   the run folder's path. If they want the run as a new baseline, the command is
   `npm run perf -- baseline accept <runDir>` (it refuses a smoke, FAIL or INVALID run); whether to is the owner's call.

## Red flags: stop

- A number in `findings.md` with no `[[fmt|expr]]`, glued to a word (`p95=704ms`), or put in backticks or a code block to dodge the check.
- A number from another run folder, from chat, from `perf compare` output or from memory written as if cited.
- A cause in part 1 ("the database is slow", "an index is missing") or a reference point, a target or advice in part 1.
- A comparison with a run that differs in more than one thing (commit and users, env and build) presented as a regression.
- A step with a handful of requests treated as a trend, or a smoke's single samples read as performance.
- `report.md` or `report.html` edited by hand; `findings.md` "done" without a passing `--verify-findings`.
- `baseline accept` run on your own, or a DEGRADED run proposed as the new baseline without saying it is the regression.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "The number is in the report, a citation is overkill." | Every number in `findings.md` is cited, or `--verify-findings` fails and the reader cannot trace it. |
| "The cause is obvious from the numbers." | Part 1 shows symptoms. The cause is a lead with evidence and confidence in part 2. |
| "Last week's run is close enough to compare." | List what differs in `meta.json`. More than one thing → no comparison, say why. |
| "I'll keep the compare table in a code block." | A code block is not checked. Cite this run's number and the baseline from `meta.json`; describe another run in words. |
| "The verify problem is a rounding nit; I'll leave it." | Write what the format prints. Not done until it passes. |
