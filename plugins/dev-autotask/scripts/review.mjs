// The latest review of a dev-autotask PR, read from `gh pr view --json headRefOid,comments`.
// finish merges only on this helper's `approved: true`, so which comment counts as the review,
// who may write it and which head it binds are decided here, not by reading comments by hand.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { showTask } from './state.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const HEAD_LINE = /^Reviewed head: ([0-9a-f]{40})$/i;

/**
 * The newest comment by a reviewer with a `Reviewed head: <sha>` line is the review. It is
 * an LGTM only in task-review's exact form (`LGTM`, `Reviewed head:`, optional `Checks:`)
 * and only if never edited: anyone with write access can edit a comment. `newerComments`
 * counts what was said after it (bots included) for finish to read; it does not block.
 */
export function latestReview({ comments, headRefOid, reviewers }) {
  need(Array.isArray(comments), 'Expected the PR comments');
  need(Array.isArray(reviewers) && reviewers.length, 'No reviewers: set reviewers in the config or pass --login');
  const allowed = new Set(reviewers.map(login => login.toLowerCase()));
  const lines = body => String(body ?? '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const sorted = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const index = sorted.findLastIndex(c => allowed.has(c.author?.login?.toLowerCase()) && lines(c.body).some(line => HEAD_LINE.test(line)));
  if (index < 0) return { review: null, current: false, newerComments: sorted.length, approved: false };
  const comment = sorted[index], body = lines(comment.body);
  const reviewedHead = HEAD_LINE.exec(body.find(line => HEAD_LINE.test(line)))[1].toLowerCase();
  const checks = body.find(line => /^Checks: /i.test(line))?.slice(8).trim() ?? null;
  const exact = body[0] === 'LGTM' && HEAD_LINE.test(body[1] ?? '') && body.slice(2).every(line => /^Checks: \S/i.test(line)) && body.length <= 3;
  const verdict = !exact ? 'findings' : comment.includesCreatedEdit ? 'edited' : 'lgtm';
  const current = reviewedHead === String(headRefOid).toLowerCase();
  const newerComments = sorted.length - index - 1;
  return {
    review: { author: comment.author.login, url: comment.url ?? null, createdAt: comment.createdAt, verdict, reviewedHead, checks },
    // approved: the current head has an exact, unedited LGTM. That alone allows a merge.
    current, newerComments, approved: verdict === 'lgtm' && current,
  };
}

// gh pr view <pr> --repo <remote> --json headRefOid,comments | review.mjs --remote <owner/repo> <id> [--login <gh-login>]
function main(argv, stdin) {
  const options = {}, args = [];
  let login = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--remote') options.remote = argv[++i];
    else if (argv[i] === '--login') login = argv[++i];
    else args.push(argv[i]);
  }
  need(args.length === 1 && options.remote, 'Usage: gh pr view <pr> --json headRefOid,comments | review.mjs --remote <owner/repo> <id> [--login <gh-login>]');
  const task = showTask(args[0], options);
  const pr = JSON.parse(stdin);
  return latestReview({ comments: pr.comments, headRefOid: pr.headRefOid, reviewers: task.reviewers ?? (login ? [login] : []) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2), fs.readFileSync(0, 'utf8')), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
