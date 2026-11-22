---
name: incident-runbook
description: Steps for investigating an alert on a platform tool, finding the cause, and choosing between a revert and a code fix. Use at the start of every incident.
---

# Incident runbook

1. **Read the alert** (get_alert). Note the tool, the metric, the threshold and when it fired.
2. **Check team memory.** Is this known noise (`known-noise.md`)? Has it happened before (`incidents/`)? What does this tool share with others (`service-map.md`)? Check your notebook too.
3. **Measure** (get_metrics) for the hour before the alert. When did errors start? Did traffic change, or only errors?
4. **Read the errors** (get_logs) for that window. Group them by route and message, and set aside known noise.
5. **Find what changed** (get_recent_deploys). A deploy that landed within 15 minutes before the errors started is the first suspect. Read it with get_diff.
6. **Connect the evidence.** The error message, the failing route and the changed code should point at the same place. If they don't, say so and keep looking.
7. **Post a diagnosis** (post_update): what broke, since when, who is affected, the cause and your confidence.
8. **Fix.**
   - One small deploy with nothing else wanted in it: revert it.
   - A deploy that also carries wanted work: the smallest code fix, plus a dated regression test in `tests/regressions/` that fails before the fix.
   - Run the tests before proposing.
9. **Record.** Write the post-mortem (record_postmortem) and add a note to your notebook.

## Good evidence

- **Timing:** errors begin within minutes after a deploy, and not before it.
- **Location:** the error names a route, table, file or function the deploy changed.
- **Scope:** only the affected route fails, and the rest of the tool is healthy.

## What not to do

- Don't propose a fix below 70% confidence. Post what you know and what would settle it.
- Don't touch workflows, agent settings, budgets, the AI baseline or check scripts, and don't skip tests.
- Don't restart, scale or roll back anything yourself. Propose; a person decides.
