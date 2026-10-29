# Performance: a k6 load-test framework you can reuse

Point this at one feature of an app. It runs a k6 load test under safety limits and writes a one-page report: a verdict,
what ran, how much load, how fast each step was, and (when the project has a database) what the database did.

This is a reusable boilerplate, not a system that watches anything. Nothing here runs on a schedule; a person starts
every run. Each app you test is a folder under `projects/`, and the framework in `core/` and `runner/` does not change.
The examples in this file use the **self-test project** (`runner/selftest/project/`), which tests a small mock server on
your own machine, so you can try every command without touching a real system.

You do not need to know anything about performance testing to start. Sections 1 to 3 get you to a first report;
sections 4 to 6 teach k6 with our own examples; section 7 reads a report line by line; sections 8 to 12 are reference.

| Folder | What is in it |
| --- | --- |
| `runner/` | The command line (`npm run perf -- …`): guardrails, k6 start, database evidence, report. Node and TypeScript. |
| `runner/selftest/` | The mock server with a planted bottleneck, the self-test project (`project/`) and the known-answer self-test. |
| `core/` | The k6-side library our scripts share: login, named requests with content checks, load profiles. Plain JS. |
| `projects/<name>/` | One folder per app: `project.yaml` (envs, caps, window), and per feature the journey, the workload and the k6 script. |
| `examples/` | `hello.js`: a first k6 script to read and run against the local mock. |
| `results/` | One folder per run (git-ignored). Open its `report.html`. |

## 1. What this is, and the safety rules

A **load test** sends many requests at once, the way many users would, and measures how the system answers. **k6** is
the tool that does the sending; this repo wraps it so that nobody can point it at the wrong place or push it too hard.

Test environments are usually shared and small: colleagues test on them, and a careless run slows everyone down. So the
runner enforces these rules. Each comes from the project's `project.yaml` (or its feature's `workload.yaml`), never from
a command line, and the values below are examples from a typical project:

| Rule | What the runner does | Set in `project.yaml` | Example value |
| --- | --- | --- | --- |
| **Only through the runner** | The project scripts refuse to start under a plain `k6 run` (they need the config the runner writes), so no limit below can be skipped by accident. | – | – |
| **Env allowlist** | Refuses an env the project does not list. | `envs:` | `local`, `staging` |
| **Caps** | Refuses more virtual users or requests/s than the cap, and a run longer than `max_duration`. Nothing overrides a cap. | `caps: { max_vus, max_rps, max_duration }` | 20 users, 30 req/s, 30 minutes |
| **Defaults** | The feature's workload sets the size of a run, and the defaults are the ceiling without `--allow-max`: a profile above them is refused. Up to the caps, `--allow-max` allows it. A load or soak run is also held at `defaults.rps` requests per second (k6's `rps` option), or at `max_rps` with `--allow-max`. | `defaults: { vus, rps }` | 10 users, 15 req/s |
| **Load window** | Load, stress and soak runs only inside the window, and the window must hold both at the start and at start + the profile's length (a 30-minute load started at 05:50 UTC is refused). A smoke run is allowed at any time. An env without a window has none. | `window_utc: { weekdays, weekends }` | weekdays `17:00-06:00` UTC, weekends all day |
| **Busy check** | If the database's CPU or data IO averaged above 20% over the last 5 minutes, somebody else is working and the run is refused. It is refused too when the database load cannot be read (no samples, or the query failed), because idleness is then not shown; `--override-busy` covers both. A database that cannot be reached at all is refused even with `--override-busy` (`DB_UNREACHABLE`): no guard, no load. Needs a project that can read its database. | – (built in) | 20% over 5 minutes |
| **Abort limits** | Stops a run that goes wrong: more than `error_rate` failed requests, p95 over `p95_ms`, or database CPU or IO at `db_cpu_or_io_pct` or more for four 15-second samples in a row. A database guard that goes blind (four polls in a row fail) stops the run too: no guard, no load. A feature may tighten the error and database limits, never loosen them; it may raise the p95 limit when the system is slow by nature. | `abort: { error_rate, p95_ms, db_cpu_or_io_pct }` | 10%, 15,000 ms, 95% |
| **One run per env on this machine** | A lock file under `results/`: a second run on the same env from this machine is refused (`RUN_IN_PROGRESS`); the runner never waits. It does not see a run started from another machine. Ctrl+C stops a run cleanly and still writes the report. | – (built in) | – |
| **Smoke first** | A load, stress or soak run does a smoke run first when none passed yet for this exact script and config. | – (built in) | – |
| **Read-only features** | A feature marked read-only never sends PUT, PATCH or DELETE, and POSTs only to routes listed as reads. `perf check` enforces it. | `read_only_post_routes:` | `/items/search` |
| **No leftovers** | The runner counts rows in the listed tables before and after a run; a difference fails the run. | `row_count_tables:` | `items` |

- **Never pass `--override-window`, `--override-busy` or `--allow-max` without the owner's OK.** Each one is written into
  the report, and `--override-busy` makes the verdict INVALID. Against a real env, tell the team before a load run: which
  env, from when to when.
