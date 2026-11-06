import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { verify, readVerified } from './verify.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const inside = (parent, child) => { const relative = path.relative(parent, child); return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)); };
const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const canonical = value => {
  const absolute = path.resolve(value);
  try { return fs.realpathSync(absolute); }
  catch (error) { if (error.code !== 'ENOENT') throw error; const parent = path.dirname(absolute); if (parent === absolute) throw error; return path.join(canonical(parent), path.basename(absolute)); }
};
export const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

export function writeAtomic(file, value, exclusive = false) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    if (exclusive) fs.linkSync(temporary, file); else fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

export function validateConfig(config) {
  need(config?.version === 1 && config.repo, 'Expected version 1 and one repo');
  const repo = config.repo;
  need(nonempty(repo.path) && path.isAbsolute(repo.path), 'repo.path must be absolute');
  need(nonempty(repo.remote) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.remote), 'repo.remote must be owner/repo');
  need(repo.remote.split('/').every(part => part !== '.' && part !== '..'), 'Remote components must identify a repository');
  need(nonempty(repo.baseBranch), 'repo.baseBranch is required');
  need(Array.isArray(repo.verify) && repo.verify.length && repo.verify.every(nonempty), 'Configure nonempty repo.verify commands');
  need(repo.prepare === undefined || (Array.isArray(repo.prepare) && repo.prepare.every(nonempty)), 'Invalid prepare commands');
  need(repo.install === undefined || nonempty(repo.install), 'Invalid install command');
  need(repo.lockfile === undefined || (nonempty(repo.lockfile) && !path.isAbsolute(repo.lockfile) && !repo.lockfile.split(/[\\/]/).includes('..')), 'lockfile must stay inside the worktree');
  need(repo.commandTimeoutSeconds === undefined || (Number.isSafeInteger(repo.commandTimeoutSeconds) && repo.commandTimeoutSeconds >= 1 && repo.commandTimeoutSeconds <= 3600), 'commandTimeoutSeconds must be from 1 to 3600');
  need(repo.forbidden === undefined || (Array.isArray(repo.forbidden) && repo.forbidden.every(nonempty)), 'Invalid forbidden rules');
  const root = config.worktreeRoot ?? '~/.claude/dev-autotask';
  need(nonempty(root) && path.isAbsolute(expand(root)), 'worktreeRoot must be absolute or start with ~/');
  need(!inside(canonical(repo.path), canonical(expand(root))) && !inside(canonical(expand(root)), canonical(repo.path)), 'Keep worktreeRoot and the main checkout separate');
  return config;
}

export function taskPaths(config, id) {
  validateConfig(config);
  need(typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id), 'Task ID must be a lowercase slug of at most 64 characters');
  const root = canonical(expand(config.worktreeRoot ?? '~/.claude/dev-autotask'));
  const taskDir = path.join(root, 'tasks', config.repo.remote.toLowerCase(), id);
  const worktree = path.join(root, 'worktrees', config.repo.remote.toLowerCase(), id);
  need(inside(path.join(root, 'tasks'), taskDir) && inside(path.join(root, 'worktrees'), worktree), 'Managed paths must stay inside their root');
  need(canonical(taskDir) === taskDir && canonical(worktree) === worktree, 'Managed paths must not contain symlinks');
  return { root, taskDir, worktree, record: path.join(taskDir, 'task.json'), plan: path.join(taskDir, 'plan.md'), lock: path.join(taskDir, '.lock'), branch: `dev/autotask-${id}` };
}

export function lockTask(paths, session) {
  need(nonempty(session), 'A saved invocation/session ID is required');
  fs.mkdirSync(paths.taskDir, { recursive: true });
  try { fs.mkdirSync(paths.lock); }
  catch (error) { if (error.code === 'EEXIST') throw new Error(`Task is locked; inspect ${paths.lock}/owner.json and preserve its work`); throw error; }
  const owner = { token: randomUUID(), session, host: os.hostname(), startedAt: now() };
  writeAtomic(path.join(paths.lock, 'owner.json'), owner, true);
  return owner;
}
export function requireLock(paths, token) {
  need(nonempty(token) && read(path.join(paths.lock, 'owner.json')).token === token, 'Task lock ownership mismatch');
}
export function unlockTask(paths, token) {
  requireLock(paths, token);
  fs.unlinkSync(path.join(paths.lock, 'owner.json'));
  fs.rmdirSync(paths.lock);
}

