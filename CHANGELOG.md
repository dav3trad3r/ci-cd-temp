# Changelog

Each release is a version tools can adopt. Merging a version change to `main` publishes it, and every tool's Dependabot proposes it as a pull request for a Pipeline approver.

- **Patch** (1.0.x): a fix. Nothing new should fail.
- **Minor** (1.x.0): a new or stricter check. Say what a tool may need to change.
- **Major** (x.0.0): a change tools must act on. Say how to move.

## 1.2.0

- **Rollback can no longer get stuck.** It has its own queue, so a running deploy can't hold it up and a newer merge can't cancel it. Staging leaves pinned traffic alone, promote stops if a rollback moved traffic under it, and writes wait while Azure finishes another change.
- **Each tool can have its own deploy identities.** Set `githubRepo` in its Azure parameters and the template creates a build identity that can push only that tool's image, and a release identity that can change only that tool's app and database job.
- **The SRE agent tests a fix in a locked-down container,** with no credentials, git or network for its checks, and pushes only the exact commit that passed. Without Docker it refuses to test a fix.

**To adopt it:** run `npm run tool -- update` on each tool and merge the pull request, because rollback's queue lives in the tool's own workflow file. For the identities, deploy the tool's Bicep with `githubRepo`, set the repository variable `AZURE_CLIENT_ID` to `buildClientId` and `AZURE_CLIENT_ID` in both environments to `releaseClientId`, then remove the organisation-wide `AZURE_CLIENT_ID`.

## 1.1.0

- Database changes now wait for approval. A tool's `migrate` command runs once per release as a one-off Azure job, from the image being released, before traffic moves. If it fails, traffic stays where it is.
- The starter app no longer migrates when it boots in production. Each migration runs in its own transaction, behind a lock.
- Onboarding and every staging deploy flag a tool that appears to change its database at startup.

- The baseline no longer lets a broken tool deploy: a crash or a result it can't count fails, a skip can't clear a serious problem, and a known install or build failure blocks deployment.
- Guardrails works on any tool's layout: check scripts by name and manifest, check settings in any folder, more ways to skip or silence a test, and Dependabot may only move an action's version.
- The starter API refuses due dates the database can't store, instead of returning a 500.

**To adopt it:** set `migrate` in `.platform/tool.json`, add `param migrateCommand` to the tool's Azure parameters, and deploy its Bicep once. Until the job exists, a tool with `migrate` set can't be promoted. A tool without `migrate` deploys as before.

## 1.0.1

- Generated Dockerfiles and Azure parameters now escape every value correctly, including backslashes and Bicep's `${`.

## 1.0.0

- Two ways onto the platform: `npm run tool -- new` and `npm run tool -- migrate`.
- Central checks, guardrails and deploy actions that every tool calls at a pinned version.
- Migration: a full-history secret scan before anything moves, and a baseline so old problems don't block new work.
- Deploy stage on Azure Container Apps: build once, staging revision, approval, promote, roll back.
- One tool register, so the SRE agent and the afternoon report cover every tool.
