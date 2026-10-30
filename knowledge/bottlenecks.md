# Bottleneck patterns

Each pattern: how it shows in a run folder (file and field), what it usually means, and the usual fixes. These are leads
for the owner to confirm, not verdicts; check the claim against the numbers before quoting it. Cited with a `ref:` tag in square brackets
(see `references.md`).

Files: `summary.json` (k6's totals per metric, per step by the `name` tag), `timeseries.json` (`buckets[]`: `vus`, `reqs`, `rps`,
`p95`, `errors`, `dropped` per 15 s), `db.json` (`resource[]`, `topStatements[]`, `missingIndexes[]`, `evicted`, `errors[]`),
`meta.json` (profile, k6 exit code, abort reason), `k6.log`.

## One step far slower than the rest, server side

- **Shows as:** one `name:<journey>.<step>` row in `summary.json` with a high p95 while the other steps are fast. The run folder keeps per-step figures only for `http_req_duration`, `http_req_failed` and `checks`; the split into `http_req_waiting`, `http_req_blocked` and `http_req_connecting` exists only run-wide [ref:k6-metrics-reference]. A run-wide `http_req_waiting` close to the run-wide `http_req_duration`, with small blocked and connecting values, is a hint that time is spent on the server and not on the load machine or network (our experience, not proof). A per-step split is not in the run folder, so do not state which part of one step's time is waiting.
- **Check next:** `db.json` `topStatements`: is there a statement with a large `elapsedUs` or `logicalReads` whose text matches what the step does?
- **Usual fixes:** see the database patterns below if a statement stands out; otherwise profile the endpoint's own code (caching, work done per request, payload size).

## Missing or unused index

- **Shows as:** a slow step plus a top statement with very high `logicalReads` per execution, and `db.json` `missingIndexes` listing the same table with a high `avgUserImpact` and many `userSeeks`. Without a usable index a filter has no sorted structure to use [ref:use-the-index-luke-anatomy].
- **Caveat:** the suggestion is an estimate for one query, resets on restart and table changes, and has no column order [ref:ms-missing-index-suggestions]. The figures also cover time since the server last restarted.
- **Usual fixes:** review the suggestion against the table's existing indexes, merge overlapping ones, put equality columns before range columns, then create it for the owner to approve [ref:ms-missing-index-suggestions]. Every index slows writes, so a write-heavy table needs more care. Re-run and compare against the baseline.

## N+1 queries

- **Shows as:** one cheap statement in `topStatements` with a huge `executions` count (and large total `elapsedUs`) relative to the number of requests of the step, often repeating with different parameters. Request time grows with the size of the list returned [ref:n-plus-one-planetscale]. Many round trips each add latency.
- **Usual fixes:** fetch the related rows with a join or one grouped query, or batch the lookups, instead of one query per row [ref:n-plus-one-planetscale]; for an ORM, load the relation eagerly.
- **Also consider:** the combined effect on database CPU, since a cheap statement run very often can outweigh a slow one run rarely.

## Lock waits and blocking

- **Shows as:** p95 and p99 of write steps (or reads that share rows with them) rising with load while database CPU and data IO stay moderate in `db.json` `resource[]`: requests are waiting, not working. Throughput stops growing and may fall; timeouts appear in `http_req_failed`. Long-lasting blocking cuts throughput and causes timeouts [ref:ms-sql-blocking].
- **Check next:** the report cannot name the head blocker. Ask the database owner to look at it during a run, or review the transaction scope of the write the step triggers.
- **Usual fixes:** shorten transactions, keep them from staying open across calls, tune the blocking statement, avoid wide locks, consider row-versioning isolation (the owner's decision) [ref:ms-sql-blocking]. Also check the test: many virtual users updating the same rows creates contention that real users would not.

## Database resource saturation

- **Shows as:** `resource[].cpu` or `dataIo` at or near the limit through the steady state (the report's `DB_HOT` flag, or a run stopped by the runner's database guard), and step latency rising together with it.
- **Reading:** sustained 100 percent is a likely bottleneck; any queueing deserves a look; a long average can hide short bursts [ref:use-method]. High CPU with high `logicalReads` points at scans or poor plans; high data IO with low cache reuse points at reads spilling to disk.
- **Usual fixes:** reduce the work (indexes, query shape, caching) before buying a bigger tier; if the tier itself is the limit, say what load it carried and let the owner decide.

## Breaking point: the system stops keeping up

- **Shows as:** in a stress run, `timeseries.json` buckets where `dropped` becomes non-zero while `p95` climbs and `rps` stops following the planned rate; `meta.json` may show an abort reason (a crossed threshold, or the database guard). Dropped iterations are a symptom of a slowing system [ref:k6-arrival-rate-vu-allocation].
- **Not the same as:** drops with unchanged `p95`, which usually means too few virtual users were prepared for the planned rate [ref:k6-arrival-rate-vu-allocation].
- **Usual fixes:** report the stage and what gave first (latency, errors or the database); find that resource's bottleneck above. Run stress only after smoke and average-load runs were sound [ref:k6-stress-testing].

## Latency that grows over a long run

- **Shows as:** `timeseries.json` `p95` drifting upward across a plateau while `vus` and `rps` are flat, or `db.json` showing steadily rising use. Needs a long run to show [ref:k6-soak-testing].
- **Usual fixes:** leaks (memory, connections, handles), growing tables or logs, cache that never evicts; confirm with the owner's server-side metrics.

## High errors with fast responses

- **Shows as:** `http_req_failed` high while p50 is low, or `checks` low with `http_req_failed` zero (wrong content under a 200) [ref:k6-checks]. A fast error is not a fast success [ref:sre-book-monitoring].
- **Check next:** the status mix, the first failing step, and whether authentication or test data (expired tokens, exhausted accounts) is the cause. Errors that appear only above a certain rate are a capacity or limit problem (connection pool, rate limit); errors from the first request are a script or data problem.

## Numbers that flatter the system

- **Shows as:** a closed-model run (fixed users) whose throughput falls as latency rises, with a clean-looking p99. The slowest periods are under-sampled [ref:k6-open-closed-models] and tail percentiles look better than users would see [ref:coordinated-omission-scylladb].
- **Usual fixes:** use a fixed arrival rate when the question is about a rate, and compare p99 only between runs that used the same model [ref:k6-open-closed-models].

## The load machine is the bottleneck

- **Shows as:** large `http_req_blocked` or `http_req_connecting`, low server-side `http_req_waiting`, and flat throughput that does not respond to more users. The load generator must stay well below saturation [ref:ms-load-testing-guidance].
- **Usual fixes:** reuse connections, run from a less loaded machine, and rerun; do not draw conclusions about the server from such a run.
