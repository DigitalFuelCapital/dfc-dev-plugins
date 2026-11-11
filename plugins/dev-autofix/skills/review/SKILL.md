---
name: review
description: Review every autofix PR from the last run, continuing automatically between PRs and reusing run worktrees for validation. Publish findings or exact LGTM comments for finish to consume. Use for batch autofix reviews in Codex or Claude Code, including re-reviews after finish addresses findings.
disable-model-invocation: true
---

# Review the autofix PR batch

Invoke as `$review` in Codex or `/dev-autofix:review` in Claude Code. Accept optional
repo names, `pr=N` (repeatable), and `review-only`. By default, process **every PR in
the last run**, one repo at a time in config order, ascending PR number within each
repo. Complete the whole pass without asking to move to the next PR. Findings, closed
PRs, and individual validation failures do not end the pass.

This is the review phase between `run` and `finish`. The skill is self-contained: it
needs no other review skill installed. Do not invoke `run` or `finish`, fix source, or
merge anything during this phase.

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

Read [shared workflow state](../../references/workflow-state.md). `<plugin>` below is
this plugin's root, two directories above this skill's directory. Run the config check
before local validation; missing verification blocks readiness, but other PRs may still
be inspected remotely. Use its repo ownership lock and worktree check for local work,
and its immutable approval record format when publishing `LGTM`.

Read `<worktreeRoot>/last-run.json` once and retain the snapshot for this pass:

```json
{
  "startedAt": "2026-09-26T12:00:00Z",
  "prs": [
    {"repo": "my-app", "number": 42, "branch": "fix/auto-20260926-example", "url": "https://github.com/your-org/my-app/pull/42"}
  ]
}
```

Match `repo` to a unique configured name, deduplicate by `(remote, number)`, and apply
repo filters. Reject malformed entries or unknown repos with a reported reason. Do not
search all open PRs or silently fall back to a different batch. A missing/invalid
manifest blocks default discovery; an empty manifest/filter result is a completed empty
pass. A run that opened no PRs retains the previous manifest, so report `startedAt`.

Explicit `pr=N` arguments replace manifest selection and can review earlier runs.
Resolve each number to a configured repo in scope; ask only if ambiguous. Continue
unambiguous entries while waiting. Without a manifest, explicit selection still works.
Require an explicit PR to use the configured `branchPrefix` followed by `-` (default
`fix/auto-`), and require a manifest PR's head branch to match its recorded `branch`.
Never follow a manifest URL to a different repository.

If the identity that will post isn't in `reviewers` (default: the `gh api user` login),
review in chat only and report the mismatch.
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

## 3. Validate locally with the helper

Local checks reuse `<worktreeRoot>/<repo.name>` at the unchanged PR head; never merge the
base into it or copy run/finish's reset, clean, sync or cleanup commands. First inspect
`repo.install`, `repo.prepare` and `repo.verify` against repository rules and
`forbidden`: never run fix-mode commands, migrations, deployments, production writes or
checks needing production secrets.

Acquire `<worktreeRoot>/.locks/repo-<repo.name>` with the shared helper, write
`{number,headSha,baseSha}` from the reviewed snapshot to a file under `review/scratch/`,
then run:

```bash
node <plugin>/scripts/review.mjs verify <config-file> <repo.name> <repoToken> <input-file>
```

It runs install plus the full prepare/verify suite, so give it a long command timeout (or
none). It checks worktree, origin and PR identity, detaches at the exact head, runs the
commands with deadlines, and restores the original checkout. Only `status: passed`
counts as local evidence; keep its receipt path in this PR's record. If the lock is busy,
the helper fails, or restoration fails (the receipt says so; never discard its
artifacts), review remotely and stop local use for that repo. Release the lock in a
finally step. Save any extra reproductions under `review/scratch/`, labelled separately.

Remote review remains useful when local checks are unavailable. Decide whether that
limit materially blocks readiness. Do not approve if necessary validation is incomplete,
required checks failed/pending, or a review blocker remains. Record each limit and
continue to the next PR instead of waiting indefinitely for CI or another session.

## 4. Publish once, then advance

Immediately before publishing, re-read PR state, head/base SHAs, checks, and all comments.
If closed/merged, skip posting. If head or base changed, inspect the delta and revalidate
affected conclusions once. If it changes again, publish only a qualified report of the
exact reviewed SHAs and unreviewed delta, never `LGTM`, then advance.

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

Return the manifest run time (or explicit selection), counts, and one row per selected
PR: link, reviewed head, outcome (`LGTM posted`, `findings posted`, `reviewed in chat`,
`already reviewed`, `closed/merged`, `blocked`, or `unreviewed`), checks/limits, and
comment URL where posted. Include worktree restoration problems and saved unpublished
comments. Name and link this skill when it authorized posting. Suggest
`/dev-autofix:finish` as the next phase without running it.
