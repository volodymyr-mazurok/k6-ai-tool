# pizza feature: notes for whoever works on it next

- **What it covers.** One kind of visitor (`pizza_shopper`, role `Visitor`) on QuickPizza's API: read a quote, look at the
  doughs and the tools, ask for a pizza recommendation. Read-mostly: the recommendation is the one write (below).
- **Where the evidence came from.** No recorded session: the API is public and documented. Every step cites the QuickPizza
  OpenAPI document at commit `fa8f2e38` (the same file `project.yaml` uses as `swagger_url`), the recommendation also the
  handler in `pkg/http/http.go`. The hosted site may run a newer build; `perf check` proves the routes against the pinned
  document, and a smoke proves what the hosted site really answers.
- **Auth.** `Authorization: token <16 characters>` on everything but `/api/quotes`. The OpenAPI document declares
  `authToken` as a global security requirement, but the hosted site serves `/api/quotes` without a token (both smokes and
  the load did), so the script sends it without one, like the app's own front page. Any 16 characters work: QuickPizza maps a
  token it does not know to its shared default user (`pkg/database/catalog.go`, the user lookup by token). Each virtual user
  makes its own random token once (`${random:16}` in `project.yaml`, `core/auth/static.js`). No account is created, and no
  ratings are touched: with a made-up token they belong to the shared default user that everybody sees.
- **Request bodies.** The recommendation sends the restrictions of QuickPizza's own k6 examples, with one change: the names
  are spelled the way the catalog spells them (`Pepperoni`, `Knife`). The app compares names exactly (`slices.Contains`), so
  the lower-case `pepperoni` / `knife` of the examples exclude nothing, and a check for "no pepperoni" would prove nothing.
- **What it writes.** `POST /api/pizza` stores the recommended pizza (`RecordRecommendation` in `catalog.go`), and the app
  keeps that table to its newest rows by itself (`enforceTableSizeLimits`; how many it keeps is a setting of the hosted
  site). So `journey.yaml` says `read_only: false` with `writes: [{ request: POST /api/pizza, cleanup: app }]`, and the
  report says "the app prunes these rows; nothing for the runner to clean up". There is no row count: the project has no
  database access.
- **Content checks.** Shape only, never exact names (every pizza is made up at random): quotes, doughs and tools are
  non-empty lists; a recommendation has `pizza.id` (a number), 4 to 9 ingredients (olive oil, tomato and mozzarella plus 2 to
  6 toppings, duplicates removed), no pepperoni and no knife. Calories are not checked: after 10 tries the app returns its
  last pizza even when it is over the limit.
- **No planted delay.** QuickPizza's error injector (`pkg/errorinjector/injector.go`) can sleep on request, through the
  header `x-delay-record-recommendation`. The first smoke (2026-10-27_1232) sent one recommendation with `300ms`: it took
  382 ms against 320 ms for the plain one, while the three GETs took 124 to 128 ms. A 300 ms sleep on the server would
  need at least about 424 ms, so the hosted site does not honour the header, and the step was dropped. For a slow step
  that is really planted, use the self-test mock.
- **Known limits and surprises.** The numbers include the distance from your machine to Grafana's hosting, and other
  people's tests on the same public site. The build fingerprint cannot see a redeploy: the OpenAPI document is pinned (its
  hash never changes) and the app's page has no `main-*.js` bundle name, so "App build" reads "not readable".
- **Last smoke / baseline.** See this project's `README.md` (no baseline is committed).
