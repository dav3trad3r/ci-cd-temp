---
name: incident-runbook
description: Steps for investigating an alert on a platform tool, finding the cause, and choosing between a revert and a code fix. Use at the start of every incident.
---

# Incident runbook

Work through the steps in order. Each one names the call to make and how to tell it worked.

## Steps

1. **Read the alert.** Call `get_alert()`.

   Check: you can name the tool, the metric, the threshold and when the alert fired.

2. **Check team memory.** Search the team memory and your notebook, both attached to this session, for the tool's name: `grep -ril "<tool>" <team memory> <notebook>`. Read `known-noise.md`, `service-map.md` and any file in `incidents/` that matches.

   Check: you can say whether this alert is known noise, a repeat of a past incident or new, and what the tool shares with others.

3. **Measure the hour before.** Call `get_metrics({"minutes_before": 60})`.

   Check: you know when errors started, and whether traffic changed or only errors did.

4. **Read the errors.** Call `get_logs({"minutes_before": 60, "level": "error"})`. Group the lines by route and message, and set aside known noise.

   Check: you have the route and the message that most of the errors share.

5. **Find what changed.** Call `get_recent_deploys()`. A deploy that landed within 15 minutes before the errors started is the first suspect: read it with `get_diff({"commit": "<sha>"})`.

   Check: you have a suspect commit and its diff, or you know that no deploy landed in that window.

6. **Connect the evidence.** Find the code the error names in the extracted repository: `grep -rn "<route, table or column from the error>" /workspace/repo/src`.

   Check: the error message, the failing route and the changed code point at the same place. If they don't, say so and keep looking.

7. **Post a diagnosis.** Call `post_update({"text": "<update>"})`: what broke, since when, who is affected, the cause and your confidence.

   Check: the update is under 120 words and gives your confidence as a percentage.

8. **Test the fix.** Make the change in `/workspace/repo`, then run `npm ci && npx vitest run`. For a code fix, add a dated regression test in `tests/regressions/` and run it on the old code first.

   Check: every test passes with the change, and a new regression test failed before it.

9. **Propose the fix.** Revert one small deploy that carries nothing else wanted with `propose_fix({"kind": "revert", "commit": "<sha>", ...})`. When the deploy also carries wanted work, send the smallest code fix and its regression test with `propose_fix({"kind": "code_fix", "files": [...], ...})`.

   Check: `propose_fix` returns a draft pull request, not a list of reasons.

10. **Record.** Call `record_postmortem({"markdown": "<post-mortem>"})` in the format of `postmortem-conventions.md`, then add a note of one or two lines to your notebook.

    Check: the post-mortem is saved and your notebook has a note for this incident.

## Good evidence

- **Timing:** errors begin within minutes after a deploy, and not before it.
- **Location:** the error names a route, table, file or function the deploy changed.
- **Scope:** only the affected route fails, and the rest of the tool is healthy.

## What not to do

- Don't propose a fix below 70% confidence. Post what you know and what would settle it.
- Don't touch workflows, agent settings, budgets, the AI baseline or check scripts, and don't skip tests.
- Don't restart, scale or roll back anything yourself. Propose; a person decides.

## Error recovery

- **`get_logs` returns no lines.** Widen the window with `{"minutes_before": 240}` and drop the `level` filter. If it's still empty, say in your update that the logs are missing: that is a finding too.
- **`get_logs` rejects the `contains` text.** It takes only letters, digits, spaces and `. _ / : -`. Remove quotes and other punctuation from the text.
- **No deploy landed before the errors started.** Look for an older deploy that changed the failing route, and check `service-map.md` for a shared database or upstream tool. If nothing matches, post that the cause isn't a deploy.
- **`npm ci` fails in the sandbox.** The sandbox reaches only package registries. Say in your update that the tests couldn't run, and propose anyway if you're at 70% or more: the workflow runs the tests before it opens anything.
- **`propose_fix` returns reasons instead of a pull request.** Correct what each reason names (a failing test, a lint error, a Guardrails rule) and call `propose_fix` once more. If it refuses a second time, stop and post the reasons for a person.
- **Your confidence stays under 70%.** Don't propose a fix. Post what you know, what you ruled out and the one piece of evidence that would settle it.
