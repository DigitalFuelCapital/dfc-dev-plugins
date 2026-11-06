import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkApproval, checkWorktree, validateConfig, writeAtomic } from './state.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const uuidOK = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const rootPath = config => fs.realpathSync((config.worktreeRoot ?? '~/.claude/autofix/worktrees').replace(/^~\//, `${os.homedir()}/`));
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 600;
const contract = repo => ({ remote: repo.remote, baseBranch: repo.baseBranch, install: repo.install ?? null, lockfile: repo.lockfile ?? 'package-lock.json', prepare: repo.prepare ?? [], verify: repo.verify, commandTimeoutSeconds: repo.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS });
const contractHash = repo => hash(JSON.stringify(contract(repo)));
const refName = (repo, id) => `refs/autofix/verify/${repo.name}/${id}`;
const recordPath = (root, repo, id) => path.join(root, 'review', 'records', 'verification', `${repo.name}-${id}.json`);

export function createRuntime(env = process.env) {
  const execute = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, timeout: 120000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trimEnd();
  const git = (cwd, args) => execute('git', ['-C', cwd, ...args]);
  return {
    git,
    readPR: (repo, number, timeout = 10000) => JSON.parse(execute('gh', ['pr', 'view', String(number), '-R', repo.remote, '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,mergeable'], { timeout })),
    readBase: repo => {
      const ref = `refs/heads/${repo.baseBranch}`;
      git(repo.path, ['check-ref-format', ref]);
      const rows = execute('git', ['-C', repo.path, 'ls-remote', '--exit-code', '--refs', 'origin', ref], { timeout: 10000 }).split('\n').map(line => line.split('\t')).filter(([, name]) => name === ref);
      requireValue(rows.length === 1 && shaOK(rows[0][0]), 'Cannot determine the remote base branch tip');
      return rows[0][0];
    },
    fetch: (repo, pr) => {
      for (const branch of [repo.baseBranch, pr.headRefName]) git(repo.path, ['check-ref-format', `refs/heads/${branch}`]);
      git(repo.path, ['fetch', '--no-tags', 'origin', ...[repo.baseBranch, pr.headRefName].map(branch => `+refs/heads/${branch}:refs/remotes/origin/${branch}`)]);
    },
    run: (command, cwd, log, timeoutMs = DEFAULT_COMMAND_TIMEOUT_SECONDS * 1000) => new Promise((resolve, reject) => {
      requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000, 'Invalid command timeout');
      const fd = fs.openSync(log, 'wx');
      // A separate POSIX group lets cleanup stop the shell AND its test-runner children.
      const child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...env, CI: '1' }, detached: true, stdio: ['ignore', fd, fd] });
      let timedOut = false, exited = false, cleanupStarted = false, cleanupDone = false, settled = false;
      let exitCode = null, signal = null, killTimer, cleanupError, interrupted;
      const killGroup = sig => {
        if (!Number.isSafeInteger(child.pid)) return false;
        try { process.kill(-child.pid, sig); return true; }
        catch (error) { if (error.code !== 'ESRCH') cleanupError = error; }
        return false;
      };
      const finish = error => {
        if (settled || (!error && (!exited || !cleanupDone))) return;
        settled = true;
        clearTimeout(timer); clearTimeout(killTimer);
        process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onTerminate);
        fs.closeSync(fd);
        if (error || cleanupError) reject(error ?? cleanupError);
        else resolve({ exitCode, signal: interrupted ?? signal, timedOut, timeoutMs });
      };
      const stopGroup = () => {
        if (cleanupStarted) return;
        cleanupStarted = true;
        clearTimeout(timer);
        if (!killGroup('SIGTERM')) {
          cleanupDone = true;
          finish();
          return;
        }
        if (!timedOut && !interrupted) fs.writeSync(fd, '\n[dev-autofix] Command exited; terminating remaining background processes.\n');
        // Do not resolve when only the shell exits: descendants may ignore SIGTERM.
        killTimer = setTimeout(() => {
          killGroup('SIGKILL');
          cleanupDone = true;
          finish();
        }, 2000);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        fs.writeSync(fd, `\n[dev-autofix] Command timed out after ${timeoutMs} ms; terminating process group.\n`);
        stopGroup();
      }, timeoutMs);
      const interrupt = sig => {
        interrupted = sig;
        fs.writeSync(fd, `\n[dev-autofix] Interrupted by ${sig}; terminating process group.\n`);
        stopGroup();
      };
      const onInterrupt = () => interrupt('SIGINT');
      const onTerminate = () => interrupt('SIGTERM');
      process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
      child.once('error', finish);
      child.once('exit', (code, sig) => { exitCode = code; signal = sig; exited = true; stopGroup(); finish(); });
    }),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

export async function waitForMergeability(readPR, sleep, attempts = 16, intervalMs = 2000) {
  const deadline = Date.now() + 30000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const pr = await readPR(Math.min(10000, remaining));
    if (pr.state !== 'OPEN' || pr.mergeable !== 'UNKNOWN') return pr;
    if (attempt + 1 < attempts) await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error('GitHub mergeability remained UNKNOWN after bounded polling; approval remains pending');
}