export function loadTask(config, paths) {
  const task = read(paths.record);
  need(task.version === 1 && task.remote === config.repo.remote && task.baseBranch === config.repo.baseBranch && task.branch === paths.branch && task.worktree === paths.worktree && task.main === canonical(config.repo.path), 'Task/config identity changed');
  return task;
}
export function createTask(config, paths, token, input) {
  requireLock(paths, token);
  need(nonempty(input.title) && nonempty(input.request) && shaOK(input.baseSha), 'Task needs title, original request and exact base SHA');
  const task = { version: 1, id: path.basename(paths.taskDir), title: input.title, request: input.request, remote: config.repo.remote, baseBranch: config.repo.baseBranch, main: canonical(config.repo.path), branch: paths.branch, worktree: paths.worktree, baseSha: input.baseSha, phase: 'planning', planSha: null, approvedPlanSha: null, pr: null, review: null, progress: [], createdAt: now() };
  writeAtomic(paths.record, task, true);
  return task;
}
function save(paths, task) { task.updatedAt = now(); writeAtomic(paths.record, task); return task; }
function approved(paths, task) {
  need(task.phase !== 'merged', 'Task is already merged');
  need(task.planSha && digest(fs.readFileSync(paths.plan)) === task.planSha && task.approvedPlanSha === task.planSha, 'The current plan needs explicit user approval');
}
export function savePlan(paths, task, input) {
  need(task.phase !== 'merged' && shaOK(input.baseSha), 'Cannot plan a merged task or an invalid base');
  const content = fs.readFileSync(paths.plan);
  need(content.toString().trim().length > 0, 'Plan is empty');
  task.planSha = digest(content); task.approvedPlanSha = null; task.baseSha = input.baseSha;
  task.phase = 'planned'; task.review = null; task.integration = null;
  return save(paths, task);
}
export function approvePlan(paths, task, input) {
  need(task.phase === 'planned' && input.planSha === task.planSha && digest(fs.readFileSync(paths.plan)) === task.planSha, 'Approve only the unchanged proposed plan');
  task.approvedPlanSha = task.planSha; task.approvedAt = now(); task.phase = 'approved';
  return save(paths, task);
}
export function startTask(paths, task) { approved(paths, task); task.phase = 'implementing'; task.review = null; task.integration = null; return save(paths, task); }
export function checkpoint(paths, task, input) {
  need(task.phase !== 'merged' && nonempty(input.summary), 'Checkpoint needs a summary for an active task');
  task.progress.push({ at: now(), summary: input.summary });
  return save(paths, task);
}
export function bindPR(paths, task, input) {
  approved(paths, task);
  need(shaOK(input.headSha) && Number.isSafeInteger(input.number) && input.number > 0 && input.url === `https://github.com/${task.remote}/pull/${input.number}`, 'Invalid task PR identity');
  need(!task.pr || (task.pr.number === input.number && task.pr.url === input.url), 'Resume the existing task PR; never replace it');
  task.pr = { number: input.number, url: input.url, headSha: input.headSha };
  task.review = null; task.integration = null; task.phase = 'published';
  return save(paths, task);
}

