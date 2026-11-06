import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkWorktree, validateConfig, writeAtomic } from './state.mjs';
import { createRuntime as createMergeRuntime } from './merge.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuidOK = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const rootPath = config => fs.realpathSync((config.worktreeRoot ?? '~/.claude/autofix/worktrees').replace(/^~\//, `${os.homedir()}/`));
const contract = repo => ({ remote: repo.remote, baseBranch: repo.baseBranch, branchPrefix: repo.branchPrefix ?? 'fix/auto', install: repo.install ?? null, lockfile: repo.lockfile ?? 'package-lock.json', prepare: repo.prepare ?? [], verify: repo.verify, commandTimeoutSeconds: repo.commandTimeoutSeconds ?? 600 });
const contractHash = repo => hash(JSON.stringify(contract(repo)));
const refRoot = (repo, number, id) => `refs/autofix/review/${repo.name}/${number}/${id}`;
const recordPath = (root, repo, number, id) => path.join(root, 'review', 'records', 'validation', `${repo.name}-pr${number}-${id}.json`);

export function createRuntime(env = process.env) {
  const merge = createMergeRuntime(env);
  return {
    ...merge,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd(),
  };
}

function repository(config, name) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === name);
  requireValue(repo, 'Unknown repository');
  requireValue(Array.isArray(repo.prepare ?? []) && (repo.prepare ?? []).every(command => typeof command === 'string' && command.trim()), 'Invalid prepare commands');
  return repo;
}
function reviewInput(input) {
  requireValue(Number.isSafeInteger(input?.number) && input.number > 0 && shaOK(input.headSha) && shaOK(input.baseSha), 'Review input needs a PR number and exact head/base SHAs');
}
function samePR(repo, input, pr) {
  requireValue(pr.number === input.number && pr.state === 'OPEN' && pr.isCrossRepository === false && pr.baseRefName === repo.baseBranch, 'PR identity, state or base changed');
  requireValue(pr.headRefName !== repo.baseBranch && pr.headRefName.startsWith(`${repo.branchPrefix ?? 'fix/auto'}-`), 'Not a same-repository autofix head branch');
  requireValue(pr.headRefOid === input.headSha, 'PR head changed; review the new commit');
  return pr;
}
function dependencyHash(worktree, repo) {
  const name = repo.lockfile ?? 'package-lock.json';
  requireValue(typeof name === 'string' && name.trim() && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..'), 'Lockfile must stay inside the worktree');
  const file = path.resolve(worktree, name);
  if (!fs.existsSync(file)) return 'no-lockfile';
  const actual = fs.realpathSync(file), relative = path.relative(fs.realpathSync(worktree), actual);
  requireValue(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), 'Lockfile escapes the worktree');
  return hash(fs.readFileSync(file));
}

