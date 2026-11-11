# Troubleshooting dev-autofix

Find the message a helper or skill printed, then read across. The first column quotes the
helper's own wording, so you can search this page for the text you were shown. If
something is not here, `/dev-autofix:status` shows the budget, queue, locks and recovery
folders in one place.

The rule behind most of these: the helpers refuse to guess. They never reset, clean,
force-push or break a lock on their own, so a refusal usually means "look at this before
anything is lost", not "something is broken".

## Setup and environment

| Message | What it means | What to do |
|---|---|---|
| `is too old: dev-autofix needs Git` | The helpers use Git features added in 2.36. | Install a newer Git (`git --version`). Ubuntu 22.04 ships 2.34. |
| `dev-autofix needs a POSIX shell and process groups` | You are on Windows outside WSL. | Run Claude Code or Codex inside WSL. |
| `configure nonempty verify commands before proceeding` | A repo in the config has no `verify` command. | Add at least one fast, non-interactive check, or re-run `/dev-autofix:init`. |
| `worktreeRoot must be outside every main checkout` | `worktreeRoot` points inside a repo. | Use the default, or another folder outside every checkout. |
| `env must be a list of variable names` | `env` holds a value or `NAME=value`. | List names only; values come from your shell. |
| A verify command passes in your terminal but fails under autofix | Helpers run repo commands with a minimal environment. | Add the variable's name to the repo's `env`. |
| The snapshot is stale, or `run` says the writer differs | Budget readings refresh only on an API response; a plugin update changes the writer. | Send a message in the session, or run `/dev-autofix:init`. See [statusline/README.md](../statusline/README.md). |

## Before work starts (preflight)

| Message | What it means | What to do |
|---|---|---|
| `Cannot resolve the gh login; authenticate gh first` | `gh` is not logged in. | `gh auth login`. |
| `gh login lacks write permission on this repository` | The account cannot push branches. | Use an account with write access. |
| `Origin does not match the configured repository` | The checkout's `origin` is not the config's `remote`. | Fix `remote` in the config, or the checkout's `origin`. |
| `Cannot create a signed commit; check the signing key and agent` | Signing is not set up, or the agent is unreachable (often a sandbox: "couldn't get agent socket"). | Configure signing; under a sandbox, re-run preflight outside it. Never disable signing. |
| `Probe commit is signed but git verify-commit rejects it` | Git cannot verify your own signature. | SSH: set `gpg.ssh.allowedSignersFile` to a file listing your key. GPG: trust the key. |

## Locks and worktrees

| Message | What it means | What to do |
|---|---|---|
| `EEXIST` when taking a lock | Another session holds the run lock or a repo lock, or one ended without releasing it. | If a session is running, wait. Otherwise follow [lock-recovery.md](../references/lock-recovery.md); never delete the folder. |
| `No persistent Claude or Codex process found in ancestry` | The helper could not find the Claude or Codex process that owns the lock. | Run the skill from Claude Code or Codex, not a bare shell; allow process inspection if a sandbox blocks `ps`. |
| `Lock owner mismatch` | The token passed is not the one that took the lock (often after context compaction). | `state.mjs resume-lock` returns your token; see [lock-recovery.md](../references/lock-recovery.md). |
| `Worktree has unfinished changes; preserve it` | The managed worktree has uncommitted or untracked files. | Look at them. A known failed attempt is moved aside with `state.mjs quarantine`; anything else is yours to keep or remove. |
| `Worktree HEAD has no retaining branch or verification ref` | The tree is on commits no branch points at; switching would orphan them. | Create a branch at that commit, then retry. |
| `prune-needed` | The worktree folder is gone but Git still lists it. | Confirm it was deleted (not moved or unmounted), then follow [worktrees.md](../references/worktrees.md). |
| `Worktree is not registered to this repository` | A folder sits where the managed worktree should be, but it is not this repo's worktree. | Move it away; `prepare` recreates the tree. |

## The queue

| Message | What it means | What to do |
|---|---|---|
| `missing the` ... `heading` | The queue lacks `## Inbox` or `## Entries`, which the helpers need. | Add the heading; the layout is in the [example queue](../examples/AUTOFIX_QUEUE.md). |
| `kind must be one of` | An entry has no `kind`, or a misspelt one. | Use `mechanical`, `bugfix`, `refactor` or `security`. |
| `is not a form the helpers know; the entry will never run` | A status such as `Ready` or `done`. | Use `ready`, `needs-human (...)`, `blocked (...)`. |
| `plan did not hold` (worker report) | The code no longer matches the plan. | The entry is `blocked`. Several at once means the base moved: re-run `/dev-autofix:plan`. |

## The push gate

A refused branch stays local in the worktree, unpushed, and its entry becomes
`blocked (push gate: <checks>)`.

| Check | What it means | What to do |
|---|---|---|
| `files` | A commit touches a protected file (dependency manifest, lockfile, CI, script, build file, `protectedPaths`) or makes a file executable. | Do that change by hand; mark the entry `needs-human`. |
| `size` | The diff is over `maxDiffLines`. | Split the entry, or ask for `publish --max-diff N` for this one. |
| `risky` | An added line contains `eval(`, `new Function(` or `createRequire`. | Make the change by hand, or add the pattern's id to `disabledPatterns`. |
| `malware` | An added line matches a known malware signature. The run stops. | Treat the machine as suspect: inspect the worktree and your dependencies before running anything else. If it is a false positive for your codebase, add the id to `disabledPatterns`. |
| `signed` | A commit has no valid signature. | Fix signing (see preflight above). |
| `clean` | The worktree has uncommitted files. | Commit or remove them. |
| `PR body must name the deploy step` | The entry names a deploy command (`deployPatterns`) that the PR body dropped. | Add it to `<worktreeRoot>/pr/<slug>.md` and run `publish` again. |

## Review and merge

| Message or classification | What it means | What to do |
|---|---|---|
| `stale` / `names a different head` | The approval was for an earlier commit. | Review the current head again. |
| `evidence-unavailable` | The approval could not be tied to a commit. | Approve again with `/dev-autofix:review`; the newer approval supersedes it. |
| `Edited approval needs fresh review` | The approval comment was edited after posting. | Post a new approval; never edit one. |
| `Missing complete approval push history` | A bare `LGTM` could not be matched to a push. | Approve with `/dev-autofix:review`, or add a `Reviewed head: <sha>` line. |
| `address` when you expected a merge | Something other than an approval is pending, or the approval had extra text. | Let finish address it, then review again. |
| `Integration conflicts require a reviewed resolution` | The PR conflicts with the base. | Finish publishes a resolution as a new commit; review that head. |
| `GitHub mergeability remained UNKNOWN after bounded polling` | GitHub had not computed mergeability in 30 seconds. | Run `/dev-autofix:finish` again; the approval is still pending. |
| `merge queued` | The merge was accepted but not confirmed (merge queue). | Nothing; the entry stays `pr-open` until GitHub merges it. |
