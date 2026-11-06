# CLAUDE.md

Private Claude Code plugin marketplace for DFC developer tooling. Plugins: `dev-autofix`,
`dev-autotask`. Split out of `DigitalFuelCapital/dfc-claude-plugin` (history preserved) so it
can evolve and be shared independently of the client-facing DFC plugins.

- Tests: `node --test plugins/*/tests/*.test.mjs`
- Versions live in two places: `plugins/<name>/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json` - keep them in sync.
- `scripts/pr.mjs` and `skills/run/SKILL.md` intentionally contain malware IOC strings
  (`AUTH_API_KEY`, `auth-confirm-nine`, `createRequire`, ...) as push-gate detection
  patterns, and `tests/pr.test.mjs` uses one as a fixture. They are not infections.
