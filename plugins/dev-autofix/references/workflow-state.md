# Shared workflow state

Read the relevant sections before running, reviewing, or finishing PRs. `<plugin>` is
the installed plugin root, two directories above a skill's directory. The helper is
`<plugin>/scripts/state.mjs`. It returns JSON and exits nonzero on a failed check. Do
not continue a dependent action after failure. Shell-quote paths and arguments.

## Helpers

| Command | Does |
|---|---|
| `state.mjs config / lock / unlock / inspect-lock / resume-lock / break-lock` | config check and lock ownership |
| `state.mjs worktree / quarantine / list-recovery` | worktree guard and preserved recoveries |
| `state.mjs record-pr / record-approval / approval` | manifest, approval records, approval checker |
| `state.mjs start-run / read-run / finish-run` | durable batches, including empty/stopped runs and historical selection |
| `preflight.mjs <config> [repo-name ...]` | publishing identity/access and disposable trusted signing check |
| `review.mjs verify / check` | exact-head local review validation, safe restoration and checked receipts |
| `pr.mjs prepare` | create or reuse the managed worktree, refresh dependencies |
| `pr.mjs queue next / set-status / inbox / add-fallback` | queue selection and bookkeeping |
| `pr.mjs brief` | render a fix worker's brief from `references/fix-brief.md` |
| `pr.mjs gate run / finish` | push gate (read-only), with move-aware size |
| `pr.mjs publish [--max-diff N]` | gate, push, draft PR, registration, queue status |
| `pr.mjs approval-input` | review timeline, classification, approval evidence |
| `pr.mjs land` | verify, CI wait, approval re-check, merge, cleanup for one approved PR |
| `merge.mjs verify / check / release` | local integration verification (used by `land`) |
| `pr.mjs cleanup / remove-worktree` | post-merge queue, branch and worktree cleanup |

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
For non-dry-run execution, immediately create/resume the run before preflight or budget
gates: `node <plugin>/scripts/state.mjs start-run <worktreeRoot> <startedAt> <runToken>`.
Retain its `runId`. The same running timestamp resumes idempotently; a new invocation
uses a new timestamp and immediately publishes an empty current batch. In finally,
after workers stop and before unlocking, call `finish-run <worktreeRoot> <runId>
<runToken> <result-file>` with `{status:"complete"|"stopped"|"failed",summary,outcomes}`.
Report failed finalization; never silently discard a running receipt.
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

Each run has `<worktreeRoot>/runs/<runId>.json`, with UUID, start/end times, status,
PRs and optional per-entry outcomes. `last-run.json` remains a compatible full snapshot
of the current run, including `prs: []` for an empty or preflight/budget-blocked run.
Only the run-lock owner writes these. History is saved before the snapshot; readers
recover a stale snapshot from a newer revision of that same history. Malformed or
conflicting records are preserved and block dependent changes.

Use `state.mjs read-run <worktreeRoot>` for the current batch, or
`read-run <worktreeRoot> <runId>` for historical selection. Reads are read-only and
validate identities. Legacy manifests without a run ID remain readable and are
adopted into history on an owned write. An interrupted historical `running` record is
retained, not silently labelled completed. Never replace an empty current batch with
an older nonempty one; use an explicit run ID or `pr=N` to select older work.

