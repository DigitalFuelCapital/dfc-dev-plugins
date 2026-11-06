import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const DEFAULT_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund';
const operations = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer'];
const contract = repo => ({ install: repo.install ?? null, lockfile: repo.lockfile ?? 'package-lock.json', prepare: repo.prepare ?? [], verify: repo.verify, commandTimeoutSeconds: repo.commandTimeoutSeconds ?? 600 });
const contractHash = repo => digest(JSON.stringify(contract(repo)));

export const defaultGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 10000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function validateRepo(repo) {
  requireValue(repo && Array.isArray(repo.verify) && repo.verify.length > 0 && repo.verify.every(nonempty), 'Configure nonempty verification commands');
  requireValue(Array.isArray(repo.prepare ?? []) && (repo.prepare ?? []).every(nonempty), 'Invalid preparation commands');
  requireValue(repo.install === undefined || nonempty(repo.install), 'Invalid installation command');
  const seconds = repo.commandTimeoutSeconds ?? 600;
  requireValue(Number.isSafeInteger(seconds) && seconds >= 1 && seconds <= 3600, 'commandTimeoutSeconds must be an integer from 1 to 3600');
}

function cleanHead(worktree, git) {
  requireValue(git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Verification requires a clean worktree; preserve unfinished changes');
  for (const operation of operations) {
    const file = git(worktree, ['rev-parse', '--git-path', operation]);
    requireValue(!fs.existsSync(path.resolve(worktree, file)), `Worktree has an active ${operation}`);
  }
  const head = git(worktree, ['rev-parse', 'HEAD']);
  requireValue(shaOK(head), 'Cannot determine the exact worktree head');
  return head;
}

// Commands run in a separate POSIX process group. Cleanup completes before a log is
// hashed or a subsequent command starts, including when a shell leaves children behind.
export function runCommand(command, { cwd, log, timeoutMs, env = process.env }) {
  requireValue(nonempty(command), 'Command must be nonempty');
  requireValue(Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3600000, 'Invalid command timeout');
  requireValue(process.platform !== 'win32', 'Verification requires POSIX process-group support');
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(log, 'wx');
    let child;
    try { child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...env, CI: '1' }, detached: true, stdio: ['ignore', fd, fd] }); }
    catch (error) { fs.closeSync(fd); reject(error); return; }
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
      if (!killGroup('SIGTERM')) { cleanupDone = true; finish(); return; }
      if (!timedOut && !interrupted) fs.writeSync(fd, '\n[dev-autotask] Command exited; terminating remaining background processes.\n');
      killTimer = setTimeout(() => {
        killGroup('SIGKILL');
        cleanupDone = true;
        finish();
      }, 2000);
    };
    const interrupt = sig => {
      interrupted = sig;
      fs.writeSync(fd, `\n[dev-autotask] Interrupted by ${sig}; terminating process group.\n`);
      stopGroup();
    };
    const onInterrupt = () => interrupt('SIGINT');
    const onTerminate = () => interrupt('SIGTERM');
    const timer = setTimeout(() => {
      timedOut = true;
      fs.writeSync(fd, `\n[dev-autotask] Command timed out after ${timeoutMs} ms; terminating process group.\n`);
      stopGroup();
    }, timeoutMs);
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onTerminate);
    child.once('error', finish);
    child.once('exit', (code, sig) => { exitCode = code; signal = sig; exited = true; stopGroup(); finish(); });
  });
}

