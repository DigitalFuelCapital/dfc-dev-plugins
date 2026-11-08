# dfc-dev-plugins

Digital Fuel Capital developer tooling, packaged as a Claude Code plugin marketplace (also
installable from Codex).

| Plugin | What it does |
|---|---|
| [`dev-autofix`](plugins/dev-autofix/README.md) | Plan and run small, pre-verified fixes as signed draft PRs on leftover subscription budget, review the batch, then address findings or merge on approval. |
| [`dev-autotask`](plugins/dev-autotask/README.md) | One large task as one PR, optionally starting from a cross-verified local security audit (`infiltrate`): Claude plans, implements and addresses findings; Codex reviews (`$task-review`). Merges only on explicit request. |

## Assumptions

These plugins encode one team's workflow and expect:

- signed commits (SSH or GPG) and `gh` authenticated against your repos
- an integration branch such as `staging` that PRs target, never production
- Codex installed alongside Claude Code, as the main reviewer
- for `dev-autofix`, a Claude subscription whose leftover budget it spends (see
  [the status line setup](plugins/dev-autofix/statusline/README.md))

## Install

Claude Code runs most skills; Codex is the main reviewer (`$review`, `$task-review`), so
install in both.

Claude Code:

```
/plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
/plugin install dev-autofix@dfc-dev-plugins
/plugin install dev-autotask@dfc-dev-plugins
```

Codex:

```bash
codex plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
codex plugin add dev-autofix@dfc-dev-plugins
codex plugin add dev-autotask@dfc-dev-plugins
```

Start a new Codex thread after installing. More Codex detail:
[dev-autofix](plugins/dev-autofix/README.md#codex), [dev-autotask](plugins/dev-autotask/README.md#codex).

## Reviewing in Codex with checks

Codex's default sandbox blocks network access, so a review can't install dependencies.
It still works, but posts `Checks: not run`, and merging then relies on GitHub CI. To let
reviews run lint, typecheck and tests themselves, start review sessions with network
enabled, leaving everyday `codex` sessions unchanged.

1. Add this alias to `~/.zshrc`:

   ```bash
   # Codex with network in the workspace-write sandbox (for $review / $task-review)
   alias codex-review='codex -c sandbox_mode="\"workspace-write\"" -c sandbox_workspace_write.network_access=true'
   ```

2. Reload your shell with `source ~/.zshrc`, or open a new terminal.
3. From the repo being reviewed (or the folder that holds `autofix.config.json`), start
   a review session and run the review skill:

   ```bash
   cd ~/path/to/repo
   codex-review
   ```

   Then, in that session: `$task-review <PR URL>` for dev-autotask, or `$review` for a
   dev-autofix batch.

The network setting lasts only for that session. With network on, the repo's install,
lint and test scripts can make outbound connections, so use `codex-review` for repos and
PRs you trust and plain `codex` for everything else.

## Update

Neither tool updates automatically. After a release is merged, update **both**, or Codex
keeps reviewing with the old skills.

Claude Code:

```
/plugin marketplace update dfc-dev-plugins
/reload-plugins
```

Codex (`codex plugin add` reinstalls the current version over the cached one):

```bash
codex plugin marketplace upgrade dfc-dev-plugins
codex plugin add dev-autofix@dfc-dev-plugins
codex plugin add dev-autotask@dfc-dev-plugins
```

Then start a new Codex thread; a thread that is already running keeps the skills it
loaded. Check what Codex has installed with
`ls ~/.codex/plugins/cache/dfc-dev-plugins/*/` (one version folder per plugin).

## Development

```
node --test plugins/*/tests/*.test.mjs
```

Bump the plugin's version in both `plugins/<name>/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json` on every behaviour change. Both Claude Code and Codex
cache plugins by version, so an unbumped change never reaches installed copies.
