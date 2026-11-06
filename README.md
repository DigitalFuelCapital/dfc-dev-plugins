# dfc-dev-plugins

Digital Fuel Capital developer tooling, packaged as a Claude Code plugin marketplace (also
installable from Codex). Private for now.

| Plugin | What it does |
|---|---|
| [`dev-autofix`](plugins/dev-autofix/README.md) | Plan and run small, pre-verified fixes as signed draft PRs on leftover subscription budget, review the batch, then address findings or merge on approval. |

## Install

```
/plugin marketplace add DigitalFuelCapital/dfc-dev-plugins
/plugin install dev-autofix@dfc-dev-plugins
```

Codex: see [plugins/dev-autofix/README.md#codex](plugins/dev-autofix/README.md#codex).

## Development

```
node --test plugins/dev-autofix/tests/*.test.mjs
```

Bump the plugin's version in both `plugins/<name>/.claude-plugin/plugin.json` and
`.claude-plugin/marketplace.json`.
