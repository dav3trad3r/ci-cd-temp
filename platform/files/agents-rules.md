# Platform rules for AI coding agents

These rules apply to any coding agent working in this repository, and to people.

## How changes reach `main`

- Work on a branch and open a pull request. Never push to `main`.
- Every pull request needs an approval from a Pipeline approver, and only they can merge.
- Agents never approve, merge, or change who can. An agent's pull request waits for a person.

## Fix the code, never the check

When a check fails, fix the code. Don't skip or delete tests, silence the linter or type checker, raise `.platform/baseline.json`, add to `.gitleaksignore`, or edit `.platform/`, `.github/workflows/` or `.claude/`. The **Guardrails** check fails a pull request that does. If a change is truly intended, explain why. A person approves it with the `guardrail-change` label; never add that label yourself.

## Tests that come with every change

- **New API route:** test that no sign-in gets 401, and another user's item gets 404.
- **New table:** switch on row-level security in its migration.
- **Bug fix:** add a test that fails before the fix.

## Secrets

- Never read, print or commit `.env` files, keys or tokens.
- Nothing secret goes in a `VITE_`, `NEXT_PUBLIC_` or `REACT_APP_` variable: those reach every visitor's browser.

## Ask a person first

Stop and ask before deleting data, branches or cloud resources, running anything against production or a shared database, changing repository settings or permissions, or adding a dependency.
