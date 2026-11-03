# Analysing a run

Explain one run folder in plain words for the dev team, compare it with cited reference points, and rank what to try.

## Sources: the run folder, and the knowledge base for references

- **Numbers** come only from the run folder: `summary.json`, `timeseries.json`, `db.json` (when present) and `meta.json`
  (profile, baseline slot, flag limits in `rules.flags`, abort limits). `report.md` and `k6.log` help you read; you cite
  the JSON files. A number that is not in these files does not go into findings.
- **Reference points** come only from `knowledge/references.md`, cited `[ref:<id>]`. `knowledge/metrics.md` says how to
  read each metric and `knowledge/bottlenecks.md` how each bottleneck pattern looks in a run folder. A claim with no
  reference is labelled **Assumption:** or "in our experience".

## What to explain

1. **Verdict** and its reason, in one sentence each (`report.md` top). Check **Duration** against the planned profile:
   a run that stopped early or never reached its load says little.
2. **Flags** raised, with the step, the value, the baseline and the limit that fired (`meta.json#rules.flags`).
3. **Slowest steps** by p95, with their request counts, failure share and checks.
4. **Proves vs suggests.** Say which, for each statement:
   - one sample, or a step with few requests (a p95 needs about a hundred): proves nothing about that step;
   - no baseline: numbers only, nothing to call worse;
   - shared database or shared env: other activity is in the numbers;
   - public demo site: other users and rate limits are in the numbers;
   - local mock: proves the framework, not an app;
   - closed model: the slowest moments are under-sampled [ref:coordinated-omission-scylladb].

## findings.md: the shape

Write `<runDir>/findings.md` in exactly two parts, these headings, this order:

```markdown
## What the run shows

Run: 2026-10-29 14:48 UTC

- Evidence only: verdict, flags, slowest steps, what the run cannot tell. Every number cited. No references, no advice.

## Compared with reference points, and suggestions

- Reference points: one line each, a run number (cited) beside a reference point (`[ref:id]`).
- Assumptions, each labelled **Assumption:**.

1. **Lead: <what to look at>.** Evidence: <cited numbers>. Confidence: high | medium | low. Expected gain: large |
   medium | small. Effort: small | medium | large. Confirm by: <the run or query that would prove it>.
```

Rank the suggestions by expected gain, then by lower effort. Each one is a lead with evidence, never a cause stated as
fact. When the perf-report skill is installed, it writes the first part and you write the second; alone, write both and
keep the first part evidence-only.

## Citing numbers: the rules `--verify-findings` enforces

A number is written `<number><unit>[[<format>|<file>#<path>]]`, no space before `[[`
(README section 7 has the formats and the expression syntax):

```text
p95 was 704 ms[[int|summary.json#metrics["http_req_duration{name:items.slow_search}"].values["p(95)"]]]
against a baseline of 403 ms[[int|meta.json#baseline.steps["items.slow_search"].p95]]
```

- **Write exactly what the format prints.** `dec2` of 0.704 prints `0.7`, not `0.70`. When the check says
  `"0.70" … is "0.7"`, copy its text.
- **The unit is not checked; convert in the expression.** Seconds from a millisecond source: `0.7 s[[dec2|… / 1000]]`.
  `pct` takes a fraction (0.012 → `1.2%`), `pctPoints` a value already in percent.
- **Only number tokens are checked**, so a digit-led word fails as an uncited number: put `5xx`, `10-minute`, `2nd` in
  backticks, or write it in words.
- **A reference point's own numbers are not in the run folder.** Write them in words ("about one second
  [ref:nielsen-response-times]") or in backticks.
- **No bold between the number and `[[`.** `**704**[[…]]` fails; bold the whole thing (`**704 ms[[…]]**`) or the label.
- **Never glue a number to a word** (`p95=704ms`): the check skips it, so an uncited number slips through. Write `p95 704 ms[[…]]`.
- **A `Run:` line** takes the run's date and time only; anything else on it (`4 users`) is an uncited number.
- **Cite the run's own limits** from `meta.json` (`rules.flags.p95AddMs`, `profile.users`), not from memory.

## Done

```bash
npm run perf -- report <runDir> --verify-findings
```

It re-renders the report and must print `findings: N numbers traced, M references` and exit 0. Fix every line it names
and run it again. Not done until it passes; then tell the person the verdict in one sentence and the top suggestion.
