# Regression tests

Every fixed bug gets a test here, so it can never quietly come back.

- **Name the file after the date and the bug:** `YYYY-MM-DD-short-description.test.ts`.
- **Start the test with what went wrong, who saw it and how it was fixed.** The comment matters as much as the assertion: it tells the next person why the test exists.
- **Write the test first, watch it fail on the old code, then fix the bug.** A regression test that never failed proves nothing.
- **Never delete one to make CI pass.** If behaviour is meant to change, update the test in the same pull request and say why.

This folder also holds the **API contract snapshots** (`api-contract.test.ts`). They fail if a response's shape changes, such as a renamed field or a new error format, so an accidental change to what other tools rely on is caught in review. If the change is intended, run `npx vitest run -u` and commit the updated snapshot with the change.

Two more regression checks run outside this folder:

- **Bundle-size budget:** `scripts/check-frontend.mjs` fails the build if the browser JavaScript grows past `budgets.json`.
- **AI evaluation baseline:** `npm run eval` runs the known-answer cases in `evals/` nightly and fails if accuracy drops below `evals/baseline.json`.
