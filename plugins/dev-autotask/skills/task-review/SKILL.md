---
name: task-review
description: Review one dev-autotask PR against its plan, run the configured checks if possible, and post one PR comment with findings or LGTM bound to the reviewed head SHA. Designed for Codex ($task-review); also works in Claude Code. Never edits code or merges.
disable-model-invocation: true
argument-hint: "[pr-number]"
---

# Review a dev-autotask PR

Invoke as `$task-review [pr]` in Codex or `/dev-autotask:task-review [pr]` in Claude Code.
`<plugin>` is this plugin's root, two directories above this skill. Use only a shell,
`git`, `gh` and `node`. Do not edit, commit or push the PR branch, approve formally,
or merge. The only write to GitHub is one PR comment.

1. **Config.** The config is the shared `autofix.config.json`, found from the current
   directory upward, then in `~/.claude/`. If the PR was given as a URL or
   `owner/repo#n`, run `node <plugin>/scripts/state.mjs --remote <owner/repo> config`;
   otherwise `... config` selects the repo containing the current directory or the only
   one (if it lists several repos, ask which, then `--repo <name>`). Use `repo.remote` for
   every `gh` call and `repo.name` below.
2. **PR.** Use the argument. Without one, list open PRs
   (`gh pr list --repo <remote> --json number,headRefName`) whose branch starts with
   `dev/autotask-`; use it if there is exactly one, otherwise ask.
3. **Context.** `gh pr view <n> --repo <remote> --json
   number,title,body,state,headRefName,headRefOid,baseRefName,url` and note `headRefOid`
   as the reviewed head. The plan is in the PR body's "Plan" section; if missing, read
   `<root>/tasks/<owner>/<repo>/<id>/plan.md` (root from the config output, lowercase
   `repo.remote`, id = branch without `dev/autotask-`). Read all PR comments (`gh pr
   view <n> --repo <remote> --comments`) so earlier findings are re-checked.
4. **Review.** Read `gh pr diff <n> --repo <remote>` in full, then the surrounding code
   it touches. Check every acceptance criterion and every earlier finding. Report only
   real, actionable problems: correctness, missed criteria, security, data loss, broken
   compatibility, missing tests for changed behavior. No style nits.
5. **Checks.** Run them in a temporary checkout of the exact head:
   `git -C <repo.path> fetch origin <headRefName>`, `git -C <repo.path> worktree add
   --detach <tmp> <headRefOid>`, then `node <plugin>/scripts/verify.mjs <tmp> <file>
   <repo.name>` (`file` from the step 1 config output; discovery from `<tmp>` would miss it) with a
   long command timeout (30+ minutes; it runs install and every verify command), then
   `git -C <repo.path> worktree remove --force <tmp>`. Also note `gh pr checks <n>
   --repo <remote>`. If you cannot run the checks (sandbox, missing tools, network),
   continue and say so in the comment.
6. **Post.** Re-read `headRefOid`; if it moved, review the new commits first. Write
   the comment to a file and run `gh pr comment <n> --repo <remote> --body-file <file>`.
   Clean, exactly:

   ```text
   LGTM
   Reviewed head: <full head SHA>
   Checks: <passed | failed: summary | not run: reason>
   ```

   Otherwise start with `Reviewed head: <full head SHA>`, then a numbered list of
   findings, each with severity (P0-P3), `file:line`, the problem, and a suggested fix,
   then the `Checks:` line. Never write LGTM when there are findings or the checks
   failed. Report the PR, head and outcome, then stop.
