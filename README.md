# dfc-dev-plugins

Digital Fuel Capital developer tooling, packaged as a Claude Code plugin marketplace (also
installable from Codex). Private for now.

| Plugin | What it does |
|---|---|
| [`dev-autofix`](plugins/dev-autofix/README.md) | Plan and run small, pre-verified fixes as signed draft PRs on leftover subscription budget, review the batch, then address findings or merge on approval. |
| [`dev-autotask`](plugins/dev-autotask/README.md) | One large task as one PR, optionally starting from a cross-verified local security audit (`infiltrate`): Claude plans, implements and addresses findings; Codex reviews (`$task-review`). Merges only on explicit request. |

## Install

```
/plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
/plugin install dev-autofix@dfc-dev-plugins
/plugin install dev-autotask@dfc-dev-plugins
```

Codex: see [plugins/dev-autofix/README.md#codex](plugins/dev-autofix/README.md#codex).

## Development

```
node --test plugins/*/tests/*.test.mjs
```

Bump the plugin's version in both `plugins/<name>/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`.
