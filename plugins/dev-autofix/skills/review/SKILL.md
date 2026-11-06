---
name: review
description: Review every autofix PR from the last run, continuing automatically between PRs and reusing run worktrees for validation. Publish findings or exact LGTM comments for finish to consume. Use for batch autofix reviews in Codex or Claude Code, including re-reviews after finish addresses findings.
disable-model-invocation: true
---

# Review the autofix PR batch

Invoke as `$review` in Codex or `/dev-autofix:review` in Claude Code. Accept optional
repo names, `run=UUID`, `pr=N` (repeatable), and `review-only`. By default, process **every PR in
the last run**, one repo at a time in config order, ascending PR number within each
repo. Complete the whole pass without asking to move to the next PR. Findings, closed
PRs, and individual validation failures do not end the pass.

This is the review phase between `run` and `finish`. It follows the single-PR
`pr-review` contract, reproduced here so that skill need not be installed separately.
Do not invoke `run` or `finish`, fix source, or merge anything during this phase.

## Authorization and client support

Explicit invocation authorizes one top-level GitHub conversation comment per reviewed
PR, including the exact `LGTM` approval token and its configured automation. It also
authorizes fetching and temporarily checking out exact PR commits **in existing run
worktrees only**, running scoped verification there, and restoring their original
branch/commit afterward. No additional checkout question is needed for those worktrees.
Never switch the user's main checkout, stage, commit, push, stash, reset, clean, change
PR draft state, submit formal GitHub reviews, or delete branches/worktrees.

If this skill was selected implicitly, review in chat unless posting is separately
authorized; use remote contents unless worktree checkout is separately authorized.
`review-only` means no comments. A do-not-merge instruction suppresses approval tokens
even when findings comments are authorized. Review the remaining PRs under either mode.

Use the current client's tools and session model. This workflow needs no Claude-only
Task tool, model name, status line, usage snapshot, or budget gate. Do not spawn workers
unless the user explicitly requests delegation. Shared worktrees remain sequential.

## 1. Resolve a fixed batch

Find `autofix.config.json` in the current directory or nearest ancestor, otherwise
`~/.claude/autofix.config.json`. Read the [config schema](../../schema/autofix.config.schema.json)
for fields and defaults; JSON Schema defaults must be applied explicitly. Expand `~`
in `worktreeRoot` (default `~/.claude/autofix/worktrees`); resolve `queuePath` relative
to the config directory. Use `repos[].remote` for every GitHub operation. A missing
config is a batch blocker: report it and suggest Claude's `/dev-autofix:init` or an
existing config; do not initialize Claude settings in Codex.

Read [shared workflow state](../../references/workflow-state.md). Run its config check
before local validation; missing verification blocks readiness, but other PRs may still
be inspected remotely. Use its repo ownership lock and worktree check for local work,
and its immutable approval record format when publishing `LGTM`.

Unless explicit `pr=N` replaces discovery, use
`state.mjs read-run <worktreeRoot> [run-id]` to read the latest batch, or the
explicit `run=UUID` history, once and retain the snapshot for this pass. Omit the
optional argument for latest. Do not combine `run=UUID` and `pr=N`; report the
ambiguous selection before acting. Legacy manifests remain readable. Example:

```json
{
  "runId": "00000000-0000-4000-8000-000000000001",
  "startedAt": "2026-09-26T12:00:00Z",
  "status": "complete",
  "prs": [
    {"repo": "dfc-tools", "number": 42, "branch": "fix/auto-20260926-example", "url": "https://github.com/DigitalFuelCapital/dfc-tools/pull/42"}
  ]
}
```

Match `repo` to a unique configured name, deduplicate by `(remote, number)`, and apply
repo filters. Reject malformed entries or unknown repos with a reported reason. Do not
search all open PRs or silently fall back to a different batch. A missing/invalid
manifest blocks default discovery; an empty manifest/filter result is a completed empty
pass. New zero-PR runs explicitly select an empty batch. Report `runId`, `startedAt`
and status; an interrupted `running` receipt is not a completed run. Never silently
substitute the previous run for an empty, stopped or failed batch.

Explicit `pr=N` arguments replace manifest selection and can review earlier runs.
Resolve each number to a configured repo in scope; ask only if ambiguous. Continue
unambiguous entries while waiting. Without a manifest, explicit selection still works.
Require an explicit PR to use the configured `branchPrefix` followed by `-` (default
`fix/auto-`), and require a manifest PR's head branch to match its recorded `branch`.
Never follow a manifest URL to a different repository.

