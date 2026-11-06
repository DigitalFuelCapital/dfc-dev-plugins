---
name: review
description: Review one large-task PR against its approved plan and acceptance criteria, verify the exact head, and save findings or a commit-bound clean outcome. Supports repeat reviews after findings are addressed. Never merge.
disable-model-invocation: true
argument-hint: "<task-id> [post]"
---

# Review the whole task

Read the [shared workflow](../../references/workflow.md). This phase authorizes
read-only investigation, scoped checks in the task worktree, and local review records.
Publish one descriptive top-level PR comment only when `post` or another explicit
instruction authorizes it; internal invocation by run defaults to local/chat results.
No approval token, formal review, source fix, PR draft change or merge is authorized.

1. Resolve task/config and acquire its lock. Require the current plan approval and
   saved PR. Read fresh PR state, repository/head/base identity, description, checks
   and complete discussion, including paginated issue comments, formal reviews and
   inline comments. Use `repo.remote`, not a supplied PR URL. Report closed/merged or
   mismatched identities before any checks or publication.
2. Establish exact current head/base and merge base. Fetch retaining refs from the
   verified origin if necessary. The task worktree must be on the recorded task branch
   at the PR head, clean and without another active owner. Never reset or switch an
   unexpected/dirty worktree to make a review pass. If local state cannot be used,
   review remotely and report `blocked`; do not save a clean outcome without required
   verification. A remote head that differs from the saved PR needs identity checks,
   local reconciliation and verification before updating `bind-pr`.
3. Read the entire cumulative diff against the merge base, then trace changed behavior
   through callers, dependencies and tests. Compare with the approved plan and verify
   every acceptance criterion, including failure cases and compatibility. On subsequent
   rounds, inspect the delta too and explicitly verify every previous finding. Reuse
   prior evidence only when its exact commit/context remains applicable. An independent
   reviewer may help, but the lead must reconcile findings before recording the result.
4. Run `verify` at the exact PR head and perform necessary acceptance checks. Distinguish
   static reasoning, local checks, isolated reproductions and CI. Investigate uncertain
   API behavior using primary documentation or a safe reproduction. Findings must be
   actionable: severity P0–P3, triggering scenario, impact, commit-pinned file/line
   evidence and suggested correction. Record material validation gaps as blockers.
5. Immediately before saving/posting, re-read head/base/state/checks and discussion.
   If either SHA changed, inspect/revalidate the affected conclusions once. A second
   movement yields a qualified blocked report, never a clean result. Required checks
   failed/pending, unresolved actionable discussion or incomplete acceptance evidence
   block cleanliness. Do not poll indefinitely for CI.
6. Save `<taskDir>/review.md` with reviewed head/base, acceptance coverage, checks and
   limits, resolved prior findings and remaining findings. Call `review` with these
   SHAs, outcome (`clean`, `findings`, `blocked`), findings array and report path.
   For a blocked report whose worktree cannot meet the helper's identity/cleanliness
   checks, save the report/checkpoint and report in chat without fabricating state.
   If posting is authorized, use a prepared body file and a descriptive comment with
   SHAs and evidence; no standalone `LGTM` or merge token. Check prior reports/comments
   to avoid duplicates, and read after an uncertain write before retrying.

Release the lock and report the PR, reviewed head, outcome, acceptance gaps and checks.
Stop after this review round. `finish` can address findings; a clean review is evidence
for a later merge request and does not authorize merging by itself.
