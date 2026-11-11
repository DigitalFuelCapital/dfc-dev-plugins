# Approval records

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

`<worktreeRoot>/review/records/` holds two kinds of file:

- `<repo>-pr<N>-comment<ID>.approval.json` - the immutable approval record review saves
  after publishing an `LGTM`. Finish binds approvals from these first.
- `<repo>-pr<N>-<headSha>.json` - review's own per-round state (reviewed head/base,
  validation results, posted comment). Finish does not read these.

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

An approval is an exact token (`LGTM` or another `approveTokens` entry), either alone or
followed by the commit it reviewed:

```text
LGTM
Reviewed head: <40-character sha>
Checks: <free text, optional>
```

Any other text makes the comment feedback. Review posts the two-line form, which states
its own commit, and also saves the record above. A comment that names its head is accepted
only for that head, and only if it has never been edited (anyone with write access can
edit a comment).

`node <plugin>/scripts/pr.mjs approval-input <config> <repo> <n> <out>` builds the input
the checker (`state.mjs approval`) and `merge.mjs` consume: `remote`, `number`, `headRef`,
current `headSha`, `reviewers`, `approveTokens`, the deciding `pending` entry, and its
evidence: a `record` (preferred), the comment's own `Reviewed head`, a formal review's
`commitSha`, or `history`. Only non-dismissed `APPROVED`/`COMMENTED` formal reviews with an
exact token qualify.

When every pending entry is an approval, the newest decides and the older ones are
returned as `superseded`. This is how an approval that could not be bound is cleared: the
reviewer approves again. A pending entry that is not an approval is never superseded; it
makes the classification `address`.

## Manual conversation approvals

Without a record or a `Reviewed head` line, a bare `LGTM` is bound using server push history
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