- **Secrets stay where they are.** A project reads logins and the token url from `.env` (names in `.env.example`) or,
  with its own `adapter.ts`, from wherever they already live (the adapter is also where a database connection comes from). The runner gives k6 a
  temporary file (mode 0600) that is deleted after the run. Never copy a password, token or raw HAR into this repo, a chat
  or a report. `perf doctor` prints "✓ User account", never the login.
- **Standing data.** A feature that searches a fixed set of test rows creates them once with `perf setup`, never in a
  run. Standing data can expire (a nightly job may archive old rows); a project's adapter should then say so by name
  instead of reporting "no data".

## 2. Quick start

You need a Mac or Linux machine, Node 22 or newer and k6 1.0 or newer (this repo was built with k6 v2.3.0).

```bash
brew install k6                      # Mac; other systems: https://grafana.com/docs/k6/latest/set-up/install-k6/
k6 version                           # k6 v1.x or v2.x
node --version                       # v22 or newer
npm install                          # this repo's dependencies
npm run perf -- doctor               # are k6, Node and the dependencies in place?
```

Now try a run against the local mock. The self-test project logs in to the mock as `perf` / `perf` (a toy login, no
secret), and `.env` is where a project's accounts go:

```bash
cat > .env <<'EOF'
PERF_TOKEN_URL=http://127.0.0.1:4010/oauth/token
PERF_TOKEN_CLIENT_ID=perf
PERF_SCOPE=openid perf offline_access
PERF_USER_LOGIN=perf
PERF_USER_PASSWORD=perf
EOF
npm run mock                         # terminal 1: the mock server on http://127.0.0.1:4010 (Ctrl+C to stop)
```

In a second terminal:

```bash
export PERF_SELFTEST_URL=http://127.0.0.1:4010                        # where the self-test project finds the mock
npm run perf -- doctor selftest --env local                           # is everything in place for this project?
npm run perf -- run selftest items --profile smoke --env local        # first run: each journey once, a few seconds
open "$(ls -dt results/20*/ | head -1)report.html"                    # the newest report (Linux: xdg-open)
```

`doctor` prints one line per check, `✓ …` or `✗ … — how to fix it`. All green looks like this:

```text
✓ k6 v2.3.0
✓ Node v22.14.0
✓ dependencies installed
✓ project selftest loaded
✓ env local is allowed (caps 20 users / 30 req/s, defaults 10 users / 15 req/s)
✓ User account
✓ swagger answers 200
✓ User token
✓ no database for this project (database evidence is skipped)
```

(A project with three roles has an account line for each. A project with a database also gets "database reachable" and
"VIEW DATABASE STATE granted" lines, and the database tier.) `doctor` sends one token request per account, one swagger
request and, when there is a database, a few read-only queries, nothing else. The **smoke** run proves the script works:
it runs every journey once. Its timings are single samples, not a measurement.

Then the real thing, still on the mock: a load run (4 users, about 1.5 minutes), and the dry run that shows what the
guardrails say before anything is sent:

```bash
npm run perf -- run selftest items --profile load --env local --dry-run   # users, req/s, duration, limits, the exact k6 command
npm run perf -- run selftest items --profile load --env local             # the load run itself
npm run perf -- run selftest items --profile stress --env local --dry-run # refused: stress goes above the 15 req/s default
```

The last command is refused on purpose (`ABOVE_DEFAULTS`, exit code 2): stress climbs to 30 req/s, the cap, and anything
above the defaults needs `--allow-max`. On a mock that is harmless; on a real env it needs the owner's OK. The
self-test (section 3) runs that stress for you.

## 3. Everyday commands

Run them from the repo root. `<runDir>` is a folder under `results/`.

| Command | Does |
| --- | --- |
| `npm run perf -- doctor [<project> --env <env>]` | Checks tools, and with a project the env: accounts, swagger, one token per role, the database. |
| `npm run perf -- run <project> <feature> --profile smoke\|load\|stress\|soak --env <env>` | A full run: guardrails, k6, database evidence, row counts, report. A load, stress or soak run does a smoke first if none passed yet. |
| `… run … --dry-run` | Shows users, req/s, duration, abort limits and the exact k6 command. Sends nothing, takes no lock, writes nothing. The guardrails still apply: outside the window a load dry run is refused. |
| `npm run perf -- check <project> <feature> --env <env>` | Checks `journey.yaml` against the env's swagger without running anything. Prints `0 problems` when it is fine. |
| `npm run perf -- setup <project> --env <env>` / `teardown …` | Create (idempotently) or remove a project's standing test data, for projects that have any. `teardown` deletes what the tests search, so run it only when told to. Neither is bound by the caps or the load window: the project's adapter owns their pace. |
| `npm run perf -- report <runDir> [--verify-sources]` | Rewrite the report of a run folder; `--verify-sources` checks every number on the page against the run's files. |
| `npm run perf -- baseline accept <runDir>` | Make a run the reference that later runs of the same feature, env and profile are compared with. It refuses a smoke, FAIL or INVALID run. It is written to `baseline.json` in the feature's folder; commit it if the team should share it. Reports already written, and a re-render of them, keep the baseline their run was judged against. |
| `npm run perf -- compare <runDirA> <runDirB>` | Table of the p95 per step in two runs, with the change in percent. |
| `npm run perf -- har-summary <har> --api <url> --out <json>` | Scrub a recorded HAR to the evidence a journey cites (method, path, status, body shape; no headers or tokens). |
| `npm run perf -- selftest` | Tests the framework itself against the local mock (about 10 minutes, nothing leaves your machine, needs no `.env`). |
| `npm run mock` | Starts the local mock server on port 4010. |
| `npm test` | Unit tests. |