export function githubRemote(value) {
  let host, name;
  if (value.includes('://')) { const url = new URL(value); need(['https:', 'ssh:'].includes(url.protocol), 'Unsupported origin protocol'); host = url.hostname; name = url.pathname; }
  else { const match = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(value); need(match, 'Unsupported origin'); [, host, name] = match; }
  need(['github.com', 'ssh.github.com'].includes(host.toLowerCase()), 'Origin must identify GitHub directly; resolve SSH aliases before setup');
  return name.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').toLowerCase();
}
export function checkWorktree(config, paths, task, { clean = true, headSha, detached = false, execute = git } = {}) {
  need(fs.existsSync(paths.worktree), 'Task worktree is missing');
  need(canonical(paths.worktree) === paths.worktree, 'Task worktree identity changed');
  const main = canonical(config.repo.path);
  need(githubRemote(execute(main, ['remote', 'get-url', 'origin'])) === task.remote.toLowerCase(), 'Origin does not match task repository');
  const list = execute(main, ['worktree', 'list', '--porcelain', '-z']).split('\0\0').filter(Boolean).map(block => block.split('\0'));
  const entry = list.find(fields => fields.includes(`worktree ${paths.worktree}`));
  need(entry && !entry.some(field => field === 'locked' || field.startsWith('locked ')), 'Worktree is unregistered or locked');
  need(canonical(execute(paths.worktree, ['rev-parse', '--show-toplevel'])) === paths.worktree, 'Worktree top-level mismatch');
  need(execute(paths.worktree, ['rev-parse', '--git-common-dir']) && canonical(path.resolve(paths.worktree, execute(paths.worktree, ['rev-parse', '--git-common-dir']))) === canonical(path.resolve(main, execute(main, ['rev-parse', '--git-common-dir']))), 'Worktree belongs to another repository');
  const head = execute(paths.worktree, ['rev-parse', 'HEAD']);
  need(shaOK(head) && (!headSha || head === headSha), 'Worktree HEAD changed');
  const attachment = execute(paths.worktree, ['rev-parse', '--abbrev-ref', 'HEAD']);
  need(detached ? attachment === 'HEAD' : attachment === task.branch, 'Unexpected task branch attachment');
  need(execute(paths.worktree, ['for-each-ref', '--contains=HEAD', '--format=%(refname)', 'refs/heads', 'refs/remotes', 'refs/dev-autotask']) !== '', 'HEAD has no retaining ref');
  if (clean) need(execute(paths.worktree, ['status', '--porcelain=v1', '--untracked-files=all']) === '', 'Worktree has unfinished changes; preserve them');
  for (const operation of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    const file = execute(paths.worktree, ['rev-parse', '--git-path', operation]);
    need(!fs.existsSync(path.resolve(paths.worktree, file)), `Active Git operation: ${operation}`);
  }
  return head;
}

export function recordReview(config, paths, task, input, execute = git) {
  approved(paths, task);
  need(task.pr && input.headSha === task.pr.headSha && shaOK(input.baseSha) && ['clean', 'findings', 'blocked'].includes(input.outcome) && nonempty(input.report), 'Review must describe the current task PR head and base');
  need(Array.isArray(input.findings) && (input.outcome !== 'clean' || input.findings.length === 0), 'Clean review cannot contain unresolved findings');
  checkWorktree(config, paths, task, { headSha: input.headSha, execute });
  if (input.outcome === 'clean') readVerified(paths, input.headSha, config.repo);
  task.review = { ...input, at: now() }; task.integration = null; task.phase = 'reviewed';
  return save(paths, task);
}

