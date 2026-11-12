import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTask, loadConfig } from '../scripts/state.mjs';
import { latestReview } from '../scripts/review.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
let clock = 0;
const comment = (login, body, extra = {}) => ({ author: { login }, body, createdAt: new Date(Date.UTC(2026, 10, 11, 10, 0, clock++)).toISOString(), url: `https://github.com/o/r/pull/1#issuecomment-${clock}`, includesCreatedEdit: false, ...extra });
const lgtm = (head = HEAD, checks = 'passed') => `LGTM\nReviewed head: ${head}\nChecks: ${checks}`;
const review = (comments, reviewers = ['Codex-Bot']) => latestReview({ comments, headRefOid: HEAD, reviewers });

test('an exact, unedited LGTM by a reviewer for the current head is approved', () => {
  const result = review([comment('someone', 'looks fine'), comment('codex-bot', lgtm())]);
  assert.equal(result.approved, true);
  assert.deepEqual({ ...result.review, url: undefined, createdAt: undefined }, { author: 'codex-bot', url: undefined, createdAt: undefined, verdict: 'lgtm', reviewedHead: HEAD, checks: 'passed' });
});

test('only a reviewer\'s comment counts, and the newest one decides', () => {
  assert.equal(review([comment('intruder', lgtm())]).review, null, 'a non-reviewer LGTM is ignored');
  const findings = `Reviewed head: ${HEAD}\n1. P1 a.js:3 off by one\nChecks: passed`;
  const result = review([comment('codex-bot', lgtm()), comment('codex-bot', findings)]);
  assert.equal(result.review.verdict, 'findings');
  assert.equal(result.approved, false);
});

test('an LGTM for an older head, an edited LGTM or one with extra text is not approved', () => {
  const stale = review([comment('codex-bot', lgtm(OLD))]);
  assert.deepEqual([stale.review.verdict, stale.current, stale.approved], ['lgtm', false, false]);
  assert.equal(review([comment('codex-bot', lgtm(), { includesCreatedEdit: true })]).review.verdict, 'edited');
  assert.equal(review([comment('codex-bot', `${lgtm()}\nbut please also rename x`)]).review.verdict, 'findings');
  assert.equal(review([comment('codex-bot', `Great work!\n${lgtm()}`)]).review.verdict, 'findings');
});

test('comments after the LGTM are counted for finish to read, without blocking the approval', () => {
  const result = review([comment('codex-bot', lgtm()), comment('teammate', 'wait, this breaks the import')]);
  assert.deepEqual([result.review.verdict, result.newerComments, result.approved], ['lgtm', 1, true]);
  assert.throws(() => review([], []), /No reviewers/);
});

test('review CLI reads the task\'s reviewers, falling back to --login', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-review-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const checkout = path.join(home, 'repo');
  fs.mkdirSync(checkout);
  const file = path.join(home, 'autofix.config.json');
  const write = extra => fs.writeFileSync(file, JSON.stringify({ version: 1, ...extra, repos: [{ name: 'repo', path: checkout, remote: 'Owner/Repo', baseBranch: 'main', verify: ['true'] }] }));
  write({});
  createTask(loadConfig(file, { root: path.join(home, '.claude', 'dev-autotask'), repo: 'repo' }), 'add-export', 'Add export');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'review.mjs');
  const pr = JSON.stringify({ headRefOid: HEAD, comments: [comment('me', lgtm())] });
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { input: pr, encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(run('--remote', 'Owner/Repo', 'add-export').stderr, /No reviewers/);
  assert.equal(JSON.parse(run('--remote', 'Owner/Repo', 'add-export', '--login', 'me').stdout).approved, true);
  write({ reviewers: ['codex-bot'] });
  assert.equal(JSON.parse(run('--remote', 'Owner/Repo', 'add-export', '--login', 'me').stdout).review, null, 'configured reviewers win over --login');
  assert.match(run('add-export').stderr, /Usage/);
});
