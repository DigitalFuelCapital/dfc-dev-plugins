import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSnapshot } from '../statusline/usage-snapshot.mjs';

const start = 1800000000;
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-budget-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    send(now, five, seven, cost = 1, session = 'one', reset5 = start + 18000, reset7 = start + 604800) {
      const rate_limits = {};
      if (five != null) rate_limits.five_hour = { used_percentage: five, resets_at: reset5 };
      if (seven != null) rate_limits.seven_day = { used_percentage: seven, resets_at: reset7 };
      writeSnapshot({ session_id: session, cost: { total_cost_usd: cost }, rate_limits }, { directory, now });
      return JSON.parse(fs.readFileSync(path.join(directory, 'latest.json'), 'utf8'));
    },
  };
}

test('partial updates cannot make the other budget window fresh', t => {
  const f = fixture(t);
  f.send(start, 20, 40);
  const snap = f.send(start + 3600, 25, null, 2);
  assert.equal(snap.observed5, start + 3600);
  assert.equal(snap.observed7, start);
  assert.equal(snap.observed_at, start);
  assert.equal(snap.pct7, 40);
  const next = f.send(start + 3700, null, 45, 3);
  assert.equal(next.observed5, start + 3600);
  assert.equal(next.observed7, start + 3700);
  assert.equal(next.observed_at, start + 3600);
});

test('idle and lower replays neither lower usage nor refresh window timestamps', t => {
  const f = fixture(t);
  f.send(start, 20, 40);
  const lower = f.send(start + 100, 10, 30, 1, 'older');
  assert.deepEqual([lower.pct5, lower.pct7, lower.observed5, lower.observed7], [20, 40, start, start]);
  const idle = f.send(start + 200, 20, 40);
  assert.equal(idle.ts, start + 200);
  assert.equal(idle.observed_at, start);
});

test('a new observation at equal usage is fresh only for reported windows', t => {
  const f = fixture(t);
  f.send(start, 20, 40);
  const current = f.send(start + 30, 20, 40, 2);
  assert.equal(current.observed_at, start + 30);
  const partial = f.send(start + 60, null, 40, 3);
  assert.equal(partial.observed5, start + 30);
  assert.equal(partial.observed7, start + 60);
});

test('expired replays are ignored and a new window can start at lower usage', t => {
  const f = fixture(t);
  f.send(start, 90, 40);
  const expired = f.send(start + 19000, 95, null, 2);
  assert.equal(expired.observed5, start);
  const next = f.send(start + 19001, 2, null, 3, 'one', start + 37000);
  assert.equal(next.pct5, 2);
  assert.equal(next.observed5, start + 19001);
  assert.equal(next.observed7, start);
});

test('partial startup and legacy snapshots never invent freshness for an unseen window', t => {
  const f = fixture(t);
  const first = f.send(start, 20, null);
  assert.equal(first.observed5, start);
  assert.equal(first.observed7, null);
  assert.equal(first.observed_at, null);
  fs.writeFileSync(path.join(f.directory, 'latest.json'), JSON.stringify({ pct5: 20, pct7: 40, reset5: start + 18000, reset7: start + 604800, observed_at: start }));
  const upgraded = f.send(start + 3600, 25, null, 2);
  assert.equal(upgraded.observed5, start + 3600);
  assert.equal(upgraded.observed7, null);
  assert.equal(upgraded.observed_at, null);
});

// The budget gate in scripts/lib/budget.mjs, which run, plan, finish and status share.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { budgetState, readBudget, writerCheck } from '../scripts/lib/budget.mjs';

const NOW = 1_800_000_000;
const snap = (extra = {}) => ({ pct5: 20, observed5: NOW - 60, reset5: NOW + 3600, pct7: 50, observed7: NOW - 120, reset7: NOW + 86400, ...extra });

test('limit flags are set only by a fresh reading', () => {
  const full = budgetState(snap({ pct5: 95, pct7: 92 }), {}, NOW);
  assert.deepEqual([full.state, full.fiveHour.atCeiling, full.weekly.atReserve], ['reserve-reached', true, true]);
  // finish reads atCeiling directly: a stale five-hour reading is not a ceiling breach.
  const stale = budgetState(snap({ pct5: 95, observed5: NOW - 5000 }), {}, NOW);
  assert.deepEqual([stale.state, stale.fiveHour.atCeiling], ['stale', false]);
  // A confirmed breach is reported even when the other window is stale or missing, so a
  // caller that may continue past `stale` or `unavailable` cannot step over a limit.
  assert.equal(budgetState(snap({ pct5: 95, observed7: NOW - 5000 }), {}, NOW).state, 'five-hour-ceiling');
  assert.equal(budgetState(snap({ pct7: 95, pct5: null }), {}, NOW).state, 'reserve-reached');
});

