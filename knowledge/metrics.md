# Reading the metrics

How to read each number `report.html` and `report.md` show. Where a source supports a reading it is cited with a `ref:` tag in square brackets
(see `references.md`); a reading without a citation is this framework's own convention. Every figure comes from
`summary.json`, `timeseries.json` or `db.json` in the run folder.

## Response time: p50, p95, p99

- The value is k6's `http_req_duration`: sending, waiting and receiving, without connection set-up [ref:k6-metrics-reference]. In `summary.json` it is `metrics.http_req_duration.values` (`med`, `p(95)` and so on); the report shows one row per step.
- **p50** is the typical request, **p95** the answer that 19 requests in 20 beat, **p99** the answer 99 in 100 beat. Read p95 and p99, not the average: a healthy mean can hide a slow tail [ref:sre-book-monitoring], and a single figure hides it too, so look at two percentiles together [ref:sre-workbook-slos].
- A percentile needs samples: p95 means little under 100 requests, p99 under 1,000. A smoke run has one request per step, so all three are that one sample.
- Judge a step against the perception limits when a person waits on it: about 0.1 s feels instant, about 1 s is noticed, about 10 s loses attention [ref:nielsen-response-times].
- A threshold such as `p(95)<200` is a pass/fail rule on one of these numbers, and a crossed one makes k6 exit non-zero [ref:k6-thresholds].
- Percentiles that stay flat while a fixed-rate test drops iterations can be flattering; see "Dropped iterations" and "Open and closed load" below.
- Core Web Vitals (LCP, INP, CLS) are browser measures judged at the 75th percentile of page loads [ref:web-vitals]. A k6 run sends no browser, so none of these appears in the report; do not infer them from p95.

## Where the time goes: waiting, blocked, connecting

- `http_req_waiting` is time to first byte: the server working before it answers. A slow query shows here [ref:k6-metrics-reference]. These timings (waiting, blocked, connecting) are recorded run-wide only; the run folder has no per-step split, so they hint at where time goes overall and say nothing about one step.
- `http_req_blocked` (waiting for a free connection) and `http_req_connecting` (opening the connection) are connection costs [ref:k6-metrics-reference]. In our experience high run-wide values point at the load machine or the network, not the server. Keep the load generator well below saturation so it does not skew the result [ref:ms-load-testing-guidance].

## Failures: http_req_failed and checks

- `http_req_failed` is the share of requests that failed (a network error or a status outside 200-399). It is a rate, and the report shows it per step [ref:k6-metrics-reference]. Failing requests are timed separately from successful ones, because a fast error flatters latency [ref:sre-book-monitoring].
- `checks` is the share of content checks that held. A failed check does not stop the run or change the exit code [ref:k6-checks], so a 200 with an error body passes `http_req_failed` and fails `checks`. Read both columns together: errors high and checks fine means the app answered badly in a way the status shows; checks low and errors zero means correct status, wrong content.
- Errors count only when the answer is wrong, not slow: the SRE book includes "too slow for the target" as a policy error [ref:sre-book-monitoring], which here is what a threshold on p95 expresses.

## Throughput: req/s and the business rate

- `req/s` is requests per second, the "traffic" signal [ref:sre-book-monitoring]; `http_reqs` is the total [ref:k6-metrics-reference]. The report shows it per step over the whole run (ramps included) and as a peak.
- Throughput, users and response time are linked: in a steady state, requests in flight = arrival rate x average time in the system [ref:littles-law]. With a fixed number of users, slower answers mean fewer requests per second; that is the signature of a closed model.
- Compare throughput with the planned load before reading latency. A run that did not reach the planned rate (see Duration in the report) says little.

## Iterations and dropped iterations

- `iterations` counts full passes through the script's main function; one iteration is several requests, and `iteration_duration` includes think time [ref:k6-metrics-reference].
- `dropped_iterations` counts iterations that never started because no virtual user was free (arrival-rate runs) or time ran out [ref:k6-metrics-reference]. Zero in a healthy run. Frequent drops can mean the system under test has slowed [ref:k6-arrival-rate-vu-allocation]: when drops start and response times rise at the same stage, that stage is the breaking point. Drops with fast answers instead suggest too few virtual users were prepared.

## Open and closed load

- With virtual users that wait for each answer (closed model), a slow system receives less load, and the slowest moments are under-sampled [ref:k6-open-closed-models]. This is coordinated omission: tail percentiles then look better than real users would see [ref:coordinated-omission-scylladb].
- With a fixed arrival rate (open model) the load does not ease off [ref:k6-open-closed-models]. When a report compares runs, check that both used the same model and rate.
- `vus` shows whether the ramp did what was planned.

## Ramp, plateau and run length

- Most figures are taken over the steady state, because a ramp is not a fair measurement. Ramp up over roughly 5-15 percent of the run and hold the plateau for at least five times the ramp [ref:k6-average-load-testing].
- Raise load in steps and let the system settle between them [ref:ms-load-testing-guidance]. A stress run is only worth reading after smoke and average-load runs were sound [ref:k6-stress-testing]. Slow degradation over hours is a soak finding, not visible in a short run [ref:k6-soak-testing].
- Each test type answers a different question [ref:k6-test-types]; name the type before judging a number.

## Database: CPU and data IO

DB CPU and DB IO are the two figures the report quotes from the database.
- `db.json` holds a sample every 15 seconds (`resource[].cpu`, `resource[].dataIo`, `logWrite`, percent of the tier's limit). The report quotes the peak and the average over the steady state; the runner's abort rule and the `DB_HOT` flag use these.
- Read database CPU and IO as utilization with a saturation question beside it [ref:use-method]: sustained 100 percent is a likely bottleneck, and a long-interval average can hide short bursts of full use. A busy database with a still-fast step means headroom is shrinking, not that anything is broken yet.
- The database is shared: other activity in the window is included. Statements and missing indexes in `db.json` (`topStatements`, `missingIndexes`) cover the plan cache or Query Store, not only this run.

## Targets and scores

- A latency objective is "share of requests under a limit" [ref:sre-workbook-slos]. Round limits down to manageable numbers (the workbook's example is steps of 50 ms) instead of copying today's measurement, and do not set a target from one run.
- An Apdex-style score collapses times into 0-1 against a target T [ref:apdex]. The report does not print one; if you compute one, state T, because the score moves with it.
