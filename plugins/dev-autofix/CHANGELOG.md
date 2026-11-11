# Changelog - dev-autofix

The plugin version changes with every behaviour change. The config file format is
separate and is still `version: 1`.

After any update, run `/dev-autofix:init` in Claude Code to refresh the copied budget
snapshot writer, and reinstall the plugin in Codex (see the
[root README](../../README.md#update)).

## 4.0.0

**Breaking: repo commands no longer see your shell's environment.** Install, prepare and
verify commands that a helper runs now get a minimal environment (`CI=1`, `PATH`, `HOME`,
locale, temp and package-manager cache variables). If a command needs a variable, such as
`NPM_TOKEN` or `DATABASE_URL`, add its name to the repo's `env` list in
`autofix.config.json`. Credentials in files under `HOME` keep working.

- `state.mjs config` and `preflight.mjs` check the platform and the Git version first, and
  say plainly when Git is older than 2.36 or the platform is Windows without WSL.
- New `pr.mjs queue init` creates the queue skeleton and `pr.mjs queue lint` checks a queue
  against what the helpers parse. `init`, `plan` and `run` use them; `run` stops on lint
  errors instead of failing halfway.
- A queue entry whose kind is `Security` in any capitalisation is never auto-executed.
  Lint reports an unknown or missing `kind` as an error.
- The plugin manifest names its homepage and repository.

Approvals:

- An approval may state its own commit: `LGTM` followed by `Reviewed head: <sha>`.
  `review` now posts this form, so an approval no longer depends on a local record or on
  GitHub's push history. Update the plugin in Codex and Claude Code together: an older
  `finish` treats the two-line form as feedback.
- When every pending comment is an approval, the newest decides and older ones are
  superseded. An approval that could not be tied to a commit no longer blocks every later
  approval. Feedback is never superseded.
- `finish` writes `<!-- dev-autofix:finish addressed=... -->`; the earlier
  `dev-autofix:review` spelling is still accepted on existing PRs.

Push gate:

- Built-in patterns are split into malware signatures (a match stops the run) and risky
  constructs (`eval(`, `new Function(`, `createRequire`: a match blocks only that entry).
  New `disabledPatterns` switches individual built-ins off by id.
- The protected-file list now covers dependency manifests and lockfiles of other
  ecosystems (Python, Go, Rust, Ruby, PHP, JVM), package manager config, more CI and hook
  config, and build files (`Makefile`, `Dockerfile`, compose files). New `protectedPaths`,
  global and per repo, adds project patterns.
- New `deployPatterns` replaces the hardcoded `supabase functions deploy` check.
- New `finishModel` (default `opus`) sets the model for finish's worker.

## 3.3.3

Documentation and skill wording only; no script changes.

- `plan`, `init` and the example queue now describe the queue layout the helpers expect
  (`## Summary - <repo>`, `## Inbox`, `## Entries`, `## Dropped`). `queue add-fallback`
  requires the `## Entries` heading, which earlier instructions never asked for.
- `finish` points at `references/fix-brief.md` for the worker hard rules and signing
  rules, which had moved out of `run`.
- `review` no longer refers to a separately installed `pr-review` skill.
- README reorganized; version notes moved to this file.

## 3.3.2

- Repository prepared for public release: internal wording and example repo names
  replaced, CI workflow added.
- The `review` skill's manifest example changed.

## 3.3.0

No config changes.

- Delivery preflight (`scripts/preflight.mjs`) runs before `run` and `finish` start
  workers: `gh` identity and write access, origin and base, and one signing probe that
  must pass `git verify-commit`.
- `scripts/review.mjs verify` runs review's local checks at the exact PR head and restores
  the worktree afterwards.
- A replaced `last-run.json` is archived to `<worktreeRoot>/runs/`.
- A failed dependency install is retried on the next `prepare`.

## 3.2.0

- The push gate counts moved code once. A branch over the size limit auto-passes when its
  effective size (raw minus lines moved as contiguous blocks of 3 or more) is within the
  limit and its raw size is within 1.5 x `maxDiffLines`. The PR body says so.
- A user-approved `publish --max-diff N` covers anything larger.
- New helpers `prepare` (worktree and dependencies) and `land` (verify, CI, re-check,
  merge, cleanup) replace the remaining hand-chained steps in `run` and `finish`.

## 3.1.1

- `remove-worktree` no longer times out after 120 seconds while Git deletes a worktree
  with `node_modules`; that command now gets up to 30 minutes.

## 3.1.0

No config changes. Steps that the first live cycle showed being improvised now live in
`scripts/pr.mjs`.

- `finish` binds approvals from review's records before falling back to push history.
- Cleanup treats a branch that GitHub already auto-deleted on merge as done.
- The push gate's size cap is `maxDiffLines`, or the entry's stated size plus 50% when
  that is larger.
- `publish` refuses a PR body that drops a deploy step the entry names.
- `perFixPercentEstimate` now defaults to 2.

## 3.0.0

Breaking: upgrading from 2.x requires at least one nonempty `verify` command for every
repo.

## Earlier notes

These were in the README without a version number:

- Budget freshness is judged per window. Both `observed5` and `observed7` must receive
  fresh API observations; an idle status-line refresh does not renew them.
- Manual approvals are bound using server push history when no saved record exists;
  incomplete evidence leaves the comment pending.
- Durable review and approval records live in `review/records/`; prepared comments and
  reports use `review/scratch/`. Records compare by fields, independent of JSON key order.
