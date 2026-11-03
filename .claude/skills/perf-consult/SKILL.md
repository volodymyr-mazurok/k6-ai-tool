---
name: perf-consult
description: Use when someone wants to performance test or load test a feature, API or page, asks how many users or how much load to simulate, how to size a k6 run, whether a response time is fast enough, or wants a run's report or results folder explained, with improvement suggestions for the developers.
---

# perf-consult

The consultant and front door of this k6 framework. Two jobs: **sizing** before a run (business numbers → users, think
time, req/s, with the arithmetic shown) and **analysis** after a run (what the run folder shows, cited reference points,
ranked suggestions). Every number either comes from the person, from arithmetic shown on the page, or from the run
folder with a citation. Nothing else.

**Violating the letter of these rules is violating the spirit.** The runner's rules in `CLAUDE.md` apply unchanged.

## Step 1: the front door (every time)

Your first reply starts with one line that offers the choice, then carries on with the answer:

> "Do you want guidance end to end (journey, script, smoke, sized run, report), or just this answer? I'll answer now; say *guided* to go end to end."

Then read `projects/<name>/README.md` (secret locations, forbidden paths) before opening anything else of that
project. The self-test project lives in `runner/selftest/project/` instead of `projects/`.

## Step 2: which job

| The person asks | Do | Read |
| --- | --- | --- |
| how many users, how big a run, which profile, "load test this" | sizing | `sizing.md` in this folder |
| explain a report or run folder, is it fast enough, what to fix | analysis | `analysis.md` in this folder |
| a new project's caps and defaults | the caps table in `sizing.md` | `sizing.md` |
| guided | the chain below | — |

## Guided mode

Go through the stages in order, stopping at each gate for the owner's yes: the feature's journey and workload
(reviewed by the owner), the script and a green smoke, sizing (`sizing.md`), the dry run and the owner's explicit go
for a load run, the run, the findings (`analysis.md`). Use the pipeline skills (perf-discover, perf-script, perf-run,
perf-report) when they are installed; otherwise follow README section 10 by hand. You never start a load, stress or
soak run yourself without the owner's go, and never skip a gate.

## Red flags: stop

- A proposed size above the env's `defaults` (users or req/s) presented as the plan. Above the defaults is the owner's call; you state the gap and propose the within-defaults run.
- A line with --allow-max, --override-window or --override-busy as a suggestion: never, unless the owner said it first in chat.
- A number in findings with no `[[fmt|expr]]` citation, or a benchmark with no `[ref:id]`.
- "Users per hour" turned into a concurrency figure without saying which reading you assumed.
- A cause stated as fact. Every suggestion is a lead with evidence, confidence, gain and effort.
- Sizing left only in chat (it goes into the feature's `context.md`).

## Rationalizations

| Thought | Reality |
| --- | --- |
| "The realistic size is the cap; the owner will surely say yes." | Then the owner says it. Propose the run within defaults, show the gap, stop. |
| "The question had all the numbers, no need to offer guided mode." | The offer is one line and costs nothing. Always make it. |
| "300 users per hour obviously means sessions started per hour." | Probably. Write it as an assumption, ask, and show what changes if it means concurrent users. |
| "Reference comparison and evidence read better mixed." | Two parts, always: what the run shows, then references and suggestions. |
| "This cause is clear from the numbers." | A run shows symptoms. Name it a lead, cite the evidence, give a confidence. |
