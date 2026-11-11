// The review timeline of one PR: what is pending, how it classifies, and what binds an approval.
import fs from 'node:fs';
import path from 'node:path';
import { checkApproval, parseApproval } from '../state.mjs';
import { createRuntime, prefix, read, shaOK } from './common.mjs';

// finish writes the first form; PRs handled before 4.0 carry the second. Both count.
const MARKERS = ['<!-- dev-autofix:finish addressed=', '<!-- dev-autofix:review addressed='];
const hasMarker = body => MARKERS.some(marker => body.includes(marker));
const DEFAULT_TOKENS = ['LGTM', '/merge'];

export function buildApprovalInput({ config, repo, number, root }, runtime = createRuntime()) {
  const remote = repo.remote;
  const pr = runtime.readPR(remote, number);
  const skip = reason => ({ number, classification: 'skipped', reason });
  if (pr.state !== 'OPEN') return skip(`PR is ${pr.state}`);
  if (pr.baseRefName !== repo.baseBranch) return skip(`base is ${pr.baseRefName}, not ${repo.baseBranch}`);
  if (pr.isCrossRepository || !pr.headRefName.startsWith(`${prefix(repo)}-`)) return skip('not a same-repository autofix branch');
  const reviewers = config.reviewers ?? [runtime.login()];
  const approveTokens = config.approveTokens ?? DEFAULT_TOKENS;
  const isReviewer = login => reviewers.some(item => item.toLowerCase() === login?.toLowerCase());
  const api = `repos/${remote}`;
  const timeline = [
    ...runtime.ghPages(`${api}/issues/${number}/comments`).map(c => ({ id: c.id, kind: 'issue', url: c.html_url, author: c.user?.login, body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at, at: c.created_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/reviews`).filter(r => r.body?.trim()).map(r => ({ id: r.id, kind: 'review', url: r.html_url, author: r.user?.login, body: r.body, state: r.state, commitSha: r.commit_id, at: r.submitted_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/comments`).map(c => ({ id: c.id, kind: 'inline', url: c.html_url, author: c.user?.login, body: c.body ?? '', path: c.path, line: c.line, createdAt: c.created_at, at: c.created_at })),
  ].filter(item => isReviewer(item.author));
  const markers = timeline.filter(item => hasMarker(item.body)).map(item => Date.parse(item.at));
  const since = markers.length ? Math.max(...markers) : -Infinity;
  const pending = timeline.filter(item => !hasMarker(item.body) && Date.parse(item.at) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(({ at, ...item }) => item);
  const base = { number, headRef: pr.headRefName, headSha: pr.headRefOid, isDraft: pr.isDraft, pending };
  if (!pending.length) return { ...base, classification: 'awaiting review' };
  // KEY-DECISION 2026-11-11: when every pending entry is an approval, the newest one decides and
  // the older ones are superseded. An approval that could not be bound to a commit used to stay
  // pending forever and turn every later approval into "feedback". Feedback is never superseded.
  const approvals = pending.map(item => item.kind === 'inline' ? null : parseApproval(item.body, approveTokens));
  if (!approvals.every(Boolean)) return { ...base, classification: 'address' };
  const only = pending.at(-1), stated = approvals.at(-1).reviewedHead;
  const superseded = pending.slice(0, -1).map(item => item.id);
  Object.assign(base, { superseded });

  const input = { remote, number, headRef: pr.headRefName, headSha: pr.headRefOid, pending: [only], reviewers, approveTokens };
  let evidence = only.kind === 'review' ? 'review' : null;
  if (only.kind === 'issue') {
    // KEY-DECISION 2026-09-27: review's immutable record is always preferred; push history is only the fallback.
    const recordFile = path.join(root, 'review', 'records', `${repo.name}-pr${number}-comment${only.id}.approval.json`);
    if (fs.existsSync(recordFile)) { input.record = read(recordFile); evidence = 'record'; }
    else if (stated) evidence = 'comment';
    else {
      const ref = `refs/heads/${pr.headRefName}`;
      const activities = runtime.ghPages(`${api}/activity?ref=${encodeURIComponent(ref)}&direction=desc&per_page=100`)
        .map(({ timestamp, before, after, ref: activityRef, activity_type }) => ({ timestamp, before, after, ref: activityRef, activity_type }));
      const observedHead = runtime.readPR(remote, number).headRefOid;
      if (observedHead !== pr.headRefOid) return { ...base, classification: 'evidence-unavailable', reason: 'head moved while collecting push history' };
      input.history = { remote, ref, complete: true, observedHead, activities };
      evidence = 'push-history';
    }
  }
  try {
    const approvedHead = checkApproval(input);
    return { ...base, classification: 'approve', evidence, approvedHead, input };
  } catch (error) {
    const stale = (stated && stated !== pr.headRefOid) || (input.record && input.record.headSha !== pr.headRefOid) || (only.kind === 'review' && shaOK(only.commitSha) && only.commitSha !== pr.headRefOid) || /different head/.test(error.message);
    return { ...base, classification: stale ? 'stale' : 'evidence-unavailable', evidence, reason: error.message };
  }
}
