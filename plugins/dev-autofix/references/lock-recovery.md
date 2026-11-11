# Lock recovery

`<plugin>` is the installed plugin root, two directories above a skill's directory. Every
helper prints JSON and exits nonzero on a failed check; never continue a dependent action
after a failure. Shell-quote paths and arguments. Index of these references:
[workflow-state.md](workflow-state.md).

Read this only when a lock is already held. Locks never expire automatically, and age
alone is never evidence that one is abandoned. The commands:

```bash
node <plugin>/scripts/state.mjs inspect-lock <directory>
node <plugin>/scripts/state.mjs resume-lock <directory> <identity-file>
node <plugin>/scripts/state.mjs break-lock <directory> <confirmation-file>
```

`resume-lock` returns the saved token only for the same session, host, PID, and process
start time; it recovers ownership after context compaction. For an abandoned lock,
inspect it and confirm the previous session **and its workers** stopped. The confirmation
file must contain the inspected `fingerprint`, `confirmedStopped: true`, and a concrete
`reason`. `break-lock` refuses a live local owner or changed fingerprint. For a remote
host or legacy lock without identity, independently establish that no owner/workers
remain before confirming. An ownerless directory is recoverable after a 60-second
initialization grace period, with the same explicit confirmation. The grace period uses
modification/change times too, so missing Linux birthtime does not disable it. The old
directory is archived beside the lock with a recovery receipt, never silently deleted. Acquire a
new lock normally afterward. Age alone is never sufficient evidence of abandonment.
