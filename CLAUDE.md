@AGENTS.md

## Claude Code

`.claude/settings.json` enforces part of these rules. Claude can't read `.env` files, force-push, push to `main`, run `rm -rf` or delete cloud resources. It asks before any other push, any package install, and any edit to the workflows, agent settings, budgets, AI baseline or check configuration.
