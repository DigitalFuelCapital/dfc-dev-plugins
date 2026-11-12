// Read-only summary of an autofix workspace: budget, queue, last run, locks, worktrees and
// recovery folders. Takes no locks, calls neither git nor gh, and writes nothing.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRuntime, inspectLock, listRecovery, validateConfig } from './state.mjs';
import { lintQueue, nextEntry, parseQueue, queueFile } from './lib/queue.mjs';

const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

// The same conditions /dev-autofix:run stops on, so status can say whether a run would start.
// Informational: run re-reads the snapshot itself before every wave.
export function budgetState(snapshot, config, nowSeconds) {
  const reserve = config.reservePercent ?? 10, ceiling = config.fiveHourCeiling ?? 90, maxAge = config.maxSnapshotAgeSeconds ?? 900;
  const limits = { weeklyStopAt: 100 - reserve, fiveHourCeiling: ceiling };
  if (!snapshot) return { state: 'unavailable', reason: 'no usage snapshot; run /dev-autofix:init, then send a message so the status line refreshes', ...limits };
  const windows = { fiveHour: ['pct5', 'observed5', 'reset5'], weekly: ['pct7', 'observed7', 'reset7'] };
  const result = { ...limits };
  for (const [name, [pct, observed, reset]] of Object.entries(windows)) {
    const used = snapshot[pct] ?? null, seen = snapshot[observed] ?? null, resets = snapshot[reset] ?? null;
    const age = Number.isFinite(seen) ? nowSeconds - seen : null;
    const fresh = used !== null && age !== null && age >= 0 && age <= maxAge && !(Number.isFinite(resets) && resets <= nowSeconds);
    result[name] = { usedPercent: used, observedSecondsAgo: age, resetsInSeconds: Number.isFinite(resets) ? resets - nowSeconds : null, fresh };
  }
  const { fiveHour, weekly } = result;
  if (fiveHour.usedPercent === null || weekly.usedPercent === null) return { ...result, state: 'unavailable', reason: 'the plan reports no rate limits (or no API response yet); run needs an explicit max=N' };
  if (!fiveHour.fresh || !weekly.fresh) return { ...result, state: 'stale', reason: 'a budget reading is older than maxSnapshotAgeSeconds or its window has reset; send a message in a session to refresh it' };
  if (weekly.usedPercent >= limits.weeklyStopAt) return { ...result, state: 'reserve-reached', reason: `weekly usage ${weekly.usedPercent}% is at or past ${limits.weeklyStopAt}% (reserve ${reserve}%)` };
  if (fiveHour.usedPercent >= ceiling) return { ...result, state: 'five-hour-ceiling', reason: `5-hour usage ${fiveHour.usedPercent}% is at or past the ceiling ${ceiling}%` };
  return { ...result, state: 'ok', headroomPercent: Math.min(limits.weeklyStopAt - weekly.usedPercent, ceiling - fiveHour.usedPercent) };
}

const STATUS_WORDS = ['ready', 'needs-human', 'blocked', 'pushed', 'pr-open', 'merged', 'fallback'];
export function queueSummary(text, config) {
  const entries = parseQueue(text);
  const repos = config.repos.map(repo => {
    const counts = Object.fromEntries([...STATUS_WORDS, 'other'].map(word => [word, 0]));
    for (const entry of entries.filter(item => item.repo === repo.name)) {
      const word = entry.status.replace(/\s*\(.*$/, '');
      counts[STATUS_WORDS.includes(word) ? word : 'other']++;
    }
    // `next` is what run would take now; ready entries can still be waiting on `after:`.
    return { repo: repo.name, ...counts, next: nextEntry(text, repo.name)?.slug ?? null };
  });
  const lint = lintQueue(text, config);
  return { entries: entries.length, repos, needsHuman: entries.filter(entry => entry.status.startsWith('needs-human')).map(entry => ({ slug: entry.slug, repo: entry.repo, decision: /\((.*)\)$/.exec(entry.status)?.[1] ?? '' })), lint: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings.length } };
}

export function status(configFile, { now = Date.now(), runtimeCheck = checkRuntime } = {}) {
  const file = path.resolve(configFile);
  const config = validateConfig(readJSON(file) ?? (() => { throw new Error(`Cannot read ${file}`); })());
  const root = expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees');
  const result = { config: file, worktreeRoot: root };
  try { result.runtime = { ok: true, ...runtimeCheck() }; } catch (error) { result.runtime = { ok: false, error: error.message }; }
  result.budget = budgetState(readJSON(expand(config.usageSnapshotPath ?? '~/.claude/usage/latest.json')), config, Math.floor(now / 1000));
  const queue = queueFile(file, config);
  result.queue = fs.existsSync(queue) ? { file: queue, ...queueSummary(fs.readFileSync(queue, 'utf8'), config) } : { file: queue, missing: true };
  const manifest = readJSON(path.join(root, 'last-run.json'));
  result.lastRun = manifest && Array.isArray(manifest.prs) ? { startedAt: manifest.startedAt, prs: manifest.prs } : null;
  result.locks = [];
  const locks = path.join(root, '.locks');
  for (const name of fs.existsSync(locks) ? fs.readdirSync(locks).sort() : []) {
    if (name.includes('.abandoned-')) continue;
    try {
      const { owner, createdAt } = inspectLock(path.join(locks, name));
      result.locks.push({ name, createdAt, owner: owner ? { session: owner.session, command: owner.command, host: owner.host, pid: owner.pid } : null });
    } catch (error) {
      // A lock released while we looked is simply gone; anything else is reported, not hidden.
      if (error.code !== 'ENOENT') result.locks.push({ name, error: error.message });
    }
  }
  result.worktrees = config.repos.map(repo => ({ repo: repo.name, path: path.join(root, repo.name), exists: fs.existsSync(path.join(root, repo.name)) }));
  result.recovery = fs.existsSync(root) ? listRecovery(config) : { entries: [], allocatedBytes: 0 };
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: status.mjs <config-file>');
    console.log(JSON.stringify(status(process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
