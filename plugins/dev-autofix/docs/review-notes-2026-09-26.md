# dev-autofix 3.0.0 - review notes (2026-09-26)

Revisit after the first live run -> review -> finish cycle on a real repo.

Assessment of dev-autofix 3.0.0 on branch `feat/autofix-batch-review`, after four Codex
iterations reviewed by Claude Code. At review time all 35 tests passed and malware-signature
scans were clean. Nothing had been exercised against a live GitHub repo.

## Rating

| Dimension | Score | Why |
| --- | --- | --- |
| Engineering quality | ~8/10 | Careful, well-tested, safety enforced in code |
| Fit for purpose | ~6/10 | Heavier than a single-user, leftover-budget tool likely needs |

Solid, careful work that has grown past what the problem probably needs.

## Strengths

- **Enforcement moved into code.** Lock ownership (auto-detected process ancestry),
  commit-bound approvals, helper-executed verification with stored evidence
  (`scripts/merge.mjs`), atomic PR registration, lease-guarded branch deletion.
- **Preserve over discard.** No reset, clean or forced removal. Failed attempts are
  quarantined intact; lock recovery archives rather than deletes.
- **Tests.** 35 tests, most against real Git fixtures, including process-group kill and
  timeout behaviour.
- **Responsiveness.** Every review point was addressed properly rather than papered over.

## Weaknesses

- **Prose surface area.** Skills plus `references/workflow-state.md` hold dozens of
  conditional steps the model must follow correctly (prune rules, quarantine triggers,
  push-history collection, retry rules). Long instructions get followed unevenly.
- **Complexity vs problem.** Lock breaking, push-history approval reconstruction and
  synthetic verification commits defend against concurrency and adversarial cases that may
  be rare for one staff member invoking manually. Each safeguard adds friction: pending
  approvals, locked repos, accumulating recovery trees.
- **Docs accreted.** README and the state contract read like a changelog of fixes rather
  than a design.
- **No end-to-end run.** GitHub-dependent paths are unproven: push-history approval,
  mergeability polling, merge queues, `ls-remote` base checks.

## Live test checklist

First live cycle: dfc-tools, 2026-09-27. init -> plan (14 entries) -> run (PRs #550-#554) ->
review -> finish (all 5 merged).

- [x] `/dev-autofix:run` on a low-risk repo opens at least 2 draft PRs in the same repo (5)
- [x] Lock acquisition and release worked for run and finish (owner record not inspected)
- [x] `/dev-autofix:review` posts `LGTM` and writes an approval record under `review/records/`
- [~] Manual `LGTM` binds via the activity API: only the one-push case was exercised
      (and only because finish skipped the records - see below)
- [x] `/dev-autofix:finish` merges all PRs in one pass, re-verifying each against the moved base, no re-review
- [ ] `UNKNOWN` mergeability resolves within the 30s poll: unproven (an ad-hoc wait hid it)
- [~] `CI=1` works with vitest; the timeout path was never triggered
- [ ] Deliberately failing fix gets quarantined: not exercised (nothing failed)
- [x] Improvised steps noted below

### What the live run showed

- **Prose steps were improvised.** The lead hand-wrote about 8 scripts: brief, gate,
  queue edits, publish, approval input, merge, cleanup. Finish ignored review's approval
  records and bound approvals from push history instead. A zsh word-splitting slip broke
  one loop, harmlessly.
- **Remote branch deletion failed** on a repo with `delete_branch_on_merge`, because the
  lease delete errors when the branch is already gone.
- **The size rule was ambiguous.** A ~2-line entry landed at 7 lines (Prettier wrapping).
- **A worker dropped the deploy note** for an edge function from the PR body.
- **`perFixPercentEstimate: 3` was high.** Fixes cost 0-1% each; planning was the
  expensive part.
- **Validation worked.** Integration verification was cheap (~20s per PR) and meaningful as
  the base moved. No recovery trees accumulated, and locks added no friction.

### Addressed in 3.1.0

`scripts/pr.mjs` now owns the queue, briefs, gate, publish, approval input and cleanup, with
tests. Finish prefers records. Cleanup treats an absent remote branch as done. The size cap
is `maxDiffLines` (or the stated size plus 50% when larger). Publish enforces deploy lines.
The perFix default is now 2. Decisions: finish still removes the worktree after checks;
lock breaking and push-history approval stay until a real case argues otherwise.

### 3.1.0 smoke run (2026-09-27)

dfc-tools PRs #555 and #556: run, review, then finish, using only the helpers. Finish bound
both approvals from `record`, and cleanup reported `already deleted` for both remote branches.
One bug: `remove-worktree` hit the helpers' 120s command timeout while deleting
`node_modules`, which left a half-removed tree (HEAD on base, only deletions). Fixed in
3.1.1.

Still untested: address path (Opus worker), conflict resolution, stale-head re-review,
quarantine, command timeout, lock break, merge queues.

## Next steps after the test

1. ~~Fix what the live run breaks before adding anything.~~ Done in 3.1.0.
2. ~~Prune: move step-by-step logic into helper commands.~~ Largely done in 3.1.0 for run and
   finish. Worktree preparation and quarantine triggers remain prose.
3. Rewrite the README around the design, not the fix history.
4. Revisit lock breaking once a real abandoned lock has occurred.
5. Exercise the failure paths deliberately.
