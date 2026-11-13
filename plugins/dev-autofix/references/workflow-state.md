# Shared workflow state

The contract between the skills and the helper scripts, split by phase so a skill reads
only what it needs. `<plugin>` is the installed plugin root, two directories above a
skill's directory. Every helper prints JSON and exits nonzero on a failed check. Do not
continue a dependent action after failure. Shell-quote paths and arguments.

| Reference | Covers | Read by |
|---|---|---|
| [locks.md](locks.md) | The config check, the run lock and the repo locks | every phase |
| [lock-recovery.md](lock-recovery.md) | Resuming your own lock, breaking an abandoned one | only when a lock is already held |
| [worktrees.md](worktrees.md) | The worktree guard, stale registrations, quarantine, the recovery inventory, the dependency cache | run, finish; review only when a worktree check fails |
| [publishing.md](publishing.md) | PR registration in the run manifest, delivery preflight | run, finish |
| [review-validation.md](review-validation.md) | Review's local checks at the exact PR head | review |
| [approvals.md](approvals.md) | What counts as an approval and what binds it to a commit | review, finish |
| [merge-verification.md](merge-verification.md) | Local integration verification before a merge | finish |

## Helpers

| Command | Does |
|---|---|
| `state.mjs config / lock / unlock / inspect-lock / resume-lock / break-lock` | config check and lock ownership |
| `state.mjs worktree / quarantine / list-recovery` | worktree guard and preserved recoveries |
| `state.mjs record-pr / record-approval / approval` | manifest, approval records, approval checker |
| `preflight.mjs <config> [repo-name ...]` | gh identity/permission, origin/base access, signing probe |
| `review.mjs verify` | review's local checks at the exact PR head, then restore |
| `pr.mjs prepare` | create or reuse the managed worktree, refresh dependencies |
| `pr.mjs queue init / lint` | create the queue skeleton; check a queue against what the helpers parse |
| `pr.mjs queue next / set-status / inbox / add-fallback` | queue selection and bookkeeping |
| `pr.mjs brief` | render a fix worker's brief from `references/fix-brief.md` |
| `pr.mjs gate run / finish` | push gate (read-only), with move-aware size |
| `pr.mjs publish [--max-diff N]` | gate, push, draft PR, registration, queue status |
| `pr.mjs approval-input` | review timeline, classification, approval evidence |
| `pr.mjs land` | verify, CI wait, approval re-check, merge, cleanup for one approved PR |
| `merge.mjs verify / check / release` | local integration verification (used by `land`) |
| `pr.mjs cleanup / remove-worktree` | post-merge queue, branch and worktree cleanup |
| `pr.mjs budget [--bounded] [--reserve N]` | the budget gate run, plan and finish read |
| `status.mjs <config>` | read-only summary: budget, queue, last run, locks, recovery |

## Files on disk

Everything below is under `<worktreeRoot>` (default `~/.claude/autofix/worktrees`), outside
every checkout. Skills read and write these through the helpers; never hand-edit a
manifest, record, receipt or lock.

| Path | Written by | Contents |
|---|---|---|
| `<repo.name>/` | `pr.mjs prepare` | The shared, single-occupancy worktree for that repo. |
| `<repo.name>.lock.sha` | install step | Lockfile digest of the last successful install ([format](worktrees.md#dependency-cache-format)). |
| `<repo.name>.prepared` | `pr.mjs prepare` | Marker that `repo.prepare` succeeded for the current tree. |
| `.locks/run`, `.locks/repo-<repo.name>` | `state.mjs lock` | The run lock and one lock per repo. |
| `last-run.json` | `state.mjs record-pr` | Manifest of the PRs the latest run registered. |
| `runs/<startedAt>.json` | `state.mjs record-pr` | Earlier manifests, archived when a new run replaces `last-run.json`. |
| `plans/<area>.md` | plan investigators | Investigation notes that plan merges into the queue. |
| `briefs/<slug>.md` | `pr.mjs brief` | The rendered worker brief. |
| `pr/<slug>.md` | fix worker | PR title (first line) and body. `publish` writes `pr/<slug>.body.md` beside it. |
| `review/records/` | review, `state.mjs record-approval` | Approval records and review's per-round state. |
| `review/records/validation/`, `review/records/verification/` | `review.mjs`, `merge.mjs` | Receipts for local review checks and merge verification. |
| `review/scratch/` | all phases | Prepared comments, approval inputs and command logs. |
| `recovery/<repo.name>-<UUID>/` and `.json` | `state.mjs quarantine` | A failed attempt moved aside intact, with its receipt. |

The helpers also keep private refs in each repo: `refs/autofix/verify/` for merge
verification and `refs/autofix/review/` for review checks. Neither is ever pushed.

The queue (`queuePath`, default `AUTOFIX_QUEUE.md`) lives beside the config, not here.
