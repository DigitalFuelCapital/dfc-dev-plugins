# Shared workflow state

Read the relevant sections before running, reviewing, or finishing PRs. `<plugin>` is
the installed plugin root, two directories above a skill's directory. The helper is
`<plugin>/scripts/state.mjs`. It returns JSON and exits nonzero on a failed check. Do
not continue a dependent action after failure. Shell-quote paths and arguments.

## Config and ownership

Run `node <plugin>/scripts/state.mjs config <config-file>` before work. This checks the
required runtime fields, including a nonempty `verify` list for every repo; it does not
replace the full config schema. Report incomplete config rather than invent commands.

Persist an identity JSON file outside the lock directory for the invocation:
`{"session":"<persistent session ID>","command":"dev-autofix:run"}`. Do not supply a PID.
The helper walks process ancestry to find the nearest Claude or Codex runtime, skipping
shells and helper processes. It recognizes the native executables and Claude's Node CLI.
If no runtime is found or process inspection is denied, it refuses acquisition. Retry
with process-inspection permission rather than guessing a PID. The owner record includes
that PID, executable, process start time, host, session, command and token.

Use a stable session ID from the runtime, or save one generated UUID for the invocation.
A Codex daemon can serve several sessions, so the session ID still distinguishes them.
A live shared daemon prevents automatic lock breaking even if one conversation ended;
release normally in the owning session, or stop the runtime and confirm workers stopped
before breaking an abandoned lock.

One run at a time may update the manifest. Before run's recovery/fix loop, acquire:

```bash
node <plugin>/scripts/state.mjs lock <worktreeRoot>/.locks/run <identity-file>
```

The returned UUID is `runToken`. Persist one ISO `startedAt` for the invocation too.
Before creating, checking out, testing, editing, or removing a repo's shared worktree,
also acquire `<worktreeRoot>/.locks/repo-<repo.name>` with the same identity file. Its
UUID is `repoToken`. Hold the repo lock throughout worker activity. Review can still
inspect remote contents when local use is locked. Release owned locks in a finally step,
after all workers stop: `node <plugin>/scripts/state.mjs unlock <directory> <token>`.

Locks never expire automatically. On an existing lock, skip that repo or stop a
conflicting run. Recovery commands:

```bash
node <plugin>/scripts/state.mjs inspect-lock <directory>
node <plugin>/scripts/state.mjs resume-lock <directory> <identity-file>
node <plugin>/scripts/state.mjs break-lock <directory> <confirmation-file>
```

`resume-lock` returns the saved token only for the same session, host, PID, and process
start time; it recovers ownership after context compaction. For an abandoned lock,
inspect it and confirm the previous session **and its workers** stopped. The confirmation
file must contain the inspected `fingerprint`, `confirmedStopped: true`, and a concrete
`reason`. `break-lock` refuses a live local owner or changed fingerprint. For a remote
host or legacy lock without identity, independently establish that no owner/workers
remain before confirming. An ownerless directory is recoverable after a 60-second
initialization grace period, with the same explicit confirmation. The grace period uses
modification/change times too, so missing Linux birthtime does not disable it. The old
directory is archived beside the lock with a recovery receipt, never silently deleted. Acquire a
new lock normally afterward. Age alone is never sufficient evidence of abandonment.

## Worktree preparation and recovery

Before creation, each checkout, and cleanup, run:

```bash
node <plugin>/scripts/state.mjs worktree <config-file> <repo.name> <repoToken>
```

The helper checks ownership, root/main separation, the GitHub origin (including SSH
HostName aliases and `ssh.github.com`), registration, clean index and tracked/untracked
files, no active Git operation, and a branch or `refs/autofix/verify/` ref retaining
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

### Recovery inventory

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
cache requires installation when the repo has an install command. Update the cache
only after installation succeeds. Never compare full `shasum` output with this file.

## PR registration and recovery

After confirmed creation **or discovery of an existing PR for a `pushed` entry**, write
an entry JSON file containing `repo`, `number`, `branch`, and canonical GitHub `url`.
Verify repository/head/base first. Register before changing queue status to `pr-open`:

