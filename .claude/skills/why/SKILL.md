---
name: why
description: "Use for 'why does X work this way', 'why we picked Y', design rationale, regressions, postmortems, or data-backed thresholds. Returns a cited read on decisions and tradeoffs. Use how for runtime behavior."
disable-model-invocation: true
---

<!-- From pstack (github.com/backnotprop/pstack at commit 0d2dc00, MIT, see LICENSE in this folder). Copied into ci-cd-temp on 2026-11-19. The changes are the "Local notes" section, and in teach and blast-radius the lines that named pstack's writing skill and its `arena` skill, which this repo does not include. -->

# Why

## Local notes (this repo)

- Read history with `git log` and `git blame`. Read pull requests and their discussion with `gh pr view` if the GitHub CLI is installed, otherwise with the GitHub MCP tools from the main session, because subagents don't use `mcp__` tools.

Answer from the record, not the code: read the commits and PR discussions that introduced the target and each later change, and other sources if the trail is thin. Cite what the authors wrote, mark your own inferences as inferences, and say what the record does not answer.
