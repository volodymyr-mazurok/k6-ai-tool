---
name: perf-run
description: 'Use when someone asks to run, start or launch a load, stress or soak test (or "run the load now", "kick off the soak tonight", "go bigger"), when a run is refused ("perf: refused", OUTSIDE_WINDOW, ENV_BUSY, DB_UNREACHABLE, ABOVE_DEFAULTS, CAPS_EXCEEDED, SMOKE_REQUIRED, RUN_IN_PROGRESS, exit code 2), or when a run ended FAIL, INVALID, aborted or interrupted and someone asks what went wrong.'
---

# perf-run

Runs one profile of one feature through the runner, safely, and says how it ended. It reads `projects/<name>/README.md`,
`project.yaml` (envs, caps, defaults, `window_utc`), the feature's `workload.yaml` and the run folder. It writes nothing
in the repo: no edit to `project.yaml`, `workload.yaml`, the script or a baseline. The runner writes the run folder.

**Core rule: the runner decides whether a run may happen, the owner decides whether it does.** You show the dry run,
you wait for the owner's explicit go for every load, stress or soak run, and you take a refusal as the answer. You never
suggest `--override-window`, `--override-busy` or `--allow-max`, and never pass one unless the owner asked for that flag in chat, in this session, for this run.

**Violating the letter of these rules is violating the spirit.** The runner's rules in `CLAUDE.md` apply unchanged.

## The flow

1. **Read** `projects/<name>/README.md` first (secret locations, forbidden paths). The self-test project lives in
   `runner/selftest/project/` instead of `projects/`. Note the env's `window_utc`, `defaults` and `caps`.
2. **Dry run, always first:**
   `npm run perf -- run <project> <feature> --profile <smoke|load|stress|soak> --env <env> --dry-run`.
   - It printed the plan (exit 0) → show the block in "The go block" below, then **stop and wait**.
   - It printed `perf: refused (<CODE>): …` (exit 2) → nothing ran. Report it with the refusal block below and stop.
     The refusal text may end "or pass --override-…" or "pass --allow-max": never repeat it as an option (owner only).
     The runner lists the flag that exists; it is not advice for you.
3. **The go.** Only the owner's explicit yes **after** they saw the dry run starts a load, stress or soak run: "go",
   "yes, run it". The request that came before the dry run ("run the load now") is the request, not the go. One go is
   one run; a second run (rerun, other profile, other env) needs its own dry run and its own go. A smoke needs no go.
4. **Run** exactly the dry-run command without `--dry-run`:
   `npm run perf -- run <project> <feature> --profile <profile> --env <env>`. A load, stress or soak with no passing
   smoke of this script and config runs the smoke first (the dry run said `smoke: runs first`); a red smoke stops it
   with `SMOKE_REQUIRED` and a smoke folder to read. Do not touch the files while it runs. Ctrl+C ends it cleanly.
5. **Read how it ended:** the exit code (0 finished, 1 failed, 2 refused, 130 interrupted) and the last line,
   `perf: verdict <WORD> — <reasons>`. Exit 0 is not a good result; the verdict is. Then `perf: run folder <runDir>`.
6. **Healthy** (PASS, NO BASELINE, DEGRADED): the run measured what it planned. Hand the folder to perf-report.
   **Unhealthy** (FAIL, INVALID, a refusal, an interrupt): classify it with the table below, naming the file and field
   that shows it, and what would fix it. One cause per run; when two show, name the first in the table.
7. **Done:** a run folder with a report, and the one-paragraph account below.

## Refusals: what each means and what you say

| `perf: refused (…)` | Means | You say / do |
| --- | --- | --- |
| `OUTSIDE_WINDOW` | Load, stress and soak only inside `window_utc`, at the start **and** at start + the profile's length | The window, the time now, the **next allowed start** and the latest start that still ends inside (below). Offer to dry-run again then. No override. |
| `ABOVE_DEFAULTS` | The workload asks more users or req/s than the env's `defaults` | The size asked against the defaults. A smaller workload is perf-consult's sizing and the owner's call; the larger one is the owner's call alone. |
| `CAPS_EXCEEDED` | Above the caps or `max_duration` | Nothing lifts a cap. The workload must shrink (owner, with perf-consult). |
| `ENV_BUSY` | The database's CPU or IO was high, or its load could not be read | Someone else is working. Say so; dry runs do not check it, so a real start can still refuse. Try again only when the person says. |
| `DB_UNREACHABLE` | The database cannot be reached: no guard, no load | An env or adapter problem for the person (`npm run perf -- doctor <project> --env <env>`). Nothing overrides it. |
| `SMOKE_REQUIRED` | The smoke that had to run first failed | Read the smoke folder it names; that is perf-script's job. No load until it is green. |
| `RUN_IN_PROGRESS` | Another run on this env from this machine holds the lock | Wait for it; never delete the lock. |
| `ENV_NOT_ALLOWED`, `ABORT_LOOSENED`, journey check | Config | Report as printed; config is the owner's. |

**The next allowed start.** The window is `HH:MM-HH:MM` UTC on weekdays plus `weekends: all-day` or not. A window that
runs past midnight belongs to the weekday it began on (Monday 02:00 is the tail of Sunday's night, so it follows the
weekend rule). Take the next moment, from now, where the window holds; the run must also end inside it, so the latest
start of that stretch is its end minus the dry run's `duration`. Example: window `17:00-06:00` on weekdays, all day on
weekends, now Tue 13:01 UTC, a load of `1 min 25 s` → "next allowed start Tue 17:00 UTC; the latest start that night is
about 05:58 UTC". State it in UTC, as the window is.

