// The managed worktree and the approved path: prepare, land, cleanup, remove-worktree.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkWorktree } from '../state.mjs';
import { checkVerifiedMerge, installIfStale, releaseVerification, verifyMerge } from '../merge.mjs';
import { createRuntime, prefix, requireValue, rootPath, shaOK } from './common.mjs';
import { parseQueue, queueFile, setStatus, writeText } from './queue.mjs';
import { buildApprovalInput } from './approval.mjs';

// Deleting a worktree with node_modules took over 120s in the live run; 30 minutes still bounds a hang.
export const WORKTREE_REMOVE_TIMEOUT_MS = 30 * 60 * 1000;

export function cleanup({ configFile, config, repo, token, number, verificationId }, runtime = createRuntime()) {
  const { git } = runtime;
  const pr = runtime.readPR(repo.remote, number);
  if (pr.state !== 'MERGED') return { ok: false, reason: `PR is ${pr.state}; merge queued or not merged, entry stays pr-open` };
  const mergeCommit = pr.mergeCommit?.oid;
  if (!shaOK(mergeCommit)) return { ok: false, reason: `GitHub reports no valid merge commit for PR #${number} (${mergeCommit ?? 'missing'}); entry stays pr-open` };
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  try { git(repo.path, ['merge-base', '--is-ancestor', mergeCommit, base]); }
  catch { return { ok: false, reason: `merge commit ${mergeCommit} is not on the fetched ${repo.baseBranch} yet` }; }
  const result = { ok: true, number };
  const qfile = queueFile(configFile, config);
  const text = fs.readFileSync(qfile, 'utf8');
  const entry = parseQueue(text).find(item => item.repo === repo.name && new RegExp(`PR #${number}\\b`).test(item.status));
  if (entry) { writeText(qfile, setStatus(text, entry.slug, `merged (PR #${number}, ${runtime.today()})`)); result.queue = `${entry.slug} -> merged`; }
  else result.queue = 'no queue entry references this PR';

  const wt = checkWorktree(config, repo.name, token, git);
  if (wt.exists) { git(wt.path, ['checkout', '--detach', base, '--quiet']); checkWorktree(config, repo.name, token, git); }
  if (verificationId) result.released = releaseVerification(config, repo.name, token, verificationId, { git }).released;

  const head = pr.headRefOid, branch = pr.headRefName;
  const local = (() => { try { return git(repo.path, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]); } catch { return ''; } })();
  if (!local) result.local = 'absent';
  else if (local !== head) result.local = `kept: tip ${local} advanced past merged ${head}`;
  else {
    try { git(repo.path, ['branch', '-D', branch]); result.local = 'deleted'; }
    catch (error) { result.local = `kept: ${error.stderr?.trim() || error.message}`; }
  }
  // KEY-DECISION 2026-09-27: repos with delete_branch_on_merge remove the head first; absence is success.
  const remoteTip = git(repo.path, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
  if (!remoteTip) result.remote = 'already deleted';
  else if (remoteTip !== head) result.remote = `kept: remote tip ${remoteTip} advanced past merged ${head}`;
  else {
    try { git(repo.path, ['push', `--force-with-lease=refs/heads/${branch}:${head}`, 'origin', `:refs/heads/${branch}`]); result.remote = 'deleted'; }
    catch (error) { result.remote = `kept: lease rejected (${error.stderr?.trim() || error.message})`; }
  }
  return result;
}

