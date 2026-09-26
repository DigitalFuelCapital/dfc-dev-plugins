---
name: init
description: Set up autofix in this project. Detects repos, base branches and verification commands, writes autofix.config.json, and checks that the budget status line is wired up. Run once before /dev-autofix:run or /dev-autofix:plan.
disable-model-invocation: true
argument-hint: "[path-to-repo ...]"
---

# /dev-autofix:init - set up autofix for this project

Writes an `autofix.config.json` that `/dev-autofix:run` and `/dev-autofix:plan` read. Detect
everything you can, ask about the rest, and never guess at anything destructive.

Arguments: zero or more repo paths. With none, discover them (step 2).

## 1. Locate the config

Resolution order, first hit wins:

1. `autofix.config.json` in the current directory or any ancestor
2. `~/.claude/autofix.config.json`

If one already exists, read it, report what it covers, and ask whether to add repos
to it or start over. Never silently overwrite a config you did not write this run.

Otherwise the new config goes in the **workspace root**: the nearest directory that
contains the repos in scope - their common parent. For a single repo, use the repo's
parent directory, so the config and queue never show up as untracked files in the
checkout.

## 2. Discover repos

If the user passed paths, use those. Otherwise look for git checkouts in the current
directory and one level below, and present what you found before writing anything.

For each repo, detect and then confirm:

```bash
git -C <path> remote get-url origin                      # -> owner/repo slug
git -C <path> symbolic-ref refs/remotes/origin/HEAD      # -> default branch
git -C <path> branch -r --list 'origin/*'                # -> is there a staging branch?
jq -r '.scripts | keys[]' <path>/package.json            # -> candidate verify commands
```

Decide each field:

- **`baseBranch`** - the branch PRs target. Use the remote HEAD, but if the repo has a
  `staging`, `develop` or `dev` branch, ask which one is the integration branch. Getting
  this wrong points draft PRs at production; always confirm it out loud.
- **`verify`** - the scripts that must pass before a PR opens. Prefer `lint`, `typecheck`,
  `test`, `build` when present. Exclude anything that starts a server, opens a browser,
  needs a database, or takes more than a couple of minutes. If a `test` script runs an
  e2e suite rather than unit tests, leave it out and say why. Every repo must have at
  least one nonempty verification command. If none can be established, ask for the
  appropriate check; do not write an executable config with verification omitted.
- **`prepare`** - codegen the repo needs in a fresh worktree before typecheck passes
  (generated types, schema clients). Detect by checking whether a gitignored generated
  file is referenced by `tsconfig.json` or imported by source.
- **`forbidden`** (per repo) - read the repo's `CLAUDE.md` / `AGENTS.md` and propose
  its hard rules as one-line entries (for example "do not write tests unless asked",
  "never edit generated types"). Workers run with a fresh context and will not otherwise
  know them. Confirm the list with the user.
- **`testCommand`** - a template with `{files}` for running only the tests covering
  changed files. Omit when the repo has no unit runner.
- **`install`** - keep the default `npm ci --ignore-scripts --no-audit --no-fund` unless
  the repo uses a different package manager; match the lockfile that is actually
  committed. Install scripts stay off: they are how a poisoned dependency runs code on
  the machine, and a fresh worktree reinstalls everything. If the repo depends on a
  package that must build on install (look for `sharp`, `esbuild`, `prisma`, `bcrypt`,
  `better-sqlite3`, `@swc/*` in `package.json`), append `&& npm rebuild <package>` for
  just those packages and tell the user which ones and why. Never drop
  `--ignore-scripts` wholesale without the user's explicit say-so.

## 3. Wire up the budget snapshot

`/dev-autofix:run` refuses to start without a fresh usage snapshot. Every user needs this
once per machine, and most will not have read `statusline/README.md`, so init does the
wiring itself - after showing the user exactly what it will change and getting a yes.
Both files involved are the user's global config; never edit them silently.

`<plugin>` below is this plugin's root: two directories up from this skill's base
directory.

1. **Install the writer.** Copy `<plugin>/statusline/usage-snapshot.mjs` to
   `~/.claude/usage-snapshot.mjs` if it is missing or its `shasum -a 256` differs.
   Copying (rather than pointing at the plugin) keeps a stable path; the plugin cache
   path changes on every update.
2. **Hook it into the status line.** Read `statusLine` from `~/.claude/settings.json`.
   - **No status line:** offer the bundled one - copy `<plugin>/statusline/budget-statusline.sh`
     to `~/.claude/`, `chmod +x`, and set `statusLine` to
     `{"type":"command","command":"~/.claude/budget-statusline.sh","padding":2,"refreshInterval":10}`.
   - **A script status line:** read the script. If it does not already reference
     `usage-snapshot.mjs`, find where it reads stdin into a variable and propose adding,
     directly after it, `printf '%s' "$<var>" | node ~/.claude/usage-snapshot.mjs 2>/dev/null`.
     Show the diff before writing. If the script is not bash/zsh or does not keep stdin in
     a variable, show the user the line and where it needs to go instead of guessing.
   - **An inline command status line:** do not rewrite it; explain the change and let the
     user make it.
3. **Check `refreshInterval`.** If `statusLine` has none, propose adding
   `"refreshInterval": 10`. Without it the snapshot goes stale during long runs and
   `/dev-autofix:run` stops itself.
4. **Verify.** The snapshot only appears after the status line next refreshes, which
   needs an API response in this session. Read `~/.claude/usage/latest.json`:
   - **Fresh** (`observed5` and `observed7` each within the last 15 minutes, and their
     reset times still in the future): report the current 5h and weekly numbers. Partial
     or legacy snapshots need a new API observation for each unobserved/stale window.
   - **Missing:** say the wiring is in place and the file appears after the next
     refresh; `/dev-autofix:run` re-checks it.
   - **Present but no `pct5`/`pct7`:** the plan does not expose rate limits (API-key and
     some enterprise setups). Say plainly that `/dev-autofix:run` cannot budget-gate on this
     plan, and that `/dev-autofix:plan` and manual `max=N` runs still work.

## 4. Write the config

Write `autofix.config.json` against the schema at `schema/autofix.config.schema.json`
in this plugin. Only include keys that differ from their defaults, plus `version` and
`repos`. Run the config check in [shared workflow state](../../references/workflow-state.md)
after writing it; do not report setup complete if required verification is missing.

Leave `worktreeRoot` at its default (`~/.claude/autofix/worktrees`) unless the user asks
otherwise, and refuse any value inside a repo checkout: a nested worktree is picked up by
that checkout's typecheck, lint and test globs.

If the queue file at `queuePath` is missing, create it with the `# Autofix queue` heading
and an empty `## Inbox` section. Preserve an existing queue when adding repos or
refreshing machine setup.

## 5. Report

Print the config path, a one-line summary per repo (`name -> owner/repo, base <branch>,
verify: <commands>`), the budget status from step 3, and the two next commands:
`/dev-autofix:plan` to fill the backlog, then `/dev-autofix:run` to spend budget on it.

State clearly that the user's own checkouts are never modified: every fix happens in a
throwaway worktree under `worktreeRoot`.
