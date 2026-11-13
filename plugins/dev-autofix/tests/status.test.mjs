import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { budgetState, queueSummary, status } from '../scripts/status.mjs';
import { queueSkeleton } from '../scripts/pr.mjs';

const NOW = 1_800_000_000;
const WRITER_OK = { ok: true, path: 'usage-snapshot.mjs' }; // the real ~/.claude copy is not under test here
const snapshot = (extra = {}) => ({ pct5: 20, observed5: NOW - 60, reset5: NOW + 3600, pct7: 50, observed7: NOW - 120, reset7: NOW + 86400, ...extra });

test('budget state mirrors the conditions run stops on', () => {
  assert.equal(budgetState(null, {}, NOW).state, 'unavailable');
  const ok = budgetState(snapshot(), {}, NOW);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.headroomPercent, 40, 'min(90 - 50, 90 - 20)');
  assert.deepEqual(ok.weekly, { usedPercent: 50, observedSecondsAgo: 120, resetsInSeconds: 86400, fresh: true, skipped: false, atReserve: false });
  assert.equal(budgetState(snapshot(), { reservePercent: 60 }, NOW).state, 'reserve-reached');
  assert.equal(budgetState(snapshot({ pct7: 90 }), {}, NOW).state, 'reserve-reached');
  assert.equal(budgetState(snapshot({ pct5: 90 }), {}, NOW).state, 'five-hour-ceiling');
  assert.equal(budgetState(snapshot({ pct5: null }), {}, NOW).state, 'unavailable');
  // Each window is judged by its own observation, never the other's.
  for (const stale of [{ observed7: NOW - 901 }, { observed5: null }, { observed5: NOW + 30 }, { reset5: NOW - 1 }]) assert.equal(budgetState(snapshot(stale), {}, NOW).state, 'stale', JSON.stringify(stale));
  assert.equal(budgetState(snapshot({ observed7: NOW - 901 }), { maxSnapshotAgeSeconds: 3600 }, NOW).state, 'ok');
});

function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-status-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['app', 'api']) fs.mkdirSync(path.join(dir, name));
  const root = path.join(dir, 'worktrees');
  const config = { version: 1, worktreeRoot: root, usageSnapshotPath: path.join(dir, 'latest.json'), repos: ['app', 'api'].map(name => ({ name, path: path.join(dir, name), remote: `o/${name}`, baseBranch: 'main', verify: ['true'] })) };
  const file = path.join(dir, 'autofix.config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  return { dir, root, config, file };
}
const entry = (slug, repo, status, extra = '') => `### ${slug} · ${repo} · Title ${slug}\n- status: ${status}\n- kind: bugfix\n- risk: low · size: ~5 changed lines · deps-change: no\n- after: ${extra || 'none'}\n`;

test('queue summary counts entries per repo and names what run would take next', t => {
  const f = fixture(t);
  const text = queueSkeleton(f.config).replace('## Entries\n', `## Entries\n\n${entry('a', 'app', 'merged (PR #1, 2026-11-01)')}\n${entry('b', 'app', 'ready', 'c')}\n${entry('c', 'app', 'pr-open (PR #2, 2026-11-02)')}\n${entry('d', 'app', 'needs-human (keep the legacy table?)')}\n${entry('e', 'api', 'ready')}\n${entry('f', 'api', 'Ready')}\n`);
  const summary = queueSummary(text, f.config);
  assert.equal(summary.entries, 6);
  assert.deepEqual(summary.repos[0], { repo: 'app', ready: 1, 'needs-human': 1, blocked: 0, pushed: 0, 'pr-open': 1, merged: 1, fallback: 0, other: 0, next: null });
  assert.deepEqual(summary.repos[1], { repo: 'api', ready: 1, 'needs-human': 0, blocked: 0, pushed: 0, 'pr-open': 0, merged: 0, fallback: 0, other: 1, next: 'e' });
  assert.deepEqual(summary.needsHuman, [{ slug: 'd', repo: 'app', decision: 'keep the legacy table?' }]);
  assert.equal(summary.lint.ok, true);
  assert.ok(summary.lint.warnings > 0);
});

test('status reports budget, queue, last run, locks, worktrees and recovery without changing anything', t => {
  const f = fixture(t);
  const empty = status(f.file, { now: NOW * 1000, writer: WRITER_OK, runtimeCheck: () => ({ platform: 'linux', git: '2.43' }) });
  assert.deepEqual(empty.runtime, { ok: true, platform: 'linux', git: '2.43' });
  assert.equal(empty.budget.state, 'unavailable');
  assert.deepEqual(empty.queue, { file: path.join(f.dir, 'AUTOFIX_QUEUE.md'), missing: true });
  assert.equal(empty.lastRun, null);
  assert.deepEqual([empty.locks, empty.recovery], [[], { entries: [], allocatedBytes: 0 }]);
  assert.ok(!fs.existsSync(f.root), 'status never creates the worktree root');

  fs.writeFileSync(path.join(f.dir, 'latest.json'), JSON.stringify(snapshot()));
  fs.writeFileSync(path.join(f.dir, 'AUTOFIX_QUEUE.md'), queueSkeleton(f.config));
  fs.mkdirSync(path.join(f.root, 'app'), { recursive: true });
  fs.mkdirSync(path.join(f.root, '.locks', 'repo-app'), { recursive: true });
  fs.writeFileSync(path.join(f.root, '.locks', 'repo-app', 'owner.json'), JSON.stringify({ token: 'secret-token', session: 's1', command: 'dev-autofix:run', host: 'h', pid: 42 }));
  fs.mkdirSync(path.join(f.root, '.locks', 'run.abandoned-1'));
  fs.writeFileSync(path.join(f.root, 'last-run.json'), JSON.stringify({ startedAt: '2026-11-10T10:00:00Z', prs: [{ repo: 'app', number: 7, branch: 'fix/auto-20261110-a', url: 'https://github.com/o/app/pull/7' }] }));
  const before = fs.readdirSync(f.root, { recursive: true }).sort();
  const full = status(f.file, { now: NOW * 1000, writer: WRITER_OK, runtimeCheck: () => { throw new Error('Git 2.34 is too old'); } });
  assert.deepEqual(full.runtime, { ok: false, error: 'Git 2.34 is too old' });
  assert.equal(full.budget.state, 'ok');
  assert.equal(full.queue.entries, 0);
  assert.equal(full.lastRun.prs[0].number, 7);
  assert.equal(full.locks.length, 1);
  assert.deepEqual(full.locks[0].owner, { session: 's1', command: 'dev-autofix:run', host: 'h', pid: 42 });
  assert.ok(!JSON.stringify(full).includes('secret-token'), 'the lock token is never printed');
  assert.deepEqual(full.worktrees.map(item => item.exists), [true, false]);
  assert.deepEqual(fs.readdirSync(f.root, { recursive: true }).sort(), before);
  // A lock that cannot be inspected is reported by name, never mistaken for no lock.
  fs.writeFileSync(path.join(f.root, '.locks', 'stray'), 'not a lock directory\n');
  const odd = status(f.file, { now: NOW * 1000, writer: WRITER_OK, runtimeCheck: () => ({ platform: 'linux', git: '2.43' }) });
  assert.deepEqual(odd.locks.find(item => item.name === 'stray'), { name: 'stray', error: 'Invalid lock directory' });
});

test('status CLI prints JSON and names a missing argument', t => {
  const f = fixture(t);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'status.mjs');
  const ok = spawnSync(process.execPath, [script, f.file], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).config, f.file);
  const bad = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Usage: status\.mjs/);
});
