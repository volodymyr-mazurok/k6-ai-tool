# Sizing a run

Turn business numbers into a run the project's defaults allow, with every step of the arithmetic on the page.

## 1. Get the business numbers

You need three, per journey:

| Number | Question to ask | Watch out |
| --- | --- | --- |
| Peak sessions per hour | "At the busiest hour, how many people start using this?" | "Users per hour" may mean people *starting* (arrivals) or people *on it at once* (concurrency). Ask which. |
| Session length | "How long does one person stay on it?" | Minutes of activity on this feature, not the whole visit to the app. |
| Actions per session | "How many times does one person do the action in that time?" | Map the action to the journey's steps (step 3). |

When a number is missing, ask for it, one question at a time. When the person gave numbers but one reading is
ambiguous, carry on with the likeliest reading, label it **Assumption:** with the question, and show in one line what
changes under the other reading. Never invent a business number.

## 2. Read the project's limits

From `projects/<name>/project.yaml`, the env's `caps` (`max_vus`, `max_rps`, `max_duration`) and `defaults` (`vus`, `rps`),
and the load window. From the feature's `journey.yaml` the steps per iteration (and each `optional_share`), from
`workload.yaml` the current `think_time` and profiles, and from the script how many `think()` pauses one iteration has.

## 3. The arithmetic (always shown)

```text
arrival rate      λ = sessions per hour / 3600                       (sessions/s)
users at once     L = λ × session seconds                            Little's law [ref:littles-law]
action rate       A = λ × actions per session                        (actions/s; × 3600 for per hour)
per user          one action every  session seconds / actions per session
iterations/s      I = A / actions per iteration                      (from journey.yaml)
req/s             R = I × requests per iteration                     (an optional step counts as its share, 5% = 0.05)
iteration time    T = users / I                                      (seconds one virtual user takes per iteration)
think time        mean pause = (T − sum of the steps' p50) / pauses per iteration
```

The server feels the request rate and the requests in flight (R × response time), not idle people. In a closed model
(virtual users that wait for each answer) a slower system receives less load [ref:k6-open-closed-models], so the
req/s you compute holds only while answers stay fast.

## 4. The proposal: within the defaults

Propose, for the env the person named:

- **Load profile:** `users` ≤ `defaults.vus`, a think time that makes those users produce R (from the formula above),
  a ramp of roughly 5–15% of the run and a hold of at least five times the ramp [ref:k6-average-load-testing] (README:
  ten minutes or more for a real feature), the total within `max_duration` and the load window. Leave about 30 s
  beyond the planned length for k6's graceful ramp-down and stop (long think times stretch a run).
- **Stress profile** (when the question is "where does it break"): arrival rate in steps, `start_rps` near R, `max_rps`
  ≤ `defaults.rps`, steps long enough to settle [ref:ms-load-testing-guidance].
- **When L or R is above the defaults:** say so plainly, with both numbers ("the realistic peak is 20 users at once;
  this env's default is 10"). Propose the within-defaults run first; going higher is the owner's decision, not part of
  your plan. When the request rate fits the defaults and only L does not, 10 users with a shorter think time give the
  server the same req/s; say that this changes concurrency, not the rate.
- **The owner's yes.** Business numbers the owner gave are the input, not a yes to what you computed from them. Show
  the proposal and ask for the yes before `workload.yaml` changes.
- Confirm the shape with `npm run perf -- run <project> <feature> --profile load --env <env> --dry-run` (sends nothing,
  writes nothing). The dry run prints users and the req/s ceiling, not your R; your R comes from the arithmetic.

## 5. When the target cannot answer honestly

Say it in the proposal, in one line each, when it applies:

- **Local mock** (the self-test project): it proves the framework works, nothing about a real app.
- **Shared dev or test env:** other people's traffic and a small database; a fast answer may only mean little data.
  Note the row counts the steps run against when known.
- **Public demo site:** other users, rate limits and a host you do not own; keep to its small caps.
- **Peak far below the defaults:** a load run at the peak shows little; a stress run within the defaults shows headroom.
  Not on a public demo site, where stress is not allowed (smoke and load only): there a load at the defaults is a
  check that the framework and the script work, and it measures little about the app.

## 6. Write it down

Append a `## Sizing (YYYY-MM-DD)` section to the feature's `context.md`
(`projects/<name>/features/<feature>/context.md`; for the self-test feature `runner/selftest/project/features/items/`,
create the file when it is missing) with: the numbers as given, the assumptions, the arithmetic, the proposal, and
what it leaves out. Change `workload.yaml` only after the owner says yes to the proposal.

Changing `workload.yaml` after the green smoke changes the smoke key, so the next load, stress or soak runs a smoke
first (the dry run says `smoke: runs first`). Say so with the proposal; where the env has a smoke budget, that smoke
counts against it.

## Worked example (self-test feature `items`)

"300 users per hour at peak, 4-minute sessions, 6 searches each." Env `local`: caps 20 users / 30 req/s, defaults 10 / 15.
One `items_grid` iteration is two searches (`search`, `slow_search`), an `export` 5% of the time and two pauses.

```text
Assumption: 300 = sessions started per hour (if it means 300 at once, everything below × 15)
λ = 300 / 3600 = 0.083 sessions/s
L = 0.083 × 240 s = 20 users at once                        (above the default of 10)
A = 0.083 × 6 = 0.5 searches/s (1,800 per hour); one search per user every 240 / 6 = 40 s
I = 0.5 / 2 = 0.25 iterations/s;  R = 0.25 × 2.05 = 0.51 req/s  (default ceiling 15)
10 users: T = 10 / 0.25 = 40 s; steps' p50 ≈ 0.4 s; pause = (40 − 0.4) / 2 ≈ 20 s → think_time 15s–25s
```

Proposal: load, 10 users, think 15–25 s, ramp 1 min, hold 10 min, ramp down 1 min → about 0.5 req/s, the peak rate,
within the defaults. The realistic 20 users at once is above the default; that is the owner's call. The peak is a
thirtieth of the default req/s, so a stress run from 1 to 15 req/s says more about headroom. Caveat: a local mock
proves the framework, not an app.

## Caps and defaults for a new project

Propose these from the target's nature; never above them without the owner's own numbers. The owner approves the
project settings in every case.

| Target | Caps (`max_vus` / `max_rps`) | Defaults (`vus` / `rps`) | Other |
| --- | --- | --- | --- |
| Public demo site | 5 / 5 | 2 / 2 | `max_duration` 5 minutes; smoke and load only |
| Shared dev or test env | 20 / 30 | 10 / 15 | a load window outside working hours; the busy check on when there is a database |
| Local mock / your own machine | start from the self-test's 20 / 30 | start from the self-test's 10 / 15 | no load window; no busy check (nobody else's work to protect) |
| Dedicated performance env | ask the owner | ask the owner | you may suggest numbers; never fill them in |
