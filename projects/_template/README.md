# CHANGE: <project name>: what it tests, in one sentence

Copy this file with the rest of the template (`cp -R projects/_template projects/<name>`) and fill in every CHANGE. It is
the page a newcomer, or an agent, reads before touching the project: the repo's own `README.md` and `CLAUDE.md` say so.
Keep it short; the repo README explains the framework, this file only what is particular to this app.

## What this project tests

- CHANGE: the app, and the feature(s) under `features/` (one line each: what a user does there, which requests it sends).
- CHANGE: what it does not test, and why (a page that writes, an endpoint that is too heavy for the env, ...).

## Envs

| Env | App | API | Who else uses it | Load window |
| --- | --- | --- | --- | --- |
| CHANGE: `staging` | CHANGE: app url | CHANGE: api url | CHANGE: the team that shares it | CHANGE: as in `project.yaml` `window_utc` |

Caps and defaults are in `project.yaml`; they are the ceiling, never raise them. CHANGE: who to tell before a load run.

## Secrets: where they live

- CHANGE: where the logins and the token url come from: `.env` at the repo root (names in `.env.example`) for the default
  adapter, or the place this project's `adapter.ts` reads them in place. Never copy them into this repo, a report or a chat.
- CHANGE (static_header projects): which `${env:PERF_NAME}` variable holds the key, or "none: `${random:N}` only".
- CHANGE (projects with a database): where the connection string comes from; never print it.

## Forbidden paths

- CHANGE: folders or files of another repo the adapter reads but must never change or copy (and the one file, if any,
  it is allowed to change).
- CHANGE: requests the journeys must never send (a route that creates accounts, deletes data, sends mail, ...).

## How to run

```bash
npm run perf -- doctor <name> --env <env>                         # tools, accounts, swagger, tokens, database
npm run perf -- check <name> <feature> --env <env>                # "0 problems"
npm run perf -- run <name> <feature> --profile smoke --env <env>  # each journey once
npm run perf -- run <name> <feature> --profile load --env <env> --dry-run
```

CHANGE: standing data (`perf setup <name> --env <env>`, and when it expires), and what a good report looks like here.
