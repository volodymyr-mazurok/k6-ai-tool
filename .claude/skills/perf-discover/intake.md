# Intake: any input → one feature brief

## 1. Each input, its tool and its fallback

Several inputs may come at once; use all of them and say in the evidence log which one gave what.

| Input | Tool | When the tool is missing or fails | What it can prove |
| --- | --- | --- | --- |
| A spec page (Confluence, Jira) | the Atlassian connector, when this session has it connected | ask the person to paste the page or export it as a file | what to look for: flows, roles, slow spots. Never a route by itself |
| A spec file (PDF, Word, Markdown, text) | read it | ask for a text or PDF export | as above |
| A link to the app or one of its pages | `npm run perf -- record <project> --env <env> --start <url> --out <feature folder>/recordings/<flow>.json`: a window opens, the **person** drives the flow and logs in, then closes it. With no login on the way, you may drive it yourself with `--actions <file.json>` (`goto`, `click`, `fill`, `wait`) | ask the person for a HAR exported from the browser's developer tools (then the HAR row) | the real calls, their order, bodies, statuses, and the sign-in shape (`<out minus .json>.auth.json`) |
| A swagger / OpenAPI url or file | fetch it read-only (`curl -s <url> -o <temp file outside the repo>`, or read the file); list paths and methods (below) | ask for the file; without any swagger `perf check` cannot pass: an open question for the owner | which routes and methods exist, bodies and examples when it has them, `securitySchemes` |
| An endpoint list, a curl command, a Postman/Insomnia export | read the requests as given; drop every header value, token and cookie on sight | — | candidate routes; each confirmed against the swagger before it becomes a step |
| A HAR file | `npm run perf -- har-summary <har> --api <api url> --out <feature folder>/recordings/<flow>.json` | — | as a recording. A HAR you made: delete it after summarising. A HAR the person owns: leave it, and tell them it holds their tokens and should be deleted |
| An automated UI or API test in another repo | read that repo's rules first and honour its forbidden paths too, when reading and when running; with the person's OK, run it with HAR recording if it supports that, then `har-summary`; otherwise read its requests | read its requests only | as a recording when run; as candidate routes when only read |
| A sentence ("the item search is slow") | turn it into questions and a probe plan: which page, which role, which action, what "slow" means | — | where to look; nothing more |
| An existing project or feature name | read its `projects/<name>/README.md`, then the feature's files; continue from the first missing piece (brief → evidence → journey → workload → check → gate) | — | what was already found; re-check anything older than the env's last deploy if the person says it changed |

**Listing a swagger's routes** (no body is printed, only path, method and operation id):

```bash
node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const[p,o]of Object.entries(s.paths))for(const m of Object.keys(o))if(/^(get|post|put|patch|delete)$/.test(m))console.log(m.toUpperCase(),p,o[m].operationId??"")' <swagger.json>
```

A YAML swagger: read it instead. Delete the temp file when done. Fetching the swagger you were handed is allowed
before Gate A (one read-only document someone gave you); probes and recordings wait for Gate A. A swagger that answers 401 or a login page is an
open question (where the document lives without a login), not a reason to send a credential.

**Probing** (after Gate A on a new project): `npm run perf -- probe <project> GET <path> --env <env>` sends one
request with the project's own auth and prints a status line and a shape, never a body, a header or a token. Exit 0
means the API answered, **whatever the status**: read the status line. 401/403: the auth settings or the role (it says
which to check); 404: the route is not there; 5xx: the env, note it and move on. A POST is probed only when its route is
in `read_only_post_routes` (or a declared write with `--feature`), with a body file from evidence (`--body <file.json>`).
A probe is one request, not load; still, keep them few on a shared env and never loop them.

## 2. The feature brief (top of `context.md`)

Write it before anything else, with every field present; an unknown is written `unknown` and gets an open question.
Then the evidence log and the data volume notes; the template's own `context.md` headings follow below them.

```markdown
# <feature>: <one line: who does what>

## Feature brief (YYYY-MM-DD)
- **Target:** app <name>; env `<env>`: base url <app url>, api url <api url>, swagger url <swagger url>
- **Auth:** ropc | static_header | unknown (<the evidence: a recording's auth.json, swagger securitySchemes, the owner>)
- **Flows:** <journey name>: <steps in order>, one line each (or `unknown` until evidence shows them)
- **Data each flow needs:** <ids, search terms, standing rows; where they come from>
- **Reads and writes:** read-only | writes <METHOD /route> (cleanup: <who>)
- **Known slow spots:** <what the person said, and where it was seen>
- **Open questions:**
  1. <the question> (asked YYYY-MM-DD / answered: <answer>)

## Evidence log
| When | Source | What it gave |
| --- | --- | --- |
| YYYY-MM-DD | swagger <url> | `POST /api/items/search` (ItemsSearch), `GET /api/items/count` (ItemsCount) |
| YYYY-MM-DD | `perf probe selftest GET /items/count` | 200, 12 ms, `{ totalCount: number }` |

## Data volume
<the counts and array lengths the probes or recordings showed, and whether they are realistic>
```

The evidence log holds what a command printed (status, time, shape) and what a document said; never a token, a
password, a header value, a person's name or e-mail from a body. An auth kind other than `ropc` or `static_header`
(another OAuth flow, signed requests, a cookie-only session) is not built in: write it in the brief and report the
feature as not testable yet.

## 3. A new project

1. Propose, in one message: the folder name (letters, digits, `_`, `-`; not `selftest`), the env name(s) with app url,
   api url and swagger url, the auth kind and roles, and the caps, defaults and load window from the target's nature
   (the table in `.claude/skills/perf-consult/sizing.md`: public demo site, shared dev or test env, dedicated performance
   env, for which you ask; a local mock or your own machine has its own row), and the busy check on or off (on when
   the adapter gives a database `db()`, off without one). Say which row you used and why.
2. **Gate A:** "These are the project settings I propose. Nothing runs against `<env>` until you approve them; say yes,
   or what to change." Stop.
3. After the yes: `cp -R projects/_template projects/<name>`; set `name:` in its `project.yaml`; fill every `CHANGE`
   there and in its `README.md` (secret locations and forbidden paths as the owner tells you; ask, never guess);
   rename `features/example` to `features/<feature>` and delete `example.js` from it (perf-script writes `<feature>.js`).
4. Clear the template's `read_only_post_routes` and list only POST routes the evidence shows to read **and** the owner
   confirmed. Keep the template's `abort` limits unless the owner gives others. The template's `roles` become the real
   roles.
5. A new env on an **existing** project is proposed the same way (urls, caps, defaults, window, busy check) and needs
   the owner's yes to its settings before any probe or recording against it.
6. Secrets: the person puts logins and the token url in `.env` themselves (names in `.env.example`); you never see or
   type them. Then `npm run perf -- doctor <name> --env <env>` checks access before the first probe.