Resolve the actual publishing-tool author and finish's effective `reviewers`.
When config omits reviewers, finish defaults to the authenticated **gh** login from
`gh api user --jq .login`, even when review publishes through a connector. Resolve
both identities; do not substitute the connector author for finish's default.
If gh/default identity cannot be established or the actual author is not a reviewer,
finish cannot consume those comments: complete the reviews in chat and report the
mismatch without changing config.
Resolve `approveTokens` (default `LGTM`, `/merge`). This skill's clean comment is always
`LGTM`; if the configured tokens exclude it, report clean results in chat and explain
the mismatch rather than posting a comment that finish would treat as concerns.

Keep a per-PR record of head/base SHAs, validation, outcome, and posted comment URL.
Use `<worktreeRoot>/review/records/` for durable review records and
`<worktreeRoot>/review/scratch/` for prepared comments and temporary output.
Key records by repository,
PR number, and head SHA; include the base SHA, comment ID/URL, publication time, and
latest finish reply ID so later invocations
can distinguish a completed review from a new review round. Never modify `last-run.json`
or queue status. If that directory is unwritable, use temporary records and report
their location.

## 2. Inspect each PR

Read metadata, description, diff, checks, and all discussion, including paginated
conversation comments, formal review bodies, and inline comments. With `gh`, use
`gh pr view <n> --repo <remote>` and `gh pr diff <n> --repo <remote>`; retrieve complete
discussion through `gh api --paginate` for `repos/<remote>/issues/<n>/comments`,
`repos/<remote>/pulls/<n>/reviews`, and `repos/<remote>/pulls/<n>/comments`.

- Skip closed/merged PRs and report their state. Drafts are expected and reviewable.
- Require the configured base branch, same-repository head (no fork), and matching
  autofix branch identity from step 1. Report mismatches and continue.
- Record exact base/head SHAs and read applicable repository instructions. Review the
  head against its merge base with the recorded base, not the main checkout's contents
  or a two-dot comparison to a moving base. Fetch exact contents as needed.
- Read the queue plan as context, then independently trace changed behavior through
  callers and dependencies. Plan claims and old verification are not proof.
- For re-reviews, find the previous reviewed SHA in records/discussion, inspect the
  delta, verify each prior finding, and retain unresolved findings. If the prior SHA
  cannot be established, review the full PR.
- Report only actionable introduced defects: priority (`P0` to `P3`), triggering
  scenario, impact, evidence, and precise commit-pinned file/line links. Verify uncertain
  API behavior with current primary documentation or an isolated reproduction.

## 3. Reuse run worktrees when local validation helps

The existing worktree is `<worktreeRoot>/<repo.name>`, shared by all that repo's PRs.
Do not copy run/finish's reset, clean, sync, or cleanup commands. Review the unchanged
PR head; merging the base would test a different commit.

Before using it, resolve real paths, require it to be outside every configured main
checkout and inside `worktreeRoot`, confirm it appears in `git worktree list --porcelain`
for `repo.path`, and confirm the origin identifies `repo.remote`. Reject a main checkout,
unregistered path, symlink escaping the root, or another repository's worktree.

Acquire `<worktreeRoot>/.locks/repo-<repo.name>` using the shared helper, then run its
worktree check before each checkout. Keep the lock through verification and restoration.
If locked or the helper fails, use remote review for that repo; never bypass the guard.
Release only this invocation's lock in a finally step after restoration is attempted.

Do not share it with an active run/finish/review session. Record original branch (or
detached state), commit, and full index/worktree status including untracked files.
Require a clean worktree and no merge, rebase, cherry-pick, or revert in progress. If
dirty, busy, missing, or identity cannot be verified, leave it alone and review remotely;
do not ask to clear it, create another worktree, or block the rest of the batch.

For an eligible worktree, inspect install/prepare/verify commands and repository rules
first. Do not run fix-mode commands, migrations, deployments, production writes or checks
requiring production secrets. Save JSON input `{number,headSha,baseSha}` from the reviewed
PR snapshot, then use the executable helper rather than manually implementing checkout,
command execution and restoration:

```bash
node <plugin>/scripts/review.mjs verify <config-file> <repo.name> <repoToken> <input-file>
```

The helper checks PR/origin/worktree identity, fetches retaining refs, checks out the
exact unchanged head, refreshes dependencies, runs configured prepare/verify commands
with deadlines and child-process cleanup, and attempts safe restoration in finally.
It records actual commands, exits, logs, head/base, configuration and restoration in
`review/records/validation/`. Keep the returned receipt ID/path in this PR's round record.
Private `refs/autofix/review/` refs retain reviewed commits; nothing is pushed.

