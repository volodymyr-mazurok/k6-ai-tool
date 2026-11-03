# Script rules: `<feature>.js`, reading a smoke, whose failure it is

The two scripts to copy from are `projects/_template/features/example/example.js` (a project under `projects/`) and
`runner/selftest/project/features/items/items.js` (the self-test project). The helpers are `core/request.js`
(`step()`, `think()`, `shouldRun()`), `core/config.js` (`loadRunConfig()`, `loadSecrets()`, `buildOptions()`),
`core/auth/ropc.js` (`fetchTokens()`, `bearer()`) and `core/auth/static.js` (`staticHeaders()`).

## 1. Writing the script

The file is `projects/<project>/features/<feature>/<feature>.js`. Imports climb four folders to the repo root
(`'../../../../core/request.js'`); the self-test's climb five.

**Skeleton, ropc** (`project.yaml` `auth.type: ropc`):

```js
import { loadRunConfig, loadSecrets, buildOptions } from '../../../../core/config.js';
import { fetchTokens, bearer } from '../../../../core/auth/ropc.js';
import { step, think, shouldRun } from '../../../../core/request.js';

export { handleSummary } from '../../../../core/summary.js';

const cfg = loadRunConfig();
const secrets = loadSecrets();
export const options = buildOptions(cfg);

export function setup() {
  return { tokens: fetchTokens(cfg.auth, secrets.accounts) }; // once per run, never per iteration
}
```

**static_header** (`auth.type: static_header`): no `setup()`, no `bearer()`; at the top level
`const AUTH = staticHeaders(secrets);` (import from `core/auth/static.js`) and `headers: AUTH` on every step.

**Per journey**, an exported function named as the journey's `exec`:

- **One `step()` per journey step**, id `<journey key>.<step name>`, the method and route `journey.yaml` names, with the
  run-time value filled into each `{param}` (from an earlier step's response, `cfg.data` from the project's adapter, or
  `fixtures/`). Never another request: anything not sent through `step()` is an `UNNAMED_REQUEST`.
- **Token per step:** `token: bearer(data.tokens, '<Role>')`, the journey's `role`. It refreshes itself.
- **`think(cfg);` between steps** (smoke and stress skip it on their own). The think time comes from `workload.yaml`
  through the run config; never write a `sleep()` of your own.
- **Optional steps:** `optionalShare(journey, step)` as the two scripts define it (it throws a named error
  `<file>: journey <j> has no step <s> in journey.yaml`), then `if (shouldRun(cfg, SHARE)) step(...)`.
  Smoke always runs them.
- **Bodies** come from the evidence. Store them in `fixtures/<name>.json` in the feature folder, the format
  perf-discover writes: plain JSON, no personal data, no secret, no token. Load them at the top level:
  `const SEARCH_BODY = JSON.parse(open('./fixtures/search.json'));` (k6 resolves the path from the script's own
  folder). A body field no evidence supports is an open question, not a guess.

**Checks** (`checks: { '<name>': (res) => boolean }`, at least one per step; `step()` adds `status 2xx` itself and
aborts the run when a step has none):

- Each check states something the evidence shows about a correct answer: the key that holds the list and that it is
  not empty, a `totalCount` the probe or recording saw, the id the step asked for coming back, a file body for an export.
  Write in `context.md` (evidence log) which evidence each check rests on.
- Parse with the `json(res)` helper of the scripts (returns `null` for a body that is not JSON), so an error page fails
  the check instead of throwing. A check never throws and never answers `true` when it cannot read the body.
- Give checks names that say what they expect (`has 20 items`, `total count is 500`); the name shows in `summary.json`.
- No `console.log` of a body, a header, a token or a login: `k6.log` is a run file people open.

## 2. Reading a smoke

`npm run perf -- run <project> <feature> --profile smoke --env <env>` ends with `perf:` lines. Read them in this order:

1. `perf: smoke failed: <reasons>` (absent when it passed) and the last line, `perf: verdict <WORD> — <reason>`.
   A smoke whose checks are below 100% exits 99: `checks rate==1 was crossed`. Exit 2 is a refusal: nothing ran.
