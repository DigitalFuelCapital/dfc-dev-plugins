# Config check and locks

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

Run `node <plugin>/scripts/state.mjs config <config-file>` before work. This checks the
platform (macOS or Linux; WSL on Windows) and the Git version (2.38 or newer), then the
required runtime fields, including a nonempty `verify` list for every repo; it does not
replace the full config schema. Report incomplete config rather than invent commands.

Persist an identity JSON file outside the lock directory for the invocation:
`{"session":"<persistent session ID>","command":"dev-autofix:run"}`. Do not supply a PID.
The helper walks process ancestry to find the nearest Claude or Codex runtime, skipping
shells and helper processes. It recognizes the native executables and Claude's Node CLI.
If no runtime is found or process inspection is denied, it refuses acquisition. Retry
with process-inspection permission rather than guessing a PID. The owner record includes
that PID, executable, process start time, host, session, command and token.

Use a stable session ID from the runtime, or save one generated UUID for the invocation.
A Codex daemon can serve several sessions, so the session ID still distinguishes them.
A live shared daemon prevents automatic lock breaking even if one conversation ended;
release normally in the owning session, or stop the runtime and confirm workers stopped
before breaking an abandoned lock.

One run at a time may update the manifest. Before run's recovery/fix loop, acquire:

```bash
node <plugin>/scripts/state.mjs lock <worktreeRoot>/.locks/run <identity-file>
```

The returned UUID is `runToken`. Persist one ISO `startedAt` for the invocation too.
Before creating, checking out, testing, editing, or removing a repo's shared worktree,
also acquire `<worktreeRoot>/.locks/repo-<repo.name>` with the same identity file. Its
UUID is `repoToken`. Hold the repo lock throughout worker activity. Review can still
inspect remote contents when local use is locked. Release owned locks in a finally step,
after all workers stop: `node <plugin>/scripts/state.mjs unlock <directory> <token>`.

Locks never expire automatically. On an existing lock, skip that repo or stop a
conflicting run; never take one over because it looks old. To resume your own lock after
context compaction, or to recover a lock whose session has ended, read
[lock-recovery.md](lock-recovery.md) first.
