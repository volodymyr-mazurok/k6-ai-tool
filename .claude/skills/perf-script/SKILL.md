---
name: perf-script
description: Use when a reviewed journey.yaml needs its k6 script written or fixed, when a smoke run fails (k6 exit 99, "checks rate==1 was crossed", "the script does not match the journey", a script error in k6.log, a step with failed checks), or when someone asks to get a feature's smoke green before a load run.
---

# perf-script

Turns a **reviewed journey** into `<feature>.js` and runs it through the runner until its smoke is green. It reads
`journey.yaml`, `workload.yaml`, `context.md`, `fixtures/` and `recordings/` of the feature, and writes only the script
(and, when a body is missing, a fixture backed by evidence). It never edits `journey.yaml` or `project.yaml`, and it
never starts a load, stress or soak run.

**Core rule: a check states what the evidence says the answer is.** A check changes only to match the evidence
(a recording, the swagger, a probe the journey cites), never to match what the app returned today. A smoke that is red
because the app or the env answers wrongly stays red, and you report it.

**Violating the letter of these rules is violating the spirit.** The runner's rules in `CLAUDE.md` apply unchanged.

## Anti-goals: a failure even if it "works"

- A skill that gets a smoke green by weakening checks (deleting a content check, widening a status check to "any 2xx with any
  body", catching errors to hide them).
- A skill that starts a load, stress or soak run on its own, passes `--override-window`, `--override-busy` or `--allow-max`, or proposes a size above the project's defaults without saying so and getting the owner's yes.
- A consultant that quotes a benchmark without a citation, a number that is not in the run folder, or a "fix" with no
  evidence behind it.
- A skill that types a password, creates an account, or reads a path a project's README forbids.
- Invented endpoints (AC P1 still holds: every step cites evidence).

## The flow

1. **Start only from a reviewed journey.** Read `projects/<name>/README.md` first (secret locations, forbidden paths),
   then the feature folder. The owner said yes at perf-discover's review gate and
   `npm run perf -- check <project> <feature> --env <env>` prints `0 problems`; otherwise hand back to perf-discover.
2. **Write the script** by `script-rules.md` section 1: one `step()` per journey step, a content check on every step
   taken from the evidence, `think(cfg)` between steps, auth the way `core/auth/` provides it, bodies from `fixtures/`.
3. **Check, then smoke:** `npm run perf -- check <project> <feature> --env <env>`, then
   `npm run perf -- run <project> <feature> --profile smoke --env <env>`. The smoke key covers the script, `core/`,
   journey, workload, `fixtures/`, `project.yaml`, `adapter.ts` and every non-test `.js` of the project and feature
   folders: any edit, even a comment, needs a fresh smoke.
4. **Read the run folder** in the order of `script-rules.md` section 2: the `perf:` lines, `k6.log`, `summary.json`
   (`checks{name:<key>.<step>}` per step), `meta.json`, `report.md`.
5. **Name the cause, and whose it is**, with the table in `script-rules.md` section 3. Confirm a content-check
   failure with one `npm run perf -- probe …` of that step's request before you call it anything.
   - **Script:** fix the script, toward the evidence, and go to step 3.
   - **App or env:** stop and report it with the block in section 4. The check stays exactly as it was.
6. **Three strikes.** At most three failed smokes for the same cause. After the third, stop and report what you tried
   and what each smoke showed; do not try a fourth idea.
7. **Done** when the last smoke of these exact files is green: verdict line printed, every step's checks at 100%
   (`passes > 0`, `fails = 0`), no "does not match the journey" line, row counts equal, and
   `npm run perf -- report <runDir> --verify-sources` ends `all N numbers traced`. Show the done block in section 4.
   The next step is perf-run (sized by perf-consult); you start nothing bigger than a smoke.

## Red flags: stop

- A content check deleted, renamed away, or replaced with `status 2xx`, `res.body.length > 0` or `true` on a step whose evidence shows a real body.
- A check rewritten after reading what the app returned, with no recording, swagger or cited probe that says the same.
- `try`/`catch` around `step()`, a check that returns `true` when parsing fails, or a step skipped when it fails.
- `journey.yaml`, `project.yaml` (`read_only_post_routes`, `row_count_tables`, caps, abort limits) or `workload.yaml` edited to make a smoke pass.
- A request sent with `http.*` directly, a step id that is not `<key>.<step name>`, or a route in the script that `journey.yaml` does not name.
- `console.log` of a response body, a header or a token; a plain `k6 run` of the script; a fourth smoke for the same cause.
- An app error "worked around" in the script: a different route, another id, a retry loop, a sleep before the step.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "The app returns `results`, not `items`; I'll check `results`." | Which one does the evidence show? The recording says `items` → the app changed or is broken: report it. No evidence either way → open question for the owner. |
| "The check is too strict; 20 items was only on that env." | Then the evidence names the env it came from. Ask the owner what this env should hold; a bare non-empty check needs their yes and goes into `context.md`. |
| "One check is flaky, the others prove the step." | A failing check is a finding. Find whose failure it is; never drop it. |
| "Green is the goal; I'll restore the check after the smoke." | A green smoke with a weaker check proves nothing and unlocks a load run for the weaker files. |
| "Catching the error keeps the run going." | `step()` already counts a throwing check as failed. A catch only hides it. |
| "It is obviously the script; one more tweak." | Three failed smokes for one cause is the limit. Stop and report. |
| "The env is down, so I'll point the script at another route." | The script follows the reviewed journey. An env problem is reported, not routed around. |
