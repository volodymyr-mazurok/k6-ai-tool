# References

Sources the consultant may cite as `[ref:<id>]`. Format and rules: `knowledge/README.md`. Each entry was fetched and read on the date shown;
the Claim is what that one source supports, in our own words.

## nielsen-response-times
- Title: Response Times: The 3 Important Limits (Nielsen Norman Group)
- URL: https://www.nngroup.com/articles/response-times-3-important-limits/
- Read: 2026-10-30
- Claim: People treat about 0.1 s as instant, notice a delay from about 1 s but keep their train of thought, and lose focus around 10 s; slow steps need feedback past 1 s and a progress indicator past 10 s, so judge each step against these three limits.

## sre-book-monitoring
- Title: Site Reliability Engineering, Chapter 6: Monitoring Distributed Systems (Google)
- URL: https://sre.google/sre-book/monitoring-distributed-systems/
- Read: 2026-10-30
- Claim: An average can look healthy while a small share of requests is very slow, so latency is best read as a distribution (buckets or percentiles); successful and failed requests are timed separately, and latency, traffic, errors and saturation are the four signals to watch.

## sre-workbook-slos
- Title: The Site Reliability Workbook, Chapter 2: Implementing SLOs (Google)
- URL: https://sre.google/workbook/implementing-slos/
- Read: 2026-10-30
- Claim: A latency objective is the share of requests faster than a threshold; one number hides the long tail, so set two (for example most requests under one limit and nearly all under a looser one), and round the limits instead of copying today's measurements.

## web-vitals
- Title: Web Vitals (web.dev)
- URL: https://web.dev/articles/vitals
- Read: 2026-10-30
- Claim: The Core Web Vitals count as good at LCP 2.5 s or less, INP 200 ms or less and CLS 0.1 or less, judged at the 75th percentile of page loads.

## littles-law
- Title: Little's law (Wikipedia)
- URL: https://en.wikipedia.org/wiki/Little%27s_law
- Read: 2026-10-30
- Claim: In a stable system the average number of requests in flight equals the arrival rate times the average time each spends in it (L = lambda x W), whatever the arrival or service pattern, which links users, throughput and response time.

## apdex
- Title: Apdex (Wikipedia)
- URL: https://en.wikipedia.org/wiki/Apdex
- Read: 2026-10-30
- Claim: Apdex turns response times into one 0-to-1 score for a chosen target time T: answers within T count as satisfied, between T and 4T as half-satisfied, and slower ones as frustrated; the score depends entirely on the T you pick.