Only `status: passed` with successful restoration proves these local checks completed.
A failed check, interruption, dirty output or moved original branch preserves evidence
and blocks dependent approval. Never discard artifacts to restore. If restoration fails
or the worktree is dirty, disable further local use for this repo and continue remotely.
When helper tooling is unavailable, use remote review rather than bypassing its guards.
Save additional isolated reproductions under `review/scratch/`; identify them separately
from the helper's configured checks. For a different dependency layout, use the repo's
documented setup/config rather than assuming npm succeeded.

Remote review remains useful when local checks are unavailable. Decide whether that
limit materially blocks readiness. Do not approve if necessary validation is incomplete,
required checks failed/pending, or a review blocker remains. Record each limit and
continue to the next PR instead of waiting indefinitely for CI or another session.

## 4. Publish once, then advance

Immediately before publishing, re-read PR state, head/base SHAs, checks, and all comments.
If closed/merged, skip posting. If head or base changed, inspect the delta and revalidate
affected conclusions once. If it changes again, publish only a qualified report of the
exact reviewed SHAs and unreviewed delta, never `LGTM`, then advance.

If relying on a local validation receipt for approval, re-run
`review.mjs check <config-file> <repo.name> <repoToken> <input-file> <receipt-id>` under
the repo lock before posting. It rejects changed head/base/configuration, failed
restoration and altered log evidence. Refresh validation when needed; a model-written
`passed` flag or old chat summary does not replace an executed receipt.

Avoid duplicate reviews for the same head **and review outcome/discussion state**.
Compare prior records with actual GitHub comments, including a newer finish reply or
reviewer comment. A prior `LGTM` alone carries no SHA: use a saved SHA/comment record or
commit/discussion history to establish which head it covered; never assume it approves
the current head. Unchanged heads can still need another review after finish posts a
reply or blocked checks recover. If the same applicable review is already published,
report its URL and advance without another comment.

Account for finish's pending-review rule before approval: it reads configured reviewers'
comments newer than its last `<!-- dev-autofix:review addressed=... -->` reply and approves
only when exactly one pending entry is an exact token. Outstanding reviewer concerns
must be resolved; do not append `LGTM` to a pending concerns timeline and claim finish
will merge it. Any other pending entry, including a stale approval for an older head,
also prevents a new token from being the sole pending entry. Report the need for a
finish round or human reconciliation, then continue.
Never edit/delete others' comments to manufacture approval. Do not put finish's marker
on this skill's comments: it would hide the review from finish.

Choose one comment, subject to the authorization rules:

- **Ready:** the entire body is exactly `LGTM`, without formatting, SHA, signature,
  hidden marker, or explanation. This token can trigger merge automation. Put validation
  details and reviewed SHAs in local records and the final chat report.
  After confirming publication, persist the immutable comment-specific approval record
  with the shared helper. It binds the comment URL, exact body and author to the reviewed
  SHA. Finish can use this record as commit evidence; a chat summary alone is not enough.
- **Findings or material blockers:** concise Markdown with reviewed head/base SHAs,
  severity-ordered findings, commit-pinned links, suggested corrections, checks actually
  performed, and validation limits. For follow-ups, summarize resolved and remaining
  findings rather than repeating the old review. Never include a standalone approve token.

Write the exact body to a file, then use the connector's top-level conversation comment
operation or `gh pr comment <n> --repo <remote> --body-file <file>`. Do not interpolate
comment text into shell commands. If publishing has an uncertain outcome, read comments
before retrying; never blindly duplicate a write. Save the returned URL and reviewed
SHA only after confirming publication. If blocked, retain the prepared file, record the
reason, and continue reviewing other PRs. Shared authentication/rate-limit failures may
block the remaining remote work; report those PRs as unreviewed rather than claiming
completion or retrying forever.

If an approval was posted but its record cannot be persisted, explicitly report
`approval record blocked` and the evidence location. Finish must not merge from that
token alone; it may recover the binding from complete server push history. Never
reconstruct the reviewed SHA from a later PR head. If history is ambiguous, finish leaves
the token pending. Repair the record only from saved original publication evidence;
do not post a duplicate token just because persistence failed.

Advance automatically after every outcome. Do not poll continuously for fixes, absorb
new runs into the snapshot, or invoke finish. End after this finite batch; another
invocation re-reviews the same batch after finish addresses findings.

## 5. Report the whole pass

Return the run ID/time/status (or explicit selection), counts, and one row per selected
PR: link, reviewed head, outcome (`LGTM posted`, `findings posted`, `reviewed in chat`,
`already reviewed`, `closed/merged`, `blocked`, or `unreviewed`), checks/limits, and
comment URL where posted. Include worktree restoration problems and saved unpublished
comments. Name and link this skill when it authorized posting. Suggest
`/dev-autofix:finish` as the next phase without running it.