export async function verifyIntegration(config, paths, task, token, { execute = git, runVerify = verify } = {}) {
  requireLock(paths, token); approved(paths, task);
  need(task.review?.outcome === 'clean' && task.review.headSha === task.pr?.headSha, 'A clean review of the current head is required');
  const head = checkWorktree(config, paths, task, { headSha: task.pr.headSha, execute });
  task.integration = null; save(paths, task);
  const baseRef = `refs/heads/${task.baseBranch}`;
  execute(task.main, ['check-ref-format', baseRef]);
  // Refresh retaining refs, then use the actual remote base rather than PR metadata.
  execute(task.main, ['fetch', '--no-tags', 'origin', `+${baseRef}:refs/remotes/origin/${task.baseBranch}`]);
  const baseSha = execute(task.main, ['rev-parse', `refs/remotes/origin/${task.baseBranch}`]);
  const treeSha = execute(task.main, ['merge-tree', '--write-tree', head, baseSha]).split('\n')[0];
  need(shaOK(treeSha), 'Integration tree is invalid or conflicted');
  const commitSha = execute(task.main, ['-c', 'commit.gpgsign=false', 'commit-tree', treeSha, '-p', head, ...(baseSha === head ? [] : ['-p', baseSha]), '-m', `Dev autotask local verification ${task.id}`]);
  const ref = `refs/dev-autotask/${task.id}/${randomUUID()}`;
  execute(task.main, ['update-ref', ref, commitSha, '0'.repeat(40)]);
  try {
    execute(paths.worktree, ['checkout', '--detach', commitSha]);
    checkWorktree(config, paths, task, { headSha: commitSha, detached: true, execute });
    const receipt = await runVerify(config, paths, task);
    need(receipt.status === 'passed', receipt.error ?? 'Integration verification failed');
    task.integration = { headSha: head, baseSha, treeSha, commitSha, ref, verifiedAt: now() };
    save(paths, task);
  } finally {
    // Never discard dirty output to return to the task branch.
    checkWorktree(config, paths, task, { headSha: commitSha, detached: true, execute });
    need(execute(task.main, ['rev-parse', `refs/heads/${task.branch}`]) === head, 'Original task branch moved');
    execute(paths.worktree, ['checkout', task.branch]);
    checkWorktree(config, paths, task, { headSha: head, execute });
  }
  return task.integration;
}
export function checkMerge(config, paths, task, input, execute = git) {
  approved(paths, task);
  need(input.mergeRequested === true, 'Merging requires an explicit current user request');
  need(task.pr && input.number === task.pr.number && input.headSha === task.pr.headSha && shaOK(input.baseSha), 'Fresh PR identity differs from task');
  need(task.review?.outcome === 'clean' && task.review.headSha === input.headSha, 'Current head has no clean review');
  const integration = task.integration;
  need(integration && integration.headSha === input.headSha && integration.baseSha === input.baseSha, 'Head or base changed since integration verification');
  checkWorktree(config, paths, task, { headSha: input.headSha, execute });
  readVerified(paths, integration.commitSha, config.repo);
  const baseRef = `refs/heads/${task.baseBranch}`;
  execute(task.main, ['check-ref-format', baseRef]);
  const rows = execute(task.main, ['ls-remote', '--exit-code', '--refs', 'origin', baseRef]).split('\n').map(line => line.split('\t')).filter(([, ref]) => ref === baseRef);
  need(rows.length === 1 && rows[0][0] === integration.baseSha, 'Remote base moved; verify integration again');
  need(execute(task.main, ['rev-parse', integration.ref]) === integration.commitSha && execute(task.main, ['rev-parse', `${integration.commitSha}^{tree}`]) === integration.treeSha, 'Integration ref or tree changed');
  need(execute(task.main, ['merge-tree', '--write-tree', input.headSha, input.baseSha]).split('\n')[0] === integration.treeSha, 'Integration no longer matches the head and base');
  const parents = execute(task.main, ['show', '-s', '--format=%P', integration.commitSha]).split(' ');
  need(JSON.stringify(parents) === JSON.stringify([...new Set([input.headSha, input.baseSha])]), 'Integration parents changed');
  return { number: task.pr.number, approvedHead: input.headSha, baseSha: input.baseSha };
}

async function main([command, configFile, id, token, inputFile]) {
  const config = validateConfig(read(configFile));
  if (command === 'config') return config;
  const paths = taskPaths(config, id);
  if (command === 'paths') return paths;
  if (command === 'lock') return lockTask(paths, token);
  if (command === 'unlock') { unlockTask(paths, token); return 'Task lock released'; }
  if (command === 'show') return loadTask(config, paths);
  requireLock(paths, token);
  const input = inputFile ? read(inputFile) : {};
  if (command === 'create') return createTask(config, paths, token, input);
  const task = loadTask(config, paths);
  switch (command) {
    case 'save-plan': return savePlan(paths, task, input);
    case 'approve-plan': return approvePlan(paths, task, input);
    case 'start': return startTask(paths, task);
    case 'checkpoint': return checkpoint(paths, task, input);
    case 'bind-pr': {
      checkWorktree(config, paths, task, { headSha: input.headSha });
      readVerified(paths, input.headSha, config.repo);
      return bindPR(paths, task, input);
    }
    case 'worktree': return { headSha: checkWorktree(config, paths, task, { clean: input.allowDirty !== true, headSha: input.headSha }) };
    case 'verify': { approved(paths, task); checkWorktree(config, paths, task); const result = await verify(config, paths, task); if (result.status !== 'passed') process.exitCode = 1; return result; }
    case 'review': return recordReview(config, paths, task, input);
    case 'integration': return verifyIntegration(config, paths, task, token);
    case 'merge-check': return checkMerge(config, paths, task, input);
    case 'merged': {
      need(task.pr && input.number === task.pr.number && input.state === 'MERGED' && input.url === task.pr.url && shaOK(input.mergeCommit), 'Confirm the task PR was merged on GitHub');
      task.phase = 'merged'; task.mergeCommit = input.mergeCommit; return save(paths, task);
    }
    default: throw new Error('Unknown command. Use config|paths|lock|unlock|show|create|save-plan|approve-plan|start|checkpoint|bind-pr|worktree|verify|review|integration|merge-check|merged');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
