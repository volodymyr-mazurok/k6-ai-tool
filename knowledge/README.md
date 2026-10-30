# Knowledge base

Cited background that the consultant skill reads and the findings checker verifies against. The files are shared and
project-agnostic: they name no app, only well-known public sources.

| File | What it holds |
| --- | --- |
| `references.md` | The sources. One entry per source, each read on the date it gives. |
| `metrics.md` | How to read each number the report shows, with the sources behind each reading. |
| `bottlenecks.md` | Bottleneck patterns: how each one looks in a run folder, and the usual fixes. |

## `references.md` format

One entry per source, in this exact shape:

```text
## <id>
- Title: <the page's title>
- URL: https://...
- Read: YYYY-MM-DD
- Claim: <the one thing this source supports, in our own words>
```

- `<id>` is lower-case words (letters and digits) joined by `-`, and is unique in the file.
- `- URL:` starts `https://`. Cite a URL only after fetching it.
- `- Read:` is the day the page was fetched. It is a real date and not in the future.
- `- Claim:` is one claim, written in our words, never a pasted passage (a few quoted words at most). If a source supports a second claim, say it in the file that cites it, not by stretching this line.
- Nothing else goes under the heading: any other line is an error. Text before the first `##` is introduction.

`runner/knowledge.ts` parses the file (`loadReferences()`, `referenceIds()`) and names the id and the line at fault when an
entry is malformed. `tests/knowledge.test.ts` holds the rules.

## Citing

Other files and findings cite an entry as `[ref:<id>]`, for example `[ref:k6-thresholds]`. An id that `references.md` does
not define is a broken citation, and the test fails on it in `metrics.md` and `bottlenecks.md`. A statement is cited only
when the source supports it; a rule of thumb of ours stays uncited and is worded as ours.

## Adding or refreshing a source

Fetch the page, write its entry (a new id, or update `Read` after re-reading an old one), and run
`npx tsx --test tests/knowledge.test.ts`. Do not keep an entry whose page you could not open.
