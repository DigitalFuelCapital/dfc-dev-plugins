# Security policy

These plugins write code, push branches and merge pull requests on your behalf, so a flaw
in one of their safeguards matters. Please report security problems privately.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and
choose **Report a vulnerability**. Please do not open a public issue or pull request for
a security problem.

Include what you can of:

- the plugin and version (`plugins/<name>/.claude-plugin/plugin.json`)
- what you did, what you expected, and what happened
- a minimal repository or queue entry that reproduces it
- your Git, Node.js and operating system versions

Reports are read and handled on a best-effort basis. There is no bug bounty.

## What counts

Anything that lets work get further than the documented safety model allows, for example:

- a way past dev-autofix's push gate (protected files, size cap, signature check, malware
  signatures) that ends in a pushed commit
- a merge of a commit that the configured reviewer did not approve, or an approval
  accepted from someone outside `reviewers`
- a helper modifying a user's own checkout, force-pushing, or pushing to a base branch
- a repo command receiving environment variables that were not listed in `env`
- command or path injection through a config value, a queue entry, a branch name, a PR
  title or a comment
- text in a repository, queue, audit document or PR comment changing what a skill is
  allowed to do

## What does not

- Bugs in a fix that an agent wrote. Those are what review is for; open a normal issue if
  a skill's instructions made the bug likely.
- Findings that need an attacker who already controls your machine, your GitHub account
  or the configured reviewer's account. The verification receipts, for instance, guard
  against skipped checks, not against someone with the same filesystem access.
- The malware signature strings in `plugins/dev-autofix/scripts/lib/gate.mjs`,
  `plugins/dev-autotask/scripts/publish-check.mjs` and their tests.
  They are detection patterns.

## Supported versions

Only the latest released version of each plugin receives fixes.