`scripts/pr.mjs publish` registers each PR it creates or discovers, after verifying
repository/head/base and before setting `pr-open`. For a PR discovered outside `publish`
(a `pushed` entry in run's recovery pass), write an entry JSON file with `repo`, `number`,
`branch` and canonical `url`, then:

```bash
node <plugin>/scripts/state.mjs record-pr <worktreeRoot> <startedAt> <entry-file> <runToken>
```

Only the lead calls this, **serially**, while holding the run lock. Workers never write the
manifest. The upsert deduplicates by repo/number and updates the selected running
history plus its snapshot. Older timestamps and finalized runs cannot receive late
registrations. Legacy callers can still register their first PR implicitly; new runs
must call `start-run` first so zero-PR runs are represented. On
failure, leave the queue `pushed` and stop publication until registration succeeds.
Malformed manifests are preserved and block registration.

## Delivery preflight

Before run workers or finish correction/conflict workers, run
`node <plugin>/scripts/preflight.mjs <config-file> [repo-name ...]` for repos in scope.
It resolves the actual `gh` login and repository write permission, checks the verified
origin and readable base, then signs and locally verifies an empty disposable commit.
The probe uses effective signing/trust settings without changing source objects, refs,
index, working files or config, and pushes nothing. It has bounded commands and removes
temporary probe artifacts. Never repair a failed check by disabling signing.

A publishing author outside `reviewers` is a warning for run (a bot may open fixes
for human reviewers). It blocks consuming that author's review comments, not ordinary
PR publication. When reviewers are omitted, finish defaults to the authenticated gh
login; connector review authors must be checked separately against that effective
list. A local trusted signature does not prove GitHub associates it with a verified
key/account or accepts every branch rule. Keep this limit visible. Read-only planning,
dry-run, remote review and merge-only approval do not need a local signing probe.

## Local review validation

Prepare input JSON `{number,headSha,baseSha}` from the exact reviewed PR snapshot.
Under the repo lock, after inspecting configured commands, run:

```bash
node <plugin>/scripts/review.mjs verify <config-file> <repo.name> <repoToken> <input-file>
node <plugin>/scripts/review.mjs check <config-file> <repo.name> <repoToken> <input-file> <validation-id>
```

`verify` checks PR and worktree identity, fetches head/base into unique private retaining
refs, detaches at the exact PR head, refreshes dependencies and runs configured
prepare/verify commands. It uses the bounded process runner, records actual exits and
logs, and attempts restoration in finally. Dirty outputs, moved branches, interruption
or failed restoration cannot produce passing evidence. It never creates a worktree,
changes the main checkout, merges the base, stages, commits or pushes. Preserve private
`refs/autofix/review/<repo>/<PR>/<UUID>/` refs and logs for inspection.

Receipts live in `review/records/validation/<repo>-pr<N>-<UUID>.json`; command logs live
in `review/scratch/review-<UUID>/`. Save the returned ID/path in per-round records.
`check` verifies head/base/config identity, exact commands, exits/deadlines, retaining
refs, restoration and log hashes, plus fresh PR/remote-base metadata. Call it before
posting approval when relying on local checks. CI, discussion, code review and
acceptance criteria remain separate evidence; a successful helper is not a code review
or merge permission. Command SIGINT/SIGTERM is recorded as failure even if cleanup
exits zero. SIGKILL or a machine crash can leave a running receipt and preserved tree;
it is never accepted as passed.

## Approval records

`<worktreeRoot>/review/records/` holds two kinds of file:

- `<repo>-pr<N>-comment<ID>.approval.json` - the immutable approval record review saves
  after publishing an `LGTM`. Finish binds approvals from these first.
- `<repo>-pr<N>-<headSha>.json` - review's own per-round state (reviewed head/base,
  validation results, posted comment). Finish does not read these.

Its `validation/` subdirectory also holds executable local review receipts, separate
from approval authorization and merge-integration verification records.

`<worktreeRoot>/review/scratch/` holds reports, prepared comments, verification logs and
approval inputs. Use `/tmp` only when `review/scratch/` is unwritable, and report where.

The approval record:

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

Save it with `node <plugin>/scripts/state.mjs record-approval <record-path> <input-file>`.
Field order does not matter. Never rebind an existing record to a later head or infer the
reviewed SHA from whatever head finish now sees.

`node <plugin>/scripts/pr.mjs approval-input <config> <repo> <n> <out>` builds the input
the checker (`state.mjs approval`) and `merge.mjs` consume: `remote`, `number`, `headRef`,
current `headSha`, `reviewers`, `approveTokens`, the complete `pending` timeline, and one of
`record` (preferred), a formal review's `commitSha`, or `history`. Only non-dismissed
`APPROVED`/`COMMENTED` formal reviews with an exact token qualify.

### Manual conversation approvals

Without a record, a manual `LGTM` is bound using server push history
([repository activity API](https://docs.github.com/en/rest/repos/repos#list-repository-activities),
every page, no actor or type filter, head re-read after collection). The checker binds the
token to the last head before the comment and requires a continuous chain to the current
head. Missing or truncated history, edited comments, same-second ambiguity, and branch
recreation or deletion fail closed as `evidence-unavailable`. Never substitute commit
author dates, repository `pushed_at`, or an incomplete PR commit timeline.

If evidence proves the approved head is stale, finish posts `Re-review required` and
consumes that token with its addressed marker. If evidence is merely unavailable or
ambiguous, it leaves the token pending and reports in chat, without a marker or a new
approval. Review may repair its missing record only from saved original publication
evidence. Do not run a fix worker just because an approval cannot be bound.

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
