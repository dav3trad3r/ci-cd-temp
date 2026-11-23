# Changelog

Each release is a version tools can adopt. Merging a version change to `main` publishes it, and every tool's Dependabot proposes it as a pull request for a Pipeline approver.

- **Patch** (1.0.x): a fix. Nothing new should fail.
- **Minor** (1.x.0): a new or stricter check. Say what a tool may need to change.
- **Major** (x.0.0): a change tools must act on. Say how to move.

## 1.1.0

- Database changes now wait for approval. A tool's `migrate` command runs once per release as a one-off Azure job, from the image being released, before traffic moves. If it fails, traffic stays where it is.
- The starter app no longer migrates when it boots in production. Each migration runs in its own transaction, behind a lock.
- Onboarding and every staging deploy flag a tool that appears to change its database at startup.

**To adopt it:** set `migrate` in `.platform/tool.json`, add `param migrateCommand` to the tool's Azure parameters, and deploy its Bicep once. Until the job exists, a tool with `migrate` set can't be promoted. A tool without `migrate` deploys as before.

## 1.0.1

- Generated Dockerfiles and Azure parameters now escape every value correctly, including backslashes and Bicep's `${`.

## 1.0.0

- Two ways onto the platform: `npm run tool -- new` and `npm run tool -- migrate`.
- Central checks, guardrails and deploy actions that every tool calls at a pinned version.
- Migration: a full-history secret scan before anything moves, and a baseline so old problems don't block new work.
- Deploy stage on Azure Container Apps: build once, staging revision, approval, promote, roll back.
- One tool register, so the SRE agent and the afternoon report cover every tool.
