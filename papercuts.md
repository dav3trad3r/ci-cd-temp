# Papercuts

Friction that agents and people hit while working in this repository: a flag that's rejected, a command that exits 0 on an error, a search that comes back empty when it should match. Each report names the skill that was being followed, then says what was tried, what was expected, what happened and what would fix it, so reports can be grouped by skill.

The `log-papercut` skill (`.claude/skills/log-papercut/SKILL.md`) adds reports to the end of this file, or opens a GitHub issue when the repository has a `papercut` label. The platform team reads them and fixes the ones that repeat. The pull request that fixes one deletes its entry.

## 2026-11-26: The Managed Agents docs don't say where a memory store is mounted

- **Skill:** `incident-runbook`, while rewriting it.
- **Tried:** writing step 2 of `sre/agent/runbook/SKILL.md` as a concrete command that searches the team memory and the notebook, which `scripts/sre/run.ts` attaches to the session as `memory_store` resources.
- **Expected:** the Managed Agents docs to give the folder each memory store is mounted at, or the tool that reads it.
- **Happened:** the overview, sessions, tools, environments and reference pages don't mention a mount path or a memory tool, so the step uses `<team memory>` and `<notebook>` placeholders.
- **Fix:** run `npm run sre:demo` once, note where the agent finds the two stores, and put that path in each store's `instructions` in `scripts/sre/run.ts` and in step 2 of the runbook.
- **Seen by:** a coding agent, while making the runbook pass the skill linter.
