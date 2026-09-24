#!/usr/bin/env node
// Budget snapshot writer for the dev-autofix plugin.
//
// Reads the Claude Code status line JSON on stdin and merges its rate_limits
// into ~/.claude/usage/latest.json, appending to history.jsonl when the merged
// numbers move. /dev-autofix:run and /dev-autofix:plan read latest.json to decide
// whether there is budget left to spend.
//
// Prints nothing and always exits 0, so it can be piped from any status line:
//   printf '%s' "$input" | node ~/.claude/usage-snapshot.mjs
//
// rate_limits is only present on Claude subscription plans, and only after the
// first API response of a session. When absent, nothing is written.
//
// KEY-DECISION 2026-09-23: merge, never overwrite. Every open session's status
// line re-runs on refreshInterval with the rate_limits from its own last API
// response, so an idle session replays old (lower) usage. Usage only rises
// within a window, so per window we keep the max, and ignore payloads from an
// older window. `observed_at` only moves when a session reports a new API
// response (its cost or rate_limits changed), never on an idle replay.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Two reports of the same window can disagree on resets_at by a few seconds.
const WINDOW_SLOP_SECONDS = 300;
// Forget sessions after the longest window, so the sessions file stays small.
const SESSION_TTL_SECONDS = 8 * 86400;
// Lock timing: a status line must stay fast, and a crashed writer must not wedge it.
const LOCK_WAIT_MS = 500;
const LOCK_STALE_MS = 5000;

// Epoch seconds; accept milliseconds defensively (unambiguous above 1e12).
const epoch = (s) => (typeof s === 'number' && s > 0 ? (s > 1e12 ? Math.floor(s / 1000) : Math.floor(s)) : null);
// used_percentage is documented as 0-100.
const pct = (w) => (w && typeof w.used_percentage === 'number' ? Math.round(w.used_percentage) : null);

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

const writeJsonAtomic = (file, value) => {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
};

/**
 * Serialize read-merge-write across status line processes. Several sessions
 * refresh concurrently; without this, two writers can read the same snapshot and
 * the later rename discards the other's higher reading. mkdir is atomic, so the
 * lock directory is the mutex. Returns false if the lock was not acquired in
 * time - the caller skips this refresh, and the next one merges it.
 */
const withLock = (lockDir, fn) => {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lockDir).mtimeMs > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {}
      if (Date.now() > deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    fn();
  } finally {
    try {
      fs.rmdirSync(lockDir);
    } catch {}
  }
  return true;
};

/**
 * Merge one window's incoming reading into the stored one.
 * Returns the merged [pct, reset] and whether the incoming reading was used.
 */
const mergeWindow = (prevPct, prevReset, inPct, inReset, now) => {
  if (inPct == null || inReset == null) return [prevPct, prevReset, false];
  // Incoming describes a window that has already reset: stale replay.
  if (inReset <= now) return [prevPct, prevReset, false];
  // Nothing stored, or the stored window has since reset: take incoming.
  if (prevPct == null || prevReset == null || prevReset <= now) return [inPct, inReset, true];
  // Incoming is from a newer window.
  if (inReset > prevReset + WINDOW_SLOP_SECONDS) return [inPct, inReset, true];
  // Incoming is from an older window.
  if (inReset < prevReset - WINDOW_SLOP_SECONDS) return [prevPct, prevReset, false];
  // Same window: usage only rises, so a lower reading is older than what we hold
  // and must not count as a fresh observation.
  return [Math.max(prevPct, inPct), Math.max(prevReset, inReset), inPct >= prevPct];
};

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  try {
    const j = JSON.parse(raw);
    const rl = j.rate_limits;
    if (!rl) return;

    const now = Math.floor(Date.now() / 1000);
    const sessionId = j.session_id ?? '';
    const dir = path.join(os.homedir(), '.claude', 'usage');
    fs.mkdirSync(dir, { recursive: true });
    const latestFile = path.join(dir, 'latest.json');
    const sessionsFile = path.join(dir, 'sessions.json');

    withLock(path.join(dir, '.lock'), () => {
      const prev = readJson(latestFile) ?? {};
      const sessions = readJson(sessionsFile) ?? {};

      // A session's cost rises on every API response, so a changed key means this
      // payload carries a new observation rather than an idle replay.
      const sessionKey = JSON.stringify([j.cost?.total_cost_usd ?? null, rl]);
      const isNewObservation = sessions[sessionId]?.key !== sessionKey;
      sessions[sessionId] = { key: sessionKey, seen: now };
      for (const [id, s] of Object.entries(sessions)) {
        if (!s || now - s.seen > SESSION_TTL_SECONDS) delete sessions[id];
      }

      const [pct5, reset5, used5] = mergeWindow(prev.pct5, prev.reset5, pct(rl.five_hour), epoch(rl.five_hour?.resets_at), now);
      const [pct7, reset7, used7] = mergeWindow(prev.pct7, prev.reset7, pct(rl.seven_day), epoch(rl.seven_day?.resets_at), now);
      // Fresh only if no window reported was behind the stored numbers.
      const has5 = pct(rl.five_hour) != null;
      const has7 = pct(rl.seven_day) != null;
      const accepted = isNewObservation && (has5 || has7) && (!has5 || used5) && (!has7 || used7);

      // Shape is a contract; the skills read exactly these keys.
      const snap = {
        ts: now,
        observed_at: accepted ? now : (prev.observed_at ?? null),
        session_id: accepted ? sessionId : (prev.session_id ?? sessionId),
        model: accepted ? (j.model?.id ?? '') : (prev.model ?? ''),
        pct5,
        pct7,
        pct_spend: accepted ? pct(rl.spend_limit) : (prev.pct_spend ?? null),
        reset5,
        reset7,
        rate_limits: accepted ? rl : (prev.rate_limits ?? rl),
      };

      writeJsonAtomic(latestFile, snap);
      writeJsonAtomic(sessionsFile, sessions);

      // History grows only when a merged number actually moves.
      const key = (o) => [o.pct5, o.pct7, o.pct_spend, o.reset5, o.reset7].join('|');
      if (key(prev) !== key(snap)) {
        fs.appendFileSync(path.join(dir, 'history.jsonl'), JSON.stringify(snap) + '\n');
      }
    });
  } catch {
    // Unparseable input or a read-only HOME must never break the status line.
  }
});
