# Dev Autotask

Take one large development task from plan to merge as one branch and one PR. Claude plans,
implements and finishes; Codex reviews. GitHub (the PR, its head SHA, CI and
`gh pr merge --match-head-commit`) holds most of the state.

## Flow

1. `/dev-autotask:plan <request or report path>` - Claude investigates and writes `plan.md`,
   shows it, and stops. Ask for changes, or approve by running the next step.
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
invoke `$task-review` from the workspace containing `dev-autotask.config.json` (or with it in
`~/.claude/`). Review needs `git`, `gh` (authenticated) and Node.js 20+, and runs the checks
in a temporary worktree; give it a sandbox that allows that or it reports the checks as not
run. Only `task-review` is written for Codex; `infiltrate`, `plan`, `run` and `finish` are
Claude workflows.

## Configuration

`dev-autotask.config.json` is found from the current directory upward, then at
`~/.claude/dev-autotask.config.json`. `plan` creates it if missing. Copy
[the example](examples/task.config.json); fields are in
[the schema](schema/task.config.schema.json). `repo.verify` needs at least one command;
`repo.install` (optional) runs before them on every verification.
`node scripts/verify.mjs <dir> [config]` runs these with a per-command timeout and a minimal
environment: `CI=1` plus `PATH`, `HOME`, locale, temp and package-manager cache
variables only. Tokens in your shell are not passed through; commands that need
credentials must get them from files under `HOME` (for example `~/.npmrc`), or list the
variable names in `repo.env` (e.g. `["DATABASE_URL", "NPM_TOKEN"]`) to pass them through.

Task state lives under `worktreeRoot` (default `~/.claude/dev-autotask`):

```text
<root>/tasks/<owner>/<repo>/<id>/task.json   id, title, repo, baseBranch, branch, worktree, pr, progress
<root>/tasks/<owner>/<repo>/<id>/plan.md
<root>/worktrees/<owner>/<repo>/<id>/        the task worktree
<root>/audits/<owner>/<repo>/<audit-id>/     infiltrate notes, findings.json, report.md
```

Production deployments and migrations are out of scope; merging a task does not authorize
them.