## Unhealthy runs: whose problem it is

Read in order: the `perf:` lines, `<runDir>/meta.json`, `<runDir>/k6.log`, `<runDir>/summary.json`,
`<runDir>/timeseries.json`, `<runDir>/db.json` (when present), `<runDir>/report.md`.

| What shows | Where (file → field) | Class | What would fix it |
| --- | --- | --- | --- |
| `perf: refused (…)`, exit 2 | the printed line; no run folder (`SMOKE_REQUIRED`: the smoke's folder) | guardrail refusal | the refusals table above |
| Script errors (`ReferenceError`, `TypeError`, `has no content check`), or "does not match the journey" | `meta.json` → `k6.scriptErrors`, `checks`; `k6.log` | script bug | perf-script, then a fresh smoke |
| `aborted by a k6 threshold: http_req_duration … p(95)<…` | `meta.json` → `k6.abortReason` = `thresholds`; the verdict reason names the metric; `timeseries.json` → `buckets[].p95` and `vus` | guardrail abort; the cause is app slow or env overloaded | p95 rising with `vus` while the smoke was fast → capacity (perf-report, perf-consult); p95 high from the first bucket → a slow step or env, look at the slowest step |
| `aborted by a k6 threshold: http_req_failed …`, or failed checks on a step | `summary.json` → `http_req_failed{name:<step>}.values.rate`, `checks{name:<step>}.values.fails`; `k6.log` | app error (one step, 4xx/5xx or wrong bodies) or env (every step) | confirm one step with `npm run perf -- probe …`; report to the app's team; never retry it into green |
| Connection refused, timeouts, DNS, `token endpoint returned …` | `k6.log`; `http_req_failed` near 100% on every step | env down or accounts | the person checks the env and `.env` (`npm run perf -- doctor <project> --env <env>`); one rerun after they say it is back |
| `stopped by the database guard` | `meta.json` → `k6.abortReason` = `db`; `db.json` | guardrail abort; env overloaded or the guard went blind | the database's owner; rerun only on the person's word |
| `the run was interrupted` | `meta.json` → `interrupted`; exit 130 | interrupt | numbers up to the stop are partial; say who stopped it if known |
| `row counts changed … cleanup is incomplete` | `meta.json` → `cleanup` (before, after) | app or journey (a write nobody cleans up) | report the tables and counts; never touch `row_count_tables` |
| INVALID: the build changed | `meta.json` → `fingerprint.changed` | env (redeployed mid-run) | rerun after the deploy, with a new dry run and go |
| INVALID: busy override | `meta.json` → `guardrails.busyOverride` | guardrail (owner's flag) | the numbers include other people's load; say so |

## The blocks

**The go block** (after a dry run that printed a plan):

```markdown
### Dry run: <project>/<feature> <profile> on <env>
- Users: <users line> · Req/s: <req/s line, its "--allow-max raises it" clause left out: never yours, owner only> · Duration: <duration>
- Window: <window line> · Smoke: <passed already (<runId>) | runs first>
- Abort: <abort line> · Not checked by a dry run: the database busy check (it runs at the real start)
Go? (one yes = this one run)
```

**The refusal block:**

```markdown
### Refused: <project>/<feature> <profile> on <env> — nothing ran
- Runner: `perf: refused (<CODE>): <the reason, without the override sentence>`
- <OUTSIDE_WINDOW: Window <weekdays> UTC on weekdays, <weekends>; now <day HH:MM> UTC; next allowed start <day HH:MM> UTC (latest start <HH:MM> UTC for this <duration> run)>
- Next: <what would let it run, and whose call it is>. I can dry-run it again then.
```

**The account** (one paragraph, after every run): what ran (project, feature, profile, env, users, duration planned
against `Duration` reached), how it ended (exit code, the verdict line as printed), the class when unhealthy with the
file and field that shows it, and the next step (perf-report for findings, perf-script for a script bug, the person
for an env problem). Quote numbers from the report as printed; findings with citations are perf-report's job.

## Red flags: stop

- A load, stress or soak started without a dry run shown and a yes given after it, or on a yes for an earlier run.
- `--override-window`, `--override-busy` or `--allow-max` on a command line or offered as an option by you (never; only when the owner asks for it in chat).
- "Pass --override-window" or "pass --allow-max" copied from a refusal into your answer: never, the owner names it first.
- `window_utc`, `defaults`, `caps`, abort limits or the workload's size edited so a refusal goes away.
- A wait loop, `sleep`, `at`, cron or a background job that starts the run when the window opens: no unattended load.
- A plain `k6 run`, a script of yours that sends load, or a retry of a refused or failed run "to see".
- "Exit 0, done" without the verdict; a FAIL reported without its class and evidence.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "They said run it now, that is the go." | It was the request. Dry run, show it, wait for the yes. |
| "It is only the local mock / a small run." | Same flow; the go costs one message. |
| "The window ends in ten minutes; the run is short." | The runner checks start and end. Refused means refused; give the next allowed start. |
| "The refusal itself says I may pass --override-window." | It names the flag that exists. It is the owner's, not yours, and you do not suggest it. |
| "I'll queue it for 17:00 so they need not wait." | No scheduled or unattended runs. Offer to dry-run again at 17:00 with them. |
| "Shortening the profile would fit the window." | `workload.yaml` is the owner's, and a changed file needs a new smoke. Say it would fit; let the owner choose. |
| "The run failed on timeouts, one more try will pass." | A rerun hides the cause. Classify first; rerun only on the person's word. |
