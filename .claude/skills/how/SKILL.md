---
name: how
description: "Use for \"how does X work\", code walkthroughs before changing something, and placement / ownership / layering questions (\"where should this live\", \"which package owns this\", \"is this the right layer\"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation."
disable-model-invocation: true
---

<!-- From pstack (github.com/backnotprop/pstack at commit 0d2dc00, MIT, see LICENSE in this folder). Copied into ci-cd-temp on 2026-11-19. The changes are the "Local notes" section, and in teach and blast-radius the lines that named pstack's writing skill and its `arena` skill, which this repo does not include. -->

# How

## Local notes (this repo)

- In Claude Code, spawn the explorer with `Agent` and `subagent_type: "Explore"`. Claude Code has no read-only flag, so the brief says not to edit files, and you check `git status` afterwards.
- Tell the explorer to read `README.md` and `AGENTS.md` first. They map the checks, the folders and the rules every change follows.

Explore the codebase to answer "how does X work?" questions.

If the scope is ambiguous, state your interpretation and explore. The user can redirect.

## 1. Explain

Spawn one read-only general-purpose subagent that explores and explains in one pass: `Task` with `subagent_type: generalPurpose` and `readonly: true` in Cursor, `Agent` in Claude Code (`subagent_type: general-purpose`), `task` in OpenCode (`subagent_type: general`), `spawn_agent` in Codex. If your harness has no subagent tool, as in Pi without an extension, do the exploring and writing yourself. Give it the user's question and this brief:

> You are writing an architectural explanation for a senior engineer. Explore the codebase and write an explanation that a senior engineer unfamiliar with this area could read and walk away with a solid mental model. They should understand the architecture well enough to start working in it confidently. You have read-only access to the codebase.

## 2. Present

Present the subagent's output. Light edits for clarity or context from the conversation are fine. Do not substantially rewrite it.
