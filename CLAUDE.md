# CLAUDE.md

Claude Code plugin marketplace for DFC developer tooling. Plugins: `dev-autofix`,
`dev-autotask`. Split out of `DigitalFuelCapital/dfc-claude-plugin` (history preserved) so it
can evolve and be shared independently of the client-facing DFC plugins.

- Tests: `node --test plugins/*/tests/*.test.mjs tests/*.test.mjs` (`tests/` checks docs,
  examples and manifests against the code)
- Versions live in two places: `plugins/<name>/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` - keep them in sync.
- Record every behaviour change, including `SKILL.md` wording, in the plugin's
  `CHANGELOG.md`.
- A `SKILL.md` holds judgement; anything that must be deterministic (gates, locks,
  approval binding, verification) belongs in a tested script under `scripts/`. When a
  skill and a script disagree, the script is the contract: fix the skill's wording.
- The queue layout (`## Summary - <repo>`, `## Inbox`, `## Entries`, `## Dropped`) is
  parsed by `plugins/dev-autofix/scripts/pr.mjs`. Keep `skills/plan/SKILL.md`,
  `skills/init/SKILL.md` and `examples/AUTOFIX_QUEUE.md` in step with it.
- `plugins/dev-autofix/scripts/pr.mjs` intentionally contains malware IOC strings
  (`AUTH_API_KEY`, `auth-confirm-nine`, `createRequire`, ...) as push-gate detection
  patterns, and `tests/pr.test.mjs` uses one as a fixture. They are not infections.
