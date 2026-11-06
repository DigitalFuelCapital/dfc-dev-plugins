---
name: run
description: Implement one approved large-task plan in its dedicated worktree, verify it, open or update its single draft PR, and review automatically. Resume unfinished work without resetting it. Never merge.
disable-model-invocation: true
argument-hint: "<task-id>"
---

# Implement and review the approved task

Read the [shared workflow](../../references/workflow.md). This invocation authorizes
the approved task's branch/worktree, source changes, commits, push to that branch,
one draft PR, and the review phase. It never authorizes pushing to the base branch,
force-pushing, production writes/deployments, or merging.

1. Resolve config/task, acquire the lock, and read the original request, plan and
   checkpoints. Confirm that the user approved the proposed plan in this conversation.
   A direct `run` invocation after the unchanged plan was presented is approval to
   implement it; an implicit skill selection is not. If approval is absent or a
   material plan change is needed, present the concrete plan/change and wait. Call
   `approve-plan` with its exact saved hash only after approval, then `start`. On
   resume, an existing matching approval remains valid: skip `approve-plan` and
   do not ask again. If already cleanly reviewed at the same head with no new work
   requested, report readiness instead of restarting implementation.
2. Create the task worktree/branch from its recorded base only if both are absent and
   no task PR exists. Otherwise verify identity and resume the saved branch. Inspect
   dirty task work and checkpoints; retain it. Check GitHub for the saved PR or an
   existing same-repository PR with the exact task branch/base before publishing, so
   interruption cannot cause a duplicate. Closed unmerged PRs need reconciliation.
3. Execute the plan's milestones. Read the relevant code rather than treating the
   plan as infallible. Follow repository conventions, signing requirements and hard
   rules. Add meaningful tests for changed behavior and acceptance criteria. Keep one
   writer in the worktree; delegated research/review must not race source edits.
   Checkpoint completed milestones, decisions, test results and next actions. A
   blocked milestone leaves the task resumable; do not substitute an unrelated task.
4. Inspect setup/test commands before running them. Configure any additional required
   acceptance checks explicitly in `repo.verify` or run and document them separately.
   Review the complete diff for scope, secrets, accidental generated/build output and
   changes to test/security/deployment configuration. These files are permitted when
   justified by the approved task; do not inherit dev-autofix's size/path restrictions.
   Stage intended files explicitly and commit to the task branch with repository
   signing rules. Run `verify` at that exact committed head; do not publish on failure.
5. Recheck the full cumulative diff and remote branch identity. Push only the task
   branch, without force. Use a short concrete title and a body that explains the
   resulting behavior, acceptance evidence, validation limits and delivery steps.
   Write the body to a file and pass `--body-file`. Create one draft PR against the
   configured base, or update the existing task PR. If the write's outcome is unclear,
   read GitHub before retrying. Re-read its same-repository head/base/state and bind
   its number, canonical URL and exact head with `bind-pr`.
6. Release the lock after all workers stop, then execute the instructions in
   [review](../review/SKILL.md) for this task automatically. Pass the exact task ID
   and saved evidence; do not assume a separate plugin installation or Claude-only
   tool is required. Review independently from implementation claims. Do not wait
   for another user instruction merely to begin the review.

Report the task/PR, milestone and acceptance status, actual checks and limits, review
outcome, and next action. Findings lead to `/dev-autotask:finish`; a clean review means
ready for the user's merge decision. Preserve records/worktree on every exit.
