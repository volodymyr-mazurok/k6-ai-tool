# Journey rules: from evidence to `journey.yaml`, `workload.yaml` and `fixtures/`

The format is in `projects/_template/features/example/journey.yaml` and `workload.yaml` (every key commented). These
rules say what goes into them.

## 1. Steps

- **API calls only.** Keep the calls under the env's api url; drop pages, scripts, images, fonts, telemetry and the
  token request (the runner's auth does that one).
- **One journey = one kind of user doing one sequence**, in the order the recording shows. From a swagger alone the order
  is a proposal: say so in the brief and ask at Gate B.
- **Name steps for what the user does** (`search`, `open_item`, `export`), not for the route. A repeated call with a
  different purpose is its own step (`list_open`, `list_search` both `POST /items/search`).
- **`request:` is `METHOD /route` relative to the api url**, written as the swagger names it: a fixed id becomes the
  swagger's `{param}` (`GET /items/{id}`). The script fills it at run time from an earlier step's response (say which
  field) or from `fixtures/`. A recorded id is never the plan.
- **`optional_share:`** only when the evidence shows the step happens in some sessions only (the owner's estimate is
  evidence; write it in the brief as theirs).
- **`role:`** is one of `project.yaml` `roles`; a flow seen only as another role is another journey.

## 2. Evidence (every step, no exceptions)

`evidence:` is a mapping; name the source so someone else can open it. One or more of:

```yaml
evidence: { swagger: "POST /api/items/search (ItemsSearch)", recording: "recordings/search.json #3", probe: "2026-11-03 200 POST /items/search" }
```

- The swagger route is required for every step (`perf check` refuses one it cannot find).
- The flow (that a user really sends it, in that order) comes from a recording, an automated test, or the owner's answer.
  When only the swagger and a sentence exist, add `flow: "owner to confirm at review"` and list it as an open question.
- A spec, ticket or chat line is written in the brief, never as a step's only evidence.
- **Spec and evidence disagree** (the spec names `/items/find`, the swagger has only `/items/search`): no step on the
  spec's route; the evidence log records both; an open question asks the owner which one is meant. A step on the
  swagger's route goes in only when other evidence supports it (a recording, the person's own words about the action),
  and its evidence says so.

## 3. Reads and writes

- `read_only: true` unless evidence shows the flow writes. A POST that only reads (a search, an export) goes into
  `project.yaml` `read_only_post_routes` after you state why it reads (swagger summary, recording, the developers) and
  the owner says yes.
- A write is declared under `writes:` with `cleanup: app`, the only mode, **only** when the app's owner or developers
  confirm the app removes those rows itself. Nobody cleans up → the feature (or that step) is **not testable yet**: say so
  in the brief and at Gate B, and keep the journey read-only without it. Never force it through.
- Never a request that creates accounts, deletes data, sends mail or pays, whatever the evidence shows.

## 4. Data volume

Probe what the steps run against (a count route, `totalCount`, an array length in the probe's shape) and write it under
**Data volume** with its source. Say it plainly when it is unrealistically small next to what the owner says the real
system holds ("120 items here, the owner says production has 2 million: timings here will look better than real"). No
production figure known → an open question, not a guess.

## 5. Bodies and `fixtures/`

Request bodies and run-time values (search terms, ids, filters) come from a recording, a swagger example, or a probe
answer. Put the ones the script needs in `fixtures/<name>.json` in the feature folder: no personal data, no secret, no
token, values a test user may see. A body field nobody has evidence for is an open question.

## 6. `workload.yaml`

- `mix` names every journey, adding up to 100; the shares from the owner, or equal shares labelled as such.
- `business_unit` and `business_action` in the owner's words.
- `think_time` and `profiles` from perf-consult's sizing (`.claude/skills/perf-consult/sizing.md`) when the owner gave
  business numbers. Without them: `load.users` at most the env's `defaults.vus` and a note in the brief that sizing is
  still to do. Never above the defaults without the owner's own number.
- `targets: baseline` unless the owner names step targets.

## 7. The check and the review gate

Run `npm run perf -- check <project> <feature> --env <env>`. Each problem names its code: `NO_EVIDENCE` (add the real
source), `ROUTE_NOT_IN_SWAGGER` (the route is wrong or the evidence was: go back to the swagger, never pick a
look-alike silently), `WRITE_IN_READ_ONLY` / `WRITE_NOT_DECLARED` (section 3). Repeat until `0 problems`.

**Gate B**: show this block, filled in, and stop:

```markdown
### Review: <project>/<feature> on <env>
`perf check`: 0 problems (YYYY-MM-DD HH:MM)

| Journey | Step | Request | Evidence |
| --- | --- | --- | --- |
| <journey> | <step> | <METHOD /route> | <source> |

- Reads and writes: <read-only, or each write and who cleans up; anything not testable yet>
- Data volume: <counts and whether they are realistic>
- Workload: mix <…>, think time <…>, load <users> users (defaults <vus> users / <rps> req/s); sizing <done | still to do>
- Open questions: <numbered, each with what changes depending on the answer>

Is this the journey to test? Say yes, or what to change. Nothing is scripted or run until you say yes.
```

A change the owner asks for goes back through sections 1–7 and the gate is shown again.
