# Dev Autofix

Spends **leftover Claude subscription budget** on small, safe code fixes, landed as signed
draft PRs. Staff dev tooling; not for client installs.

The weekly budget resets whether or not you use it. If the window is at 60% on a Friday,
the other 40% expires. Autofix turns that into reviewed draft PRs for work you already
decided was worth doing, and stops at a reserve so it never eats the budget you need.

## Three pieces, one system

| | What it does |
|---|---|
| **Budget snapshot** | `statusline/usage-snapshot.mjs`, piped from your status line. Persists the rate limits the skills gate on. The data source, not decoration. |
| **`/dev-autofix:plan`** | Research. Investigates the repos, verifies findings against the base branch, writes a backlog of pre-verified one-PR fix plans. |
| **`/dev-autofix:run`** | Execution. Reads the budget, takes plans off the backlog, fixes them in throwaway worktrees, gates each branch, opens one draft PR each, stops at the reserve. |

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

## Quickstart

```
/dev-autofix:init          # detect repos, write autofix.config.json, check budget wiring
/dev-autofix:plan          # fill the backlog with verified fix plans - review it
/dev-autofix:run           # spend leftover budget landing them as draft PRs
```

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
```

## Configuration

`/dev-autofix:init` writes `autofix.config.json` at the workspace root (the common parent of
the repos, for example `DFC/`), validated by [the schema](schema/autofix.config.schema.json).
A worked DFC example is in [examples/autofix.config.json](examples/autofix.config.json).

The fields that matter most:

- **`baseBranch`** - what PRs target. The integration branch (`staging` in most DFC repos),
  never production.
- **`verify`** - commands that must pass before a PR opens. Fast and non-interactive;
  nothing that starts a server, needs secrets from Infisical, or touches a database.
- **`forbidden`** (global and per repo) - hard rules appended to every brief. Put each
  repo's `CLAUDE.md` rules here; fix workers start with a fresh context and will not
  otherwise know them.
- **`reservePercent`** - the weekly budget to leave alone. A run stops at `100 - reserve`.
- **`fallbackSearch`** - off by default. When on, a repo with an empty queue lets its
  worker pick its own fix. That skips your backlog review, so leave it off unless you
  mean it.
- **`sources`** - audit documents the planner mines for candidates. Treated as dated
  leads and re-verified before use.

Worktrees live under `~/.claude/autofix/worktrees`, outside every checkout. A worktree
nested inside a repo gets swept up by that repo's `tsc`, ESLint and Vitest globs.

## Safety model

This plugin writes code and pushes branches, so the boundaries are explicit.

**Invoking `/dev-autofix:run` is the authorization.** It covers `branchPrefix` branches, their
commits and pushes, and draft PRs against `baseBranch`. Nothing else.

**Your checkouts are never touched.** Every fix happens in a detached worktree, reset
between waves. Your working tree, branches and stashes are left alone.

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
green. Nothing is ever merged.

**Budget gating fails closed.** A run stops if the snapshot is missing, stale, or shows the
reserve reached. Parallel waves are sized from twice the largest per-fix cost seen so
far. That limits the risk of crossing the reserve but cannot rule it out, because one
fix's cost is not known in advance; the reserve is the buffer, so size it accordingly.

**Risky work is quarantined, not attempted.** The planner marks anything that changes
observable behaviour, touches auth or crypto, changes dependencies, needs a gate-refused
file, or deletes code on weak evidence as `needs-human`, with the specific decision
written out.

## Requirements

- A Claude subscription plan that exposes rate limits. Without one, `/dev-autofix:plan` still
  works and `/dev-autofix:run` needs an explicit `max=N`.
- `git` with commit signing configured, `gh` (authenticated), `node`, `jq`
- Repos with non-interactive lint/typecheck/test commands

## FAQ

**Does it merge anything?** No. Draft PRs only, never merged, never pushed to the base
branch.

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
