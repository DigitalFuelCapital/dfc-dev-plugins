# dfc-dev-plugins

Digital Fuel Capital developer tooling, packaged as a Claude Code plugin marketplace (also
installable from Codex). Private for now.

| Plugin | What it does |
|---|---|
| [`dev-autofix`](plugins/dev-autofix/README.md) | Plan and run small, pre-verified fixes as signed draft PRs on leftover subscription budget, review the batch, then address findings or merge on approval. |
| [`dev-autotask`](plugins/dev-autotask/README.md) | One large task as one PR, optionally starting from a cross-verified local security audit (`infiltrate`): Claude plans, implements and addresses findings; Codex reviews (`$task-review`). Merges only on explicit request. |

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