2. `<runDir>/k6.log`: script errors (`ReferenceError`, `TypeError`, a named `optionalShare` error,
   `step <id> has no content check`), `token endpoint returned <status> for <role>`, connection errors.
3. `<runDir>/summary.json` `metrics`: per step, `checks{name:<key>.<step>}` → `values.passes` / `values.fails`, and
   `http_req_failed{name:<key>.<step>}` → `values.rate` (the status was not 2xx). `root_group.checks` lists each check
   **name** with its passes and fails, summed over all steps that use that name.
4. `<runDir>/meta.json` `k6` (`exitCode`, `scriptErrors`) and `checks` (journey problems: `STEP_NOT_EXERCISED`,
   `UNNAMED_REQUEST`, `ROUTE_MISMATCH`).
5. `<runDir>/report.md`: the step table (Checks passed per step) and the row counts, when the project counts rows.

To see what a step really answers, without printing it from the script, send the same request once:
`npm run perf -- probe <project> <METHOD> <path> --env <env> [--body <fixtures file>] [--role <role>]`. It prints the
status, time, content type and the shape of the body (keys, types, array lengths, count-like numbers). A POST is sent
only when the route is in `read_only_post_routes`.

## 3. Whose failure it is

| What the smoke shows | Cause | Do |
| --- | --- | --- |
| A script error in `k6.log`, `has no content check`, a named `optionalShare` error | script | fix the script |
| `the script does not match the journey: …` (`STEP_NOT_EXERCISED`, `UNNAMED_REQUEST`, `ROUTE_MISMATCH`) | script | make the script send what `journey.yaml` says; a journey that is wrong goes back to perf-discover and the owner |
| A content check fails, the probe's shape matches the evidence, and the check asks for something the evidence never showed (wrong key, wrong field type) | script | rewrite the check from the evidence; write the evidence it rests on |
| A content check fails and the probe's shape **contradicts** the evidence (another key, an empty list where the recording had rows, an error object in a 200) | app or env | report; the check stays |
| `http_req_failed` 100% on a step, probe 400, and the body is not from evidence | script | take the body from a recording or a swagger example; none → open question |
| Probe 400 with a body from evidence, or 5xx | app | report |
| 404 with the route `journey.yaml` names | app or env (deployment, wrong env url) | report |
| 401 / 403, or `token endpoint returned …` | env (accounts, role rights) | report; the person fixes `.env` or the account. You never type or ask for a password |
| Connection refused, timeouts, DNS errors | env down | report; one more smoke only after the person says it is back |
| `perf:` says the row counts differ or could not be read | app or journey (a write nobody cleans up) | report; never touch `row_count_tables` |
| Exit 2, a refusal (env lock, busy, unknown env) | guardrail | report the refusal as printed; no override flag (they are never yours to pass; only the owner can ask for one) |

Same cause = the same step and the same failing check or error. Three failed smokes for one cause, then stop. A
failure that only changes its name (the same step failing for the same underlying reason, for example a parse error
that becomes a failed check after an edit, or another check name on the same wrong body) is the same cause: the count
does not restart.

## 4. The two report blocks

**App or env problem** (show it and stop; nothing in the script changed to hide it):

```markdown
### Smoke red: <project>/<feature> on <env>: app/env problem, not the script
Run: <runDir> (verdict <WORD>, k6 exit <code>)
- Step `<key>.<step>`: check `<name>` <passes> passed / <fails> failed (summary.json `checks{name:<key>.<step>}`)
- Probe: `<status> <METHOD> <path> <ms> <content type>`, shape <keys and lengths>
- Evidence: <recording / swagger / earlier probe> shows <what a correct answer holds>
- So: <the app answers X where the evidence shows Y>. The check is unchanged.
- Needed: <who should look, or which question the owner answers>
```

**Done** (green smoke):

```markdown
### Smoke green: <project>/<feature> on <env>
Run: <runDir>, verdict <WORD>, k6 exit 0, 0 script errors, the script matches the journey
| Step | Checks | Passed / failed |
| --- | --- | --- |
| <key>.<step> | <check names> | <passes> / 0 |
`report --verify-sources`: all <N> numbers traced. Row counts: <equal | not counted for this project>.
Next: sizing (perf-consult) and a dry run (perf-run). Nothing larger than a smoke ran.
```
