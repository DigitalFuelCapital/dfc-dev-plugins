import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkWorktree, validateConfig, writeAtomic } from './state.mjs';
import { createRuntime, installIfStale } from './merge.mjs';

export { createRuntime };

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const rootPath = config => fs.realpathSync((config.worktreeRoot ?? '~/.claude/autofix/worktrees').replace(/^~\//, `${os.homedir()}/`));
const recordPath = (root, repo, number, id) => path.join(root, 'review', 'records', 'validation', `${repo.name}-pr${number}-${id}.json`);

function repository(config, name) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === name);
  requireValue(repo, 'Unknown repository');
  return repo;
}
function samePR(repo, input, pr) {
  requireValue(pr.number === input.number && pr.state === 'OPEN' && pr.isCrossRepository === false && pr.baseRefName === repo.baseBranch, 'PR identity, state or base changed');
  requireValue(pr.headRefName !== repo.baseBranch && pr.headRefName.startsWith(`${repo.branchPrefix ?? 'fix/auto'}-`), 'Not a same-repository autofix head branch');
  requireValue(pr.headRefOid === input.headSha, 'PR head changed; review the new commit');
  return pr;
}

// Tests and commands run only at the unchanged PR head. The caller still performs
// the code review, checks discussion/CI, and decides whether validation is sufficient.
export async function verifyReview(config, name, token, input, runtime = createRuntime()) {
  const repo = repository(config, name);
  requireValue(Number.isSafeInteger(input?.number) && input.number > 0 && shaOK(input.headSha) && shaOK(input.baseSha), 'Review input needs a PR number and exact head/base SHAs');
  const id = randomUUID(), root = rootPath(config);
  const logs = path.join(root, 'review', 'scratch', `review-${id}`);
  fs.mkdirSync(logs, { recursive: true });
  const result = { id, repo: name, number: input.number, headSha: input.headSha, baseSha: input.baseSha, startedAt: new Date().toISOString(), status: 'running', commands: [], restoration: { status: 'not-needed' } };
  const target = recordPath(root, repo, input.number, id);
  writeAtomic(target, result, { exclusive: true });
  let worktree, original, headRef, checkoutAttempted = false, interrupted;
  const onInterrupt = () => { interrupted = 'SIGINT'; };
  const onTerminate = () => { interrupted = 'SIGTERM'; };
  const uninterrupted = () => requireValue(!interrupted, `Review interrupted by ${interrupted}`);
  const attachment = () => runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    result.stage = 'worktree';
    worktree = checkWorktree(config, name, token, runtime.git);
    requireValue(worktree.exists, 'Review reuses an existing managed worktree; none exists');
    const branch = attachment();
    original = { headSha: worktree.headSha, branch: branch === 'HEAD' ? null : branch, status: runtime.git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']) };
    result.original = original;
    result.stage = 'identity';
    const pr = samePR(repo, input, await runtime.readPR(repo, input.number));
    result.headBranch = pr.headRefName;
    requireValue(await runtime.readBase(repo) === input.baseSha, 'Remote base changed; refresh the review baseline');
    uninterrupted();
    result.stage = 'fetch';
    // A private ref retains the PR head. --refmap= leaves refs/remotes/origin/<branch> alone:
    // it may be all that retains a detached original HEAD when the PR was force-pushed.
    runtime.git(repo.path, ['check-ref-format', `refs/heads/${pr.headRefName}`]);
    headRef = `refs/autofix/review/${repo.name}/pr${input.number}-${id}`;
    runtime.git(repo.path, ['fetch', '--no-tags', '--refmap=', 'origin', `+refs/heads/${pr.headRefName}:${headRef}`]);
    requireValue(runtime.git(repo.path, ['rev-parse', headRef]) === input.headSha, 'Head moved during fetch; refresh and review again');
    requireValue(checkWorktree(config, name, token, runtime.git).headSha === original.headSha && attachment() === (original.branch ?? 'HEAD'), 'Original worktree moved before checkout');
    uninterrupted();
    result.stage = 'checkout';
    checkoutAttempted = true;
    runtime.git(worktree.path, ['checkout', '--detach', input.headSha]);
    requireValue(checkWorktree(config, name, token, runtime.git).headSha === input.headSha && attachment() === 'HEAD', 'Checkout did not select the exact detached PR head');
    const run = async (phase, command) => {
      uninterrupted();
      result.stage = phase;
      const log = path.join(logs, `${result.commands.length}.log`);
      const execution = await runtime.run(command, worktree.path, log, (repo.commandTimeoutSeconds ?? 600) * 1000);
      result.commands.push({ phase, command, ...execution, log, logHash: hash(fs.readFileSync(log)) });
      uninterrupted();
      requireValue(!execution.timedOut && execution.exitCode === 0 && !execution.signal, `${phase} command failed or timed out; see ${log}`);
      return true;
    };
    await installIfStale(root, repo, worktree.path, run);
    for (const command of repo.prepare ?? []) await run('prepare', command);
    for (const command of repo.verify) await run('verify', command);
    result.stage = 'freshness';
    requireValue(checkWorktree(config, name, token, runtime.git).headSha === input.headSha, 'Verification changed HEAD; preserve it');
    samePR(repo, input, await runtime.readPR(repo, input.number));
    requireValue(await runtime.readBase(repo) === input.baseSha, 'Remote base changed during verification');
    uninterrupted();
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  } finally {
    if (checkoutAttempted && original) {
      try {
        const current = checkWorktree(config, name, token, runtime.git, { requireRetained: false });
        if (current.headSha === original.headSha && attachment() === (original.branch ?? 'HEAD')) {
          result.restoration = { status: 'unchanged' };
        } else {
          requireValue(current.headSha === input.headSha && attachment() === 'HEAD', 'Worktree HEAD or attachment changed; preserve it rather than switch');
          if (original.branch) requireValue(runtime.git(repo.path, ['rev-parse', `refs/heads/${original.branch}`]) === original.headSha, 'Original branch moved; preserve the review checkout');
          runtime.git(worktree.path, ['checkout', ...(original.branch ? [original.branch] : ['--detach', original.headSha])]);
          const restored = checkWorktree(config, name, token, runtime.git);
          requireValue(restored.headSha === original.headSha && attachment() === (original.branch ?? 'HEAD') && runtime.git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']) === original.status, 'Original worktree was not fully restored');
          result.restoration = { status: 'restored' };
        }
      } catch (error) {
        result.status = 'failed';
        result.restoration = { status: 'failed', error: error.message };
        result.error ??= error.message;
        // A preserved detached checkout keeps the private ref so later fetches cannot orphan it.
        try {
          if (attachment() === 'HEAD') {
            result.retainedRef = headRef;
            runtime.git(repo.path, ['update-ref', headRef, runtime.git(worktree.path, ['rev-parse', 'HEAD'])]);
          }
        } catch (refError) { result.restoration.retainError = refError.message; }
      }
    }
    if (headRef && !result.retainedRef) {
      try { runtime.git(repo.path, ['update-ref', '-d', headRef]); } catch (refError) { result.retainedRef = headRef; result.refCleanupError = refError.message; }
    }
    if (interrupted) { result.status = 'failed'; result.error ??= `Review interrupted by ${interrupted}`; }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    result.finishedAt = new Date().toISOString();
    writeAtomic(target, result);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, configFile, name, token, inputFile] = process.argv.slice(2);
    requireValue(command === 'verify' && inputFile, 'Usage: review.mjs verify <config> <repo> <token> <input-file>');
    const result = await verifyReview(read(configFile), name, token, read(inputFile));
    console.log(JSON.stringify(result));
    if (result.status !== 'passed') process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
