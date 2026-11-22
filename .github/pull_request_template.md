## What and why

<!-- One or two sentences: what changes, and the problem it solves. -->

**Tool and owner:** <!-- which tool this changes, and its owner (the domain leader) -->

**Linked issue:** Closes # <!-- the request or incident this answers, so the record links up -->

## Checklist

- [ ] CI is green (format, lint, types, tests, build, front-end checks, smoke test)
- [ ] New API routes have an access test (no sign-in → 401; another user's data → 404)
- [ ] New tables have row-level security switched on
- [ ] A bug fix includes a regression test in `tests/regressions/` that failed before the fix
- [ ] No secrets in code or in `VITE_` variables; new settings are added to `.env.example`
- [ ] If an API response changed shape on purpose, the snapshot is updated and the change explained here
- [ ] If a prompt or model changed, `npm run eval` still meets the baseline
- [ ] No check weakened to make CI pass. If one changed on purpose, the reason is here and a person has added the `guardrail-change` label
- [ ] Ready for a Pipeline approver to review: they approve, and only they can merge

## Data and risk

<!-- What data does this touch (personal, financial, none)? Anything reviewers should look at closely? -->
