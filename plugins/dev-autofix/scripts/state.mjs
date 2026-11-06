import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const nameOK = (value) => typeof value === 'string' && /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(value);
const shaOK = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const expand = (value) => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const inside = (parent, child) => {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
// Resolve existing ancestors too, so a not-yet-created root cannot hide behind a symlink.
const canonical = (value) => {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const parent = path.dirname(absolute);
    if (parent === absolute) throw error;
    return path.join(canonical(parent), path.basename(absolute));
  }
};

export function writeAtomic(file, value, { exclusive = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    if (exclusive) fs.linkSync(temp, file);
    else fs.renameSync(temp, file);
  } finally {
    if (fs.existsSync(temp)) fs.unlinkSync(temp);
  }
}

const ps = (pid, fields) => {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', fields], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    if (error.status === 1 && !error.stdout?.trim()) throw new Error(`Lock owner process ${pid} is not running`);
    throw new Error(`Cannot inspect lock owner process ${pid}: ${error.code ?? error.message}`);
  }
};
export const processStart = pid => {
  const started = ps(pid, 'lstart=');
  requireValue(started, `Lock owner process ${pid} is not running`);
  return started;
};
const processInfo = pid => {
  const match = /^(\d+)\s+(.+)$/.exec(ps(pid, 'ppid=,comm='));
  requireValue(match, 'Cannot read process ancestry');
  let executable = match[2];
  if (process.platform === 'linux') {
    try { executable = fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, ''); }
    catch { /* ps still identifies named runtimes when procfs is restricted */ }
  }
  return { ppid: Number(match[1]), executable, args: path.basename(executable) === 'node' ? ps(pid, 'args=') : '', processStart: processStart(pid) };
};

export function detectLockOwner(pid = process.ppid, inspect = processInfo) {
  const seen = new Set();
  while (pid > 1 && !seen.has(pid) && seen.size < 64) {
    seen.add(pid);
    const info = inspect(pid);
    const native = /^(?:claude|codex)(?:\.exe)?$/i.test(path.basename(info.executable)) || /\/claude\/versions\/\d+\.\d+\.\d+(?:[-.][\w.-]+)?$/.test(info.executable);
    const nodeCLI = /^(?:\S*\/)?node\s+\S*\/@anthropic-ai\/claude-code\/cli\.js(?:\s|$)/.test(info.args ?? '');
    if (native || nodeCLI) return { pid, processStart: info.processStart, executable: info.executable };
    pid = info.ppid;
  }
  throw new Error('No persistent Claude or Codex process found in ancestry; refusing a shell-owned lock');
}
const processAlive = pid => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

// Caller supplies the session, never a PID. Runtime ancestry determines process ownership.
export function acquireLock(directory, identity, detect = detectLockOwner) {
  requireValue(identity && nonempty(identity.session) && nonempty(identity.command) && !('pid' in identity), 'Lock needs session and command; PID is detected automatically');
  const owner = detect();
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  fs.mkdirSync(directory);
  const token = randomUUID();
  writeAtomic(path.join(directory, 'owner.json'), { token, createdAt: new Date().toISOString(), ...owner, session: identity.session, host: os.hostname(), command: identity.command });
  return token;
}

export function lockInitializationTime(stat) {
  // birthtime is zero on some Linux filesystems; metadata changes restart the grace period.
  return Math.max(stat.birthtimeMs || 0, stat.mtimeMs || 0, stat.ctimeMs || 0);
}

