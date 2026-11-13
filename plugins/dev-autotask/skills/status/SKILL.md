---
name: status
description: List dev-autotask tasks and where each one stands without changing anything. Shows the PR, its latest review, whether a worktree or lock remains, and the next command for each task.
disable-model-invocation: true
argument-hint: "[repo:][task-id]"
---

# Where each task stands

Read-only. Do not edit, commit, push, comment, merge, lock or clean up anything.

`<plugin>` is this plugin's root, two directories above this skill; `<state>` is
`node <plugin>/scripts/state.mjs`.

1. **Tasks.** `<state> list` (with `--repo <name>` for a `<repo>:` argument). Each row
   has the task `id`, `repo`, `remote`, `title`, `pr`, `done`, `worktree` and `locked`.
   With a task ID argument, report that task only. With no tasks, say so and suggest
   `/dev-autotask:plan`.
2. **PR state.** For each task that has a `pr` and is not `done`:
   `gh pr view <pr> --repo <remote> --json state,isDraft,url` for the state, and
   `gh pr view <pr> --repo <remote> --json headRefOid,comments | node
   <plugin>/scripts/review.mjs --remote <remote> <id> --login <gh api user --jq .login>`
   for the latest review (the row's `remote`: task IDs are unique only within one
   repository). If `gh` is unavailable, say the PR state could not be read and report
   the rest.
3. **Report** one row per task: ID, title, PR link, and a state with its next command.
   `<task>` is `<repo>:<id>` with the row's `repo`, so the command picks the same
   repository even when another repository has a task with that ID:

   | State | Next |
   |---|---|
   | No PR yet | `/dev-autotask:run <task>` (it approves the plan and implements it) |
   | PR open, no review, or an LGTM that is `edited` or not `current` | `$task-review <pr>` in Codex |
   | Review `findings` | `/dev-autotask:finish <task>` |
   | `approved: true` | `/dev-autotask:finish <task> merge` |
   | PR merged, task not done | `/dev-autotask:finish <task>` (records the merge and cleans up) |
   | PR closed unmerged | ask the user what they want to do with the task |
   | Done | nothing; mention a leftover worktree if `worktree` is set |

   Mention a task that is `locked`: another session is working on it, or one crashed.
