# Verification for batch merges

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

An approval binds the PR head; verification binds the head, base and configured commands.
Use the executable helper instead of constructing a `tested` object:

```bash
node <plugin>/scripts/merge.mjs verify <config-file> <repo.name> <repoToken> <approval-input>
node <plugin>/scripts/merge.mjs check <config-file> <repo.name> <repoToken> <fresh-approval-input> <verification-id>
node <plugin>/scripts/merge.mjs release <config-file> <repo.name> <repoToken> <verification-id>
```

`verify` checks ownership and PR identity, fetches the current head/base, computes the
merge, creates a synthetic local commit, checks it out, refreshes dependencies as needed,
runs configured prepare/verify commands, checks cleanliness and head/base stability,
and restores the PR head on success. It writes actual exit codes and command logs,
returning a verification ID. No model-authored `passed` flag is accepted. On failure,
the CLI exits nonzero and returns `failed` or `conflict` with evidence; preserve any
unfinished work using the [recovery procedure](worktrees.md). A crash leaves a non-passing receipt.

Each install, prepare and verify command that a helper runs (in `prepare`, review
validation and merge verification) gets a minimal environment: `CI=1`, plus `PATH`,
`HOME`, locale, temp and package-manager cache variables, plus the names listed in
`repo.env`. Tokens in the caller's shell are not passed through. Commands a fix worker
runs itself use the worker's own shell and are not covered by this.

Each of those commands also has a per-command timeout:
`repo.commandTimeoutSeconds`, default 600 seconds, configurable from 1 to 3600. On
timeout the helper sends SIGTERM to the shell's entire process group, then SIGKILL
after a two-second grace period. It waits for that cleanup before returning and records
`timedOut`, the configured limit, exit status/signal and a log message. Even a command
that handles SIGTERM by exiting zero fails verification after its timeout. Files and
private refs remain available for recovery. Keep commands non-interactive; CI mode and
the deadline also protect against accidental watch mode.
After an ordinary exit, the helper also stops any remaining processes in the command's
group using the same grace period, preserving the command's exit status. Cleanup
finishes before the next command starts or the log is recorded.

The local synthetic commit is unsigned and retained only under
`refs/autofix/verify/<repo.name>/<UUID>`. It never enters the branch list or gets pushed.
All commits intended for a PR still require signing. The worktree guard accepts private
verification refs as retaining refs. `release` deletes only the matching successful
attempt's private ref, after checking that no worktree uses it. Receipts and logs remain.
Failed attempt refs remain with their work for inspection.

`check` loads the helper's receipt by ID, verifies command/log evidence, private commit
and ref identity, and re-reads the PR head and the actual remote base branch tip.
Base freshness comes from `git ls-remote origin refs/heads/<base>`, independently of
PR `baseRefOid` metadata, both during verification and before merging. It polls `UNKNOWN`
mergeability at two-second intervals for up to 30 seconds. Conflicts and other errors
return promptly; a timeout leaves approval pending. Base movement requires a new
verification run, not a new approval of the unchanged head. A changed PR head requires
fresh approval evidence.
Prepare runs for each integration; install runs when dependencies are missing or the
lockfile changed, using the shared digest-only [cache](worktrees.md#dependency-cache-format). Both are included in the
execution log, alongside every verify command.

These receipts prevent accidental skipped checks; they are not a security boundary
against an actor with the same filesystem/Git access. Never hand-edit a receipt or log.
The skill still obtains fresh review evidence, waits for required CI and performs the
merge. Use `gh pr merge --match-head-commit <approvedHead>` without bypassing branch
rules. The flag pins the head, not the base. Recheck immediately before merging;
GitHub's branch rules/merge queue govern races afterward. A strict up-to-date rule may
still require a pushed sync and fresh review. Queue acceptance is not a confirmed merge.
