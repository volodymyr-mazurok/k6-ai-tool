# Findings rules: part 1, "What the run shows"

The shape of `findings.md` (two parts, these headings, this order) and the citation syntax are in perf-consult's
`analysis.md`; README section 7 has the formats. This file says what goes into part 1 and how to back it.

## 1. Part 1: what goes in, in this order

Start with `## What the run shows`, then a `Run:` line with the run's date and time only (`Run: 2026-10-29 14:48 UTC`).
Then numbered findings, most important first. Each finding has four parts:

- **Claim** in bold, one sentence, a fact the folder shows ("`items.slow_search` regressed"), never a cause.
- **Numbers**, each cited to this folder: `summary.json`, `timeseries.json`, `db.json`, `meta.json`. Expressions may
  combine files (`summary.json#… / meta.json#… - 1`).
- **Evidence:** the file and field, written `` `summary.json` → `http_req_duration{name:<step>}` ``.
- **Confidence:** high | medium | low, by the table below.

What to cover, where each comes from:

| Finding | Source (file → field) |
| --- | --- |
| Verdict and its reasons | `report.md` top (built from `meta.json`); the word and the reason as printed |
| Load reached vs planned | `meta.json` → `profile` (`users`, `totalSec`); `summary.json` → `state.testRunDurationMs`, `metrics.vus_max.values.max`, `metrics.http_reqs.values.count` |
| Each flag: step, value, baseline, limit | `summary.json` → `http_req_duration{name:<step>}.values["p(95)"]`; `meta.json` → `baseline.steps["<step>"].p95`, `rules.flags` (`p95Factor`, `p95AddMs`, `errorRate`, `checkFailureRate`); the p95 limit is the larger of baseline × `p95Factor` and baseline + `p95AddMs` |
| Slowest steps by p95, with their request counts | `summary.json` → `http_req_duration{name:<step>}.values["p(95)"]` and `.values.count` |
| Failed requests and checks per step | `summary.json` → `http_req_failed{name:<step>}.values.rate`, `checks{name:<step>}.values.passes` / `.fails` |
| How it moved over time | `timeseries.json` → `buckets[i]` (`t`, `vus`, `reqs`, `rps`, `p95`, `errors`, `dropped`) |
| Database load, top statements | `db.json`, only when the folder has it |
| What the run cannot tell | the "proves vs suggests" list in perf-consult's `analysis.md` |

Steps that did not change are a finding too ("`items.search` unchanged"): they show the change is local to one step.

**Confidence:**

| Level | When |
| --- | --- |
| high | a rule fired, or a difference far beyond the limit, on about a hundred requests or more, against a baseline (or a run) that differs in one thing |
| medium | a clear difference on fewer requests, or a stretch of `timeseries.json` rather than the whole run, or a shared env where other activity is possible |
| low | a handful of requests, a run that stopped early, a smoke, or no baseline (numbers alone, nothing to call worse) |

**Never in part 1:** a cause ("the database", "a missing index", "a lock"), a reference point or `[ref:id]`, a target
the run did not have, advice. Those are part 2.

## 2. What to compare with

1. **The baseline in `meta.json` → `baseline`** is the default: it is the one the verdict used, and its numbers are
   citable from this folder (`meta.json#baseline.steps["<step>"].p95`). No baseline there → say so and call nothing worse.
2. **An earlier run folder**, when the person asks or there is no baseline, only when the two differ in **one** thing.
   Compare their `meta.json`: `project`, `feature`, `env`, `profile`, `workload`, `abort`, `git.commit` and `git.dirty`,
   `fingerprint.after` (app build, swagger), `k6Version`, `loadMachine`, `guardrails`, `database`. Name the one
   difference ("only the commit changed"). Two or more → no comparison; list what differs.
3. `npm run perf -- compare <runDirA> <runDirB>` prints the p95 change per step. Its numbers come from the other folder,
   which `findings.md` cannot cite: describe the direction in words with the run id ("slower on this step than the run
   of 14:45, see `perf compare`") and cite only this run's own numbers.

## 3. Runs that say little

| Run | Part 1 says |
| --- | --- |
| smoke | single samples: it shows the journey works, not how fast; no regression call |
| stopped early (aborted, interrupted) | how long it ran against the plan, what stopped it (`meta.json` → `k6.abortReason`, `interrupted`), and that the figures cover the whole run, not the steady state |
| INVALID | why (`meta.json` → `fingerprint.changed`, `guardrails.busyOverride`), and that its numbers cannot be compared |
| FAIL from a script or env problem | perf-run's class and its evidence, and that no performance finding follows |

## 4. Example (the self-test's planted regression)

```markdown
## What the run shows

Run: 2026-10-29 14:48 UTC

1. **`items.slow_search` regressed; it is the only flagged step.** p95 704 ms[[int|summary.json#metrics["http_req_duration{name:items.slow_search}"].values["p(95)"]]]
   against a baseline of 403 ms[[int|meta.json#baseline.steps["items.slow_search"].p95]] (+75%[[signedPct|summary.json#metrics["http_req_duration{name:items.slow_search}"].values["p(95)"] / meta.json#baseline.steps["items.slow_search"].p95 - 1]]),
   above the flag limit of 503 ms[[int|meta.json#baseline.steps["items.slow_search"].p95 + meta.json#rules.flags.p95AddMs]],
   over 131[[int|summary.json#metrics["http_req_duration{name:items.slow_search}"].values.count]] requests.
   Evidence: `summary.json` → `http_req_duration{name:items.slow_search}`, `meta.json` → `baseline.steps`, `rules.flags`. Confidence: high.
```

These numbers belong to that one folder; yours come from yours. Write each one as `--verify-findings` prints it.