```bash
node <plugin>/scripts/state.mjs record-pr <worktreeRoot> <startedAt> <entry-file> <runToken>
```

Only the lead calls this helper, **serially**, while holding the run lock. Workers never
write the manifest. No second manifest lock is needed. The atomic upsert deduplicates by
repo/number. The first registration replaces the prior manifest; later registrations
append. No registrations leave the prior manifest intact. Recovered PRs belong to this
pass. On failure, leave the queue `pushed`, preserve the entry file and stop publication
until registration succeeds. Malformed manifests are preserved and block registration.

## Approval records

Use `<worktreeRoot>/review/records/` for durable review records and
`<worktreeRoot>/review/scratch/` for reports, prepared comments and verification input.
Review saves an immutable record after confirming publication:

```json
{
  "remote": "owner/repo",
  "number": 42,
  "headSha": "0123456789012345678901234567890123456789",
  "commentUrl": "https://github.com/owner/repo/pull/42#issuecomment-123",
  "author": "reviewer-login",
  "body": "LGTM"
}
```

Save it with `node <plugin>/scripts/state.mjs record-approval <record-path> <input-file>`
at `review/records/<repo.name>-pr<N>-comment<ID>.approval.json`. Field order does not
matter. Never rebind an existing record to a later head or infer the reviewed SHA from
whatever head finish now sees.

Before classification and immediately before merging, construct fresh metadata and run
`node <plugin>/scripts/state.mjs approval <input-file>`. Input: `remote`, `number`,
`headRef`, current `headSha`, resolved `reviewers` and `approveTokens`, complete `pending`
timeline, and `record` if available. Each pending entry has `kind` (`issue`, `review`,
`inline`), `url`, `author`, `body`. Formal reviews include `commitSha` from `commit_id`
and `state`; only non-dismissed `APPROVED`/`COMMENTED` reviews with an exact token qualify.

### Manual conversation approvals

An unrecorded manual `LGTM` is supported using server push history. Fetch
`repos/<remote>/activity` with `ref=refs/heads/<headRef>`, `direction=desc`, `per_page=100`,
following every Link pagination cursor. Do not filter by actor or activity type: force
pushes, creation, deletion and merges matter too. Include history reaching an event
strictly before the comment and every event through the latest head. GitHub's
[repository activity API](https://docs.github.com/en/rest/repos/repos#list-repository-activities)
provides `timestamp`, `before`, `after`, `ref`, and `activity_type`.

Add the issue comment's `created_at`/`updated_at` as `createdAt`/`updatedAt`. Supply
`history: {remote, ref, complete: true, observedHead, activities}` only after fetching
all pages successfully and re-reading the PR head after collection. `observedHead`
must equal that fresh head. The helper binds the token to the last head before the
comment and checks a continuous chain to the current head. Missing/truncated history,
edited comments, same-second ambiguity, and branch recreation/deletion fail closed.
Never substitute commit author dates, repository `pushed_at`, or an incomplete PR
commit timeline. API errors or uncertain ordering mean `approval evidence unavailable`.

If evidence proves the approved head is stale, finish posts `Re-review required` and
consumes that stale token with its addressed marker. If evidence is merely unavailable
or ambiguous, leave it pending and report in chat, without a marker or a new approval.
Review may repair its missing record only from saved original publication evidence.
Do not run a fix worker just because an approval cannot be bound.

## Verification for batch merges

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
unfinished work using the recovery procedure. A crash leaves a non-passing receipt.

Each install, prepare and verify command runs with `CI=1` and a per-command timeout:
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
lockfile changed, using the shared digest-only cache above. Both are included in the
execution log, alongside every verify command.

These receipts prevent accidental skipped checks; they are not a security boundary
against an actor with the same filesystem/Git access. Never hand-edit a receipt or log.
The skill still obtains fresh review evidence, waits for required CI and performs the
merge. Use `gh pr merge --match-head-commit <approvedHead>` without bypassing branch
rules. The flag pins the head, not the base. Recheck immediately before merging;
GitHub's branch rules/merge queue govern races afterward. A strict up-to-date rule may
still require a pushed sync and fresh review. Queue acceptance is not a confirmed merge.
