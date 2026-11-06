---
name: run
description: Implement an approved dev-autotask plan in its own worktree, verify it, push, and open one draft PR. Resumes an interrupted task. Stops for review; never merges.
disable-model-invocation: true
argument-hint: "<task-id>"
---

# Implement the planned task

`<plugin>` is this plugin's root, two directories above this skill; `<state>` is
`node <plugin>/scripts/state.mjs`. Invoking this skill approves the current `plan.md`.
It authorizes the task worktree and branch, commits, pushing that branch, and one draft
PR. Never push to the base branch, never force-push, never merge.

1. **Load.** `<state> show <id>` (use `<state> list` and ask if no ID was given) and
   read `plan.md` from `<state> paths <id>`. If the plan has open questions, ask them
   first. If `task.pr` is set and every milestone is done, report the PR and stop;
   review findings are handled by `finish`.
2. **Worktree.** If `task.worktree` exists, resume there: keep uncommitted work and
   read `task.progress`. Otherwise run `git -C <repo.path> fetch origin` (allow at
   least 120s), then `git -C <repo.path> worktree add -b <branch> <worktree>
   origin/<baseBranch>`, or `git worktree add <worktree> <branch>` if the branch
   already exists. Never switch or edit the main checkout.
3. **Implement** the milestones in order inside the worktree. Follow the repository's
   instructions, `repo.forbidden`, and its commit-signing rules. Add tests for the
   acceptance criteria. Commit each milestone with explicit paths, then record it:
   `<state> progress <id> "<what was done>"`.
4. **Verify.** `node <plugin>/scripts/verify.mjs <worktree>` runs the configured install
   and verify commands; give it a long timeout (install plus every verify command can
   take many minutes). Fix failures and re-run until it passes. Do not publish failing
   work. Read the full diff against `origin/<baseBranch>` for scope, secrets and stray
   generated files.
5. **Publish.** If `plan.md` has a `Source: infiltrate` line, first run `gh repo view
   <remote> --json visibility`; unless it is `PRIVATE` (or `INTERNAL`), stop and ask the
   user before pushing, because the fix and its regression tests disclose the
   vulnerability. Keep exploit detail out of the PR body and commit messages.
   `git -C <worktree> push -u origin <branch>` (no force). If `task.pr` is
   null, check `gh pr list --repo <remote> --head <branch> --state all` so a retry
   never opens a second PR; if none exists, write the body to a file and run
   `gh pr create --draft --repo <remote> --base <baseBranch> --head <branch> --title
   <title> --body-file <file>`. The body summarizes the change and verification, then
   includes `plan.md` inside `<details><summary>Plan</summary>...</details>` so the
   reviewer has it. Record the number: `<state> pr <id> <number>`.
6. **Stop.** Report the PR URL, milestones done and verification result. Tell the user
   to review it in Codex with `$task-review <number>` (or `/dev-autotask:task-review <number>`),
   then run `/dev-autotask:finish <id>`. Do not review it yourself.