## k6-open-closed-models
- Title: Open and closed models (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/open-vs-closed/
- Read: 2026-10-30
- Claim: In a closed model a virtual user starts its next iteration only after the last one ends, so a slow system receives less load; in an open model (the arrival-rate executors) iterations start on a schedule whatever the response times are, and k6 uses the term coordinated omission for the closed model's habit of easing off just when the system struggles.

## coordinated-omission-scylladb
- Title: On Coordinated Omission (ScyllaDB)
- URL: https://www.scylladb.com/2021/04/22/on-coordinated-omission/
- Read: 2026-10-30
- Claim: When a load tool waits for each answer before sending the next request, a stall removes exactly the requests that would have been slow, so tail percentiles look better than users would see; a fixed arrival rate, or timing from the intended send time, avoids it.

## k6-test-types
- Title: Load test types (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/testing-guides/test-types/
- Read: 2026-10-30
- Claim: A smoke test checks the script and a very light load, an average-load test shows everyday behaviour, stress goes above normal, soak runs long, spike adds sudden surges and breakpoint raises the load until the system fails; each answers a different question.

## k6-average-load-testing
- Title: Average-load testing (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/testing-guides/test-types/load-testing/
- Read: 2026-10-30
- Claim: Ramp up over roughly 5 to 15 percent of the test so the system can warm up or scale, then hold the plateau for at least five times the ramp-up, so the numbers describe sustained load and not the start.

## k6-stress-testing
- Title: Stress testing (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/testing-guides/test-types/stress-testing/
- Read: 2026-10-30
- Claim: A stress test looks like an average-load test with a higher target and a longer ramp-up, and is run only after smoke and average-load tests have shown the lower volumes are sound.

## k6-soak-testing
- Title: Soak testing (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/testing-guides/test-types/soak-testing/
- Read: 2026-10-30
- Claim: A soak test holds an ordinary load for hours or days to expose problems that need time, such as slowly growing response times, leaks and storage filling up; only the plateau is longer than in an average-load test.

## k6-thresholds
- Title: Thresholds (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/using-k6/thresholds/
- Read: 2026-10-30
- Claim: A threshold is a pass/fail rule on a metric, for example p(95)<200 on http_req_duration; a crossed threshold makes k6 exit non-zero, and abortOnFail stops the run at once, with delayAbortEval holding the check back while data is sparse.

## k6-checks
- Title: Checks (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/using-k6/checks/
- Read: 2026-10-30
- Claim: A check is a yes/no assertion on a response that is only counted as a rate; a failed check neither stops the test nor changes its exit code, so a threshold on the checks rate is needed to make it matter.

## k6-metrics-reference
- Title: Built-in metrics (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/using-k6/metrics/reference/
- Read: 2026-10-30
- Claim: http_req_duration covers sending, waiting and receiving but not connection set-up, http_req_waiting is time to first byte, http_req_failed is a rate, and dropped_iterations counts iterations that never started because no user was free or time ran out.

## k6-arrival-rate-vu-allocation
- Title: Arrival-rate VU allocation (Grafana k6 documentation)
- URL: https://grafana.com/docs/k6/latest/using-k6/scenarios/concepts/arrival-rate-vu-allocation/
- Read: 2026-10-30
- Claim: An arrival-rate run needs enough virtual users ready for the longest iterations; when there are too few, k6 records dropped iterations, and frequent drops can also mean the system under test has slowed down.

## ms-load-testing-guidance
- Title: Chapter 17: Load-Testing Web Applications (Microsoft patterns and practices)
- URL: https://learn.microsoft.com/en-us/previous-versions/msp-n-p/bb924372(v=pandp.10)
- Read: 2026-10-30
- Claim: Start with few users and raise the load in steps, letting the system settle between steps; record processor, memory, disk and network next to response time and throughput, and keep the load generator itself well below saturation so it does not skew the result.

## use-method
- Title: The USE Method (Brendan Gregg)
- URL: https://www.brendangregg.com/usemethod.html
- Read: 2026-10-30
- Claim: For every resource (CPU, disk, network) check utilization, saturation and errors; sustained 100 percent use is a likely bottleneck, any queueing is worth a look, and a long-interval average can hide short bursts of full use.

## ms-sql-blocking
- Title: Understand and resolve SQL Server blocking problems (Microsoft Learn)
- URL: https://learn.microsoft.com/en-us/troubleshoot/sql/database-engine/performance/understand-resolve-blocking
- Read: 2026-10-30
- Claim: Some blocking is normal, but long-lasting blocking cuts throughput and causes timeouts; find the head blocker (the session at the front of the chain) and its statement, and fix the cause, usually long or open transactions, wide locks, or a query that needs tuning.

## ms-missing-index-suggestions
- Title: Tune nonclustered indexes with missing index suggestions (Microsoft Learn)
- URL: https://learn.microsoft.com/en-us/sql/relational-databases/indexes/tune-nonclustered-missing-index-suggestions
- Read: 2026-10-30
- Claim: SQL Server's missing-index suggestions come from single-query estimates, are cleared on restart and on table changes, and give no column order, so treat them as leads to review against existing indexes (each index slows writes), not as statements to run as given.

## use-the-index-luke-anatomy
- Title: Anatomy of an SQL Index (Use The Index, Luke)
- URL: https://use-the-index-luke.com/sql/anatomy
- Read: 2026-10-30
- Claim: An index is a separate, sorted copy of the chosen columns kept in order by a search tree, which is why a lookup on an indexed column is quick and why a filter on an unindexed column has no such shortcut.

## n-plus-one-planetscale
- Title: What is the N+1 query problem and how to solve it? (PlanetScale)
- URL: https://planetscale.com/blog/what-is-n-1-query-problem-and-how-to-solve-it
- Read: 2026-10-30
- Claim: N+1 means one query for a list and one more per row for related data, so the number of database round trips grows with the list; a join or a grouped query returns the same data in one trip, and many near-identical statements with a high row count are the tell-tale.
