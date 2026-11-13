# Local review validation

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

`review.mjs verify <config> <repo.name> <repoToken> <input-file>`, with input
`{number,headSha,baseSha}`, runs under the repo lock. It checks worktree ownership and
cleanliness plus PR and base identity, fetches the head into a private
`refs/autofix/review/<repo>/pr<N>-<UUID>` ref (remote-tracking refs are left alone, since
one may be all that retains a detached original), detaches at the exact head, installs dependencies when stale, runs prepare/verify with
the bounded runner, re-checks PR/base freshness and restores the original checkout, then deletes the private ref. The
receipt goes to `review/records/validation/<repo>-pr<N>-<UUID>.json` and logs to
`review/scratch/review-<UUID>/`. If restoration fails the worktree is preserved and,
when detached, that ref is kept (`retainedRef`) to retain it; inspect it before reuse.
A passing receipt is not a code review or merge permission.
