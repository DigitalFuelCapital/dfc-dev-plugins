# Worktree preparation and recovery

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

Before creation, each checkout, and cleanup, run:

```bash
node <plugin>/scripts/state.mjs worktree <config-file> <repo.name> <repoToken>
```

The helper checks ownership, root/main separation, the GitHub origin (including SSH
HostName aliases and `ssh.github.com`), registration, clean index and tracked/untracked
files, no active Git operation, and a branch, `refs/autofix/verify/` or
`refs/autofix/review/` ref retaining
HEAD. It accepts case and URL spelling differences but rejects another host or
repository. It never switches or discards work itself.

For `exists: false`, inspect registrations before adding a tree. If `registered: true`,
confirm the folder was deleted, rather than moved or temporarily unmounted. Inspect:

```bash
git -C <repo.path> worktree list --porcelain
git -C <repo.path> worktree prune --dry-run --verbose --expire now
```

When every prune candidate is a confirmed missing, abandoned directory, run
`git -C <repo.path> worktree prune --verbose --expire now`, then rerun the helper before
`worktree add`. Pruning only removes stale Git registration metadata. Preserve locked
entries; use `worktree repair` for moved trees and stop on uncertain mounts. Because prune
is repository-wide, do not run it if any candidate is uncertain. Review never creates
or prunes worktrees. Recheck after creating a tree. A stale registration elsewhere must
not prevent checking a valid shared tree.

Run/finish recover a **known failed worker or verification attempt** under the repo lock,
after stopping all workers, by moving its entire worktree aside. Write a failure JSON
file with `headSha` observed at failure, `workersStopped: true`, and `reason`, plus useful
session/queue/PR context, then run:

```bash
node <plugin>/scripts/state.mjs quarantine <config-file> <repo.name> <repoToken> <failure-file>
```

The helper verifies identity and the expected head, writes a receipt, and uses
`git worktree move` to a unique `<worktreeRoot>/recovery/<repo.name>-<UUID>` path. It
preserves the index, tracked, untracked and ignored files, local commits and operation
state. It stages or commits nothing. If moving is unsupported (such as a tree with
submodules), stop that repo and report; never fall back to reset/clean. On success,
record the recovery path in the report/queue, recreate the managed path normally, and
continue with the next eligible entry/PR. Re-run install and prepare for the fresh tree.
The failed entry remains blocked. Recovery trees are excluded from automatic cleanup.

After an interruption, inspect saved failure reports/receipts and establish the same
ownership and stopped-worker facts before recovery. Unknown user changes are preserved
and reported, not automatically moved. Clean detached commits can also be retained with
a unique recovery branch before switching (run/finish only). Never force-update refs.
Review leaves unfinished work untouched and continues remote review.

## Recovery inventory

Run `node <plugin>/scripts/state.mjs list-recovery <config-file>` in run/finish reports.
It lists preserved trees, receipt/reason and allocated bytes per tree, plus a total.
Sizes include dependencies; symlinks are not followed. Unreadable sizes are reported as
unknown, never zero. Include these paths and disk usage in the final report even when
no new failure occurred. Nothing is removed automatically. After inspecting a recovery
and preserving anything needed, the user can explicitly request its removal; use Git's
worktree removal with ownership checks rather than deleting directories blindly.

## Dependency cache format

Run, review and merge verification share `<worktreeRoot>/<repo.name>.lock.sha`.
Its content is the lowercase SHA-256 digest followed by one newline, with no filename.
Compute it with `shasum -a 256 <lockfile> | awk '{print $1}'`; compare with the first
field of the saved file, so older `shasum` output with a pathname remains readable.
If the configured lockfile does not exist, use `no-lockfile` plus a newline. A missing
cache requires installation when the repo has an install command. The helpers delete
the cache before installing and rewrite it only after installation succeeds. Never compare full `shasum` output with this file.
