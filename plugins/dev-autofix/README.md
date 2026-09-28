# Dev Autofix

Spends **leftover Claude subscription budget** on small, safe code fixes, landed as signed
draft PRs, then acts on your review of them. Staff dev tooling; not for client installs.

The weekly budget resets whether or not you use it. If the window is at 60% on a Friday,
the other 40% expires. Autofix turns that into reviewed draft PRs for work you already
decided was worth doing, and stops at a reserve so it never eats the budget you need.

## Five pieces, one system

| | What it does |
|---|---|
| **Budget snapshot** | `statusline/usage-snapshot.mjs`, piped from your status line. Persists the rate limits the skills gate on. The data source, not decoration. |
| **`/dev-autofix:plan`** | Research. Investigates the repos, verifies findings against the base branch, writes a backlog of pre-verified one-PR fix plans. |
| **`/dev-autofix:run`** | Execution. Reads the budget, takes plans off the backlog, fixes them in reusable worktrees, gates each branch, opens one draft PR each, stops at the reserve. |
| **`/dev-autofix:review`** | Review. Walks every PR from the last run automatically, reuses existing worktrees for validation, and posts findings or exact `LGTM` comments for `finish`. Works in Codex as `$review` too. |
| **`/dev-autofix:finish`** | Follow-through. Reads your comment on each PR. Concerns: an Opus worker addresses them, the lead gates and pushes, then posts what was done. `LGTM`: merges only the exact approved head. Tests clean base integration locally while retaining approval of the unchanged PR head. Removes only the clean shared worktree after checking older work too. Walks the PRs the last run opened in number order, reusing run's worktrees. |

Planning and fixing are separate on purpose. Planning is expensive, reads widely and needs
judgement. Fixing is cheap, reads one plan and needs obedience. Splitting them means the
fix loop never burns budget re-deriving what to do, and **you review the backlog before any
code is written**.

## Install

```
/plugin marketplace add DigitalFuelCapital/dfc-claude-plugin
/plugin install dev-autofix@dfc-claude-plugin
```

Then run `/dev-autofix:init` once per machine. Plugins cannot ship a status line, so init
wires up the budget snapshot for you: it copies the writer to `~/.claude/`, proposes the
one-line addition to your existing status line (or installs the bundled one), and adds
`refreshInterval`. It shows each change and asks before touching your global config.
`/dev-autofix:run` re-checks the wiring every time and tells you to re-run init if a plugin
update changed the writer. Manual steps: [statusline/README.md](statusline/README.md).

### Codex

Codex supports this repository's Claude-compatible marketplace and plugin manifests.
With a current Codex CLI, register the repository and install the plugin:

```bash
codex plugin marketplace add DigitalFuelCapital/dfc-claude-plugin
codex plugin add dev-autofix@dfc-claude-plugin
```

To try local changes before publishing, register the local checkout instead of the
GitHub source, then install with the same `codex plugin add` command:

```bash
codex plugin marketplace add /absolute/path/to/dfc-claude-plugin
```

Start a new thread after installation and invoke
`$review` from the workspace containing `autofix.config.json` or one of its repos.
The repository is the marketplace; `dev-autofix` is the plugin to install.

