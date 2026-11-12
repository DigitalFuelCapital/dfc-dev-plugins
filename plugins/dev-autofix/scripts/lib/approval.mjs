// The review timeline of one PR: what is pending, how it classifies, and what binds an approval.
import fs from 'node:fs';
import path from 'node:path';
import { checkApproval, parseApproval } from '../state.mjs';
import { createRuntime, prefix, read, shaOK } from './common.mjs';

// The follow-up marker finish posts: a line of its own in a conversation comment. PRs handled
// before 4.0 say `review`. A quoted (`> `) or inline copy is not a marker. Spacing is loose:
// `addressed=31, 32` and trailing whitespace are fine; up to three leading spaces, as four
// (or a tab) make a Markdown code block.
const MARKER = /^ {0,3}<!-- dev-autofix:(?:finish|review) addressed=([^>]*?)[ \t]*-->[ \t]*$/;
// CommonMark fences: at most three leading spaces; a backtick fence's info string has no
// backtick; a closing fence repeats the opening character at least as many times and is
// followed only by spaces or tabs, so `~~~html` or an indented fence does not close one.
const OPEN_FENCE = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/, CLOSE_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const markerIds = item => {
  if (item.kind !== 'issue') return null;
  // Text inside a ``` or ~~~ fence is an example, never a marker.
  let fence = null;
  for (const line of item.body.split(/\r?\n/)) {
    if (fence) {
      const close = CLOSE_FENCE.exec(line)?.[1];
      if (close && close[0] === fence[0] && close.length >= fence.length) fence = null;
      continue;
    }
    const open = OPEN_FENCE.exec(line)?.[1];
    if (open) { fence = open; continue; }
    const match = MARKER.exec(line);
    if (match) return new Set(match[1].split(/[\s,]+/).filter(Boolean));
  }
  return null;
};
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
  // finish posts markers as the gh user, who need not be a reviewer; feedback is reviewers' only.
  const finisher = config.reviewers ? runtime.login() : reviewers[0];
  const markerAuthor = login => isReviewer(login) || login?.toLowerCase() === finisher?.toLowerCase();
  const api = `repos/${remote}`;
  const timeline = [
    ...runtime.ghPages(`${api}/issues/${number}/comments`).map(c => ({ id: c.id, kind: 'issue', url: c.html_url, author: c.user?.login, body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at, at: c.created_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/reviews`).filter(r => r.body?.trim()).map(r => ({ id: r.id, kind: 'review', url: r.html_url, author: r.user?.login, body: r.body, state: r.state, commitSha: r.commit_id, at: r.submitted_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/comments`).map(c => ({ id: c.id, kind: 'inline', url: c.html_url, author: c.user?.login, body: c.body ?? '', path: c.path, line: c.line, createdAt: c.created_at, at: c.created_at })),
  ].map(item => ({ ...item, addressed: markerAuthor(item.author) ? markerIds(item) : null }))
    .filter(item => item.addressed || isReviewer(item.author));
  const markers = timeline.filter(item => item.addressed);
  const since = markers.length ? Math.max(...markers.map(item => Date.parse(item.at))) : -Infinity;
  // GitHub times have one-second resolution: feedback in the newest marker's second is pending
  // unless that marker names it.
  const addressed = new Set(markers.filter(item => Date.parse(item.at) === since).flatMap(item => [...item.addressed]));
  const pending = timeline.filter(item => !item.addressed && (Date.parse(item.at) > since || (Date.parse(item.at) === since && !addressed.has(String(item.id)))))
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(({ at, addressed: _, ...item }) => item);
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