`npm run perf -- --help` lists every command and flag. `run` exits 0 when it finished, 1 when the run failed, 2 when it
was refused, 130 when interrupted. A zero exit code is not a good result: read the verdict. `run` prints it as its last
line, `perf: verdict <WORD> — <reasons>`, and the report explains it.

**The self-test** is how you know the framework itself is right. It runs a smoke, a load, a deliberately planted
regression, a stress and two abort demos against the mock, which has a bottleneck planted in it (one endpoint serves 10
requests per second), and checks that the reports find exactly what was planted: the regression is flagged on the one
slow step and nowhere else, the stress breaks near 20 req/s, and each abort rule stops a run early. Section 7's example
report names 24 req/s as the breaking point: that is the first stage that broke, and the stages step by 2 req/s. It ends with
`selftest: N/N passed`. Its run folders land in `results/selftest/`, which is where the report examples in section 7 come from.

Every run writes `results/<date_time>_<project>_<feature>_<profile>/`: `report.html` and `report.md` (read these),
`k6-dashboard.html` (k6's own charts), `summary.json`, `timeseries.json`, `points.json.gz` (the numbers behind the
report), `db.json` (database evidence, when the project has a database), `meta.json` (facts about the run),
`k6-config.json` and `k6.log`.

**Plain k6.** Everything above is k6 underneath, and k6 is worth knowing by itself. The example script runs against
the local mock, so no shared env is touched. Start the mock (`npm run mock`) in terminal 1, then in terminal 2:

```bash
k6 run -e BASE_URL=http://127.0.0.1:4010 examples/hello.js                      # 2 users, 10 s
k6 run -e BASE_URL=http://127.0.0.1:4010 --vus 5 --duration 20s examples/hello.js   # flags beat the script's options
mkdir -p .tmp
k6 run -e BASE_URL=http://127.0.0.1:4010 --summary-export=.tmp/hello-summary.json examples/hello.js   # numbers as JSON
k6 run -e BASE_URL=http://127.0.0.1:4010 --out json=.tmp/hello-points.json examples/hello.js          # every data point
K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_PERIOD=1s K6_WEB_DASHBOARD_EXPORT=.tmp/hello-dashboard.html \
  k6 run -e BASE_URL=http://127.0.0.1:4010 examples/hello.js   # live charts at http://127.0.0.1:5665, an HTML copy at the end
k6 run runner/selftest/project/features/items/items.js         # refuses to start: see below
```