export function removeWorktree({ configFile, config, repo, token }, runtime = createRuntime()) {
  const { git, gh } = runtime;
  const keep = reason => ({ removed: false, reason });
  const text = fs.readFileSync(queueFile(configFile, config), 'utf8');
  const unpublished = parseQueue(text).filter(entry => entry.repo === repo.name && /^(pr-open|pushed)\b/.test(entry.status));
  if (unpublished.length) return keep(`queue has ${unpublished.map(entry => `${entry.slug} (${entry.status})`).join(', ')}`);
  const open = JSON.parse(gh(['pr', 'list', '-R', repo.remote, '--state', 'open', '--json', 'number,headRefName', '--limit', '200'])).filter(item => item.headRefName.startsWith(`${prefix(repo)}-`));
  if (open.length) return keep(`open autofix PRs: ${open.map(item => `#${item.number}`).join(', ')}`);
  const wt = checkWorktree(config, repo.name, token, git);
  if (!wt.exists) return keep('managed worktree does not exist');
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  try { git(wt.path, ['merge-base', '--is-ancestor', 'HEAD', base]); }
  catch { return keep('worktree HEAD is not on the fetched base'); }
  checkWorktree(config, repo.name, token, git);
  git(repo.path, ['worktree', 'remove', wt.path], { timeout: WORKTREE_REMOVE_TIMEOUT_MS });
  for (const file of [path.join(rootPath(config), `${repo.name}.lock.sha`), prepareMarker(rootPath(config), repo)]) if (fs.existsSync(file)) fs.unlinkSync(file);
  return { removed: true, path: wt.path };
}

/**
 * Create or reuse the managed worktree at the base (or a PR head), then refresh dependencies.
 * Never prunes, resets or cleans: a stale registration is reported for the skill's prune rules.
 */
export async function prepare({ config, repo, token, head = null, depsOnly = false }, runtime = createRuntime()) {
  const { git } = runtime;
  const root = rootPath(config);
  // --deps-only refreshes dependencies in place after finish syncs the base: HEAD is an unretained
  // local merge that must not be checked out or switched away from.
  if (depsOnly) {
    const wt = checkWorktree(config, repo.name, token, git, { requireRetained: false });
    requireValue(wt.exists, 'Managed worktree is missing; run prepare without --deps-only');
    return refreshDependencies({ config, repo, token, root, wtPath: wt.path, created: false }, runtime);
  }
  let wt = checkWorktree(config, repo.name, token, git);
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  let target = base;
  if (head) {
    git(repo.path, ['check-ref-format', `refs/heads/${head}`]);
    target = `refs/remotes/origin/${head}`;
    git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${head}:${target}`]);
  }
  let created = false;
  if (!wt.exists) {
    if (wt.registered) {
      // git prints prune --dry-run to stderr; the porcelain listing carries the same reason.
      const listing = git(repo.path, ['worktree', 'list', '--porcelain']).split('\n\n').find(item => item.startsWith(`worktree ${wt.path}\n`)) ?? '';
      return { ok: false, stage: 'prune-needed', path: wt.path, registration: listing };
    }
    git(repo.path, ['worktree', 'add', '--detach', wt.path, target]);
    created = true;
  } else {
    git(wt.path, ['checkout', '--detach', target, '--quiet']);
  }
  wt = checkWorktree(config, repo.name, token, git);
  return refreshDependencies({ config, repo, token, root, wtPath: wt.path, created }, runtime);
}

// Prepare commands succeed once per managed tree; the marker makes a failed attempt re-run on retry.
const prepareMarker = (root, repo) => path.join(root, `${repo.name}.prepared`);
const prepareFingerprint = repo => createHash('sha256').update(JSON.stringify(repo.prepare ?? [])).digest('hex');

async function refreshDependencies({ config, repo, token, root, wtPath, created }, runtime) {
  const { git } = runtime;
  const marker = prepareMarker(root, repo);
  if (created && fs.existsSync(marker)) fs.unlinkSync(marker);
  // A new tree has no dependencies yet: drop the digest cache so install runs even for a repo
  // whose installMarker is "" (no path to look for).
  if (created) fs.rmSync(path.join(root, `${repo.name}.lock.sha`), { force: true });
  const logs = path.join(root, 'review', 'scratch', `prepare-${randomUUID()}`);
  const timeoutMs = (repo.commandTimeoutSeconds ?? 600) * 1000;
  const steps = [];
  const exec = async (phase, command) => {
    fs.mkdirSync(logs, { recursive: true });
    const log = path.join(logs, `${steps.length}.log`);
    const result = await runtime.merge.run(command, wtPath, log, timeoutMs, repo.env ?? []);
    steps.push({ phase, command, log, ...result });
    return result.exitCode === 0 && !result.signal && !result.timedOut;
  };
  const installed = await installIfStale(root, repo, wtPath, exec);
  if (installed === false) return { ok: false, stage: 'install', path: wtPath, steps };
  let prepared = false;
  const fingerprint = prepareFingerprint(repo);
  const done = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === fingerprint;
  if (!done && (repo.prepare ?? []).length) {
    for (const command of repo.prepare) if (!await exec('prepare', command)) return { ok: false, stage: 'prepare', path: wtPath, steps };
    prepared = true;
  }
  if (!done) fs.writeFileSync(marker, `${fingerprint}\n`);
  try { checkWorktree(config, repo.name, token, git, { requireRetained: false }); }
  catch (error) { return { ok: false, stage: 'dirty', path: wtPath, error: error.message, steps }; }
  return { ok: true, path: wtPath, created, installed: Boolean(installed), prepared, head: git(wtPath, ['rev-parse', 'HEAD']), logs: steps.map(step => step.log) };
}

const LONG_GH_MS = 60 * 60 * 1000;

async function waitForChecks({ repo, number }, runtime, retries = 4, pauseMs = 15000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      runtime.gh(['pr', 'checks', String(number), '-R', repo.remote, '--watch', '--fail-fast', '--interval', '15'], { timeout: LONG_GH_MS });
      return { ok: true };
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`;
      // Checks can take a few seconds to register after a ready event.
      if (!/no checks reported/i.test(output)) return { ok: false, error: output.trim().split('\n').slice(-5).join('\n') };
      if (attempt < retries) await runtime.sleep(pauseMs);
    }
  }
  return { ok: true, noChecks: true };
}

