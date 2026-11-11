---
name: run
description: Spend leftover subscription budget on small, safe code fixes landed as signed draft PRs. Reads the budget snapshot written by the status line, consumes pre-planned entries from the autofix queue, works in reusable worktrees, gates every push through a diff and malware check, opens one PR per fix, and stops at a reserve. Invoke manually when the status line shows unused weekly budget.
disable-model-invocation: true
argument-hint: "[repo ...] [reserve=10] [max=5] [model=sonnet] [dry-run]"
---

# /dev-autofix:run - spend leftover budget on fixes

Manual, in-session, budget-aware fix loop. Runs until the weekly reserve is reached, the
5h window is nearly full, `max` fixes have landed, or no safe candidate remains.

Arguments override config for this run only (any order, `=` or `-` as separator): repo
names to limit scope, `reserve=N` weekly percent to leave untouched, `max=N` fixes,
`model=` for fix workers, `dry-run` to pick candidates and print the briefs without
branching or pushing.

**Authorization.** Invoking this skill is the user's explicit authorization for exactly
what it does: create `branchPrefix` branches, commit to them, push them, and open draft
PRs against `baseBranch`. Nothing else. It never merges, never pushes to the base branch,
never force-pushes, and never touches the user's own checkouts.

**Division of labour.** Workers edit, verify and commit. Only the lead pushes, and only
after the push gate (step 5) passes. A worker is a model that can be wrong or misled; the
gate is a check that cannot.

**Names used below.** `<plugin>` is this plugin's root, two directories above this
skill's base directory. `<config-file>` is the resolved path of `autofix.config.json`.

## 1. Load config

Resolve `autofix.config.json` from the current directory or any ancestor, else
`~/.claude/autofix.config.json`. Stop and tell the user to run `/dev-autofix:init` if it is
missing. Apply argument overrides on top. Resolve `queuePath` relative to the directory
holding the config; expand `~` in `worktreeRoot` and `usageSnapshotPath`.

Read [shared workflow state](../../references/workflow-state.md) and run its config
check. Require nonempty verification commands; acquire the run lock before recovery or
publication and each repo lock before worktree use. Acquiring them returns the `runToken`
and `repoToken` that the helpers below take; also persist one ISO `startedAt` for this
invocation. Release owned locks in a finally step after workers stop. A busy repo is
skipped, never reset.