Look inside `.tmp/hello-summary.json`: it holds `setup_data`, whatever `setup()` returned, which here is the mock's
token. On a real env that is a live token, so never share a raw summary file. (The runner's own summary drops it.)

`-e NAME=value` becomes `__ENV.NAME` in the script. The runner starts k6 without any `K6_*` variable of your shell
that would change the run (`K6_VUS`, `K6_DURATION`, …); `--dry-run` names the ones it dropped. On a project script,
plain k6 stops at once, on purpose, with `PERF_CONFIG_FILE not set — start runs with: npm run perf -- run …`.

## 4. k6 in ten minutes

**Virtual users and iterations.** A virtual user (VU) is a loop. It runs your script's main function, waits, runs it
again. One pass through the function is an **iteration**. In the self-test project one iteration is one user's visit to
the items list: a search, a slow search, and now and then (1 visit in 20) an export. Ten VUs are ten users working side
by side, each in their own loop.

**Anatomy of a script.** Five parts, all optional except the main function:

```js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = { vus: 2, duration: '10s' };   // 1. how to run: users, time, thresholds. Read first.

export function setup() { return { token: 'abc' }; }   // 2. once, before the load. Its result goes to every VU.

export default function (data) {                       // 3. one iteration. k6 calls it over and over.
  const res = http.get('http://127.0.0.1:4010/');
  check(res, { 'status is 200': (r) => r.status === 200 });
  sleep(1);                                            //    think time
}

export function teardown(data) {}                      // 4. once, after the load.
export function handleSummary(data) {                  // 5. once, at the end: decides what is written, and where.
  return { 'summary.json': JSON.stringify(data) };     //    (returning only a file means k6 prints no summary table)
}
```

`examples/hello.js` is a working, commented version: it logs in once in `setup()` (one token request, however long
the test), then each VU posts a search, checks the answer and sleeps. Read it, run it, change a number, run it again.
The self-test script (`runner/selftest/project/features/items/items.js`) has the same shape, with the runner's config on top.

**Checks and thresholds.** They sound alike and do different jobs.
- A **check** is a yes/no question about one response: "status is 200", "the answer lists rows". k6 counts the passes
  and carries on; a failed check never stops a test. Check the *content*: a 200 can carry an error body.
- A **threshold** is a pass/fail rule over a whole metric at the end: "p95 of `http_req_duration` under 500 ms". If one
  fails, k6 exits with code 99. With `abortOnFail` it stops the test at once. Our abort rules are thresholds.

Our helper `step()` (in `core/request.js`) adds a "status is 2xx" check to every request and refuses to run a step
that has no content check.

**Think time.** Real people read before they click. `sleep()` between steps models that; a workload sets it in
`workload.yaml` (`think_time: { min: 0.5s, max: 1s }` in the self-test project; a real app often wants 2 to 6 seconds).
Without it a VU fires its next request the moment the last one ends: ten such VUs send far more than ten users would,
and the numbers describe a load nobody produces.

**Closed and open models.** Two ways to say "how much load".
- **Closed model: a fixed number of users.** "10 users are working." If the server slows down, each user waits
  longer and sends fewer requests, so the load drops just when the system struggles. Good for "can we serve our usual
  users?". Our `load` profile works this way (k6 executor `ramping-vus`).
- **Open model: a fixed arrival rate.** "Requests keep arriving at a steady rate", whether or not the earlier ones
  finished. If the server slows down, work piles up: that is what exposes a breaking point. Our `stress` profile works
  this way (`ramping-arrival-rate`). One wording trap: k6's arrival rate counts **iterations**, not requests. Our
  profile states the rate in **requests per second** and converts it for you: an iteration that sends 2 requests, at
  10 requests/s, becomes 5 iterations per second. The users k6 may start to serve the arrivals are capped by the env's `max_vus`.

## 5. Test types

| Type | The question | Shape | When | Here |
| --- | --- | --- | --- | --- |
| **Smoke** | Does the script work at all? | 1 user, each journey once | Before anything else; any time of day | `--profile smoke`. The runner demands a passing smoke before load, stress or soak. |
| **Load** | Does it hold the load we expect on a normal busy day? | Ramp up, hold, ramp down | The main test; compare with a baseline | `--profile load`: the self-test project holds 4 users for 60 s (15 s up, 10 s down). A real feature holds the expected users for 10 minutes or more. |
| **Stress** | Where does it start to hurt? | Arrival rate climbs in steps | When you want the limit | `--profile stress`: the self-test project goes from 2 req/s up by 2 every 15 s to 30. The report names the breaking point. |
| **Spike** | Does it survive a sudden jump, and recover? | Low, a jump to high for a short while, low again | Before an event that brings a crowd | Not built: against caps of 20 users the jump is small. The stress profile covers the steep part. |
| **Soak** | Does it stay healthy for hours? Leaks, expiring tokens, full connection pools. | Moderate load for a long time | Before a release, overnight | `--profile soak` exists, but a feature must define one and the caps limit a run's length (`max_duration`). |
| **Breakpoint** | What is the maximum? | Keep raising the load until something breaks | Capacity planning | A stress run read for its breaking point. The caps stop it before production-like limits. |

Run them in this order: smoke, then load, then stress. A failed smoke means the script is wrong, not the system.

## 6. Metrics explained

k6 prints these at the end of every run (here `examples/hello.js` against the mock, trimmed):

```text
    checks_total.......: 40      3.90402/s
    checks_succeeded...: 100.00% 40 out of 40
    http_req_duration..............: avg=21.82ms min=4.95ms med=22.45ms max=24.26ms p(90)=23.71ms p(95)=23.98ms
    http_req_failed................: 0.00%  0 out of 21
    http_reqs......................: 21     2.049611/s
    iteration_duration.............: avg=1.02s   min=1.02s  med=1.02s   max=1.02s   p(90)=1.02s   p(95)=1.02s
    iterations.....................: 20     1.95201/s
    vus............................: 2      min=2       max=2
    data_received..................: 15 kB  1.4 kB/s
    data_sent......................: 6.7 kB 654 B/s
```

| Metric | What it is | How to read it |
| --- | --- | --- |
| `http_req_duration` | Time from sending a request until the last byte of the answer arrived: `sending` + `waiting` + `receiving`. | **The number people mean by "response time".** Read its p95, not its average. |
| `http_req_blocked` | Time waiting for a free connection slot before the request could start. | Near zero when connections are reused. A big value points at the load machine or the network, not the server. |
| `http_req_connecting` | Time to open the TCP connection. | Paid once per connection, then reused. High on a bad network. |
| `http_req_tls_handshaking` | Time for the HTTPS handshake. | Same: once per connection. |
| `http_req_sending` | Time to send the request. | Tiny, unless the body is large. |
| `http_req_waiting` | Time to first byte (TTFB): the server working before it starts answering. | **Where server slowness shows.** Almost all of `http_req_duration` for a slow query. |
| `http_req_receiving` | Time to download the answer. | Large for big answers (an Excel export) or a slow link. |
| `http_req_failed` | Share of requests that failed: a network error or a status outside 200–399. | Should be 0%. A 401 or 500 counts as failed even if the answer was fast. |
| `http_reqs` | How many requests were sent, and per second. | The throughput. Includes token requests. |
| `iterations` | How many full passes through the main function. | One iteration is several requests (for the self-test project, two or three). |
| `iteration_duration` | How long one iteration took, think time included. | Mostly your `sleep()`s; a jump means slow requests. |
| `vus` / `vus_max` | Virtual users running now / the most k6 prepared. | Checks that the ramp did what you planned. |
| `dropped_iterations` | Iterations an arrival-rate run wanted to start but could not, because no virtual user was free. | Zero in a healthy run. Above zero means the answers got too slow to keep the rate: a sign of the breaking point. |
| `checks` | Share of checks that passed (k6 2.x prints `checks_total`, `checks_succeeded`, `checks_failed`). | Should be 100%. Below it, some answers had the wrong content. |
| `data_sent` / `data_received` | Bytes uploaded / downloaded. | Explains slow receiving; shows if exports are heavy. |

**Our own measurements.** Every request our scripts send carries the tag `name:<journey key>.<step>`, for example
`items.slow_search`. That is how the report shows one line per step instead of one blob. The login request is tagged
`name:auth_token` and is counted apart: it must be as many as the accounts, plus a refresh when a token is within 5
minutes of expiry (a token that lives less than 10 minutes is refreshed at half its life). The expiry is the token's own
`exp` claim, or the `expires_in` of the login answer for a token that is not a JWT, or whose `exp` this machine's clock
already sees as past. Keep the load machine's clock in sync: a clock that runs ahead by more than a token's life
makes every call a refresh. If there are hundreds, a script logs in on
every iteration (section 9).

**Percentiles, and why p95 beats the average.** Sort all response times from fastest to slowest. **p50** (the median)
is the one in the middle. **p95** is the time that 95 out of 100 requests beat; only the slowest 5 were worse.
**p99** is the same for 99 out of 100. Take 100 searches, where 90 take 200 ms and 10 take 5,000 ms (an illustration,
not a measurement):

- The average is (90 × 200 + 10 × 5,000) / 100 = **680 ms**. Nobody waited 680 ms. Nine users in ten waited 200 ms; the
  tenth waited 5 seconds.
- p50 = 200 ms: the typical user is fine. p95 = **5,000 ms**: at least one user in twenty waits 5 seconds (here one in ten).
- The one who waits 5 seconds is the one who complains. p95 shows them; the average hides them.

A percentile needs enough samples: p95 means little under 100 requests and p99 under 1,000. A smoke run has one
request per step, so its p50, p95 and p99 are all that one sample.

## 7. Reading our report

Open `report.html` (`report.md` has the same words and numbers, without the charts). The examples below come from
two self-test runs; yours will differ in the last digit, not in the story. Make them yourself with
`npm run perf -- selftest`, which leaves its run folders in `results/selftest/`. The page runs top to bottom like this.

**Verdict.** One word, a one-line reason, and a table of what each word means:

| Verdict | What it means |
| --- | --- |
| `PASS` | The run finished cleanly and no automatic flag was raised. |
| `DEGRADED` | Worse than the baseline: at least one automatic flag was raised. |
| `FAIL` | k6 failed or was stopped, the run was aborted or interrupted, cleanup left rows behind, or an explicit target was missed. |
| `NO BASELINE` | The first run for this feature, env and profile: numbers only, nothing to compare with yet. |
| `INVALID` | The numbers cannot be trusted: the app was redeployed mid-run (the build fingerprint changed), or the busy check was overridden. |

If several apply, the first in this order wins: INVALID, FAIL, NO BASELINE, DEGRADED, PASS. Our example load run says
**FAIL** with the reason "the run was aborted by a k6 threshold: http_req_duration p(95)<300 was crossed; k6 exited with code 99"
(the metric and the limit that tripped come from k6's own summary).
A smoke run adds a note that its timings are single samples.

**What ran.** The facts needed to repeat the run: project, feature, env, database tier, load machine, k6 version,
profile, duration, start time, git commit (`+ uncommitted changes` when the working tree was dirty), the app build
(the name of the hashed script bundle the app's own page loads from its own origin, such as `main-ABCD1234.js` or
`index-D4f5aB9c.js`, so a redeploy shows and a versioned third-party script does not; `not readable` when the page names no such bundle, and then only a changed swagger document reveals a
redeploy), k6's exit code, script errors, and the guardrail overrides
(`none`, or the flags used). The example's profile reads "load: 4 users, ramp-up 15 s, steady state 1 min, ramp-down 10 s" (85 s planned). Compare
**Duration** with the plan: the example ran 1 min 2 s, so it stopped early. `k6.log` then holds a line "thresholds on
metrics … were crossed … stopping test prematurely" that names the metric, and the stage windows quoted below are the
planned ones, not what was reached.
The **steady state** is the stretch where all the users are in and the load is flat; most numbers on the page are
taken from it, because the ramps are not a fair measurement.

Under it, **Limits applied** shows the abort limits this run really used, where each came from (`project`, `feature` or
`override` for a run option) and the project default:

| Limit | Value | Source | Project default |
| --- | ---: | --- | ---: |
| Error rate (k6 threshold) | 10% | project | 10% |
| p95 of all requests (k6 threshold) | 300 ms | override | 15,000 ms |
| Database CPU or data IO (the runner stops the run) | 95% | project | 95% |

The self-test sets that 300 ms p95 on purpose to show an abort. It is how you notice that a run used a stricter or a
looser limit than the project's. Then come **What the test does** (every step and its request, and whether the feature
writes data) and, when the project's adapter counts rows (`rowCounts`) and `project.yaml` lists `row_count_tables`, **Row counts before and after**, which must be equal for a read-only feature.

**Under what load.** A sentence, then the figures: "4 users working (pausing 0.5–1 s between actions) ≈ 156 item actions/min", measured over the steady
state (the pause is the think time of section 4). Then the most active users at once (`vus`), the peak requests per second (`req/s`), the
requests in the measured stretch (token requests are not counted) and the business rate, actions per minute. A report
with charts also shows users, requests per second and, with a database, database load over the same time axis. A "business rate" such
as 156 actions/min counts requests here because each action is one request. Read this first when a number looks odd: a
run that did not reach the load you planned (see **Duration** above) says little. When a run stopped early, this section
says so, with how long it ran against the plan, and counts the figures over the whole run instead of the steady state.

**Results per step.** One row per step, the heart of the report:

| Column | Meaning |
| --- | --- |
| Requests (`http_reqs`) | How many requests the step sent. |
| `req/s` | Requests per second over the whole run, ramps included. |
| `p50`, `p95`, `p99` (ms) | The step's response time (`http_req_duration`): typical, 95 out of 100 faster, 99 out of 100 faster. |
| Failed (`http_req_failed`) | Share of the step's requests that returned an error. |
| Checks passed (`checks`) | Share of the step's content checks that held. A 200 with an error body fails its check. |
| vs target or baseline | The change of p95 against the baseline (or "no baseline"), and "– flagged" when an automatic flag fired. |

A step with only a handful of requests (the example's `items.export` has 1) has a p95 and a "change vs baseline" that mean
nothing: they are one sample, so ignore them. In the example, `items.slow_search` shows 86 requests, p50 903 ms, p95 904 ms, 0% failed, 100% checks passed and
"+124% vs baseline – flagged"; `items.search` shows p95 23 ms. The slowest step is the one with the highest p95, and
that is where to look first. A note under the table says how many `auth_token` requests the run sent (one per account,
plus a refresh when a token was about to expire).

**Breaking point** (stress runs only). The stress profile raises the arrival rate in steps. The report gives the stage where
the system stopped keeping up, how long into the run, and what gave first. A stage counts as broken when more than 5% of its
requests failed, its p95 was over 3 times the first stage's, or k6 dropped iterations (`dropped_iterations`) because answers
were too slow to keep the rate. A table lists every stage with its requests, failures, p95, dropped iterations and "held",
"broke here" or "after the break". In the example stress run the answer is "The system stopped keeping up at 24 req/s, about
2 min 45 s into the run. What gave first: latency": p95 stayed at 402-403 ms up to 20 req/s, rose to 687 at 22, and reached
1,923 ms with 8 dropped iterations at 24. The mock's planted bottleneck carries about 20.5 req/s of total traffic, so
this is the right answer. If the database reached 90% CPU or IO first, the report blames the database instead.

**Database** (when the project has one). The tier, the peak CPU and data IO of the run, then **Top statements during the run**: the
SQL that spent the most time (values hidden), with executions, average and total time, CPU time and logical reads, sorted by total
time. A cheap statement run very often can outweigh a slow one run rarely, which is why the sort is by total. Then
**Missing indexes on the tables those statements touch**: SQL Server's own suggestions. Treat them as leads for the database
owner, not a verdict: the figures cover the time since the server last restarted, and an index also slows writes. A project
without a database says "No database evidence for this run", as the examples do.

**Compared with baseline.** A **baseline** is an earlier run you accepted as normal (`baseline accept <runDir>`). A run
is judged against the baseline that was taken at run time, and the report says which run it was and when it was accepted.
The table gives, per step, the p95 before and now, the change in ms and percent, p99 and the failure share before and now.
With no baseline the section says so and the verdict is NO BASELINE. A baseline belongs to one feature, env and profile.

**Automatic flags.** Four rules, checked per step (or on the database), each raising a named flag:

| Flag | Raised when | Limit |
| --- | --- | --- |
| `ERRORS` | a step's share of failed requests (`http_req_failed`) is above the limit | 1% |
| `CHECKS` | a step's share of failed content checks (`checks`) is above the limit | 0.5% |
| `P95_REGRESSION` | a step's p95 is above its baseline by more than both limits | 20% and 100 ms |
| `DB_HOT` | database CPU or data IO averages above the limit over the steady state | 80% |

Any flag turns PASS into DEGRADED. In the example one flag was raised: `P95_REGRESSION` on `items.slow_search` (904 ms against a
baseline of 403 ms; the limit was 503 ms), and none on `items.search`, which is exactly what the self-test planted.
Flags catch regressions; a load that is slow from the start needs a target or an owner's eye. If the run folder has a
`findings.md` (written by a person, and later by the perf-report skill, see section 10) it appears here as **Findings and
recommendations**.

**Files.** The last table names every file of the run folder. The report is built only from `summary.json`,
`timeseries.json`, `db.json` and `meta.json`; every number in `report.html` carries a `data-src` attribute that names the
file and the path it came from. To check them, run `npm run perf -- report <runDir> --verify-sources`: it prints
`all N numbers traced`, or the numbers that differ from their source (exit code 1). Use it before you quote a figure.

## 8. Glossary

- **Latency**: how long one request takes, from sent to answered. Reported as p50, p95, p99.
- **Throughput**: how much work is done per second, in requests per second (`http_reqs`).
- **Concurrency**: how many things happen at the same time; here, the number of virtual users.
- **Saturation**: a resource (the database CPU, a connection pool) has no room left. Latency then climbs steeply
  while throughput stops growing. This is the breaking point.
- **Baseline**: an earlier run of the same test that we accepted as "normal". New runs are judged against it.
- **SLO** (service level objective): a target such as "p95 of the search under 1 s". Where there is no SLO yet, the baseline is the target.
- **p95**: the time 95% of requests were faster than.
- **Error rate**: the share of requests that failed (`http_req_failed`). The report also flags failed *content checks*.
- **DTU** (database transaction unit): Azure SQL's blended measure of CPU, memory and disk speed. A small test database
  may have a few dozen; production is far bigger. Test-env numbers compare runs with each other; they do not predict production.
- **Virtual user, iteration, think time, ramp**: sections 4 and 5. A ramp is the stretch where users are added or removed.

## 9. Common mistakes

- **A token per iteration.** Logging in on every loop floods the login service (some throttle it) and measures login, not the feature. Log in once in `setup()`.
- **No content checks.** A 200 can carry an error message or an empty list. If you check only the status, a broken feature passes.
- **A check that throws.** `r.json('items').length` throws on an error page, which ends the iteration before `sleep()`; the loop then hammers the server. Our `step()` counts a check that throws as failed and goes on, but a plain k6 `check()` does not: make checks answer `false`, as `examples/hello.js` does.
- **Sharing a raw k6 summary.** `--summary-export` and a bare `handleSummary(data)` write whatever `setup()` returned, and that is the access token. Drop `setup_data` before a file leaves your machine.
- **Sharing raw run files.** Share `report.html` or `report.md`, not the raw files of a run folder. `db.json` holds the text of the database's busiest statements, which can carry other people's data from the shared database; `k6.log` holds whatever a script printed.
- **Trusting laptop numbers as absolute.** Your Mac, your Wi-Fi or VPN and a small shared database are in every number. Use them to compare runs, not to promise a speed.
- **Loading a shared env in the daytime.** Colleagues are testing there. Use the window, and tell the team.
- **Looking at averages.** See section 6. Look at p95, and at `http_req_failed`.
- **A run too short to warm up.** The first minutes are slower (cold caches, connection set-up). A 30-second load run mostly measures the warm-up; on a real system hold the load for at least 10 minutes.
- **Comparing runs that differ in two ways.** Change one thing between runs (the code, or the load), or you will not know which caused the difference.
- **Ignoring think time.** No `sleep()` means far more load than the number of users suggests.

## 10. Adding a feature or a project

A later plan will add Claude Code skills for this: **perf-discover** (find the feature's real requests from the spec, the
swagger and a recorded run, and write `journey.yaml` and `workload.yaml`), **perf-script** (write the k6 script and run it
until its smoke is green), **perf-run** and **perf-report**, and a consultant, **perf-consult**, which will give sizing
advice before a run, a plain-language analysis with cited reference points and improvement suggestions after it, and,
if you want it, guidance from start to end. None of them is built yet. Until they are, do the same steps by hand:

1. Record what the feature really sends: drive the real app (or the matching automated test) with HAR recording, then
   `npm run perf -- har-summary <har> --api <api url> --out projects/<p>/features/<f>/recordings/<name>.json`, and delete the raw HAR.
2. Write `journey.yaml` (the steps, each with its evidence) and `workload.yaml` (user mix, think time, profile sizes) in
   `projects/<p>/features/<f>/`. Copy the self-test project's (`runner/selftest/project/features/items/`).
3. Write `<f>.js` the way `items.js` is written: `step()` for every request, a content check in each.
4. `npm run perf -- check <p> <f> --env <env>` until it says `0 problems`, then a smoke run until it is green.
5. A load run inside the window, read the report, `baseline accept` if it is a good one.

A **new project** is a new folder `projects/<name>/` with a `project.yaml` (envs, caps, window, abort limits) and no
change to `core/` or `runner/`. Start by copying `projects/_template/`: `cp -R projects/_template projects/<name>`, then
set `name:` in its `project.yaml` to `<name>`. It has every `project.yaml` key with a comment, a `README.md` skeleton to
fill in (what the project tests, its envs, where its secrets live, its forbidden paths, how to run it), and an `example`
feature (`journey.yaml`, `workload.yaml`, `example.js`, `context.md`) to rename and fill in. The template never runs against an env (its URLs
end in `.test`), but tests keep it loadable and run its `example.js` against the local mock, whose routes it uses. Without an `adapter.ts` it reads logins and the token url from `.env` (names in
`.env.example`). With one, a project can read its secrets from wherever they already live, supply a database connection,
keep standing data (`setup`, `teardown`, `verifyStandingData`; `setup` receives the feature's `standing_data` mapping and
the `--set key=value` flags untouched; neither `setup` nor `teardown` is bound by the caps or the load window, so the
adapter must pace them itself), count rows and give the script run-time data: the interface is `ProjectAdapter` in
`runner/adapter.ts`. A static_header project's adapter may leave `resolveEnv` out. The name `selftest` is taken (it is
the self-test project), so do not give a project that name. `runner/selftest/project/` is the smallest complete example.

**What is built in, and what is not.**

- **Login: OAuth password grant, or a static header.** With `auth.type: ropc` the scripts fetch a token per account from a
  token endpoint with a client id, a scope, and a login and password (`fetchTokens()` in `core/auth/ropc.js`, once, in
  `setup()`). With `auth: { type: static_header, header, value }` every request carries the same header and nothing logs in:
  no accounts, no token request, `roles` are labels only. `value` may hold `${random:N}` (N random letters and digits, made
  once per virtual user inside k6, for an API that takes any token) and `${env:PERF_NAME}` (a real key, read from `.env` or
  the environment by the runner; the name must start with `PERF_` so it never sits in k6's environment, the value must be
  at least 4 characters, it reaches k6 only through the temporary secrets file, and the run folder is scanned for it
  afterwards). The script adds
  it with `staticHeaders()` from `core/auth/static.js`. Other OAuth flows and signed requests are not built in.
- **Database evidence: SQL Server and Azure SQL only.** The busy check before a load run, the abort on database CPU or
  data IO, and the report's Database section read SQL Server's own views (`sys.dm_db_resource_stats` and the query
  statistics) through the `db()` of the project's adapter. A project whose adapter has no `db()`, or whose `db()` returns
  null, runs with none of that: no db.json, no busy check (a load run is **not** refused), and it may leave
  `db_cpu_or_io_pct` out (a project that has a database must set it: a run of a feature that does not set it is refused). The report says so: "No database evidence (this project has no database access)", and **Limits applied** marks
  the database abort and the busy check "not applicable". If `db()` throws, the evidence is marked unavailable and a load, stress or soak
  run is refused (`DB_UNREACHABLE`), even with `--override-busy`: without a connection nothing would guard the database.
- **Row counts** come from the adapter's `rowCounts()`, for the tables `row_count_tables` lists. How it counts (a database,
  an API) is the adapter's business; the runner only compares the numbers before and after.
