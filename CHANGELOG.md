# Changelog

Each release is a version tools can adopt. Merging a version change to `main` publishes it, and every tool's Dependabot proposes it as a pull request for a Pipeline approver.

- **Patch** (1.0.x): a fix. Nothing new should fail.
- **Minor** (1.x.0): a new or stricter check. Say what a tool may need to change.
- **Major** (x.0.0): a change tools must act on. Say how to move.

## 1.0.0

- Two ways onto the platform: `npm run tool -- new` and `npm run tool -- migrate`.
- Central checks, guardrails and deploy actions that every tool calls at a pinned version.
- Migration: a full-history secret scan before anything moves, and a baseline so old problems don't block new work.
- Deploy stage on Azure Container Apps: build once, staging revision, approval, promote, roll back.
- One tool register, so the SRE agent and the afternoon report cover every tool.
