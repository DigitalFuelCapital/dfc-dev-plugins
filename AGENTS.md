# Notes for coding agents

Guidance for agents working on this repository (Claude Code reads it through `CLAUDE.md`,
Codex reads it directly). People should start with [CONTRIBUTING.md](CONTRIBUTING.md).

This is a Claude Code plugin marketplace, also installable in Codex, with two plugins:
`dev-autofix` and `dev-autotask`.

- Tests: `node --test plugins/*/tests/*.test.mjs tests/*.test.mjs`. They need Git 2.36+,
  `ssh-keygen` and a committer identity. `tests/` checks docs, examples and manifests
  against the code.
- Versions live in two places: `plugins/<name>/.claude-plugin/plugin.json` and
  `.claude-plugin/marketplace.json`. Keep them in sync, and bump on every behaviour
  change; both tools cache plugins by version.
- Record every behaviour change, including `SKILL.md` wording, in the plugin's
  `CHANGELOG.md`.
- A `SKILL.md` holds judgement; anything that must be deterministic (gates, locks,
  approval binding, verification) belongs in a tested script under `scripts/`. When a
  skill and a script disagree, the script is the contract: fix the skill's wording.
- The helper scripts have no runtime dependencies. Do not add any.
- Never weaken a safeguard to make a test pass: no reset, clean, force-push or forced
  worktree removal in a helper, and no skill without `disable-model-invocation: true`.
- The queue layout (`## Summary - <repo>`, `## Inbox`, `## Entries`, `## Dropped`) is
  parsed by `plugins/dev-autofix/scripts/lib/queue.mjs`. Keep `skills/plan/SKILL.md`,
  `skills/init/SKILL.md` and `examples/AUTOFIX_QUEUE.md` in step with it.
- `plugins/dev-autofix/scripts/lib/gate.mjs` and
  `plugins/dev-autotask/scripts/publish-check.mjs` intentionally contain malware IOC
  strings (`AUTH_API_KEY`, `auth-confirm-nine`, `createRequire`, ...) as detection
  patterns, and their tests use some as fixtures. They are not infections.
- `scripts/pr.mjs` in dev-autofix is the CLI and re-exports everything in `scripts/lib/`.
  Put new logic in the `lib/` module it belongs to, not in `pr.mjs`.
- `npm run lint` (ESLint, correctness rules only) and `npm test` must both pass. The
  linter is a dev dependency of the repository; the plugins themselves stay
  dependency-free.