export async function verify(config, paths, task, { git = defaultGit, run = runCommand } = {}) {
  validateRepo(config.repo);
  requireValue(nonempty(task?.id) && nonempty(paths?.worktree) && nonempty(paths?.taskDir), 'Task paths and identity are required');
  const repo = config.repo;
  const id = randomUUID(), headSha = cleanHead(paths.worktree, git);
  const logs = path.join(paths.taskDir, 'logs', id);
  fs.mkdirSync(logs, { recursive: true });
  const target = path.join(paths.taskDir, 'verification.json');
  const result = { id, taskId: task.id, headSha, configHash: contractHash(repo), startedAt: new Date().toISOString(), status: 'running', commands: [] };
  // A crash must invalidate the preceding receipt, even if it tested the same head.
  writeAtomic(target, result);
  try {
    const execute = async (phase, command) => {
      const log = path.join(logs, `${result.commands.length}.log`);
      const execution = await run(command, { cwd: paths.worktree, log, timeoutMs: (repo.commandTimeoutSeconds ?? 600) * 1000 });
      result.commands.push({ phase, command, ...execution, log, logHash: digest(fs.readFileSync(log)) });
      requireValue(!execution.timedOut, `${phase} command timed out; see ${log}`);
      requireValue(execution.exitCode === 0 && !execution.signal, `${phase} command failed; see ${log}`);
    };
    const configuredLockfile = repo.lockfile ?? 'package-lock.json';
    requireValue(nonempty(configuredLockfile) && !path.isAbsolute(configuredLockfile), 'Lockfile must be relative to the worktree');
    const lockfile = path.resolve(paths.worktree, configuredLockfile);
    requireValue(inside(path.resolve(paths.worktree), lockfile), 'Lockfile escapes the worktree');
    if (fs.existsSync(lockfile)) {
      requireValue(inside(fs.realpathSync(paths.worktree), fs.realpathSync(lockfile)), 'Lockfile symlink escapes the worktree');
      requireValue(fs.statSync(lockfile).isFile(), 'Lockfile must be a regular file');
    }
    const fingerprint = fs.existsSync(lockfile) ? digest(fs.readFileSync(lockfile)) : 'no-lockfile';
    const cache = path.join(paths.taskDir, 'dependency.sha');
    const previous = fs.existsSync(cache) ? fs.readFileSync(cache, 'utf8').trim().split(/\s+/)[0] : null;
    const install = repo.install ?? (fs.existsSync(path.join(paths.worktree, 'package.json')) ? DEFAULT_INSTALL : null);
    if (install && (!fs.existsSync(path.join(paths.worktree, 'node_modules')) || previous !== fingerprint)) {
      await execute('install', install);
      fs.writeFileSync(cache, `${fingerprint}\n`);
    }
    for (const command of repo.prepare ?? []) await execute('prepare', command);
    for (const command of repo.verify) await execute('verify', command);
    requireValue(cleanHead(paths.worktree, git) === headSha, 'Verification changed HEAD; review and verify the new commit');
    result.status = 'passed';
  } catch (error) {
    result.status = 'failed';
    result.error = error.message;
  }
  result.finishedAt = new Date().toISOString();
  writeAtomic(target, result);
  return result;
}

// Receipts guard against accidentally skipped or stale checks. An actor with the
// same filesystem access can edit them; they are not a security boundary.
export function readVerified(paths, headSha, repo) {
  validateRepo(repo);
  const record = JSON.parse(fs.readFileSync(path.join(paths.taskDir, 'verification.json'), 'utf8'));
  requireValue(record.status === 'passed' && shaOK(headSha) && record.headSha === headSha, 'Verification did not pass for the current head');
  requireValue(record.configHash === contractHash(repo) && Array.isArray(record.commands), 'Verification commands or configuration changed');
  const expected = [...(repo.prepare ?? []).map(command => ['prepare', command]), ...repo.verify.map(command => ['verify', command])];
  const actual = record.commands.filter(item => item.phase !== 'install').map(({ phase, command }) => [phase, command]);
  requireValue(JSON.stringify(actual) === JSON.stringify(expected), 'Verification commands were skipped or reordered');
  const installs = record.commands.filter(item => item.phase === 'install');
  requireValue(installs.length <= 1 && (!installs.length || (record.commands[0] === installs[0] && installs[0].command === (repo.install ?? DEFAULT_INSTALL))), 'Invalid installation evidence');
  const logRoot = path.join(paths.taskDir, 'logs', record.id);
  for (const [index, item] of record.commands.entries()) {
    requireValue(item.log === path.join(logRoot, `${index}.log`), 'Verification log belongs to another attempt');
    requireValue(item.exitCode === 0 && !item.signal && item.timedOut === false && item.timeoutMs === (repo.commandTimeoutSeconds ?? 600) * 1000, 'Verification command failed or its deadline changed');
    requireValue(digest(fs.readFileSync(item.log)) === item.logHash, 'Verification log changed');
  }
  return record;
}
