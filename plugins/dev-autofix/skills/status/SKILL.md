---
name: status
description: Show where an autofix workspace stands without changing anything. Reports the budget, queue counts per repo, the last run's PRs with their review state, held locks and preserved recovery folders, and says which command comes next.
disable-model-invocation: true
argument-hint: "[repo ...]"
---

# /dev-autofix:status - where things stand

Read-only. Take no locks, start no workers, and do not fix, push, comment or merge
anything, even if the report shows a problem. Report it and name the command that deals
with it.

`<plugin>` is this plugin's root, two directories above this skill's base directory.
Arguments: repo names to limit the report (default: all).

## 1. Local state

Resolve `autofix.config.json` from the current directory or any ancestor, else
`~/.claude/autofix.config.json`. If there is none, say so and suggest
`/dev-autofix:init`. Then run:

```bash
node <plugin>/scripts/status.mjs <config-file>
```

It reads files only (no git, no `gh`) and returns:

- `runtime` - the platform and Git version check
- `budget` - `state` is `ok`, `stale`, `reserve-reached`, `five-hour-ceiling`,
  `unavailable` or `writer-outdated` (run `/dev-autofix:init`), with the reason and each
  window's numbers. It is the same gate `/dev-autofix:run` uses, read at this moment.
- `queue` - counts per repo by status, `next` (the entry run would take now),
  `needsHuman` (each open decision) and lint results
- `lastRun` - the run manifest: when it started and the PRs it registered
- `locks` - who holds the run lock or a repo lock
- `worktrees`, `recovery` - managed worktrees and preserved failed attempts

## 2. Review state of the last run's PRs

For each PR in `lastRun.prs` (in scope), classify its review timeline. This reads
GitHub and writes nothing (no output file is given, so none is created):

```bash
node <plugin>/scripts/pr.mjs approval-input <config-file> <repo> <number>
```

Use `classification`: `awaiting review`, `address` (feedback is pending), `approve`
(the current head is approved), `stale` (approved an earlier head),
`evidence-unavailable`, or `skipped` (closed, merged or not an autofix PR; report
`reason`). If `gh` is unavailable, say the review state could not be read and carry on.

## 3. Report

Keep it short. In this order, leaving out anything empty:

1. One line for the budget: both percentages, and whether a run would start.
2. A table per repo: ready, needs-human, blocked, pr-open, merged, and `next`.
3. Each `needs-human` decision, verbatim. These are what the user has to answer.
4. The last run: start time, and one row per PR with its link and classification.
5. Held locks (session, command, since when) and recovery folders with their size.
6. Lint errors, and a failed runtime check.

Finish with the single most useful next command:

| Situation | Suggest |
|---|---|
| A lock is held and no session is running | read `references/lock-recovery.md` before anything else |
| PRs classify as `approve` or `address` | `/dev-autofix:finish` |
| PRs are `awaiting review`, `stale` or `evidence-unavailable` | `/dev-autofix:review` |
| Ready entries and budget `ok` | `/dev-autofix:run` |
| No ready entries | `/dev-autofix:plan`, or answer the `needs-human` decisions |
| Budget `stale` or `unavailable` | send a message to refresh the status line, or `/dev-autofix:init` |