function repository(config, name) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === name);
  requireValue(repo, 'Unknown repository');
  requireValue((repo.prepare ?? []).every(command => typeof command === 'string' && command.trim()), 'Invalid prepare commands');
  return repo;
}

function approvePR(config, repo, approval, pr) {
  requireValue(Number.isSafeInteger(approval.number) && approval.number > 0, 'Invalid PR number');
  requireValue(pr.number === approval.number && pr.state === 'OPEN' && pr.isCrossRepository === false && pr.baseRefName === repo.baseBranch, 'PR identity, state or base changed');
  requireValue(pr.headRefName !== repo.baseBranch && pr.headRefName.startsWith(`${repo.branchPrefix ?? 'fix/auto'}-`), 'Not an autofix head branch');
  requireValue(!approval.headRef || pr.headRefName === approval.headRef, 'PR head branch changed');
  requireValue(shaOK(pr.headRefOid), 'Invalid GitHub commit identity');
  requireValue(approval.remote === repo.remote && approval.headSha === pr.headRefOid, 'Approval metadata must describe the current PR head');
  return checkApproval({ ...approval, reviewers: config.reviewers ?? approval.reviewers, approveTokens: config.approveTokens ?? approval.approveTokens });
}

// KEY-DECISION 2026-09-26: the helper runs verification and records actual exits; callers cannot supply a passed flag.
export async function verifyMerge(config, name, token, approval, runtime = createRuntime()) {
  const repo = repository(config, name);
  const wt = checkWorktree(config, name, token, runtime.git);
  requireValue(wt.exists, 'Prepare the managed worktree before verification');
  requireValue(Number.isSafeInteger(approval.number) && approval.number > 0, 'Invalid PR number');
  const pr = await runtime.readPR(repo, approval.number);
  const headSha = approvePR(config, repo, approval, pr);
  await runtime.fetch(repo, pr);
  const baseSha = runtime.git(repo.path, ['rev-parse', `refs/remotes/origin/${repo.baseBranch}`]);
  requireValue(baseSha === await runtime.readBase(repo) && runtime.git(repo.path, ['rev-parse', `refs/remotes/origin/${pr.headRefName}`]) === headSha, 'Head or base moved during fetch; refresh and retry');
  const id = randomUUID(), root = rootPath(config);
  const logs = path.join(root, 'review', 'scratch', `verify-${id}`);
  fs.mkdirSync(logs, { recursive: true });
  const result = { id, repo: name, remote: repo.remote, number: pr.number, headSha, baseSha, configHash: contractHash(repo), ref: refName(repo, id), startedAt: new Date().toISOString(), commands: [], status: 'running' };
  const target = recordPath(root, repo, id);
  // A crash leaves a running receipt, which the check command will never accept.
  writeAtomic(target, result, { exclusive: true });
  try {
    let merged;
    try { merged = runtime.git(repo.path, ['merge-tree', '--write-tree', headSha, baseSha]); }
    catch (error) {
      fs.writeFileSync(path.join(logs, 'merge.log'), `${error.stdout ?? ''}\n${error.stderr ?? error.message}`);
      result.status = error.status === 1 ? 'conflict' : 'failed';
      throw new Error(result.status === 'conflict' ? 'Integration conflicts require a reviewed resolution' : 'Cannot compute integration tree');
    }
    result.treeSha = merged.split('\n')[0];
    requireValue(shaOK(result.treeSha), 'Invalid integration tree');
    // This unsigned synthetic object stays under refs/autofix. Published commits remain signed.
    result.commitSha = runtime.git(repo.path, ['-c', 'commit.gpgsign=false', 'commit-tree', result.treeSha, '-p', headSha, ...(baseSha === headSha ? [] : ['-p', baseSha]), '-m', `Autofix local verification ${id}`]);
    runtime.git(repo.path, ['update-ref', result.ref, result.commitSha, '0'.repeat(40)]);
    checkWorktree(config, name, token, runtime.git);
    runtime.git(wt.path, ['checkout', '--detach', result.commitSha]);
    const run = async (phase, command) => {
      const log = path.join(logs, `${result.commands.length}.log`);
      const execution = await runtime.run(command, wt.path, log, (repo.commandTimeoutSeconds ?? DEFAULT_COMMAND_TIMEOUT_SECONDS) * 1000);
      result.commands.push({ phase, command, ...execution, log, logHash: hash(fs.readFileSync(log)) });
      requireValue(!execution.timedOut, `${phase} command timed out after ${execution.timeoutMs} ms: ${command}; see ${log}`);
      requireValue(execution.exitCode === 0 && !execution.signal, `${phase} command failed: ${command}; see ${log}`);
    };
    const lockfile = path.resolve(wt.path, repo.lockfile ?? 'package-lock.json');
    const fingerprint = fs.existsSync(lockfile) ? hash(fs.readFileSync(lockfile)) : 'no-lockfile';
    const installHash = path.join(root, `${name}.lock.sha`);
    const prior = fs.existsSync(installHash) ? fs.readFileSync(installHash, 'utf8').trim().split(/\s+/)[0] : null;
    const install = repo.install ?? (fs.existsSync(path.join(wt.path, 'package.json')) ? 'npm ci --ignore-scripts --no-audit --no-fund' : null);
    if (install && (!fs.existsSync(path.join(wt.path, 'node_modules')) || prior !== fingerprint)) {
      await run('install', install);
      fs.writeFileSync(installHash, `${fingerprint}\n`);
    }
    for (const command of repo.prepare ?? []) await run('prepare', command);
    for (const command of repo.verify) await run('verify', command);
    const after = checkWorktree(config, name, token, runtime.git);
    requireValue(after.headSha === result.commitSha, 'Verification changed HEAD');
    const fresh = await runtime.readPR(repo, pr.number);
    approvePR(config, repo, approval, fresh);
    requireValue(await runtime.readBase(repo) === baseSha, 'Base moved during verification; run verify again');
    runtime.git(wt.path, ['checkout', '--detach', headSha]);
    result.status = 'passed';
  } catch (error) {
    if (result.status === 'running') result.status = 'failed';
    result.error = error.message;
  }
  result.finishedAt = new Date().toISOString();
  writeAtomic(target, result);
  return result;
}

