// The budget gate: whether leftover subscription budget may be spent now. run, plan, finish
// and status all read it here, so none of them judges timestamps or percentages by hand.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expand } from './common.mjs';

const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const WINDOWS = { fiveHour: ['pct5', 'observed5', 'reset5'], weekly: ['pct7', 'observed7', 'reset7'] };

/**
 * Each window is judged by its own observation time, never `ts`. A reading is fresh when it
 * exists, is not in the future, is no older than maxSnapshotAgeSeconds and its window has
 * not reset since. `bounded` is run's confirmed `max=N` mode: a window the plan does not
 * report is skipped instead of making the whole budget unavailable; present ones still count.
 */
export function budgetState(snapshot, config, nowSeconds, { bounded = false } = {}) {
  const reserve = config.reservePercent ?? 10, ceiling = config.fiveHourCeiling ?? 90, maxAge = config.maxSnapshotAgeSeconds ?? 900;
  const limits = { weeklyStopAt: 100 - reserve, fiveHourCeiling: ceiling };
  const result = { ...limits };
  for (const [name, [pct, observed, reset]] of Object.entries(WINDOWS)) {
    const used = snapshot?.[pct] ?? null, seen = snapshot?.[observed] ?? null, resets = snapshot?.[reset] ?? null;
    const age = Number.isFinite(seen) ? nowSeconds - seen : null;
    const fresh = used !== null && age !== null && age >= 0 && age <= maxAge && !(Number.isFinite(resets) && resets <= nowSeconds);
    const limit = name === 'weekly' ? limits.weeklyStopAt : ceiling;
    result[name] = { usedPercent: used, observedSecondsAgo: age, resetsInSeconds: Number.isFinite(resets) ? resets - nowSeconds : null, fresh, skipped: bounded && used === null };
    // Only a fresh reading can say the limit is reached; a stale one says nothing.
    result[name][name === 'weekly' ? 'atReserve' : 'atCeiling'] = fresh && used >= limit;
  }
  const { fiveHour, weekly } = result;
  const counted = [fiveHour, weekly].filter(window => !window.skipped);
  // A confirmed breach wins over a missing or stale other window: callers may carry on past
  // `stale` or `unavailable` with the user's go-ahead, but never past a limit.
  if (weekly.atReserve) return { ...result, state: 'reserve-reached', reason: `weekly usage ${weekly.usedPercent}% is at or past ${limits.weeklyStopAt}% (reserve ${reserve}%)` };
  if (fiveHour.atCeiling) return { ...result, state: 'five-hour-ceiling', reason: `5-hour usage ${fiveHour.usedPercent}% is at or past the ceiling ${ceiling}%` };
  if (!snapshot && !bounded) return { ...result, state: 'unavailable', reason: 'no usage snapshot; run /dev-autofix:init, then send a message so the status line refreshes' };
  if (counted.some(window => window.usedPercent === null)) return { ...result, state: 'unavailable', reason: 'the plan reports no rate limits (or no API response yet); run needs an explicit max=N' };
  if (counted.some(window => !window.fresh)) return { ...result, state: 'stale', reason: 'a budget reading is older than maxSnapshotAgeSeconds, in the future, or its window has reset; send a message in a session to refresh it' };
  const room = [weekly.skipped ? null : limits.weeklyStopAt - weekly.usedPercent, fiveHour.skipped ? null : ceiling - fiveHour.usedPercent].filter(value => value !== null);
  return { ...result, state: 'ok', headroomPercent: room.length ? Math.min(...room) : null };
}

const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const BUNDLED_WRITER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'statusline', 'usage-snapshot.mjs');

// init copies the writer to ~/.claude; a plugin update does not, and an old writer emits a
// snapshot shape the rules above misread.
export function writerCheck(installed = expand('~/.claude/usage-snapshot.mjs'), bundled = BUNDLED_WRITER) {
  if (!fs.existsSync(installed)) return { ok: false, path: installed, reason: `${installed} is missing; run /dev-autofix:init` };
  if (sha256(installed) !== sha256(bundled)) return { ok: false, path: installed, reason: `${installed} differs from this plugin's copy; run /dev-autofix:init` };
  return { ok: true, path: installed };
}

export function readBudget(config, { bounded = false, now = Date.now(), writer = writerCheck() } = {}) {
  const snapshot = readJSON(expand(config.usageSnapshotPath ?? '~/.claude/usage/latest.json'));
  const result = budgetState(snapshot, config, Math.floor(now / 1000), { bounded });
  if (!writer.ok) return { ...result, state: 'writer-outdated', reason: writer.reason, writer };
  return { ...result, writer };
}