Unless `dry-run`, run [delivery preflight](../../references/workflow-state.md#delivery-preflight)
for the selected repos before installing dependencies or launching workers:
`node <plugin>/scripts/preflight.mjs <config-file> <repo-name ...>`. On `ok: false`, report
the failed checks and stop before spending worker budget. Relay any `warnings`.

Stop if `worktreeRoot` resolves to a path inside any `repo.path`. A worktree nested in a
checkout gets picked up by that checkout's typecheck, lint and test globs.

## 2. Read the budget

The snapshot writer merges every session's status line refresh into one snapshot. Usage
only rises within a window, so the merged `pct5`/`pct7` never drop because an idle session
replayed an old reading. `observed5` and `observed7` are the observation times for their respective windows.
`observed_at` is their conservative minimum, or null until both have been observed.
`ts` is only the last write; **never judge freshness by `ts`**.

```bash
jq '{pct5, reset5, observed5, pct7, reset7, observed7}' <usageSnapshotPath>
```

First check the writer itself: if `~/.claude/usage-snapshot.mjs` is missing, or its
`shasum -a 256` differs from this plugin's `statusline/usage-snapshot.mjs` (two
directories up from this skill's base directory), stop and tell the user to run
`/dev-autofix:init`. A plugin update does not refresh the copied writer, and an old writer
emits a snapshot shape these steps misread.

**Budget unavailable.** The writer is installed but `latest.json` is missing, or either
`pct5` or `pct7` is null. That means the plan does not expose rate limits (API-key
billing, some enterprise setups), or this session has not had its first API response yet.
Full budget gating is impossible: proceed only if the user passed an explicit `max=N` and
confirms. After confirmation, skip the checks below for each missing window for the whole
run, but keep enforcing any window that is present - `max` covers only what is missing.
Without `max=N`, stop and explain both paths.

Otherwise stop immediately, and say which condition tripped, if:

- For each available window, its `observed5` or `observed7` is null, in the future, or
  older than `maxSnapshotAgeSeconds`. Do not substitute `observed_at` for missing
  per-window fields in an old snapshot. A new API observation is needed; refreshing
  an idle status line only changes `ts`. A partial update cannot renew the other window.
  These checks also apply to the available windows in bounded `max=N` mode.
- `reset5` or `reset7` is in the past - that window has reset since the last observation,
  so its number is meaningless. Treat as stale.
- `pct7 >= 100 - reserve`
- `pct5 >= fiveHourCeiling` - tell the user when the 5h window resets so they can
  re-invoke

Re-run this check before every wave and after every fix, and print the line each time so
the user can follow the burn.

**Size each wave to the headroom.** Workers in a wave run in parallel and the budget is
only re-read between waves. A fix's cost is not bounded in advance - a single worker can
use more than any estimate - so this sizing limits the risk of crossing the reserve; it
does not guarantee against it. The reserve itself is the buffer.

```
headroom   = min((100 - reserve) - pct7, fiveHourCeiling - pct5)
waveSize   = min(repos with a candidate, max - landed, floor(headroom / (2 * perFix)))
```

`perFix` starts at `perFixPercentEstimate` and becomes the largest per-worker `pct7` or
`pct5` delta observed so far this run; the factor of 2 is a safety margin for a fix that
costs more than any seen so far. If `waveSize` is 0, stop: the next fix could cross the
reserve. When the budget is unavailable (above), `waveSize` is just
`min(repos with a candidate, max - landed)`.

## 3. Prepare worktrees

Never touch the user's checkout. Hold the repo lock, then:

```bash
node <plugin>/scripts/pr.mjs prepare <config-file> <repo.name> <repoToken>
```

`prepare` runs the worktree guard, fetches the base, creates `<worktreeRoot>/<repo.name>` if
it is missing or detaches an existing clean tree onto `origin/<baseBranch>`, and re-checks the
guard. It runs `repo.install` when `node_modules` is missing or the lockfile digest changed
(writing the digest only after success), and runs `repo.prepare` until it has succeeded once
for the current tree, so a failed preparation is retried rather than skipped. Both
use the per-command timeout and `CI=1`, with logs under `review/scratch/prepare-*`. It never
resets, cleans or prunes.

Run it before the first entry and again between entries to switch the clean tree back to
the base. On failure, read `stage`:

- **`prune-needed`** - the tree is missing but still registered. Follow the shared
  [preparation and recovery procedure](../../references/workflow-state.md#worktree-preparation-and-recovery):
  confirm the folder was deleted (not moved or unmounted) and every
  `git worktree prune --dry-run --verbose --expire now` candidate is abandoned, prune, then
  run `prepare` again. Never prune on uncertainty.
- **`install` / `prepare`** - a command failed; `steps` has its log. Stop that repo.
- **`dirty`** - preparation left tracked or untracked changes. Preserve them and stop that repo.
- A thrown guard error (unfinished changes, active operation, unretained HEAD, foreign
  origin) means the tree holds work: quarantine a known failed attempt with the shared helper,
  or stop and report unknown changes.

## 4. Fix loop

One worker per repo at a time, since a worktree is single-occupancy. With several repos in
scope, run up to `waveSize` of their workers in parallel as a wave. Delegate each fix to
one `general-purpose` subagent on `workerModel`, and keep the lead's own context small -
the lead reads reports and helper output, not diffs.

`<pr>` below is `node <plugin>/scripts/pr.mjs`. Every helper prints JSON and exits nonzero
on a refusal; never continue a dependent step after one.

Between waves: gate and publish (step 5), safely switch the clean worktree (step 3),
re-read the budget (step 2), and stop when the count reaches `max` or a stop condition
trips.

**Check the queue first.** `<pr> queue lint <config-file>`. On `ok: false`, stop and
show the `errors`: a malformed queue makes helpers fail halfway through a run, or lets an
entry run that should not. Relay any `warnings` and continue.

**Sync PR outcomes.** Once per run, before the first wave and after fetching, check
every `pr-open (PR #n, ...)` entry:

```bash
gh pr view <n> -R <repo.remote> --json state,mergeCommit --jq '.state + " " + (.mergeCommit.oid // "")'
git -C <repo.path> merge-base --is-ancestor <oid> origin/<repo.baseBranch>
```

- `MERGED` and the merge commit is an ancestor of the fetched base:
  `<pr> queue set-status <config-file> <slug> "merged (PR #n, yyyy-mm-dd)"`.
- `CLOSED` without merging: set `blocked (PR #n closed unmerged)` the same way.
- Still open, or merged but not yet on the fetched base: leave it `pr-open`.

For every `pushed (<branch>, ...)` entry, look for its PR with
`gh pr list -R <repo.remote> --head <branch> --state all --json number,url`. If one exists,
verify its repository/head/base, register it with `state.mjs record-pr` (lead only, serial,
under the run lock), then set `pr-open (PR #n, ...)`. Otherwise check the branch out in the
managed worktree and re-run `<pr> publish` (step 5), which skips the push when the remote
branch already holds the gated head. Registration failure leaves the entry `pushed` and
stops publication until it is recovered.

**Pick the entry.** `<pr> queue next <config-file> <repo.name>` returns the first entry that
is `ready`, not `kind: security`, and whose `after:` is `none` or `merged` - or
`{"slug": null}`. A security entry is never executed automatically, even after a human
sets it to `ready`. A prerequisite that is only `pr-open` does not unlock anything: the
worktree starts from the base branch, which does not contain it yet.

When a repo has no ready entry:

- `fallbackSearch: false` (default) - skip the repo and say its queue is empty. Unplanned
  work is exactly what the planning step exists to prevent.
- `fallbackSearch: true` - brief the worker by hand with the search tiers below instead of
  `<pr> brief`: (1) failures from the repo's own verification commands; (2) actionable,
  re-verified items for this repo in `config.sources`; (3) TODO/FIXME comments with an
  obvious local fix. Skip anything covered by an open PR. Everything else in the
  [brief template](../../references/fix-brief.md) still applies. Before publishing a
  fallback fix, give it a queue entry so its status is tracked:
  `<pr> queue add-fallback <config-file> <repo.name> <slug> "<title>"`. The slug must
  match the branch `<branchPrefix>-<yyyymmdd>-<slug>`.

**Brief the worker.** `<pr> brief <config-file> <repo.name> <slug>` renders
[`references/fix-brief.md`](../../references/fix-brief.md) with the verbatim entry, the
hard rules, `config.forbidden` and `repo.forbidden`, verification commands, branch name and
PR-file path, and writes it to `briefFile`. Spawn the worker with a prompt that tells it to
read `briefFile` first and follow it exactly. With `dry-run`, print the briefs and stop.

After a worker fails or stops for scope/verification, mark the entry
`blocked (<reason>)` with `queue set-status` and save the failure context, HEAD and worker
status. Once all its workers have stopped, quarantine unfinished work using the shared
helper, report the recovery path, and prepare a fresh managed tree for the next eligible
entry. Do not retry the same blocked entry automatically. Clean retained branches can stay
local while the tree is reused.

## 5. Gate and publish (lead)

For each worker that reported a branch, with the worktree still on that branch:

```bash
<pr> publish <config-file> <repo.name> <repoToken> <runToken> <startedAt> <slug>
```

`publish` runs the push gate, then pushes, records `pushed`, discovers or creates the draft
PR, verifies its repository/head/base, registers it in `last-run.json`, and records
`pr-open`. Read its `stage` on failure:

- **`gate`** - the branch is not pushed and the entry is already `blocked (push gate:
  <checks>)`. Leave the branch local for the user and continue with other repos. A
  `risky` check means the fix added a construct malware also uses (`eval(`,
  `new Function(`, `createRequire`): that entry needs a human, and the run carries on. If
  `stopRun` is true, a known **malware signature** was found: stop the whole run, push
  nothing further, and tell the user to treat the machine as suspect.
- **`pr-file`** - nothing was pushed. The PR file breaks a rule in `problems` (title
  length, the word "draft", or a deploy step matching `deployPatterns` that the entry
  names but the body drops). Fix
  `<worktreeRoot>/pr/<slug>.md` and run `publish` again.
- **`create` / `discover` / `identity` / `register`** - the branch is pushed and the entry
  stays `pushed`. Report it; the next run's recovery pass finishes it. Never retry blindly.

`<pr> gate <config-file> <repo.name> <repoToken> run <slug>` runs the same checks
read-only, without publishing. The gate checks every outgoing commit, not just the net diff,
because a payload added in one commit and removed in the next is still published:

0. **Shape.** The worktree is on the entry's fix branch, based on the freshly fetched base,
   with at least one commit and no merge commits.
1. **Files.** No commit touches `.gitignore`, `.env*`, a dependency manifest or lockfile
   of any ecosystem (`package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`,
   `Cargo.toml`, `Gemfile` and their lockfiles), package manager config (`.npmrc`,
   `.yarnrc`), CI or hook config (`.github/`, `.husky/`, `.circleci/`, `.gitlab-ci.yml`,
   `.pre-commit-config.yaml`), a shell or Windows script, a build file (`Makefile`,
   `justfile`, `Taskfile`, `Dockerfile`, compose files), a build/lint tool config
   (`postcss`/`eslint`/`next`/`vite` config, `tsconfig*.json`, `wrangler.*`,
   `.graphqlrc.*`), or a path matching `protectedPaths` (global or per repo), and none
   makes a file executable. An entry that genuinely needs one of these must be done by a
   human.
2. **Size.** Net insertions plus deletions are within the limit: `maxDiffLines`, or the
   entry's stated size plus 50% when that is larger. Moved code counts once: a branch over
   the limit still **auto-passes** when its effective size (raw minus lines moved as contiguous
   blocks of 3 or more) is within the limit and its raw size is within 1.5 x `maxDiffLines`. `publish`
   then adds a `Size:` line to the PR body and returns `sizeAutoPassed: true`; say so in the
   report. Only when the user explicitly asks to push a refused branch, re-run
   `publish ... <slug> --max-diff <N>`. It needs no status reset, and adds a
   `Size override:` line to the PR body.
3. **Malware signatures and risky constructs.** No added line matches a built-in
   malware signature (`MALWARE_SIGNATURES` in `scripts/lib/gate.mjs`) or a `blockPatterns`
   entry; a match sets `stopRun`. No added line matches a risky construct
   (`RISKY_CONSTRUCTS` there: `eval(`, `new Function(`, `createRequire`); a match is the `risky`
   check and blocks only that entry. `disabledPatterns` switches built-ins off by id.
4. **Signed.** Every outgoing commit passes `git verify-commit`. SSH signing needs
   `gpg.ssh.allowedSignersFile` configured; if verification fails for that reason, tell the
   user to configure it.
5. **Clean.** No uncommitted or untracked files.

**Run manifest.** `/dev-autofix:review` and `/dev-autofix:finish` act on exactly the PRs
the last run registered. The first registration of a run replaces `last-run.json`; later
ones upsert into the same batch; a run with no registrations leaves the previous manifest
in place. Never hand-edit or truncate it.

Never push to `baseBranch`, never force-push, never merge.

**Inbox.** Append candidates a worker mentioned with
`<pr> queue inbox <config-file> "<one-line item>"`, for the next `/dev-autofix:plan`.

A `blocked` entry is a signal, not an error: it usually means the base moved under a plan.
Several in one run means the queue needs re-planning.

## 6. Report

A table: PR, repo, one-line summary, verification run. Then one line with budget before and
after (`wk 61% -> 84%`, `5h 12% -> 58%`), the number of fixes landed, and how many `ready`
entries remain per repo. List any branch the push gate refused, with the failing check and
its local path.

Finish with anything a worker flagged that a human needs to see: real bugs found but not
taken, and anything that looked like a security issue. Those never become autofix PRs, so
surfacing them here is the only way they reach the user.

Include `state.mjs list-recovery <config-file>` output in the final report: preserved
paths, reasons, allocated bytes per tree and total, including older recovery trees.
