# quickpizza: a real-world example you can run as is

[QuickPizza](https://github.com/grafana/quickpizza) is Grafana's demo web app for k6: it makes up a pizza recommendation
on request. Grafana hosts a copy at <https://quickpizza.grafana.com> for people learning k6. This project tests that hosted
copy with the framework, so you can see a whole project, from `project.yaml` to a report, against a real system on the
internet. It needs **no secret, no account and no database access**: no `.env`, nothing to set up.

The project lives on the `demo` branch next to the framework. Nothing from QuickPizza's own repository is copied here
(it is AGPL-licensed); the journey links to its OpenAPI document and code at a pinned commit instead.

## Run it

```bash
npm run perf -- doctor quickpizza --env hosted                       # k6, Node, the project, the OpenAPI document
npm run perf -- check quickpizza pizza --env hosted                  # "0 problems": every step is a documented route
npm run perf -- run quickpizza pizza --profile smoke --env hosted    # each step once, a few seconds
npm run perf -- run quickpizza pizza --profile load --env hosted --dry-run
npm run perf -- run quickpizza pizza --profile load --env hosted     # 2 visitors, 3 minutes
npm run perf -- report "$(ls -dt results/20*_quickpizza_*/ | head -1)" --verify-sources
open "$(ls -dt results/20*_quickpizza_*/ | head -1)report.html"
```

`doctor` and `check` read the OpenAPI document from GitHub and send nothing to QuickPizza. A smoke sends four requests.
The load run sends roughly one request per second for three minutes (two visitors who pause 1 to 3 seconds between clicks).

## Politeness rules

QuickPizza's README says the hosted copy is meant for small-scale tests like the ones in its `k6` folder, and Grafana's
[learning path](https://grafana.com/docs/learning-paths/find-k6-limits/) calls it "a resilient shared demo target". So:

- **Caps of 5 users, 5 requests per second and 5 minutes**, defaults of 2 users and 2 requests per second (`project.yaml`).
  Do not raise them.
- **Smoke and load only.** There is no stress and no soak profile: a stress run against a shared, well-provisioned demo
  site shows little, and finding a breaking point needs an environment of your own. To see a breaking point found and
  explained, run the framework's self-test (`npm run perf -- selftest`): its local mock has a bottleneck planted in it.
- **No accounts and no ratings.** The journey never calls `/api/users` (that creates an account) or `/api/ratings` (with a
  made-up token, ratings belong to the shared default user that everybody sees).
- **No schedules and no loops.** A person starts each run. Do not run it again and again to "warm it up".
- There is no load window (a public site has no colleagues' working hours to protect), but keep runs small at any hour.

## What the test does

One journey, `pizza_shopper` (`features/pizza/`), as a `Visitor`:

| Step | Request | Checks (shape only: every pizza is made up at random) |
| --- | --- | --- |
| `pizza.quotes` | `GET /api/quotes` (public) | a non-empty list of quotes |
| `pizza.catalog_doughs` | `GET /api/doughs` | a non-empty list of doughs |
| `pizza.catalog_tools` | `GET /api/tools` | a non-empty list of tools |
| `pizza.recommend` | `POST /api/pizza` with restrictions | a pizza id, 4 to 9 ingredients, no pepperoni, no knife |

Auth is a header, `Authorization: token <16 characters>`, and any 16 characters work, so each virtual user makes up its own
(`auth: { type: static_header, value: "token ${random:16}" }`). `features/pizza/context.md` has the details: where each step
comes from, why the restriction names are capitalised, what the checks prove.

## What the report will and will not show

- **Verdict.** The first load run says `NO BASELINE`: nothing to compare with yet. `baseline accept` it if it looks right,
  and later runs are compared with it. The numbers include the distance from your machine to Grafana's hosting and other
  people's tests on the same site, so compare runs from the same place, and expect them to move more than on a private env.
- **What the test does** says the feature writes data: "the app prunes these rows; nothing for the runner to clean up".
  `POST /api/pizza` stores each recommended pizza, and QuickPizza itself keeps only its newest rows. There is no row-count
  table, because this project cannot see QuickPizza's database.
- **Database:** "No database evidence (this project has no database access)". There is no database chart, no busy check
  before a load run and no database abort; **Limits applied** marks those as "not applicable". The k6 abort limits still
  apply: 10% failed requests, or a p95 above 5,000 ms (high on purpose: the site may be slow from far away).
- **Results per step** has no `auth_token` row: the header needs no login, so the run sends no token request.
- **App build** reads "not readable", so a redeploy during a run cannot be detected: the OpenAPI document is pinned (its
  hash never changes) and QuickPizza's page has no bundle name to read.

## How this project maps to the template

| `projects/_template/` | here | why |
| --- | --- | --- |
| `roles: [Analyst]`, logins in `.env` | `roles: [Visitor]`, no logins | the role is a label; a static header has no accounts |
| `envs.staging` with a load window | `envs.hosted`, no `window_utc` | a public site, no working hours to protect |
| caps 20 / 30 / 30m, defaults 10 / 15 | caps 5 / 5 / 5m, defaults 2 / 2 | a shared public demo site |
| `auth: { type: ropc }` | `auth: { type: static_header, ... }` | QuickPizza takes any 16-character token |
| `abort.p95_ms: 15000` | `abort.p95_ms: 5000` | catch a real problem, not a slow line |
| `abort.db_cpu_or_io_pct: 95` | left out | no database; a project with one must set it |
| `read_only: true`, `read_only_post_routes` | `read_only: false`, `writes: [{ request: POST /api/pizza, cleanup: app }]` | the one write is pruned by the app |
| `profiles: load, stress` | `profiles: load` | no stress or soak on a shared demo site |
| evidence from a recorded session | evidence from the OpenAPI document and code at a pinned commit | the API is public and documented |
| no `adapter.ts` | no `adapter.ts` | nothing to read from elsewhere; no database |

## No planted delay

QuickPizza's code can add latency on request (the header `x-delay-record-recommendation`, see
[injector.go](https://github.com/grafana/quickpizza/blob/fa8f2e382fcc7d0caee4a2abac8200b9f71778d7/pkg/errorinjector/injector.go#L28)),
which would make a nice "slow step" demo. The first smoke probed it once with `300ms`: the delayed recommendation took
382 ms, the plain one 320 ms, and the three GETs 124 to 128 ms, which is the network floor from here. A 300 ms sleep on the
server would take at least about 424 ms, so the hosted copy does not honour the header, and the probe step was dropped.
For a slow step that is really planted, and a regression the report flags, run the self-test (`npm run perf -- selftest`).

## Runs

The first runs, on 2026-10-27 from a laptop in Europe (run folders are not committed; `results/` is git-ignored):

| Run | Verdict | Requests | Failed | p95 per step (ms): quotes / doughs / tools / recommend |
| --- | --- | ---: | ---: | --- |
| `2026-10-27_1232_quickpizza_pizza_smoke` (with the delay probe) | NO BASELINE | 5 | 0% | 127 / 124 / 128 / 320 |
| `2026-10-27_1233_quickpizza_pizza_smoke` | NO BASELINE | 4 | 0% | 122 / 121 / 126 / 237 |
| `2026-10-27_1233_quickpizza_pizza_load` (2 visitors, 3 min 3 s) | NO BASELINE | 188 | 0% | 133 / 136 / 138 / 433 |

Every content check held, and `report --verify-sources` traced every number of the three reports. The load ran at about
73 pizza actions per minute in its steady state. No baseline is committed: a baseline taken from one place on the
internet says little about another, so accept your own.
