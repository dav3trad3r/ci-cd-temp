---
name: log-papercut
description: File a short report when a tool, command or check gets in your way, such as a flag that's rejected, a command that exits 0 on an error, or a search that returns nothing when it should match. Use it once you've worked around the problem, then carry on with your task.
---

# Log a papercut

A papercut is friction that slowed you down without stopping you. A report takes a minute. The platform team reads them and fixes the ones that keep coming up, so the next agent or person doesn't hit the same thing.

File one when:

- a tool rejects a flag or option that its help or docs list
- a command exits 0 but printed an error, or exits non-zero when it worked
- a search, filter or query returns nothing when something should match
- the docs, a skill or `AGENTS.md` told you to do something that doesn't work

It isn't a papercut when the code you're changing has a bug (fix it, with a regression test) or a check fails (fix the code, never the check).

Never put a secret, key, token, password or personal detail in a report. Write `<redacted>` in its place.

The commands are for a POSIX shell (bash, zsh, or Git Bash on Windows), run from the repository root.

## Steps

1. **Check it isn't already filed.** Search for the command or the error text:

   ```bash
   grep -n -i "<command or error text>" papercuts.md
   gh issue list --label papercut --state open --search "<command or error text>"
   ```

   Check: neither search shows the same problem. If one does, add a line to that report (`- **Seen again:** <date>, <what you were doing>`) or comment on the issue with `gh issue comment <number> --body "<one line>"`, and stop here.

2. **Write the report.** Copy this template into a scratch file outside the repository, such as `/tmp/papercut.md`, and fill in every field:

   ```markdown
   ## <YYYY-MM-DD>: <what went wrong, in one line>

   - **Tried:** the exact command or call, with its flags and the tool's version.
   - **Expected:** what should have happened, and why you expected it (help text, docs, an earlier run).
   - **Happened:** what did happen: the exit code and the first lines of output.
   - **Fix:** what would have prevented it, such as a clearer error, a changed default or a corrected doc.
   - **Seen by:** the agent and model, or the person, and the task they were on.
   ```

   Then check the draft:

   ```bash
   grep -c -E '^- \*\*(Tried|Expected|Happened|Fix|Seen by):\*\* \S' /tmp/papercut.md
   grep -n -i -E 'api[_-]?key|secret|token|password|bearer' /tmp/papercut.md
   ```

   Check: the first command prints `5`, and the second prints nothing, or only words used in plain prose with no value next to them.

3. **Choose where it goes.** Look for a `papercut` issue label: `gh label list --search papercut --json name --jq '.[].name'`

   Check: if it prints `papercut`, open an issue in step 4. If it prints nothing or fails (`gh` isn't installed or signed in), add the report to `papercuts.md`.

4. **File it.** For the file, append the report and format it:

   ```bash
   printf '\n' >> papercuts.md && cat /tmp/papercut.md >> papercuts.md && npx prettier --write papercuts.md
   ```

   For an issue:

   ```bash
   gh issue create --label papercut --title "Papercut: <what went wrong>" --body-file /tmp/papercut.md
   ```

   Check: `git diff papercuts.md` shows only your new lines, or `gh` printed the new issue's URL.

5. **Commit the entry.** For the file only (skip this for an issue), commit it on its own on the branch you're working on, never `main`, so it travels with your pull request without mixing into your change:

   ```bash
   git commit -m "Log papercut: <what went wrong>" -- papercuts.md
   ```

   Check: `git show --stat HEAD` lists only `papercuts.md`.

Then name the papercut in one line in your reply or pull request description (`Papercut filed: <what went wrong>`), and carry on with your task.

## Error recovery

- **`gh: command not found`, or `gh` says you aren't logged in.** Add the report to `papercuts.md`. Don't sign in or ask for a token just to file a papercut.
- **`gh issue create` says the `papercut` label wasn't found.** Add the report to `papercuts.md` instead. Creating a label changes the repository's settings, which needs a person.
- **`papercuts.md` doesn't exist.** Create it with a `# Papercuts` heading line, then append the report as in step 4.
- **`npm run format:check` flags `papercuts.md`.** Run `npx prettier --write papercuts.md` and commit the result. Never add the file to `.prettierignore`.
- **The secrets search in step 2 finds a value.** Replace the value with `<redacted>`, keep the setting's name so the report still makes sense, and search the draft once more.
- **You don't know what would fix it.** Write `unknown` in the Fix field, followed by the one question whose answer would settle it.
- **`git commit` in step 5 picks up other files.** Commit with the path after `--`, exactly as shown: that commits only `papercuts.md`, even when other files are staged.
