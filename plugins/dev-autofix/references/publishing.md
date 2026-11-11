# Publishing

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

How a PR gets into the run manifest, and the checks made before any worker starts.

## PR registration and recovery

`scripts/pr.mjs publish` registers each PR it creates or discovers, after verifying
repository/head/base and before setting `pr-open`. For a PR discovered outside `publish`
(a `pushed` entry in run's recovery pass), write an entry JSON file with `repo`, `number`,
`branch` and canonical `url`, then:

```bash
node <plugin>/scripts/state.mjs record-pr <worktreeRoot> <startedAt> <entry-file> <runToken>
```

Only the lead calls this, **serially**, while holding the run lock. Workers never write the
manifest. The atomic upsert deduplicates by repo/number. The first registration of a run
replaces the prior manifest (archived to `runs/<startedAt>.json`); later ones append; no
registrations leave it intact, so report `startedAt` to show which batch is selected. On
failure, leave the queue `pushed` and stop publication until registration succeeds.
Malformed manifests are preserved and block registration.

## Delivery preflight

`preflight.mjs` repeats the platform and Git version check, resolves the `gh` login, checks the publishing host, each repo's origin,
readable remote base and write permission, and signs one empty, unreferenced commit with
`git commit-tree -S` in the first selected repo (signing config is normally global), then
runs `git verify-commit` on it, the same check publish applies; an unverifiable signature
fails preflight (for SSH, set `gpg.ssh.allowedSignersFile`). It changes no refs, index,
files or config and pushes nothing. A gh login outside `reviewers` is a `warning`, not a
failure. Limits: a local signature does not prove GitHub has the key on a verified
account or that branch rules accept the push, and a connector may publish as a different
account than `gh`. Never fix a failed check by disabling signing.
If the signing check fails with an agent or socket error ("couldn't get agent socket",
gpg agent unreachable), rerun preflight outside the sandbox before treating it as real. Read-only planning,
`dry-run`, remote review and merge-only approval need no preflight.
