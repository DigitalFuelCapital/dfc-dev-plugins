# Changelog - dev-autotask

After any update, reinstall the plugin in Codex as well (see the
[root README](../../README.md#update)), or `$task-review` keeps using the old skill.

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
