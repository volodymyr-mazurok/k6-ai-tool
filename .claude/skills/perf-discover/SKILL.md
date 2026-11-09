---
name: perf-discover
description: Use when a feature, page, API or flow is to be performance tested and its journey.yaml does not exist or is not reviewed yet; when someone hands over a spec page, a spec file, a portal link, a swagger or OpenAPI url, an endpoint list, a curl command, a Postman export, a HAR, another repo's automated test, or just says "this page is slow"; or when a new project folder is needed for an app.
---

# perf-discover

Turns whatever the person has in hand into a **reviewed journey**: a feature brief and evidence log in `context.md`,
`journey.yaml`, `workload.yaml`, `recordings/`, `fixtures/` and, for a new app, a project folder. It does not write the
k6 script (perf-script does) and it runs no load.

**Core rule: every step comes from evidence, never from prose or a guess.** Evidence is the env's swagger, a scrubbed
recording, or a probe answer. A spec, a ticket or a sentence from the person says what to look for; it never puts a
route into `journey.yaml`. When the two disagree, the swagger or the recording wins and the disagreement becomes an
open question.

**Violating the letter of these rules is violating the spirit.** The runner's rules in `CLAUDE.md` apply unchanged.

## The flow

1. **Find the project.** `projects/<name>/` exists → read `projects/<name>/README.md` first (secret locations, forbidden
   paths), then everything under the feature's folder; continue from the first missing piece below. No project → step 3
   comes before any probe or recording.
2. **Intake.** Name the inputs you were given and use each with the tool in `intake.md` (and its fallback when the tool is
   missing). Write the **feature brief** at the top of the feature's `context.md` with all its fields, unknowns included.
3. **New project** (only when none exists): propose it from `projects/_template/` as `intake.md` says, caps and defaults
   from the table in `.claude/skills/perf-consult/sizing.md`. **Gate A**: the owner approves the project settings.
   No probe and no recording against the env before that yes (fetching a swagger you were handed is fine). A new env
   on an existing project goes through the same gate.
4. **Fill the gaps** with the cheapest honest step, one at a time: read what was given → fetch the swagger → one
   `npm run perf -- probe …` → one question to the person. One question per message. Every answer goes into the evidence
   log; every unanswered gap stays an open question.
5. **Write the journey and workload** by `journey-rules.md`: API calls only, named steps, ids from earlier responses,
   every step mapped to its swagger route with its evidence, writes declared with their cleanup or the feature reported
   not testable yet, data volume noted.
6. **Check:** `npm run perf -- check <project> <feature> --env <env>` until it prints `0 problems`. Fix `journey.yaml`
   from evidence; never add a step or an evidence line to silence it.
7. **Gate B**: show the owner the review block in `journey-rules.md` and stop. Done when the check says `0 problems`
   **and** the owner said yes. Hand over to perf-script.

## Red flags: stop

- A route in `journey.yaml` that you read in a spec, a ticket, a chat message or a guess, and not in the swagger or a recording.
- A spec route quietly renamed to the swagger's nearest match. Log the disagreement and ask; do not decide for the owner.
- An `evidence:` that says "spec", "assumed", "typical", "CHANGE" or names a source you did not open.
- A probe or recording before Gate A on a new project or a new env, or a POST probed that is not in `read_only_post_routes`.
- Two questions in one message, or a gap filled with a plausible value instead of an open question.
- A writing step with no one to clean up its rows kept in the journey, or `cleanup: app` written without the app's owner saying it prunes them.
- Typing a password, asking for one in chat, or creating an account. The person logs in in the browser; logins go into `.env` by their own hand.
- Gate B skipped because `perf check` printed `0 problems`. The check proves routes exist, not that the flow is right.

## Rationalizations

| Thought | Reality |
| --- | --- |
| "The spec says `/find`, the swagger has `/search`; obviously the same." | Maybe. Log it as an open question, build nothing on `/find`, ask the owner at the gate. |
| "A search endpoint obviously only reads; add it to `read_only_post_routes`." | A name is a hint. Say why you think it reads, and the owner confirms before it goes in. |
| "The swagger has no request bodies; I'll write a typical one." | A body comes from a recording, an example in the swagger or a probe. Otherwise it is an open question. |
| "Asking is slow; I'll guess the flow order and fix it later." | Write the order the evidence shows; an order no evidence shows is an open question at the gate. |
| "`perf check` passed, so the journey is reviewed." | Reviewed means the owner said yes at Gate B. |
| "The defaults are small; the realistic size is bigger." | perf-consult sizes; anything above the defaults is the owner's call. |