// Tests and commands run only at the unchanged PR head. The caller still performs
// the code review, checks discussion/CI, and decides whether validation is sufficient.
export async function verifyReview(config, name, token, input, runtime = createRuntime()) {
  const repo = repository(config, name);
  reviewInput(input);
  const id = randomUUID(), root = rootPath(config), refs = refRoot(repo, input.number, id);
  const logs = path.join(root, 'review', 'scratch', `review-${id}`);
  fs.mkdirSync(logs, { recursive: true });
  const result = { id, repo: name, remote: repo.remote, number: input.number, headSha: input.headSha, baseSha: input.baseSha, configHash: contractHash(repo), headRef: `${refs}/head`, baseRef: `${refs}/base`, startedAt: new Date().toISOString(), status: 'running', commands: [], restoration: { status: 'not-needed' } };
  const target = recordPath(root, repo, input.number, id);
  writeAtomic(target, result, { exclusive: true });
  let worktree, original, checkoutAttempted = false, interrupted;
  const onInterrupt = () => { interrupted = 'SIGINT'; };
  const onTerminate = () => { interrupted = 'SIGTERM'; };
  const uninterrupted = () => requireValue(!interrupted, `Review interrupted by ${interrupted}`);
  process.once('SIGINT', onInterrupt);
  process.once('SIGTERM', onTerminate);
  try {
    result.stage = 'worktree';
    worktree = checkWorktree(config, name, token, runtime.git);
    requireValue(worktree.exists, 'Review reuses an existing managed worktree; none exists');
    const branch = runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    original = { headSha: worktree.headSha, branch: branch === 'HEAD' ? null : branch, status: runtime.git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']) };
    result.original = original;
    result.stage = 'identity';
    const pr = samePR(repo, input, await runtime.readPR(repo, input.number));
    result.headBranch = pr.headRefName;
    requireValue(await runtime.readBase(repo) === input.baseSha, 'Remote base changed; refresh the review baseline');
    uninterrupted();
    result.stage = 'fetch';
    for (const branchName of [pr.headRefName, repo.baseBranch]) runtime.git(repo.path, ['check-ref-format', `refs/heads/${branchName}`]);
    // Unique private destinations retain both exact objects without moving a user's
    // local branch or an old detached head's remote-tracking retaining ref.
    runtime.git(repo.path, ['fetch', '--no-tags', 'origin', `refs/heads/${pr.headRefName}:${result.headRef}`, `refs/heads/${repo.baseBranch}:${result.baseRef}`]);
    requireValue(runtime.git(repo.path, ['rev-parse', result.headRef]) === input.headSha && runtime.git(repo.path, ['rev-parse', result.baseRef]) === input.baseSha, 'Head or base moved during fetch; refresh and review again');
    const before = checkWorktree(config, name, token, runtime.git);
    requireValue(before.headSha === original.headSha && runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']) === (original.branch ?? 'HEAD'), 'Original worktree moved before checkout');
    uninterrupted();
    result.stage = 'checkout';
    checkoutAttempted = true;
    runtime.git(worktree.path, ['checkout', '--detach', input.headSha]);
    requireValue(checkWorktree(config, name, token, runtime.git).headSha === input.headSha && runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD', 'Checkout did not select the exact detached PR head');
    const run = async (phase, command) => {
      uninterrupted();
      result.stage = phase;
      const log = path.join(logs, `${result.commands.length}.log`);
      const execution = await runtime.run(command, worktree.path, log, (repo.commandTimeoutSeconds ?? 600) * 1000);
      result.commands.push({ phase, command, ...execution, log, logHash: hash(fs.readFileSync(log)) });
      uninterrupted();
      requireValue(!execution.timedOut && execution.exitCode === 0 && !execution.signal, `${phase} command failed or timed out; see ${log}`);
    };
    const fingerprint = dependencyHash(worktree.path, repo);
    const cache = path.join(root, `${name}.lock.sha`);
    const prior = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8').trim().split(/\s+/)[0] : null;
    const install = repo.install ?? (fs.existsSync(path.join(worktree.path, 'package.json')) ? 'npm ci --ignore-scripts --no-audit --no-fund' : null);
    if (install && (!fs.existsSync(path.join(worktree.path, 'node_modules')) || prior !== fingerprint)) {
      await run('install', install);
      fs.writeFileSync(cache, `${fingerprint}\n`);
    }
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
        const current = checkWorktree(config, name, token, runtime.git);
        const attachment = runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
        if (current.headSha === original.headSha && attachment === (original.branch ?? 'HEAD')) {
          result.restoration = { status: 'unchanged' };
        } else {
          requireValue(current.headSha === input.headSha && attachment === 'HEAD', 'Worktree HEAD or attachment changed; preserve it rather than switch');
          if (original.branch) requireValue(runtime.git(repo.path, ['rev-parse', `refs/heads/${original.branch}`]) === original.headSha, 'Original branch moved; preserve the review checkout');
          runtime.git(worktree.path, ['checkout', ...(original.branch ? [original.branch] : ['--detach', original.headSha])]);
          const restored = checkWorktree(config, name, token, runtime.git);
          requireValue(restored.headSha === original.headSha && runtime.git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']) === (original.branch ?? 'HEAD') && runtime.git(worktree.path, ['status', '--porcelain=v1', '--untracked-files=all']) === original.status, 'Original worktree was not fully restored');
          result.restoration = { status: 'restored' };
        }
      } catch (error) {
        result.status = 'failed';
        result.restoration = { status: 'failed', error: error.message };
        result.error ??= error.message;
      }
    }
    if (interrupted) { result.status = 'failed'; result.error ??= `Review interrupted by ${interrupted}`; }
    process.removeListener('SIGINT', onInterrupt);
    process.removeListener('SIGTERM', onTerminate);
    result.finishedAt = new Date().toISOString();
    writeAtomic(target, result);
  }
  return result;
}

export async function checkVerifiedReview(config, name, token, input, id, runtime = createRuntime()) {
  const repo = repository(config, name);
  reviewInput(input);
  requireValue(uuidOK(id), 'Use the review validation ID returned by verify');
  checkWorktree(config, name, token, runtime.git);
  const root = rootPath(config), result = read(recordPath(root, repo, input.number, id)), refs = refRoot(repo, input.number, id);
  requireValue(result.id === id && result.repo === name && result.remote === repo.remote && result.number === input.number && result.headSha === input.headSha && result.baseSha === input.baseSha && result.configHash === contractHash(repo), 'Review identity, head/base or configuration changed');
  requireValue(result.status === 'passed' && ['restored', 'unchanged'].includes(result.restoration?.status) && Array.isArray(result.commands), 'Review validation or restoration did not pass');
  requireValue(result.headRef === `${refs}/head` && result.baseRef === `${refs}/base` && runtime.git(repo.path, ['rev-parse', result.headRef]) === input.headSha && runtime.git(repo.path, ['rev-parse', result.baseRef]) === input.baseSha, 'Review retaining refs changed');
  const expected = [...(repo.prepare ?? []).map(command => ['prepare', command]), ...repo.verify.map(command => ['verify', command])];
  const actual = result.commands.filter(command => command.phase !== 'install').map(({ phase, command }) => [phase, command]);
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), 'Review verification commands were skipped or changed');
  const installs = result.commands.filter(command => command.phase === 'install');
  requireValue(installs.length <= 1 && (!installs.length || (result.commands[0] === installs[0] && installs[0].command === (repo.install ?? 'npm ci --ignore-scripts --no-audit --no-fund'))), 'Invalid install evidence');
  for (const [index, command] of result.commands.entries()) {
    requireValue(command.log === path.join(root, 'review', 'scratch', `review-${id}`, `${index}.log`) && command.exitCode === 0 && !command.signal && command.timedOut === false && command.timeoutMs === (repo.commandTimeoutSeconds ?? 600) * 1000 && hash(fs.readFileSync(command.log)) === command.logHash, 'Review command failed or its log/deadline changed');
  }
  samePR(repo, input, await runtime.readPR(repo, input.number));
  requireValue(await runtime.readBase(repo) === input.baseSha, 'Remote base changed since review validation');
  return { number: input.number, reviewedHead: input.headSha, baseSha: input.baseSha, validationId: id };
}

async function main([command, configFile, name, token, inputFile, id]) {
  const config = read(configFile), input = read(inputFile);
  if (command === 'verify') { const result = await verifyReview(config, name, token, input); if (result.status !== 'passed') process.exitCode = 1; return result; }
  if (command === 'check') return checkVerifiedReview(config, name, token, input, id);
  throw new Error('Usage: review.mjs verify|check <config> <repo> <token> <input-file> [validation-id]');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