function loadVerification(config, repo, id) {
  requireValue(uuidOK(id), 'Use the verification ID returned by verify, not a self-authored result');
  const record = read(recordPath(rootPath(config), repo, id));
  requireValue(record.id === id && record.repo === repo.name && record.remote === repo.remote && record.ref === refName(repo, id) && record.configHash === contractHash(repo), 'Verification identity or commands changed');
  requireValue(record.status === 'passed' && Array.isArray(record.commands), 'Verification did not pass');
  const expected = [...(repo.prepare ?? []).map(command => ['prepare', command]), ...repo.verify.map(command => ['verify', command])];
  const actual = record.commands.filter(command => command.phase !== 'install').map(({ phase, command }) => [phase, command]);
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), 'Verification commands are missing or changed');
  for (const command of record.commands) {
    requireValue(command.exitCode === 0 && !command.signal && command.timedOut === false && hash(fs.readFileSync(command.log)) === command.logHash, 'Verification command failed or its log changed');
  }
  return record;
}

export async function checkVerifiedMerge(config, name, token, approval, id, runtime = createRuntime()) {
  const repo = repository(config, name);
  checkWorktree(config, name, token, runtime.git);
  const record = loadVerification(config, repo, id);
  const pr = await waitForMergeability(timeout => runtime.readPR(repo, approval.number, timeout), runtime.sleep);
  const approvedHead = approvePR(config, repo, approval, pr);
  requireValue(record.number === pr.number && record.headSha === approvedHead && record.baseSha === await runtime.readBase(repo), 'Head or base changed since verification; run verify again');
  requireValue(pr.mergeable === 'MERGEABLE', 'GitHub reports integration conflicts; approval remains pending');
  requireValue(runtime.git(repo.path, ['rev-parse', record.ref]) === record.commitSha, 'Verification ref changed');
  requireValue(runtime.git(repo.path, ['rev-parse', `${record.commitSha}^{tree}`]) === record.treeSha, 'Verification tree changed');
  requireValue(runtime.git(repo.path, ['merge-tree', '--write-tree', record.headSha, record.baseSha]).split('\n')[0] === record.treeSha, 'Verification does not match the integration tree');
  const parents = runtime.git(repo.path, ['show', '-s', '--format=%P', record.commitSha]).split(' ');
  requireValue(JSON.stringify(parents) === JSON.stringify([...new Set([record.headSha, record.baseSha])]), 'Verification parents changed');
  return { approvedHead, baseSha: record.baseSha, verificationId: id };
}

export function releaseVerification(config, name, token, id, runtime = createRuntime()) {
  const repo = repository(config, name);
  checkWorktree(config, name, token, runtime.git);
  const record = loadVerification(config, repo, id);
  requireValue(!runtime.git(repo.path, ['worktree', 'list', '--porcelain', '-z']).split('\0').includes(`HEAD ${record.commitSha}`), 'A worktree still uses the verification commit');
  runtime.git(repo.path, ['update-ref', '-d', record.ref, record.commitSha]);
  return { released: record.ref };
}

async function main([command, configFile, name, token, input, id]) {
  const config = read(configFile);
  if (command === 'verify') {
    const result = await verifyMerge(config, name, token, read(input));
    if (result.status !== 'passed') process.exitCode = 1;
    return result;
  }
  if (command === 'check') return checkVerifiedMerge(config, name, token, read(input), id);
  if (command === 'release') return releaseVerification(config, name, token, input);
  throw new Error('Usage: merge.mjs verify|check <config> <repo> <token> <approval-file> [verification-id], or release <config> <repo> <token> <verification-id>');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