The new review skill uses the config, manifest, and worktrees produced by Claude's run
phase, without needing its budget snapshot or the separately installed `pr-review`
skill. `init`, `plan`, `run`, and `finish` still contain Claude-specific setup, budget,
or worker instructions; installing the package does not port those workflows to Codex.
See [OpenAI's plugin compatibility documentation](https://developers.openai.com/plugins/build/plugins).

## Quickstart

```
/dev-autofix:init          # detect repos, write autofix.config.json, check budget wiring
/dev-autofix:plan          # fill the backlog with verified fix plans - review it
/dev-autofix:run           # spend leftover budget landing them as draft PRs
/dev-autofix:review        # review every PR from that run and post findings or LGTM
/dev-autofix:finish        # after you comment on the PRs: address concerns or merge
```

**Reviewing.** Run `/dev-autofix:review` (or `$review` in Codex) to review all PRs in
`<worktreeRoot>/last-run.json`, sequentially, without prompting between PRs. It leaves
findings or exact `LGTM` comments under your authenticated account. Individual blockers
are reported and the pass continues. Use `review-only` for chat results without posting.
It can temporarily check out PR heads in existing clean run worktrees and restores
their original branch/commit afterward. Dirty, busy, or missing worktrees use remote
review instead. Do not run `run`, `review`, or `finish` concurrently on shared worktrees.

You can also comment manually - an issue comment, a review body or inline comments.
Then run `/dev-autofix:finish`. A PR is merged only when its sole pending review is an
exact approve token (`LGTM` or `/merge` by default) bound to the current head. The review
skill saves commit evidence; formal GitHub reviews supply `commit_id`, and manual
conversation approvals can be bound using complete server push history. Ambiguous
history leaves approval pending. Finish verifies a local merge with the latest base
without pushing it, so clean PRs can merge consecutively in one pass. Publishing a
conflict resolution or other head change requires another review. Anything else,
including "LGTM but rename X", is treated as feedback to address.

Finish checks every PR in `<worktreeRoot>/last-run.json`, oldest first, using the shared
worktree for each repo. After it addresses findings, run review again for the next pass.
Review does not apply fixes or invoke finish, and never adds finish's reply marker.

Review `AUTOFIX_QUEUE.md` between plan and run. Entries marked `needs-human` are waiting on
a decision only you can make; they are never auto-executed. Flip them to `ready` once you
have decided - except `kind: security` entries, which autofix never executes and you fix
by hand.

Useful arguments:

```
/dev-autofix:run reserve=25      # leave a quarter of the week untouched
/dev-autofix:run max=2           # cap at two PRs
/dev-autofix:run dry-run         # pick candidates and print the briefs, change nothing
/dev-autofix:run dfc-tools       # one repo only
/dev-autofix:run model=haiku     # cheaper fix workers
/dev-autofix:review             # the full last-run batch; Codex: $review
/dev-autofix:review dfc-tools    # review one repo's PRs from the last run
/dev-autofix:review pr=42        # explicit PR; qualify with a repo if ambiguous
/dev-autofix:review review-only # review in chat, no GitHub comments
/dev-autofix:finish dry-run      # show which PRs would be addressed vs merged
/dev-autofix:finish pr=42        # one PR only
```

## Configuration

`/dev-autofix:init` writes `autofix.config.json` at the workspace root (the common parent of
the repos, for example `DFC/`), validated by [the schema](schema/autofix.config.schema.json).
A worked DFC example is in [examples/autofix.config.json](examples/autofix.config.json).

The fields that matter most:

- **`baseBranch`** - what PRs target. The integration branch (`staging` in most DFC repos),
  never production.
- **`verify`** - required nonempty commands that must pass before a PR opens or merges.
  Fast and non-interactive;
  nothing that starts a server, needs secrets from Infisical, or touches a database.
- **`commandTimeoutSeconds`** (per repo) - timeout for each merge-verification install,
  prepare and verify command; default 600 seconds, range 1-3600. Commands run with
  `CI=1`; timed-out process groups are terminated and recorded as failures.
- **`forbidden`** (global and per repo) - hard rules appended to every brief. Put each
  repo's `CLAUDE.md` rules here; fix workers start with a fresh context and will not
  otherwise know them.
- **`reservePercent`** - the weekly budget to leave alone. A run stops at `100 - reserve`.
- **`fallbackSearch`** - off by default. When on, a repo with an empty queue lets its
  worker pick its own fix. That skips your backlog review, so leave it off unless you
  mean it.
- **`sources`** - audit documents the planner mines for candidates. Treated as dated
  leads and re-verified before use.
- **`reviewers`**, **`approveTokens`**, **`mergeMethod`** - whose comments
  `/dev-autofix:finish` acts on (default: your `gh` login), which exact comments mean
  "merge" when bound to the current head, and how (default `squash`).

Worktrees live under `~/.claude/autofix/worktrees`, outside every checkout. A worktree
nested inside a repo gets swept up by that repo's `tsc`, ESLint and Vitest globs.

## Safety model

This plugin writes code and pushes branches, so the boundaries are explicit.

**Invoking `/dev-autofix:run` is the authorization.** It covers `branchPrefix` branches, their
commits and pushes, and draft PRs against `baseBranch`. Nothing else.

**Review requires explicit invocation in Claude Code and Codex.** Invoking it authorizes
review comments and temporary use of existing run worktrees. Clean reviews post exactly
`LGTM`, which finish or other configured automation may treat as merge approval.
`review-only` posts nothing; a do-not-merge instruction suppresses approval tokens.
Review never fixes, commits, pushes, merges, or removes worktrees. Its comment author
must be in `reviewers` for finish to consume the results, and `approveTokens` must
include `LGTM` for clean approvals.

**Invoking `/dev-autofix:finish` is the authorization to follow through.** It covers
signed commits (including merges of the base) and fast-forward pushes to the PR's own
branch, PR comments, and - only on an exact approve token from a listed reviewer bound
to the current head - marking the PR ready and merging the approved, verified commit.
Cleanup preserves dirty, busy, advanced, and older/interrupted work. Remote deletion
uses an expected-tip lease for the confirmed merged branch. Comments from anyone else
are never acted on. Review pushes go through the same gate, adapted so the only merge
commits allowed are ones that bring in the base; conflict resolutions are checked like
any other code.

**Your checkouts are never touched.** Fixes use one shared worktree per repo. The run,
review, and finish phases acquire the same ownership lock. The shared guard rejects
wrong repositories, dirty trees, active Git operations, and unretained commits before
checkout. No reset, clean, or forced worktree removal is used. Known failed
attempts move intact to unique recovery worktrees once workers stop, allowing the next
fix to use a fresh managed tree. Unknown changes remain in place. Confirmed stale
worktree registrations can be pruned before recreating a deleted tree.

**Fix workers never push.** They edit, verify and commit. The lead pushes only after a
deterministic gate passes on the branch:

- no touched `.gitignore`, `.env*`, lockfile, `package.json`, `.github/`, git hook, script
  file or build/lint tool config (the files the 2026 dev-environment malware campaign
  plants itself in)
- diff within the size cap
- no added line matching a known malware signature or a `blockPatterns` entry - a match
  stops the whole run and flags the machine as suspect
- every commit signed
- nothing left uncommitted

**Every fix worker is also barred from:** starting dev or preview servers, running browser
or e2e tests, deploying, creating or running migrations, touching secrets, changing
dependencies, acting on anything filed under a security heading, bare `git stash`,
unsigned commits, `--no-verify`, force-pushing and pushing to the base branch.

**Every PR is a draft**, one concern, under a diff cap, with the repo's own verification
green. `/dev-autofix:run` never merges. `/dev-autofix:finish` merges only when you
approve the exact PR head, and only after its integration with the latest base and CI
pass. The helper executes verification commands itself and stores results/logs. Its
unsigned synthetic commit stays under private `refs/autofix/verify/` refs and is never
pushed. A published head change needs review. Strict up-to-date rules may still require
a sync and another review; merge queues remain pending until GitHub confirms the merge.

**Budget gating fails closed.** A run stops if the snapshot is missing, stale, or shows the
reserve reached. Parallel waves are sized from twice the largest per-fix cost seen so
far. That limits the risk of crossing the reserve but cannot rule it out, because one
fix's cost is not known in advance; the reserve is the buffer, so size it accordingly.

**Risky work is quarantined, not attempted.** The planner marks anything that changes
observable behaviour, touches auth or crypto, changes dependencies, needs a gate-refused
file, or deletes code on weak evidence as `needs-human`, with the specific decision
written out.

## State checks and recovery

[scripts/state.mjs](scripts/state.mjs) handles ownership, worktree checks, PR registration,
recovery and approval evidence. [scripts/merge.mjs](scripts/merge.mjs) executes local
integration verification and records command results itself.
[scripts/pr.mjs](scripts/pr.mjs) owns the queue (`queue next/set-status/inbox`), fix
briefs (`brief`, from [references/fix-brief.md](references/fix-brief.md)), the push gate
(`gate`), publication (`publish`), approval evidence (`approval-input`) and post-merge
cleanup (`cleanup`, `remove-worktree`). See the
[shared state contract](references/workflow-state.md). The model still reviews code,
waits for CI and invokes the final merge.

Run recovery registers PRs found after an uncertain creation result before setting
queue status to `pr-open`. Registration retries are idempotent. The latest run's manifest
remains the default review scope; cleanup additionally checks older outstanding PRs.

Locks are not automatically stolen after a timeout. An interrupted session can leave a
lock and unfinished work. Locks automatically find the Claude/Codex ancestor and record
its PID, process start time and host, alongside the session and command. Use
`inspect-lock`, `resume-lock`, or checked `break-lock` as documented in the shared
contract. Abandoned and ownerless locks can be recovered after confirming workers have
stopped. Shared runtime daemons remain live across conversations, so a live daemon lock
must be released by its owning session. Review can inspect remote contents while local
use is blocked. `state.mjs list-recovery <config-file>` reports preserved worktrees and
the disk space they occupy, including dependencies.

Durable review/approval records now live in `review/records/`; prepared comments and
reports use `review/scratch/`. Records compare by fields, independent of JSON key order.

**Version 3.2.0:** the push gate counts moved code once. A branch over the size limit
auto-passes when its effective size (raw minus lines moved as contiguous blocks of 3+) is within the
limit and its raw size is within 1.5 x `maxDiffLines`; the PR body says so. A user-approved
`publish --max-diff N` covers the rest. New helpers `prepare` (worktree and dependencies) and
`land` (verify, CI, re-check, merge, cleanup) replace the remaining hand-chained steps in run
and finish.

**Version 3.1.1:** `remove-worktree` no longer times out after 120 seconds while Git deletes a
worktree with `node_modules`; that command now gets up to 30 minutes.

**Version 3.1.0:** no config changes. The steps the first live cycle showed being
improvised now live in `scripts/pr.mjs`. Finish binds approvals from review's records
before falling back to push history. Cleanup treats a branch that GitHub already
auto-deleted on merge as done. The push gate's size cap is `maxDiffLines`, or the entry's
stated size plus 50% when that is larger. Publish refuses a PR body that drops a deploy
step the entry names. `perFixPercentEstimate` now defaults to 2.

**Version 3.0.0:** upgrading from 2.x requires nonempty `verify` commands for every repo.
The plugin version changes; the config file still uses `version: 1`.

After updating, run Claude's `/dev-autofix:init` to refresh the copied budget writer.
Both `observed5` and `observed7` must receive fresh API observations; an idle status-line
refresh does not renew them. Manual approvals use server push history when no saved
record exists; incomplete evidence leaves the comment pending. Existing configs must
supply at least one nonempty `verify` command.

Run the isolated regression suite from the repository root:

```bash
node --test plugins/dev-autofix/tests/*.test.mjs
```

## Requirements

- For review alone: Codex or Claude Code, authenticated `gh` (or a GitHub connector),
  the existing autofix config and run manifest, and `git` for optional worktree tests.
- For the Claude budget workflow: a Claude subscription plan that exposes rate limits.
  Without one, `/dev-autofix:plan` still works and `/dev-autofix:run` needs an explicit `max=N`.
- `git` with commit signing configured, `gh` (authenticated), `node`, `jq`
- Repos with non-interactive lint/typecheck/test commands

## FAQ

**Does it merge anything?** Only through `/dev-autofix:finish`, when an exact approve
token is bound to the current PR head, local integration with the latest base passes
verification, and required CI/branch rules allow merging. Clean integration preserves
approval; publishing a new PR head requires review. Nothing is pushed directly to the
base branch or force-pushed over existing work.

**What if the queue is empty?** With `fallbackSearch` off (the default), the repo is
skipped and the report tells you to run `/dev-autofix:plan`.

**What if a plan no longer matches the code?** The worker stops and reports `plan did not
hold`, and the lead marks the entry `blocked`. Several blocked entries in one run means the
base moved and the queue needs re-planning.

**What happens to a branch the gate refuses?** It stays local in the worktree, unpushed,
and the report lists it with the failing check so you can inspect it.

**Why keep "draft" out of PR titles?** Some review bots skip anything that looks
draft-titled. The PR itself is still opened as a draft.

## License

MIT - see [LICENSE](LICENSE). Originally derived from an MIT-licensed project; the
copyright notice is retained as the license requires.
