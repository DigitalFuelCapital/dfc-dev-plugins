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

- [ ] `/dev-autofix:run` on a low-risk repo opens at least 2 draft PRs in the same repo
- [ ] Lock acquisition finds the Claude process (not a shell) and releases cleanly
- [ ] `/dev-autofix:review` posts `LGTM` and writes an approval record under `review/records/`
- [ ] Manual `LGTM` issue comment binds via the activity API (or reports evidence unavailable clearly)
- [ ] `/dev-autofix:finish` merges both PRs in one pass (second PR re-verifies against the moved base, no re-review)
- [ ] `UNKNOWN` mergeability after the first merge resolves within the 30s poll
- [ ] Verification timeout and `CI=1` behave with the repo's real test runner
- [ ] Deliberately failing fix gets quarantined; `list-recovery` reports it with disk usage
- [ ] Note every point where the model skipped, reordered or improvised a step

## Next steps after the test

1. Fix what the live run breaks before adding anything.
2. Prune: move remaining step-by-step logic into helper commands so skills read as short
   procedures that mostly call scripts.
3. Rewrite the README around the design, not the fix history.
4. Decide whether manual-approval recovery and lock breaking earn their complexity, versus
   "use a formal review" and "delete the lock yourself" for a single-user tool.
