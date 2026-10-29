# Example feature: notes for whoever works on it next

Keep what is not obvious from the YAML and the script here. A future you (or an agent) starts from this file.

- **What it covers.** One sentence: which screen or API area, which roles.
- **Where the evidence came from.** The recorded session (file under `recordings/`), swagger operations, app code. Say which step came from where, and which steps have no recording and why.
- **Request bodies.** Which fields matter, which are random per iteration, where the real values come from (standing data).
- **Data it needs.** Standing rows the grid or list is measured against; how they are created and removed (adapter `setup`/`teardown`), and what happens when they expire.
- **Content checks.** What each check proves, and what a failing one usually means.
- **Known limits and surprises.** Rate limits, caches, features that behave differently on a cold start, things that were wrong in a probe and why.
- **Last smoke / baseline.** Date, run folder and verdict of the last green smoke and of the accepted baseline.