test('bounded mode skips a window the plan does not report and still enforces the other', () => {
  assert.equal(budgetState(snap({ pct5: null }), {}, NOW).state, 'unavailable', 'unbounded: a missing window stops the run');
  const one = budgetState(snap({ pct5: null }), {}, NOW, { bounded: true });
  assert.deepEqual([one.state, one.fiveHour.skipped, one.headroomPercent], ['ok', true, 40]);
  assert.equal(budgetState(snap({ pct5: null, pct7: 95 }), {}, NOW, { bounded: true }).state, 'reserve-reached');
  assert.equal(budgetState(snap({ pct5: null, observed7: NOW - 5000 }), {}, NOW, { bounded: true }).state, 'stale');
  for (const none of [null, snap({ pct5: null, pct7: null })]) {
    const result = budgetState(none, {}, NOW, { bounded: true });
    assert.deepEqual([result.state, result.headroomPercent], ['ok', null]);
  }
});

test('the copied snapshot writer must match the plugin\'s copy', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-writer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bundled = path.join(dir, 'bundled.mjs'), installed = path.join(dir, 'installed.mjs');
  fs.writeFileSync(bundled, 'export const v = 2;\n');
  assert.match(writerCheck(installed, bundled).reason, /missing; run \/dev-autofix:init/);
  fs.writeFileSync(installed, 'export const v = 1;\n');
  assert.match(writerCheck(installed, bundled).reason, /differs .* run \/dev-autofix:init/);
  fs.copyFileSync(bundled, installed);
  assert.equal(writerCheck(installed, bundled).ok, true);
  const config = { usageSnapshotPath: path.join(dir, 'latest.json') };
  fs.writeFileSync(config.usageSnapshotPath, JSON.stringify(snap()));
  assert.equal(readBudget(config, { now: NOW * 1000, writer: writerCheck(installed, bundled) }).state, 'ok');
  fs.writeFileSync(installed, 'export const v = 1;\n');
  const outdated = readBudget(config, { now: NOW * 1000, writer: writerCheck(installed, bundled) });
  assert.deepEqual([outdated.state, outdated.writer.ok], ['writer-outdated', false]);
});

test('pr.mjs budget prints the gate for a config, with --bounded for run\'s max=N mode', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-budget-cli-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const plugin = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  fs.mkdirSync(path.join(home, '.claude'));
  fs.copyFileSync(path.join(plugin, 'statusline', 'usage-snapshot.mjs'), path.join(home, '.claude', 'usage-snapshot.mjs'));
  fs.mkdirSync(path.join(home, 'repo'));
  const file = path.join(home, 'autofix.config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, usageSnapshotPath: path.join(home, 'missing.json'), repos: [{ name: 'repo', path: path.join(home, 'repo'), remote: 'o/repo', baseBranch: 'main', verify: ['true'] }] }));
  const run = (...args) => spawnSync(process.execPath, [path.join(plugin, 'scripts', 'pr.mjs'), 'budget', ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  const plain = run(file);
  assert.equal(plain.status, 0, plain.stderr);
  assert.deepEqual([JSON.parse(plain.stdout).state, JSON.parse(plain.stdout).writer.ok], ['unavailable', true]);
  assert.equal(JSON.parse(run(file, '--bounded').stdout).state, 'ok');
  assert.match(run(file, '--max').stderr, /Usage:/);
  assert.match(run(file, '--reserve').stderr, /Usage:/);
  assert.match(run(file, '--reserve', '101').stderr, /Usage:/);
  fs.writeFileSync(path.join(home, 'missing.json'), JSON.stringify({ pct5: 10, observed5: Math.floor(Date.now() / 1000), pct7: 50, observed7: Math.floor(Date.now() / 1000) }));
  assert.equal(JSON.parse(run(file).stdout).state, 'ok', 'default reserve 10: 50% is fine');
  assert.equal(JSON.parse(run(file, '--reserve', '60').stdout).state, 'reserve-reached', 'run\'s reserve=60 stops at 40%');
  assert.equal(JSON.parse(run(file, '--reserve', '100').stdout).state, 'reserve-reached', 'reserve=100 is valid and spends nothing');
});
