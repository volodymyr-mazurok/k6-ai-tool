# CLAUDE.md

A reusable k6 performance-testing framework: a runner with safety guardrails, a k6 helper library, a report generator and
a self-test. It is a boilerplate that we refine and copy to other projects, not a system that watches anything.
`README.md` is the guide; read it first.

## Rules (they protect shared environments)

- **Never raise a cap.** `caps` (`max_vus`, `max_rps`, `max_duration`) in a `project.yaml` are the ceiling. Do not edit
  them upward, and do not work around them in code, config or a k6 command line.
- **Never run load outside the runner.** Every run goes through `npm run perf -- run …`. Never start a project script with
  a plain `k6 run`, and never write a throwaway script that sends load to a shared env.
- **Never pass `--override-window`, `--override-busy` or `--allow-max` without the owner's OK in chat.** Each is recorded in
  the report; `--override-busy` makes the verdict INVALID.
- **No scheduled, nightly or recurring runs, and no monitoring**, unless the owner asks for one.
- **Use `--dry-run` first**, and run load, stress or soak against a shared env only when the owner has said so. The local
  mock (`npm run mock`, the `selftest` project) is always fine to load.
- **Never copy secrets** (logins, tokens, connection strings) into the repo, a report, a log or a chat. Never commit a raw
  HAR (`*.har` is git-ignored; summarise it with `perf har-summary` and delete it). Never print an access token.
- **Every number in a report comes from `summary.json`, `timeseries.json` or `db.json`.** Do not hand-edit a report; run
  `npm run perf -- report <runDir> --verify-sources` after any change to report code.
- Project names, env names, roles and URLs of a particular app belong in `projects/<name>/`, never in `README.md`, this
  file, `core/` or `runner/` (a test enforces it for the two documents).

## Where things live

| Path | What |
| --- | --- |
| `core/` | The k6-side library (plain JS, runs inside k6): `auth/ropc.js` and `auth/static.js` (the two logins), `request.js` (`step()`), `config.js`, `lib/` profiles, thresholds, tokens. |
| `runner/` | The CLI (`cli.ts`) and everything around a run: `guardrails.ts`, `run.ts`, `k6.ts`, `config.ts`, `adapter.ts`, `auth.ts`, `baseline.ts`, `checks.ts`, `standing.ts`, `doctor.ts`. |
| `runner/collectors/` | Database evidence (MSSQL). `runner/report/` builds `report.html` and `report.md` from a run folder. |
| `projects/_template/` | Copyable skeleton of a project: every `project.yaml` key, commented, and an `example` feature. |
| `projects/<name>/` | One app: `project.yaml`, optional `adapter.ts`, and `features/<f>/` with `journey.yaml`, `workload.yaml`, `<f>.js`, `recordings/`. |
| `runner/selftest/` | The mock server with a planted bottleneck, the self-test project (`project/`) and the known-answer self-test. |
| `examples/` | `hello.js`, the first k6 script (runs against the mock). |
| `results/` | One folder per run (git-ignored). `results/selftest/` holds the self-test's runs. |
| `tests/` | Cross-cutting tests (README, examples, fixtures). Unit tests sit next to their code as `*.test.ts` / `*.test.js`. |

Other branches add a real project under `projects/`: the `demo` branch adds quickpizza, a project against Grafana's public
QuickPizza demo app with no secrets and no database (README section 11). A real project is the reference for writing one. The shared files (`core/`, `runner/`, `README.md`, this file) are identical on every branch.

**Before touching a project, read `projects/<name>/README.md`**: it holds that project's secret locations and forbidden paths.

## Commands

```bash
npm test                                   # unit tests; must end with "# fail 0"
npx tsc --noEmit                           # type check; must be clean
npm run perf -- doctor [<project> --env <env>]
npm run perf -- check <project> <feature> --env <env>               # "0 problems"
npm run perf -- run <project> <feature> --profile smoke --env <env>
npm run perf -- run <project> <feature> --profile load --env <env> --dry-run
npm run perf -- selftest                   # known-answer test against the local mock, about 10 minutes
npm run perf -- report <runDir> --verify-sources
npm run mock                               # local mock server on port 4010
scripts/check-shared.sh                    # HEAD without any real project: npm ci, test, tsc, word grep (shared files only)
```

Unit tests: `npx tsx --test <file>`. Tests that touch a real env run only with `PERF_LIVE=1`; never set it without the owner's OK.

## Skills

The agent skills are not built yet. A later plan will add perf-discover, perf-script, perf-run, perf-report and a
consultant, perf-consult (sizing advice before a run, a plain-language analysis with cited reference points and
improvement suggestions after it, optional start-to-end guidance). Until then do the steps by hand as README section 10
describes, and do not pretend a skill ran.

## Working style

Say what you verified ("Checked: `npm test` 0 fail, tsc clean, `perf check` 0 problems"). A zero exit code is not a good
result: read the verdict. Keep README and the code in step: `tests/readme.test.ts` fails when the README forgets a report term.
