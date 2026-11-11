import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkApproval, parseApproval } from '../scripts/state.mjs';
import { buildApprovalInput, createRuntime } from '../scripts/pr.mjs';

const HEAD = 'a'.repeat(40), OLD = 'b'.repeat(40);
const twoLine = (head = HEAD, checks = '') => `LGTM\nReviewed head: ${head}${checks ? `\nChecks: ${checks}` : ''}`;

test('an approval is a bare token, or a token that names the commit it reviewed', () => {
  assert.deepEqual(parseApproval('LGTM'), { token: 'LGTM', reviewedHead: null });
  assert.deepEqual(parseApproval('  lgtm \n'), { token: 'LGTM', reviewedHead: null });
  assert.deepEqual(parseApproval('/merge'), { token: '/merge', reviewedHead: null });
  assert.deepEqual(parseApproval(twoLine()), { token: 'LGTM', reviewedHead: HEAD });
  assert.deepEqual(parseApproval(twoLine(HEAD.toUpperCase(), 'passed').replace('LGTM', 'lgtm').replace(HEAD.toUpperCase(), HEAD)), { token: 'LGTM', reviewedHead: HEAD });
  assert.deepEqual(parseApproval(`LGTM\r\n\r\nReviewed head: ${HEAD}\r\nChecks: not run: sandbox`), { token: 'LGTM', reviewedHead: HEAD });
  for (const feedback of ['', '   ', 'LGTM but rename x', 'LGTM\nrename x', `LGTM\nReviewed head: ${HEAD}\nplease also fix y`, 'LGTM\nChecks: passed', 'LGTM\nReviewed head: abc123',
    `Reviewed head: ${HEAD}\nLGTM`, `LGTM\nReviewed head: ${HEAD}\nReviewed head: ${OLD}`, 'Looks good', '**LGTM**']) {
    assert.equal(parseApproval(feedback), null, JSON.stringify(feedback));
  }
  assert.deepEqual(parseApproval('ship it', ['ship it']), { token: 'ship it', reviewedHead: null });
});

const pending = (body, extra = {}) => ({ id: 11, kind: 'issue', url: 'https://github.com/owner/repo/pull/7#issuecomment-11', author: 'Reviewer', body, createdAt: '2026-09-27T18:00:00Z', updatedAt: '2026-09-27T18:00:00Z', ...extra });
const input = (entry, extra = {}) => ({ remote: 'owner/repo', number: 7, headRef: 'fix/auto-x', headSha: HEAD, pending: [entry], reviewers: ['reviewer'], ...extra });

test('a comment that names its reviewed head approves that head and no other, without a record or push history', () => {
  assert.equal(checkApproval(input(pending(twoLine()))), HEAD);
  assert.equal(checkApproval(input(pending(twoLine(HEAD, 'passed')))), HEAD);
  assert.throws(() => checkApproval(input(pending(twoLine(OLD)))), /different head/);
  assert.throws(() => checkApproval(input(pending(twoLine(), { updatedAt: '2026-09-27T18:05:00Z' }))), /Edited approval/);
  assert.throws(() => checkApproval(input(pending(twoLine(), { author: 'stranger' }))), /not a configured reviewer/);
  assert.throws(() => checkApproval(input(pending(twoLine(), { kind: 'inline' }))), /Inline comments cannot approve/);
  assert.throws(() => checkApproval(input(pending(twoLine(), { url: 'https://github.com/owner/other/pull/7#issuecomment-11' }))), /published conversation comment/);
  assert.throws(() => checkApproval(input(pending(`${twoLine()}\nand one more thing`))), /Not an exact approval token/);
  // A bare token still needs a record or push history.
  assert.throws(() => checkApproval(input(pending('LGTM'))), /push history/);
  // A formal review that also names a head must name the current one.
  const review = { id: 5, kind: 'review', url: 'https://github.com/owner/repo/pull/7#pullrequestreview-5', author: 'reviewer', state: 'APPROVED', commitSha: HEAD };
  assert.equal(checkApproval(input({ ...review, body: twoLine() })), HEAD);
  assert.throws(() => checkApproval(input({ ...review, body: twoLine(OLD) })), /different head/);
});