- **A feature that writes** says `read_only: false` in `journey.yaml` and must list its writes under `writes:` (each a
  `request` and who cleans up); without them the feature does not load. `perf check` refuses any write step that is not
  listed. `cleanup: app` is the only cleanup mode: the app removes these rows itself, for example by keeping a table to its
  newest rows, and the report then says "the app prunes these rows; nothing for the runner to clean up" and makes no
  row-count claim. The runner deletes nothing, so a feature whose rows nobody removes cannot be run; make it read-only.

## 11. Worked example: the demo branch

`main` holds only the framework and the self-test project, and the self-test mock is the runnable example on every
branch. The `demo` branch adds one real project, `projects/quickpizza/`, which tests
Grafana's public QuickPizza demo app at https://quickpizza.grafana.com with no secret, no account and no database access:
a static header with a random token per virtual user, caps of 5 users, 5 requests per second and 5 minutes, smoke and load
only, and one write that the app prunes itself. Its own `README.md` says how to run it, what its report shows and does not
show, and how it maps to `projects/_template/`. It is a shared public site, so run it with small loads only and keep to
section 1.

## 12. Further reading

- [k6 documentation](https://grafana.com/docs/k6/latest/) and [running k6](https://grafana.com/docs/k6/latest/get-started/running-k6/)
- [Test lifecycle](https://grafana.com/docs/k6/latest/using-k6/test-lifecycle/): init, setup, VU code, teardown
- [Checks](https://grafana.com/docs/k6/latest/using-k6/checks/) and [thresholds](https://grafana.com/docs/k6/latest/using-k6/thresholds/)
- [Built-in metrics](https://grafana.com/docs/k6/latest/using-k6/metrics/reference/)
- [Scenarios](https://grafana.com/docs/k6/latest/using-k6/scenarios/) and [open vs closed models](https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/)
- [Test types](https://grafana.com/docs/k6/latest/testing-guides/test-types/)
- [Web dashboard](https://grafana.com/docs/k6/latest/results-output/web-dashboard/) and [end-of-test summary](https://grafana.com/docs/k6/latest/results-output/end-of-test/)
