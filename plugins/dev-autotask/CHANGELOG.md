# Changelog - dev-autotask

After any update, reinstall the plugin in Codex as well (see the
[root README](../../README.md#update)), or `$task-review` keeps using the old skill.

## 1.3.0

- **Task lock.** `run` and `finish` take a per-task lock (`state.mjs lock` / `unlock`),
  so two sessions cannot work on one task at once.
- **Publish check.** New `scripts/publish-check.mjs` runs before every push. It refuses
  uncommitted work, a credential or `.env` file in any commit, a known malware signature,
  and an unsigned commit where the repository requires signing, and lists sensitive files
  for the PR body.
- **Reviewers.** `finish` acts on review comments from the logins in the config's
  `reviewers` list, not only the account `gh` is logged in as.
- **Cleanup.** `state.mjs cleanup <id>` removes a clean task worktree and marks the task
  done; `finish` runs it after a confirmed merge. `list` shows done, worktree and lock.
- `plan` takes the task ID as `id=<slug>`, so an ID can no longer be confused with the
  first word of a request.
- `verify.mjs` names Windows without WSL plainly, and exports its environment pass-list so
  a repository test can keep it identical to dev-autofix's.
- The plugin manifest names its homepage and repository.

## 1.2.1

Documentation and skill wording only; no script changes.

- `plan` is laid out as sub-steps (config and repo, the three kinds of request) instead
  of two long paragraphs. The instructions themselves are unchanged.
- `run` uses `git -C <task.path>` for both forms of `worktree add`.
- `finish` states that the review comment must come from the account `gh` is logged in
  as.
- Examples use a generic `my-app` repo name.
- README reorganized: requirements, quickstart, command table, FAQ.

## 1.2.0

- `plan` with no request investigates the repo itself and proposes up to five verified
  tasks that are too large for dev-autofix.

## 1.1.0

- Uses dev-autofix's `autofix.config.json` instead of a per-repo config, so one file can
  cover every repo in a workspace folder.
- Task state is namespaced by GitHub repository. Records from 1.0 are not resumed;
  re-plan them.
- `plan` can suggest tasks.

## 1.0.0

- One large task as one branch and one PR: `plan`, `run`, `task-review`, `finish`.
- `infiltrate`: a local security audit whose findings are cross-verified by a second
  agent before they reach a report.