function approvalRuntime({ head = HEAD, issues = [], reviews = [], inline = [], activities = null } = {}) {
  const runtime = createRuntime();
  runtime.login = () => 'reviewer';
  runtime.readPR = () => ({ number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: 'fix/auto-20260927-alpha', headRefOid: head, baseRefName: 'staging', url: 'https://github.com/owner/repo/pull/7' });
  runtime.ghPages = api => {
    if (api.endsWith('/issues/7/comments')) return issues;
    if (api.endsWith('/pulls/7/reviews')) return reviews;
    if (api.endsWith('/pulls/7/comments')) return inline;
    if (api.includes('/activity?')) { assert.ok(activities, 'push history must not be fetched for this case'); return activities; }
    throw new Error(`unexpected api ${api}`);
  };
  return runtime;
}
const comment = (id, body, at, extra = {}) => ({ id, body, user: { login: 'reviewer' }, html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`, created_at: at, updated_at: at, ...extra });
const config = { version: 1, reviewers: ['reviewer'], repos: [] };
const repo = { name: 'repo', remote: 'owner/repo', baseBranch: 'staging' };
const build = (t, options) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return buildApprovalInput({ config, repo, number: 7, root }, approvalRuntime(options));
};

test('approval input binds a self-describing approval from the comment alone', t => {
  const ok = build(t, { issues: [comment(11, twoLine(HEAD, 'passed'), '2026-09-27T18:00:00Z')] });
  assert.equal(ok.classification, 'approve');
  assert.equal(ok.evidence, 'comment');
  assert.equal(ok.approvedHead, HEAD);
  assert.deepEqual(ok.superseded, []);
  const stale = build(t, { issues: [comment(11, twoLine(OLD), '2026-09-27T18:00:00Z')] });
  assert.equal(stale.classification, 'stale');
  const edited = build(t, { issues: [comment(11, twoLine(), '2026-09-27T18:00:00Z', { updated_at: '2026-09-27T18:09:00Z' })] });
  assert.equal(edited.classification, 'evidence-unavailable');
});

test('a newer approval supersedes older approvals, but never feedback', t => {
  // The first approval is a bare token that cannot be bound (edited). It no longer blocks the second.
  const unbindable = comment(11, 'LGTM', '2026-09-27T18:00:00Z', { updated_at: '2026-09-27T18:01:00Z' });
  const result = build(t, { issues: [unbindable, comment(12, twoLine(), '2026-09-27T18:10:00Z')] });
  assert.equal(result.classification, 'approve');
  assert.equal(result.evidence, 'comment');
  assert.deepEqual(result.superseded, [11]);
  assert.deepEqual(result.input.pending.map(item => item.id), [12]);
  assert.deepEqual(result.pending.map(item => item.id), [11, 12], 'the full timeline is still reported');
  // The newest approval decides, even when an older one was valid.
  const newestStale = build(t, { issues: [comment(11, twoLine(), '2026-09-27T18:00:00Z'), comment(12, twoLine(OLD), '2026-09-27T18:10:00Z')] });
  assert.equal(newestStale.classification, 'stale');
  // Feedback anywhere in the pending timeline is addressed, whatever approvals surround it.
  for (const issues of [
    [comment(11, 'rename x', '2026-09-27T18:00:00Z'), comment(12, twoLine(), '2026-09-27T18:10:00Z')],
    [comment(11, twoLine(), '2026-09-27T18:00:00Z'), comment(12, 'actually, rename x', '2026-09-27T18:10:00Z')],
    [comment(11, `${twoLine()}\nbut rename x`, '2026-09-27T18:00:00Z')],
  ]) assert.equal(build(t, { issues }).classification, 'address');
  const inline = [{ id: 41, body: 'LGTM', user: { login: 'reviewer' }, html_url: 'https://github.com/owner/repo/pull/7#discussion_r41', path: 'a.txt', line: 1, created_at: '2026-09-27T18:20:00Z' }];
  assert.equal(build(t, { issues: [comment(11, twoLine(), '2026-09-27T18:00:00Z')], inline }).classification, 'address', 'an inline comment is never an approval');
});

test('both spellings of the follow-up marker end a review round', t => {
  for (const marker of ['<!-- dev-autofix:finish addressed=31 -->', '<!-- dev-autofix:review addressed=31 -->']) {
    const issues = [comment(31, 'rename x', '2026-09-27T18:00:00Z'), comment(32, `**Review addressed**\n${marker}`, '2026-09-27T18:10:00Z')];
    assert.equal(build(t, { issues }).classification, 'awaiting review', marker);
    const next = build(t, { issues: [...issues, comment(33, twoLine(), '2026-09-27T18:20:00Z')] });
    assert.equal(next.classification, 'approve', marker);
    assert.deepEqual(next.pending.map(item => item.id), [33]);
  }
});
