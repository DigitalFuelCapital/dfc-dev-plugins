# Budget snapshot and status line

`/dev-autofix:run` needs to know how much subscription budget is left. Claude Code exposes
that in exactly one place: the `rate_limits` field of the JSON it pipes to the status line
command. Nothing persists it, so this folder ships two files:

| File | Purpose |
|---|---|
| `usage-snapshot.mjs` | **Required.** Reads the status line JSON on stdin, writes `~/.claude/usage/latest.json` and appends to `history.jsonl`. Prints nothing. |
| `budget-statusline.sh` | Optional. A complete status line that renders context, cost and budget, and calls `usage-snapshot.mjs`. |

Plugins cannot ship a status line - it is global user config - so installing is manual.

## Option A: keep your existing status line (recommended)

Copy the snapshot writer:

```bash
cp statusline/usage-snapshot.mjs ~/.claude/usage-snapshot.mjs
```

Then add one line to your status line script, right after it reads stdin into a variable
(named `input` here):

```bash
printf '%s' "$input" | node ~/.claude/usage-snapshot.mjs 2>/dev/null
```

## Option B: use the bundled status line

```bash
cp statusline/budget-statusline.sh statusline/usage-snapshot.mjs ~/.claude/
chmod +x ~/.claude/budget-statusline.sh
```

```
▮▮▮▮▮▯▯▯▯▯▯▯ 38%/200k │ 12m │ $2.41 │ 90% cached
5h 24%~2h14m  wk 61%~1d10h
```

Line 1 is context used / window size, session duration, session cost and cache hit rate.
Line 2 is percent used of the 5-hour and weekly windows, each followed by the time until
reset. Green under 60% used, amber to 85%, rose above.

## settings.json

Either way, `~/.claude/settings.json` needs a `refreshInterval`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "~/.claude/budget-statusline.sh",
    "padding": 2,
    "refreshInterval": 10
  }
}
```

`refreshInterval` lets the writer regularly persist available input. It does not fetch
new rate limits: replaying an idle session only advances `ts`. A long worker wave can
still leave the lead's readings stale; a new API observation is needed to renew them.

## Verifying it works

```bash
cat ~/.claude/usage/latest.json
```

You want recent `observed5` and `observed7`, non-null `pct5` / `pct7`, and future resets:

```json
{
  "ts": 1790174041,
  "observed_at": 1790174030,
  "observed5": 1790174030,
  "observed7": 1790174030,
  "session_id": "...",
  "model": "claude-opus-5-5",
  "pct5": 24,
  "pct7": 61,
  "pct_spend": null,
  "reset5": 1790182000,
  "reset7": 1790300000,
  "rate_limits": { "...": "raw payload, unmodified" }
}
```

`pct*` are integers 0-100 (as documented for `used_percentage`), `reset*` are epoch
seconds. The keys are a contract with the skills; do not rename them.

The snapshot is merged across every open session, not overwritten. Each session's status
line keeps re-running with the rate limits from its own last API response, so an idle
session would otherwise replay old, lower usage over newer numbers. Within a window usage
only rises, so the writer keeps the highest reading per window and ignores readings from
an older window. `observed5` and `observed7` move independently when a new API observation
supplies an accepted reading for that window. A five-hour-only update cannot refresh
weekly freshness. `observed_at` is their minimum, or null until both have been observed;
`ts` is just the last write. Skills gate each available window using its own timestamp.
Per-session state lives in `sessions.json` next to the snapshot. Legacy snapshots without
per-window timestamps require new observations; their old aggregate timestamp is not
used to invent freshness.

To test without touching your real snapshot, run from the repository root:

```bash
node --test plugins/dev-autofix/tests/budget.test.mjs
```

Tests inject an isolated snapshot directory and clock into the writer. Production CLI
use still reads stdin, writes under the real home directory, and produces no output.

## When there is no budget to show

`rate_limits` only appears on Claude subscription plans, and only after the first API
response of a session. When it is absent no snapshot is written (and the bundled status
line omits line 2). That is expected on API-key billing and on a session's first refresh.
`/dev-autofix:run` says plainly when it cannot budget-gate.

## Notes

- `latest.json` is written to a temp file and renamed, so a skill never reads it half-written.
- `history.jsonl` only grows when a merged percentage or reset time changes, so it
  stays small enough to chart a week of usage.
- A read-only `HOME` or unparseable input is swallowed; the snapshot writer never breaks
  the status line it is attached to.