/**
 * Land one approved PR: verify the integration, wait for CI, re-check approval and base, merge
 * the exact approved head, confirm, and clean up. Never posts comments or bypasses branch rules.
 */
export async function land({ configFile, config, repo, token, number }, runtime = createRuntime()) {
  const root = rootPath(config);
  const approval = () => buildApprovalInput({ config, repo, number, root }, runtime);
  const first = approval();
  if (first.classification !== 'approve') return { ok: false, number, stage: first.classification, reason: first.reason ?? null, pending: first.pending ?? [] };
  let input = first.input, verification, checked, ci = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    verification = await verifyMerge(config, repo.name, token, input, runtime.merge);
    if (verification.status !== 'passed') return { ok: false, number, stage: verification.status === 'conflict' ? 'conflict' : 'verify', error: verification.error, verificationId: verification.id };
    if (!ci) {
      if (first.isDraft) runtime.gh(['pr', 'ready', String(number), '-R', repo.remote]);
      ci = await waitForChecks({ repo, number }, runtime);
      if (!ci.ok) return { ok: false, number, stage: 'ci', error: ci.error, verificationId: verification.id };
    }
    const fresh = approval();
    if (fresh.classification !== 'approve') return { ok: false, number, stage: fresh.classification, reason: fresh.reason ?? null, verificationId: verification.id };
    try {
      checked = await checkVerifiedMerge(config, repo.name, token, fresh.input, verification.id, runtime.merge);
      break;
    } catch (error) {
      // Only a moved base is retried; the unchanged head keeps its approval.
      if (!/changed since verification/.test(error.message) || fresh.headSha !== first.headSha || attempt === 3) return { ok: false, number, stage: 'check', error: error.message, verificationId: verification.id, attempts: attempt };
      releaseVerification(config, repo.name, token, verification.id, runtime.merge);
      input = fresh.input;
    }
  }
  runtime.gh(['pr', 'merge', String(number), '-R', repo.remote, `--${config.mergeMethod ?? 'squash'}`, '--match-head-commit', checked.approvedHead], { timeout: 10 * 60 * 1000 });
  let state = null;
  for (let poll = 0; poll < 6; poll++) {
    state = runtime.readPR(repo.remote, number).state;
    if (state === 'MERGED') break;
    await runtime.sleep(5000);
  }
  if (state !== 'MERGED') return { ok: false, number, stage: 'queued', state, verificationId: verification.id };
  const cleaned = cleanup({ configFile, config, repo, token, number, verificationId: verification.id }, runtime);
  return { ok: cleaned.ok, number, evidence: first.evidence, approvedHead: checked.approvedHead, verificationId: verification.id, noChecks: ci?.noChecks ?? false, cleanup: cleaned };
}
