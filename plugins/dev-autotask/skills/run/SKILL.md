---
name: run
description: Implement an approved dev-autotask plan in its own worktree, verify it, push, and open one draft PR. Resumes an interrupted task. Stops for review; never merges.
disable-model-invocation: true
argument-hint: "[repo:]<task-id>"
---

# Implement the planned task

`<plugin>` is this plugin's root, two directories above this skill; `<state>` is
`node <plugin>/scripts/state.mjs`. Invoking this skill approves the current `plan.md`.
It authorizes the task worktree and branch, commits, pushing that branch, and one draft
PR. Never push to the base branch, never force-push, never merge.

1. **Load.** `<state> show <id>` (with `--repo <repo>` for a `<repo>:<id>` argument, or if
   it reports several repos; `<state> list` and ask if no ID was given). It prints the
   task with its `plan` path, checkout `path`, `remote` and `forbidden` rules, read from
   the task's recorded `config`. Read the plan. If the plan has open questions, ask them
   first. If `task.pr` is set and every milestone is done, report the PR and stop;
   review findings are handled by `finish`.
   Then take the task lock: pick one session ID for this invocation (a UUID) and run
   `<state> --remote <task.remote> lock <id> <session>`. If another session holds it,
   stop and tell the user who holds it and since when; use `--force` only after the user
   confirms that session has ended. Release it in step 6, also when you stop on a failure:
   `<state> --remote <task.remote> unlock <id> <session>`.
2. **Worktree.** If `task.worktree` exists, resume there: keep uncommitted work and
   read `task.progress`. Otherwise run `git -C <task.path> fetch origin` (allow at
   least 120s), then `git -C <task.path> worktree add -b <branch> <worktree>
   origin/<baseBranch>`, or `git -C <task.path> worktree add <worktree> <branch>` if
   the branch already exists. Never switch or edit the main checkout.
3. **Implement** the milestones in order inside the worktree. Follow the repository's
   instructions, `task.forbidden`, and its commit-signing rules. Add tests for the
   acceptance criteria. Commit each milestone with explicit paths, then record it:
   `<state> --remote <task.remote> progress <id> "<what was done>"`.
4. **Verify.** `node <plugin>/scripts/verify.mjs <worktree> <task.config> <task.repo>`
   runs that repo's configured install, prepare and verify commands. Always pass the
   recorded config and repo; discovery from the worktree would miss them. Give it a long
   timeout (install plus every verify command can take many minutes). Fix failures and
   re-run until it passes. Do not publish failing work. Read the full diff against `origin/<baseBranch>` for scope, secrets and stray
   generated files.
5. **Publish.** If `plan.md` has a `Source: infiltrate` line, first run `gh repo view
   <remote> --json visibility`; unless it is `PRIVATE` (or `INTERNAL`), stop and ask the
   user before pushing, because the fix and its regression tests disclose the
   vulnerability. Keep exploit detail out of the PR body and commit messages.
   Run `node <plugin>/scripts/publish-check.mjs <worktree> <task.config> <task.repo> <id>`
   and push only when it reports `ok: true`. It refuses uncommitted work, a branch other
   than this task's, a credential or `.env` file in any commit, an unsigned commit where
   the repository requires signing, and a known malware signature. It scans every
   commit, so a new commit fixes only `clean` and `shape` failures. For `env-file`,
   `secret` or `signed`, stop and tell the user which commit fails and why; the repair is
   a history rewrite, which you do only on the user's explicit authorization and only
   for commits not yet pushed (never force-push). A credential must also be revoked,
   pushed or not. If `malware` is true, stop, push nothing, and tell the user to treat
   the machine as suspect. Mention every file under `attention` in the PR body so the
   reviewer looks at it.
   `git -C <worktree> push -u origin <branch>` (no force). If `task.pr` is
   null, check `gh pr list --repo <remote> --head <branch> --state all` so a retry
   never opens a second PR; if none exists, write the body to a file and run
   `gh pr create --draft --repo <remote> --base <baseBranch> --head <branch> --title
   <title> --body-file <file>`. The body summarizes the change and verification, then
   includes `plan.md` inside `<details><summary>Plan</summary>...</details>` so the
   reviewer has it. Record the number: `<state> --remote <task.remote> pr <id> <number>`.
6. **Stop.** Release the task lock. Report the PR URL, milestones done and verification
   result. Tell the user
   to review it in Codex with `$task-review <number>` (or `/dev-autotask:task-review <number>`),
   then run `/dev-autotask:finish <id>`. Do not review it yourself.
