---
name: perf-consult
description: Use when someone wants to performance test or load test a feature, API or page, asks how many users or how much load to simulate, how to size a k6 run, whether a response time is fast enough, wants a run's report or results folder explained, with improvement suggestions for the developers, or wants to be guided end to end from journey to report.
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

The person said *guided* (or asked to be taken through the whole thing). You run the chain below, one stage at a time,
using each stage's own skill and its rules unchanged. Each stop is that skill's gate: show its block, then **stop and
wait** for the owner's answer in chat. A yes answers that one gate only; "guided", "do it all" or "go ahead with
everything" is the request, never a yes for a gate you have not shown yet.

| Stage | Skill | Stop (wait for the owner) |
| --- | --- | --- |
| 1. Journey and workload | perf-discover | Gate A (new project or new env only: its settings), then Gate B (the review block). An existing journey is shown at Gate B too; a review from another session is not this owner's yes |
| 2. Script and smoke | perf-script | after the green smoke: its done block (or its report when the app or env is at fault, and the chain ends there) |
| 3. Sizing | `sizing.md` | the proposal, or the one question for a missing business number; `workload.yaml` changes only after the yes |
| 4. Load go-ahead | perf-run | the dry run's go block; a refusal block ends the chain until the owner says what to do |
| 5. Run | perf-run | none: the go was given; then its account (healthy, or the class and evidence) |
| 6. Findings | perf-report | none: `findings.md` with `--verify-findings` passing |
| 7. Analysis | `analysis.md` | none: part 2 of `findings.md`; a `baseline accept` is the owner's call, offered, never run |

After every stage, one status line before anything else: what is done and what comes next, for example
"done: journey reviewed; next: script and smoke" or "done: smoke green (`<runId>`); next: sizing". When stages 3 and 4
both wait on the owner, ask them in two messages, sizing first: the dry run is of the workload the owner approved.

- **The load needs its own go.** Nothing in stages 1–3 is a go for a load, stress or soak run. You start one only
  after the owner saw the dry run and said yes to it, in this session, for that run, even on the local mock.
- **No gate is skipped**, also when it looks settled: a feature that already has a journey, a project whose smoke
  passed yesterday, a sizing the person half-gave in the first message. Show the gate; a quick yes costs one message.
- **A stage that cannot finish ends the chain there**: an open question at Gate B, a red smoke after three strikes,
  a refusal. Report it with that skill's block and the status line ("stopped: smoke red, app answers 500 on
  `items.search`; next: the app's team"); never move on to the next stage around it.
- When a pipeline skill is not installed, follow README section 10 by hand for that stage, with the same stops.

## Red flags: stop

- A proposed size above the env's `defaults` (users or req/s) presented as the plan. Above the defaults is the owner's call; you state the gap and propose the within-defaults run.
- A line with --allow-max, --override-window or --override-busy as a suggestion: never, unless the owner said it first in chat.
- A number in findings with no `[[fmt|expr]]` citation, or a benchmark with no `[ref:id]`.
- "Users per hour" turned into a concurrency figure without saying which reading you assumed.
- A cause stated as fact. Every suggestion is a lead with evidence, confidence, gain and effort.
- Sizing left only in chat (it goes into the feature's `context.md`).
- In guided mode: two gates in one message, a stage started before the stop ahead of it got its yes, or a load started on "guided".

## Rationalizations

| Thought | Reality |
| --- | --- |
| "The realistic size is the cap; the owner will surely say yes." | Then the owner says it. Propose the run within defaults, show the gap, stop. |
| "The question had all the numbers, no need to offer guided mode." | The offer is one line and costs nothing. Always make it. |
| "300 users per hour obviously means sessions started per hour." | Probably. Write it as an assumption, ask, and show what changes if it means concurrent users. |
| "Reference comparison and evidence read better mixed." | Two parts, always: what the run shows, then references and suggestions. |
| "This cause is clear from the numbers." | A run shows symptoms. Name it a lead, cite the evidence, give a confidence. |
| "They said *guided*, so the whole chain is approved." | Guided is the request. Every gate is its own stop, and the load is its own go after the dry run. |
| "The journey already exists; the review gate is a formality." | Show it at Gate B; an earlier review is not this owner's yes in this session. |
