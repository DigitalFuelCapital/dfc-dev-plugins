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
