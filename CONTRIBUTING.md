# Contributing

Thanks for looking. These plugins encode one team's workflow, so the most useful
contributions are bug reports with a reproduction, fixes to the helper scripts, and
changes that make the plugins work for more kinds of repository without weakening a
safeguard.

For a security problem, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

You need Git 2.38+, `ssh-keygen` and Node.js `^20.19.0`, `^22.13.0` or 24+ (the range
ESLint supports), on macOS or Linux. The plugins themselves run on any Node 20+. The
helpers have no dependencies and the tests need nothing installed; `npm ci` is only for
the linter.

```bash
git clone https://github.com/DigitalFuelCapital/dfc-dev-plugins
cd dfc-dev-plugins
npm test          # node --test plugins/*/tests/*.test.mjs tests/*.test.mjs
npm ci && npm run lint
```

To try a change in a real session, register your checkout as the marketplace:
`/plugin marketplace add /absolute/path/to/dfc-dev-plugins` in Claude Code, or
`codex plugin marketplace add /absolute/path/to/dfc-dev-plugins` in Codex. Both tools
cache plugins by version, so bump the version (below) or you will keep running the old
copy.

## How the repository is organised

Each plugin has `skills/` (one `SKILL.md` per command: the instructions the agent
follows) and `scripts/` (Node helpers the skills call). The rule that decides where a
change goes:

- **Judgement belongs in a skill**: what to investigate, when to stop and ask, how to
  word a report.
- **Anything that must not depend on a model getting it right belongs in a script, with a
  test**: gates, locks, approval binding, verification, anything that writes shared state.

When a skill and a script disagree, the script is the contract. Fix the skill's wording.

## Making a change

1. Add or update tests. Script changes need a test in `plugins/<name>/tests/`. The suite
   in `tests/` checks that the docs, examples and manifests agree with the code, so it
   will tell you when a README, example or skill needs updating too.
2. Bump the plugin's version in **both** `plugins/<name>/.claude-plugin/plugin.json` and
   `.claude-plugin/marketplace.json` for any behaviour change. Editing a `SKILL.md` is a
   behaviour change. Breaking changes get a major version. CI checks this
   (`node tools/release.mjs check origin/main`), and merging a new version to `main`
   tags and releases it automatically.
3. Add an entry at the top of the plugin's `CHANGELOG.md`, written for someone deciding
   whether to update.
4. Explain non-obvious decisions where they live, with a dated comment in the style the
   code already uses: `// KEY-DECISION 2026-09-27: <what and why>`.
5. Keep commits focused and use a conventional prefix with the plugin as scope, for
   example `fix(dev-autofix): ...` or `feat(dev-autotask): ...`.

## What will not be merged

- A change that removes or weakens a safeguard (the push gate, approval binding, the
  minimal command environment, the never-touch-your-checkout rule) without a replacement.
- A helper that resets, cleans, force-pushes or force-removes anything.
- Auto-invoked skills. Every skill here pushes code or posts comments, so each one sets
  `disable-model-invocation: true` and runs only when a person asks for it.
- New runtime dependencies for the helper scripts.
