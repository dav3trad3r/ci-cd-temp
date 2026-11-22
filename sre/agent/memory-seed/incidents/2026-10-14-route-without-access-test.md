# 2026-10-14: a new route shipped without its access test (example incident for the demo)

**Summary:** a tool added an export route that returned every user's records, not only the caller's. A staff member noticed within two hours, and the route was fixed the same day.

**Cause:** the route was written with an AI coding assistant and reviewed quickly. It had no access test, so nothing checked that one user couldn't read another's data. Lint, types and the existing tests all passed.

**Fix:** the route now filters by the signed-in user, and an access test covers it.

**Follow-ups:** AGENTS.md now asks for an access test with every new API route. Reviewers check that a new route comes with one.

**Lesson for the next incident:** when a new route misbehaves, check first whether it has any test at all. Missing tests on new routes are the most common way a bug reaches production here.
