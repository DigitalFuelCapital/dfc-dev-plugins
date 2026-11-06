# Dev Autotask

Take one large development task from plan to merge as one branch and one PR. Claude plans,
implements and finishes; Codex reviews. GitHub (the PR, its head SHA, CI and
`gh pr merge --match-head-commit`) holds most of the state.

## Flow

1. `/dev-autotask:plan [repo:] <request or report path>` - Claude investigates and writes
   `plan.md`, shows it, and stops. Ask for changes, or approve by running the next step.
   With no request it suggests 3-5 candidate tasks (from TODO/FIXME clusters, open
   issues and dev-autofix backlog items too large for a small fix) and waits for a pick.
2. `/dev-autotask:run <id>` - Claude implements the plan in a dedicated worktree, runs the
   configured checks, pushes and opens one draft PR, then stops.
3. `$task-review <pr>` in Codex - reviews the PR against its plan, runs the checks if it can, and
   posts one comment: findings, or `LGTM`, bound to the reviewed head SHA.
   (`/dev-autotask:task-review` works in Claude Code too.)
4. `/dev-autotask:finish <id>` - Claude addresses findings and pushes; go back to step 3.
   Once the current head has an LGTM, `/dev-autotask:finish <id> merge` merges it.

Nothing reviews or merges automatically. Each step stops and tells you the next one.

## Security audit

`/dev-autotask:infiltrate [objective]` runs before step 1. Three Claude agents each audit
one area of a detached checkout of `origin/<baseBranch>`, then each tries to disprove
another agent's findings. `scripts/audit.mjs` merges their JSON into a local
`report.md`; a finding counts as confirmed only when a different agent confirmed it and
none rejected it. Agents inspect code and run proofs of concept only in throwaway copies
with an empty environment; nothing touches deployed systems or leaves your machine.

Remediate with `/dev-autotask:plan <report.md> [finding IDs]`, then the normal flow.
Plan re-checks each finding against the current base. Before pushing a security fix,
`run` checks the repository's visibility and asks first if it is public, since the fix
and its tests disclose the vulnerability.

## Rules

- One task, one branch (`dev/autotask-<id>`), one PR. Resuming reads `task.json`; it never
  opens a second PR.
- Never force-push, never push to the base branch, never edit or switch the main checkout.
- Merge only on an explicit request, and only when an `LGTM` comment's `Reviewed head`
  equals the current PR head (`gh pr merge --match-head-commit`). Never `--admin`.
- Any new commit after an LGTM needs another `$task-review`.

## Install

```text
/plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
/plugin install dev-autotask@dfc-dev-plugins
```

### Codex

Install the same plugin in Codex for the review step:

```bash
codex plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
codex plugin add dev-autotask@dfc-dev-plugins
```

To try local changes, register the checkout instead:
`codex plugin marketplace add /absolute/path/to/dfc-dev-plugins`. Start a new thread and
invoke `$task-review` from the workspace containing `autofix.config.json` (or with it in
`~/.claude/`). Review needs `git`, `gh` (authenticated) and Node.js 20+, and runs the checks
in a temporary worktree; give it a sandbox that allows that or it reports the checks as not
run. Only `task-review` is written for Codex; `infiltrate`, `plan`, `run` and `finish` are
Claude workflows.

## Configuration

dev-autotask uses your `autofix.config.json`, the same file
[dev-autofix](../dev-autofix/README.md) uses: the nearest one from the current directory
upward, then `~/.claude/autofix.config.json`. One file can list every repo under a
workspace folder. Commands pick the repo named in the argument (`livingdex: add CSV
export`, `--repo <name>` for the scripts), else the repo containing the current
directory, else the only one; otherwise they ask. If no config exists, `plan` detects the
repos and writes one in dev-autofix's format
([schema](../dev-autofix/schema/autofix.config.schema.json)), so dev-autofix can use it
too.

Per repo it reads `path`, `remote`, `baseBranch`, `install` (default `npm ci
--ignore-scripts --no-audit --no-fund`), `prepare`, `verify` (at least one command),
`commandTimeoutSeconds` (default 600) and `forbidden` (plus the top-level `forbidden`).
`node scripts/verify.mjs <dir> <config> <repo-name>` runs install, prepare and verify with
a per-command timeout and a minimal environment: `CI=1` plus `PATH`, `HOME`, locale, temp
and package-manager cache variables only. Tokens in your shell are not passed through;
commands that need credentials must get them from files under `HOME` (for example
`~/.npmrc`), or list the variable names in the repo's optional `env` (e.g.
`["DATABASE_URL", "NPM_TOKEN"]`) to pass them through. dev-autofix ignores `env`.

Task state lives under `~/.claude/dev-autotask` (it must resolve outside every configured
checkout), namespaced by GitHub repository, so the same task ID can exist in two repos
(then pass `<repo>:<id>`):

```text
<root>/tasks/<owner>/<repo>/<id>/task.json   id, title, config, repo, remote, baseBranch, branch, worktree, pr, progress
<root>/tasks/<owner>/<repo>/<id>/plan.md
<root>/worktrees/<owner>/<repo>/<id>/        the task worktree
<root>/audits/<owner>/<repo>/<audit-id>/     infiltrate notes, findings.json, report.md
```

Production deployments and migrations are out of scope; merging a task does not authorize
them.