export function inspectLock(directory) {
  const stat = fs.lstatSync(directory);
  requireValue(stat.isDirectory() && !stat.isSymbolicLink(), 'Invalid lock directory');
  let raw = '';
  try { raw = fs.readFileSync(path.join(directory, 'owner.json'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let owner = null;
  try { owner = JSON.parse(raw); } catch { /* interrupted publication */ }
  const fingerprint = createHash('sha256').update(`${stat.dev}:${stat.ino}:${stat.birthtimeMs}:${stat.mtimeMs}:${stat.ctimeMs}:${raw}`).digest('hex');
  return { fingerprint, owner, createdAt: new Date(lockInitializationTime(stat)).toISOString() };
}

export function resumeLock(directory, identity, detect = detectLockOwner) {
  requireValue(identity && !('pid' in identity), 'PID is detected automatically');
  const detected = detect();
  const { owner } = inspectLock(directory);
  requireValue(owner && owner.session === identity.session && owner.pid === detected.pid && owner.host === os.hostname() && owner.processStart === detected.processStart, 'Cannot resume another session lock');
  return owner.token;
}

export function breakLock(directory, confirmation) {
  const snapshot = inspectLock(directory);
  requireValue(confirmation.confirmedStopped === true && nonempty(confirmation.reason), 'Confirm the previous session and all workers stopped, with a reason');
  requireValue(snapshot.fingerprint === confirmation.fingerprint, 'Lock changed since inspection');
  const owner = snapshot.owner;
  if (owner?.host === os.hostname() && Number.isSafeInteger(owner.pid) && owner.pid > 0 && processAlive(owner.pid)) {
    requireValue(nonempty(owner.processStart) && processStart(owner.pid) !== owner.processStart, 'Lock owner is still running');
  }
  // An ownerless mkdir may still be initializing. Never auto-break based on age alone.
  requireValue(owner || Date.now() - Date.parse(snapshot.createdAt) >= 60_000, 'Ownerless lock is still initializing; inspect again later');
  requireValue(inspectLock(directory).fingerprint === snapshot.fingerprint, 'Lock changed since inspection');
  const archive = `${directory}.abandoned-${randomUUID()}`;
  fs.renameSync(directory, archive);
  writeAtomic(path.join(archive, 'recovery.json'), { ...confirmation, recoveredAt: new Date().toISOString() });
  return { archive };
}

export function requireLock(directory, token) {
  requireValue(nonempty(token) && read(path.join(directory, 'owner.json')).token === token, 'Lock owner mismatch');
}

export function releaseLock(directory, token) {
  requireLock(directory, token);
  fs.unlinkSync(path.join(directory, 'owner.json'));
  fs.rmdirSync(directory);
}

export function validateConfig(config) {
  requireValue(config?.version === 1 && Array.isArray(config.repos) && config.repos.length > 0, 'Invalid autofix config');
  const names = new Set();
  for (const repo of config.repos) {
    requireValue(nameOK(repo.name) && !names.has(repo.name), 'Repository names must be unique safe directory names');
    names.add(repo.name);
    requireValue(nonempty(repo.path) && path.isAbsolute(repo.path), `${repo.name}: path must be absolute`);
    requireValue(nonempty(repo.remote) && /^[^/\s]+\/[^/\s]+$/.test(repo.remote), `${repo.name}: remote must be owner/repo`);
    requireValue(nonempty(repo.baseBranch), `${repo.name}: baseBranch is required`);
    requireValue(Array.isArray(repo.verify) && repo.verify.length > 0 && repo.verify.every(nonempty), `${repo.name}: configure nonempty verify commands before proceeding`);
    requireValue(repo.commandTimeoutSeconds === undefined || (Number.isSafeInteger(repo.commandTimeoutSeconds) && repo.commandTimeoutSeconds >= 1 && repo.commandTimeoutSeconds <= 3600), `${repo.name}: commandTimeoutSeconds must be an integer from 1 to 3600`);
  }
  const worktreeRoot = config.worktreeRoot ?? '~/.claude/autofix/worktrees';
  requireValue(nonempty(worktreeRoot), 'worktreeRoot must be a path');
  const root = canonical(expand(worktreeRoot));
  for (const repo of config.repos) {
    requireValue(!inside(canonical(repo.path), root), 'worktreeRoot must be outside every main checkout');
    for (const managed of config.repos) {
      requireValue(!inside(canonical(repo.path), canonical(path.join(root, managed.name))), 'Managed worktree must be outside every main checkout');
    }
  }
  return config;
}

const runIdOK = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const runTimestamp = value => {
  requireValue(nonempty(value) && Number.isFinite(Date.parse(value)), 'Invalid run timestamp');
  return new Date(value).toISOString();
};
function validatePREntry(entry) {
  requireValue(entry && typeof entry === 'object', 'Invalid PR identity');
  requireValue(nameOK(entry.repo) && Number.isSafeInteger(entry.number) && entry.number > 0 && nonempty(entry.branch), 'Invalid PR identity');
  requireValue(typeof entry.url === 'string' && /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/.test(entry.url), 'Invalid PR URL');
  requireValue(Number(entry.url.split('/').at(-1)) === entry.number, 'PR URL/number mismatch');
}
function validateRun(manifest) {
  requireValue(manifest && nonempty(manifest.startedAt) && Number.isFinite(Date.parse(manifest.startedAt)) && Array.isArray(manifest.prs), 'Invalid existing manifest; preserve it for recovery');
  for (const entry of manifest.prs) validatePREntry(entry);
  if (manifest.runId !== undefined) {
    requireValue(manifest.version === 1 && runIdOK(manifest.runId) && Number.isSafeInteger(manifest.revision) && manifest.revision >= 0, 'Invalid run history identity or revision');
    requireValue(['running', 'complete', 'stopped', 'failed'].includes(manifest.status) && Array.isArray(manifest.outcomes), 'Invalid run history status or outcomes');
    if (manifest.status !== 'running') requireValue(nonempty(manifest.finishedAt) && Number.isFinite(Date.parse(manifest.finishedAt)), 'Finalized run needs a completion time');
  }
  return manifest;
}
function runFile(root, runId) {
  requireValue(runIdOK(runId), 'Invalid run ID');
  const directory = path.join(canonical(root), 'runs');
  requireValue(canonical(directory) === directory, 'Run history directory must not be a symlink');
  const file = path.join(directory, `${runId}.json`);
  try {
    const stat = fs.lstatSync(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Run history must be a regular file, not a symlink');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return file;
}
function currentRun(root) {
  const file = path.join(root, 'last-run.json');
  try {
    const stat = fs.lstatSync(file);
    requireValue(stat.isFile() && !stat.isSymbolicLink(), 'Run snapshot must be a regular file, not a symlink');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const snapshot = validateRun(read(file));
  if (snapshot.runId === undefined) return snapshot;
  const history = validateRun(read(runFile(root, snapshot.runId)));
  requireValue(history.runId === snapshot.runId && runTimestamp(history.startedAt) === runTimestamp(snapshot.startedAt), 'Run snapshot/history identity mismatch; preserve both files');
  requireValue(history.revision >= snapshot.revision, 'Run snapshot is newer than its history; preserve both files');
  // History is committed first. A failed snapshot write can leave an older revision;
  // the next owned write repairs it from this authoritative history, never the reverse.
  requireValue(history.revision !== snapshot.revision || isDeepStrictEqual(history, snapshot), 'Run snapshot/history differ at the same revision; preserve both files');
  return history;
}
function persistRun(root, manifest, { exclusive = false } = {}) {
  validateRun(manifest);
  writeAtomic(runFile(root, manifest.runId), manifest, { exclusive });
  writeAtomic(path.join(root, 'last-run.json'), manifest);
  return manifest;
}
function promoteLegacyRun(root, manifest) {
  return persistRun(root, { ...manifest, version: 1, runId: randomUUID(), startedAt: runTimestamp(manifest.startedAt), status: 'running', revision: 0, outcomes: [], legacy: true }, { exclusive: true });
}

export function readRun(root, runId) {
  if (runId === undefined) {
    const current = currentRun(root);
    requireValue(current, 'No run manifest exists');
    return current;
  }
  const history = validateRun(read(runFile(root, runId)));
  requireValue(history.runId === runId, 'Requested run/history identity mismatch');
  return history;
}

// Start before budget/preflight gates so even a run opening no PRs owns an empty batch.
// The run lock serializes history and snapshot updates; workers never write either.
export function beginRun(root, startedAt, runToken) {
  requireLock(path.join(root, '.locks', 'run'), runToken);
  const timestamp = runTimestamp(startedAt);
  let previous = currentRun(root);
  if (previous) {
    const prior = runTimestamp(previous.startedAt);
    requireValue(Date.parse(timestamp) >= Date.parse(prior), 'Run timestamp precedes the current run; late registrations cannot replace its batch');
    if (previous.runId === undefined) previous = promoteLegacyRun(root, previous);
    if (timestamp === prior) {
      requireValue(previous.status === 'running', 'Run is already finalized; start a new run instead of reopening it');
      // Idempotent after compaction, including repair after an interrupted snapshot write.
      writeAtomic(path.join(root, 'last-run.json'), previous);
      return previous;
    }
  }
  return persistRun(root, { version: 1, runId: randomUUID(), startedAt: timestamp, status: 'running', revision: 0, prs: [], outcomes: [] }, { exclusive: true });
}

export function finishRun(root, runId, runToken, input) {
  requireLock(path.join(root, '.locks', 'run'), runToken);
  requireValue(runIdOK(runId) && input && ['complete', 'stopped', 'failed'].includes(input.status), 'Finish run needs its ID and complete, stopped or failed status');
  requireValue(input.summary === undefined || typeof input.summary === 'string', 'Run summary must be text');
  requireValue(input.outcomes === undefined || Array.isArray(input.outcomes), 'Run outcomes must be an array');
  const current = currentRun(root);
  requireValue(current?.runId === runId, 'Cannot finalize another run or replace the current batch');
  if (current.status !== 'running') {
    requireValue(current.status === input.status && (input.summary === undefined || current.summary === input.summary) && (input.outcomes === undefined || isDeepStrictEqual(current.outcomes, input.outcomes)), 'Finalized run cannot be changed');
    writeAtomic(path.join(root, 'last-run.json'), current);
    return current;
  }
  return persistRun(root, { ...current, status: input.status, finishedAt: new Date().toISOString(), revision: current.revision + 1, ...(input.summary === undefined ? {} : { summary: input.summary }), outcomes: input.outcomes ?? current.outcomes });
}

export function recordPR(root, startedAt, entry, runToken) {
  requireLock(path.join(root, '.locks', 'run'), runToken);
  validatePREntry(entry);
  // Legacy callers that register their first PR implicitly still gain a durable run.
  // beginRun refuses older timestamps and never clears the same running batch.
  const manifest = beginRun(root, startedAt, runToken);
  const index = manifest.prs.findIndex(pr => pr.repo === entry.repo && pr.number === entry.number);
  if (index < 0) manifest.prs.push(entry);
  else manifest.prs[index] = entry;
  manifest.revision += 1;
  return persistRun(root, manifest);
}

export function validateApprovalRecord(record) {
  requireValue(record && nonempty(record.remote) && Number.isSafeInteger(record.number) && record.number > 0, 'Invalid approval PR identity');
  requireValue(shaOK(record.headSha) && nonempty(record.author) && nonempty(record.body), 'Invalid approval evidence');
  const prefix = `https://github.com/${record.remote}/pull/${record.number}#issuecomment-`;
  requireValue(typeof record.commentUrl === 'string' && record.commentUrl.startsWith(prefix) && /^\d+$/.test(record.commentUrl.slice(prefix.length)), 'Approval must reference the published conversation comment');
  return Object.fromEntries(['remote', 'number', 'headSha', 'commentUrl', 'author', 'body'].map(key => [key, record[key]]));
}

// Use server push history, never author/committer dates, to bind a manual token.
export function manualApprovalHead({ remote, headRef, headSha, comment, history }) {
  requireValue(history?.complete === true && history.remote?.toLowerCase() === remote.toLowerCase() && history.ref === `refs/heads/${headRef}` && history.observedHead === headSha, 'Missing complete approval push history');
  const time = Date.parse(comment.createdAt);
  requireValue(Number.isFinite(time) && comment.updatedAt === comment.createdAt, 'Edited or undated manual approval needs fresh review');
  requireValue(Array.isArray(history.activities), 'Missing approval activities');
  const events = history.activities.filter(event => event.ref === history.ref).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  requireValue(events.every(event => Number.isFinite(Date.parse(event.timestamp))), 'Invalid activity time');
  requireValue(!events.some(event => Date.parse(event.timestamp) === time), 'Approval and push ordering is ambiguous');
  const anchor = events.findLastIndex(event => Date.parse(event.timestamp) < time);
  requireValue(anchor >= 0, 'Approval history does not reach the comment');
  const relevant = events.slice(anchor);
  const seen = new Set();
  let cursor, approved;
  for (const event of relevant) {
    requireValue(['push', 'force_push', 'branch_creation', 'pr_merge', 'merge_queue_merge'].includes(event.activity_type) && shaOK(event.after) && event.after !== '0'.repeat(40), 'Branch deletion or unknown activity needs fresh review');
    const timestamp = Date.parse(event.timestamp);
    requireValue(!seen.has(timestamp), 'Push ordering is ambiguous');
    seen.add(timestamp);
    if (cursor) requireValue(event.activity_type !== 'branch_creation' && event.before === cursor, 'Incomplete or recreated branch history');
    cursor = event.after;
    approved ??= cursor;
  }
  requireValue(cursor === headSha, 'Push history does not reach the current head');
  return approved;
}

// KEY-DECISION 2026-09-26: a token approves its recorded commit, never the head observed later by finish.
export function checkApproval({ remote, number, headRef, headSha, pending, reviewers, approveTokens = ['LGTM', '/merge'], record, history }) {
  requireValue(shaOK(headSha), 'Invalid current head');
  requireValue(Array.isArray(pending) && pending.length === 1, 'Approval must be the only pending entry');
  const comment = pending[0];
  requireValue(['issue', 'review'].includes(comment.kind), 'Inline comments cannot approve');
  requireValue(Array.isArray(reviewers) && reviewers.some(login => login.toLowerCase() === comment.author?.toLowerCase()), 'Author is not a configured reviewer');
  requireValue(nonempty(comment.body) && approveTokens.some(token => token.toLowerCase() === comment.body.trim().toLowerCase()), 'Not an exact approval token');
  if (comment.kind === 'review') {
    requireValue(['APPROVED', 'COMMENTED'].includes(comment.state?.toUpperCase()) && comment.commitSha === headSha, 'Formal review is dismissed, incompatible, or for a different head');
    requireValue(comment.url?.startsWith(`https://github.com/${remote}/pull/${number}#pullrequestreview-`), 'Review belongs to another PR');
  } else if (record) {
    validateApprovalRecord(record);
    requireValue(record.remote === remote && record.number === number && record.headSha === headSha && record.commentUrl === comment.url && record.author.toLowerCase() === comment.author.toLowerCase() && record.body === comment.body, 'Missing or stale approval record; re-review the current head');
  } else {
    const bound = manualApprovalHead({ remote, headRef, headSha, comment, history });
    validateApprovalRecord({ remote, number, headSha: bound, commentUrl: comment.url, author: comment.author, body: comment.body });
    requireValue(bound === headSha, 'Manual approval is for a different head; re-review required');
  }
  return headSha;
}

const gitRead = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trimEnd();

const sshHost = host => execFileSync('ssh', ['-G', host], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).match(/^hostname\s+(\S+)$/m)?.[1];
export function githubRemote(value, resolveSSH = sshHost) {
  let host, pathname, ssh = false;
  if (value.includes('://')) {
    const url = new URL(value);
    requireValue(['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol) && !url.search && !url.hash, 'Unsupported origin URL');
    host = url.hostname; pathname = url.pathname; ssh = url.protocol === 'ssh:';
  } else {
    const match = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(value);
    requireValue(match, 'Unsupported origin URL');
    [, host, pathname] = match; ssh = true;
  }
  if (ssh) {
    requireValue(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(host), 'Invalid SSH origin host');
    host = resolveSSH(host);
  }
  requireValue((ssh ? ['github.com', 'ssh.github.com'] : ['github.com']).includes(host?.toLowerCase()), 'Origin host is not GitHub');
  const name = pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '');
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name), 'Invalid origin repository');
  return name.toLowerCase();
}

function worktreeIdentity(config, repoName, token, git) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === repoName);
  requireValue(repo, 'Unknown repository');
  const root = fs.realpathSync(expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees'));
  requireLock(path.join(root, '.locks', `repo-${repoName}`), token);
  const main = fs.realpathSync(repo.path);
  for (const item of config.repos) {
    requireValue(!inside(fs.realpathSync(item.path), root), 'worktreeRoot must be outside every main checkout');
  }
  const wt = path.join(root, repoName);
  const origin = git(main, ['remote', 'get-url', 'origin']);
  requireValue(githubRemote(origin) === repo.remote.toLowerCase(), 'Origin does not match configured repository');
  const listed = git(main, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => {
    const fields = block.split('\0');
    return { path: fields.find(field => field.startsWith('worktree '))?.slice(9), locked: fields.some(field => field === 'locked' || field.startsWith('locked ')) };
  });
  let exists = true;
  try { requireValue(!fs.lstatSync(wt).isSymbolicLink(), 'Worktree path must not be a symlink'); }
  catch (error) { if (error.code === 'ENOENT') exists = false; else throw error; }
  if (!exists) return { path: wt, exists: false, registered: listed.some(item => item.path && canonical(item.path) === canonical(wt)) };
  const actual = fs.realpathSync(wt);
  requireValue(inside(root, actual) && actual !== root && actual !== main, 'Unsafe worktree path');
  const registration = listed.find(item => item.path && canonical(item.path) === actual);
  requireValue(registration, 'Worktree is not registered to this repository');
  requireValue(!registration.locked, 'Git worktree is locked; preserve it');
  requireValue(fs.realpathSync(git(actual, ['rev-parse', '--show-toplevel'])) === actual, 'Worktree identity mismatch');
  return { path: actual, exists: true, headSha: git(actual, ['rev-parse', 'HEAD']) };
}

// requireRetained guards checkouts; the read-only push gate may inspect unretained detached commits.
export function checkWorktree(config, repoName, token, git = gitRead, { requireRetained = true } = {}) {
  const result = worktreeIdentity(config, repoName, token, git);
  if (!result.exists) return result;
  const actual = result.path;
  requireValue(git(actual, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Worktree has unfinished changes; preserve it');
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const file = git(actual, ['rev-parse', '--git-path', operation]);
    requireValue(!fs.existsSync(path.resolve(actual, file)), `Worktree has an active ${operation}; preserve it`);
  }
  requireValue(!requireRetained || git(actual, ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/autofix/verify', 'refs/autofix/review']) !== '', 'Worktree HEAD has no retaining branch or verification ref; preserve its commits before switching');
  return result;
}

export function quarantineWorktree(config, repoName, token, failure, git = gitRead) {
  requireValue(failure?.workersStopped === true && nonempty(failure.reason) && shaOK(failure.headSha), 'Recovery needs a known failure, stopped workers and expected HEAD');
  const wt = worktreeIdentity(config, repoName, token, git);
  requireValue(wt.exists && wt.headSha === failure.headSha, 'Recovery worktree HEAD changed or disappeared');
  const root = path.dirname(wt.path);
  const id = `${repoName}-${randomUUID()}`;
  const destination = path.join(root, 'recovery', id);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  requireValue(canonical(path.dirname(destination)) === path.join(root, 'recovery'), 'Recovery directory must not be a symlink');
  const receipt = path.join(root, 'recovery', `${id}.json`);
  writeAtomic(receipt, { ...failure, source: wt.path, destination, status: 'planned' }, { exclusive: true });
  // Moving the entire worktree preserves its index, ignored files and operation state.
  git(config.repos.find(item => item.name === repoName).path, ['worktree', 'move', wt.path, destination]);
  writeAtomic(receipt, { ...failure, source: wt.path, destination, status: 'moved' });
  return { destination, receipt };
}

export function listRecovery(config) {
  validateConfig(config);
  const root = canonical(expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees'));
  const recovery = path.join(root, 'recovery');
  if (!fs.existsSync(recovery)) return { entries: [], allocatedBytes: 0 };
  requireValue(canonical(recovery) === recovery, 'Recovery directory must not be a symlink');
  const entries = fs.readdirSync(recovery, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => {
    const directory = path.join(recovery, entry.name);
    const receipt = `${directory}.json`;
    let context = null;
    try { context = read(receipt); } catch { /* list orphaned trees too */ }
    try {
      const output = execFileSync('du', ['-sk', directory], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      const allocatedBytes = Number(output.trim().split(/\s+/)[0]) * 1024;
      requireValue(Number.isFinite(allocatedBytes), 'Invalid disk usage');
      return { path: directory, allocatedBytes, reason: context?.reason ?? 'No readable receipt', receipt: fs.existsSync(receipt) ? receipt : null };
    } catch { return { path: directory, allocatedBytes: null, error: 'Disk usage unavailable; inspect permissions', receipt }; }
  });
  return { entries, allocatedBytes: entries.some(entry => entry.allocatedBytes === null) ? null : entries.reduce((sum, entry) => sum + entry.allocatedBytes, 0) };
}

function main([command, ...args]) {
  switch (command) {
    case 'config': validateConfig(read(args[0])); return 'Config checks passed';
    case 'lock': requireValue(args[1], 'lock requires an identity JSON file'); return acquireLock(args[0], read(args[1]));
    case 'inspect-lock': return inspectLock(args[0]);
    case 'resume-lock': return resumeLock(args[0], read(args[1]));
    case 'break-lock': return breakLock(args[0], read(args[1]));
    case 'unlock': releaseLock(args[0], args[1]); return 'Lock released';
    case 'worktree': return checkWorktree(read(args[0]), args[1], args[2]);
    case 'quarantine': return quarantineWorktree(read(args[0]), args[1], args[2], read(args[3]));
    case 'list-recovery': return listRecovery(read(args[0]));
    case 'record-pr': return recordPR(args[0], args[1], read(args[2]), args[3]);
    case 'start-run': return beginRun(args[0], args[1], args[2]);
    case 'read-run': return readRun(args[0], args[1]);
    case 'finish-run': return finishRun(args[0], args[1], args[2], read(args[3]));
    case 'record-approval': {
      const record = validateApprovalRecord(read(args[1]));
      if (fs.existsSync(args[0])) requireValue(isDeepStrictEqual(validateApprovalRecord(read(args[0])), record), 'Approval record already exists with different evidence');
      else writeAtomic(args[0], record, { exclusive: true });
      return 'Approval recorded';
    }
    case 'approval': return { approvedHead: checkApproval(read(args[0])) };
    default: throw new Error('Usage: state.mjs config|lock|inspect-lock|resume-lock|break-lock|unlock|worktree|quarantine|list-recovery|start-run|read-run|finish-run|record-pr|record-approval|approval <arguments>');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
