// Task records for dev-autotask. Git and GitHub are driven by the skills; this only
// reads the shared autofix.config.json, picks the repo, derives paths and keeps task.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// KEY-DECISION 2026-11-06: reuse dev-autofix's config (one file per workspace, a `repos`
// list) instead of a per-repo dev-autotask config; autotask-only settings are defaults.
const CONFIG = 'autofix.config.json';
export const ROOT = '~/.claude/dev-autotask';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim() !== '';
const list = (value, ok = text) => value === undefined || (Array.isArray(value) && value.every(ok));
const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const inside = (parent, child) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel)); };
// Real path, resolving symlinks; for a path that does not exist yet, the nearest existing
// ancestor's real path plus the rest, so a symlinked root cannot hide inside a checkout.
const real = p => {
  const missing = [];
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) return path.join(fs.realpathSync(dir), ...missing);
    if (path.dirname(dir) === dir) return path.resolve(p);
    missing.unshift(path.basename(dir));
  }
};

// Nearest autofix.config.json from `start` upward, else ~/.claude/autofix.config.json.
export function findConfig(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG))) return path.join(dir, CONFIG);
    if (path.dirname(dir) === dir) break;
  }
  const home = path.join(os.homedir(), '.claude', CONFIG);
  need(fs.existsSync(home), `No ${CONFIG} found from ${start} upward or in ~/.claude`);
  return home;
}

function checkRepo(repo, file) {
  const at = `${file}: repo ${repo?.name}`;
  need(/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(repo?.name ?? ''), `${file}: every repo needs a name`);
  need(text(repo.path) && path.isAbsolute(repo.path), `${at}: path must be absolute`);
  need(/^[\w.-]+\/[\w.-]+$/.test(repo.remote ?? ''), `${at}: remote must be owner/repo`);
  need(text(repo.baseBranch), `${at}: baseBranch is required`);
  need(Array.isArray(repo.verify) && repo.verify.length && repo.verify.every(text), `${at}: verify needs at least one command`);
  need(repo.install === undefined || text(repo.install), `${at}: install must be a command`);
  need(list(repo.prepare), `${at}: prepare must be a list of commands`);
  need(list(repo.forbidden, s => typeof s === 'string'), `${at}: forbidden must be a list`);
  need(list(repo.env, n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)), `${at}: env must be a list of variable names`);
  const seconds = repo.commandTimeoutSeconds ?? 600;
  need(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600, `${at}: commandTimeoutSeconds must be 1-3600`);
  return { ...repo, install: repo.install ?? null, prepare: repo.prepare ?? [], env: repo.env ?? [], forbidden: repo.forbidden ?? [], commandTimeoutSeconds: seconds };
}

// Picks one repo: by name, by GitHub remote, the one whose checkout contains cwd, or the
// only one. Anything else is ambiguous and must be asked, never guessed.
export function selectRepo(repos, file, { repo: name, remote, cwd = process.cwd() } = {}) {
  const names = repos.map(r => r.name).join(', ');
  if (name) {
    const hit = repos.find(r => r.name === name);
    need(hit, `No repo named ${name} in ${file}; repos: ${names}`);
    return hit;
  }
  if (remote) {
    const hits = repos.filter(r => r.remote.toLowerCase() === remote.toLowerCase());
    need(hits.length === 1, `${hits.length ? 'Several repos' : 'No repo'} with remote ${remote} in ${file}; repos: ${names}`);
    return hits[0];
  }
  const here = real(cwd);
  const containing = repos.filter(r => inside(real(r.path), here)).sort((a, b) => real(b.path).length - real(a.path).length);
  if (containing.length) return containing[0];
  need(repos.length === 1, `Several repos in ${file}: ${names}. Name one (--repo <name>).`);
  return repos[0];
}

// The config's repos, validated, plus the selected one as `repo`. `root` holds every task,
// worktree and audit and must resolve outside every configured checkout.
export function loadConfig(file = findConfig(), options = {}) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  need(config?.version === 1 && Array.isArray(config.repos) && config.repos.length, `${file}: expected version 1 and a repos list`);
  need(list(config.forbidden, s => typeof s === 'string'), `${file}: forbidden must be a list`);
  need(list(config.reviewers), `${file}: reviewers must be a list of GitHub logins`);
  need(list(config.disabledPatterns), `${file}: disabledPatterns must be a list of pattern ids`);
  const repos = config.repos.map(repo => checkRepo(repo, file));
  need(new Set(repos.map(r => r.name)).size === repos.length, `${file}: repo names must be unique`);
  const root = expand(options.root ?? ROOT);
  need(path.isAbsolute(root), 'The dev-autotask root must be absolute');
  for (const r of repos) need(!inside(real(r.path), real(root)), `${root} must be outside every repo checkout (it is inside ${r.name})`);
  const repo = selectRepo(repos, file, options);
  // reviewers: whose review comments finish acts on; null means the authenticated gh user.
  return { file: path.resolve(file), root, forbidden: config.forbidden ?? [], reviewers: config.reviewers ?? null, disabledPatterns: config.disabledPatterns ?? [], repos: repos.map(r => r.name), repo };
}

// Tasks are namespaced by GitHub repository, like their branches.
export function taskPaths(root, remote, id) {
  need(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? ''), 'Task ID must be a lowercase slug (max 64)');
  const ns = remote.toLowerCase();
  const taskDir = path.join(root, 'tasks', ns, id);
  return {
    taskDir, record: path.join(taskDir, 'task.json'), plan: path.join(taskDir, 'plan.md'),
    worktree: path.join(root, 'worktrees', ns, id), branch: `dev/autotask-${id}`,
  };
}

const write = (file, task) => fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));

export function createTask(config, id, title) {
  need(text(title), 'A task title is required');
  const { repo } = config;
  const p = taskPaths(config.root, repo.remote, id);
  need(!fs.existsSync(p.record), `Task ${id} already exists for ${repo.remote}; resume it instead`);
  fs.mkdirSync(p.taskDir, { recursive: true });
  // config + repo: verify.mjs gets both explicitly, since discovery from a worktree
  // outside the checkout would miss the config or pick another repo.
  const task = { id, title, config: config.file, repo: repo.name, remote: repo.remote, baseBranch: repo.baseBranch, branch: p.branch, worktree: p.worktree, pr: null, progress: [] };
  write(p.record, task);
  return { ...task, plan: p.plan };
}

// A 1.0 task.json has no `remote` and points at dev-autotask.config.json; it is never
// resumed or listed, only reported by locate().
const legacy = task => typeof task?.remote !== 'string' || path.basename(String(task.config)) !== CONFIG;
function scan(root) {
  const dir = path.join(expand(root), 'tasks');
  const dirs = p => fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const found = [];
  for (const owner of dirs(dir)) {
    for (const name of dirs(path.join(dir, owner))) {
      for (const id of dirs(path.join(dir, owner, name))) {
        const record = path.join(dir, owner, name, id, 'task.json');
        if (fs.existsSync(record)) found.push({ id, record, task: read(record) });
      }
    }
  }
  return found;
}

// Every current task under root, optionally only one GitHub repository's. Repo names are
// aliases local to one config, so callers resolve them to a remote first (see main).
export function listTasks({ root = ROOT, remote } = {}) {
  return scan(root)
    .filter(({ task }) => !legacy(task) && (!remote || task.remote.toLowerCase() === remote.toLowerCase()))
    .map(({ id, record, task }) => ({ id, repo: task.repo, remote: task.remote, title: task.title, pr: task.pr, done: task.done ?? null, worktree: fs.existsSync(task.worktree) ? task.worktree : null, locked: fs.existsSync(lockFile(record)), record }));
}

function locate(id, options) {
  taskPaths('/', 'o/r', id); // validates the ID
  const hits = listTasks(options).filter(t => t.id === id);
  need(hits.length || !scan(options.root ?? ROOT).some(t => t.id === id && legacy(t.task)), `Task ${id} was created by dev-autotask 1.0; re-plan it with /dev-autotask:plan`);
  need(hits.length, `No task ${id}${options.remote ? ` for ${options.remote}` : ''}`);
  need(hits.length === 1, `Task ${id} exists for several repos (${hits.map(t => t.remote).join(', ')}); pass --repo <name>`);
  return hits[0].record;
}

// The task plus its plan path and, from its recorded config, the checkout path and rules.
// Fails if that config no longer maps the task's repo name to the same remote.
export function showTask(id, options = {}) {
  const task = read(locate(id, options));
  const config = loadConfig(task.config, { root: options.root, repo: task.repo });
  need(config.repo.remote.toLowerCase() === task.remote.toLowerCase(), `${task.config}: repo ${task.repo} is now ${config.repo.remote}, not ${task.remote}`);
  return { ...task, plan: taskPaths(config.root, task.remote, id).plan, path: config.repo.path, forbidden: [...config.forbidden, ...config.repo.forbidden], reviewers: config.reviewers };
}

// KEY-DECISION 2026-11-11: one session works on a task at a time. The lock is a plain file
// naming the session; nothing expires it, and only an explicit --force (after the user
// confirms the other session has ended) replaces it. The old owner is kept beside it.
const lockFile = record => path.join(path.dirname(record), 'lock.json');
export function lockTask(id, session, options = {}) {
  need(text(session), 'A session ID is required');
  const file = lockFile(locate(id, options));
  const mine = { session, host: os.hostname(), at: new Date().toISOString() };
  const claim = () => fs.writeFileSync(file, `${JSON.stringify(mine, null, 2)}\n`, { flag: 'wx' });
  try { claim(); return { locked: true, ...mine }; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const owner = read(file);
  if (owner.session === session && owner.host === mine.host) return { locked: true, resumed: true, ...owner };
  need(options.force === true, `Task ${id} is locked by session ${owner.session} on ${owner.host} since ${owner.at}. If that session has ended, confirm with the user, then repeat with --force`);
  fs.renameSync(file, `${file}.replaced-${Date.now()}`);
  claim();
  return { locked: true, replaced: owner, ...mine };
}
export function unlockTask(id, session, options = {}) {
  const file = lockFile(locate(id, options));
  if (!fs.existsSync(file)) return { locked: false };
  need(read(file).session === session, `Task ${id} is locked by another session; not releasing it`);
  fs.unlinkSync(file);
  return { locked: false };
}

const gitExec = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30 * 60 * 1000 }).trimEnd();
// After a merge (or when a task is abandoned): remove the task worktree and mark the task done.
// Only the session holding the task lock may do it, so another session's worktree is never
// pulled out from under it. Never forced: uncommitted work stops it, and so does a HEAD the
// task branch does not contain (a detached commit would otherwise lose its only reference).
// Records, plan.md and the branch are kept.
export function cleanupTask(id, session, options = {}, git = gitExec) {
  need(text(session), 'A session ID is required; take the task lock first');
  need(options.merged === undefined || /^[0-9a-f]{40}$/i.test(options.merged), '--merged takes the full 40-character head SHA that was merged');
  const record = locate(id, options);
  const lock = lockFile(record);
  need(fs.existsSync(lock), `Task ${id} is not locked; take the lock (state.mjs lock ${id} <session>) before cleanup`);
  need(read(lock).session === session, `Task ${id} is locked by another session; not cleaning it up`);
  const task = read(record);
  const config = loadConfig(task.config, { root: options.root, repo: task.repo });
  let worktree = 'absent';
  if (fs.existsSync(task.worktree)) {
    const common = cwd => real(git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
    need(common(task.worktree) === common(config.repo.path), `${task.worktree} is not a worktree of ${config.repo.path}; not removing it`);
    need(git(task.worktree, ['status', '--porcelain']) === '', `${task.worktree} has uncommitted changes; commit or discard them before cleanup`);
    if (git(task.worktree, ['branch', '--show-current']) !== task.branch) {
      const head = git(task.worktree, ['rev-parse', 'HEAD']);
      let kept = true;
      try { git(task.worktree, ['merge-base', '--is-ancestor', head, `refs/heads/${task.branch}`]); } catch { kept = false; }
      need(kept, `${task.worktree} is at ${head.slice(0, 12)}, which ${task.branch} does not contain; keep it with \`git -C ${task.worktree} branch <name> ${head.slice(0, 12)}\` or move it onto ${task.branch}, then clean up`);
    }
    git(config.repo.path, ['worktree', 'remove', task.worktree]);
    worktree = 'removed';
  }
  // With --merged <sha>, delete the remote branch, but only while it still points at that
  // merged head: the lease leaves anything pushed since untouched.
  let remote = 'kept';
  if (options.merged) {
    const tip = git(config.repo.path, ['ls-remote', 'origin', `refs/heads/${task.branch}`]).split('\t')[0];
    if (!tip) remote = 'already deleted';
    else if (tip.toLowerCase() !== options.merged.toLowerCase()) remote = `kept: remote tip ${tip.slice(0, 12)} is not the merged head`;
    else {
      try { git(config.repo.path, ['push', `--force-with-lease=refs/heads/${task.branch}:${tip}`, 'origin', `:refs/heads/${task.branch}`]); remote = 'deleted'; }
      catch (error) { remote = `kept: ${error.stderr?.trim() || error.message}`; }
    }
  }
  task.done ??= new Date().toISOString();
  write(record, task);
  return { id, worktree, done: task.done, branch: task.branch, remote };
}

function update(id, options, change) {
  const record = locate(id, options);
  const task = read(record);
  change(task);
  write(record, task);
  return task;
}

export const setPR = (id, number, options = {}) => update(id, options, task => {
  const pr = Number(number);
  need(Number.isInteger(pr) && pr > 0, 'PR must be a positive number');
  need(task.pr === null || task.pr === pr, `Task already has PR #${task.pr}; keep one PR per task`);
  task.pr = pr;
});

export const addProgress = (id, note, options = {}) => update(id, options, task => {
  need(text(note), 'Progress note is required');
  task.progress.push({ at: new Date().toISOString(), note });
});

const USAGE = 'Usage: state.mjs [--repo <name> | --remote <owner/repo>] config | list | show <id> | create <id> <title> | pr <id> <number> | progress <id> <note> | lock <id> <session> [--force] | unlock <id> <session> | cleanup <id> <session> [--merged <sha>]';
function main(argv) {
  const options = {}, args = [];
  let force = false, merged;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' || argv[i] === '--remote') options[argv[i].slice(2)] = argv[++i];
    else if (argv[i] === '--force') force = true;
    else if (argv[i] === '--merged') merged = argv[++i] ?? '';
    else args.push(argv[i]);
  }
  need(!('repo' in options && 'remote' in options) && Object.values(options).every(text), USAGE);
  const [command, id, ...rest] = args;
  // Task lookups never match the alias itself: it is resolved through this workspace's
  // config to a remote, so another workspace's same-named repo cannot be picked.
  const scope = { remote: options.repo ? loadConfig(findConfig(), options).repo.remote : options.remote };
  switch (command) {
    case 'config': return loadConfig(findConfig(), options);
    case 'create': return createTask(loadConfig(findConfig(), options), id, rest.join(' '));
    case 'list': return listTasks(scope);
    case 'show': return showTask(id, scope);
    case 'pr': return setPR(id, rest[0], scope);
    case 'progress': return addProgress(id, rest.join(' '), scope);
    case 'lock': return lockTask(id, rest[0], { ...scope, force });
    case 'unlock': return unlockTask(id, rest[0], scope);
    case 'cleanup': return cleanupTask(id, rest[0], { ...scope, merged });
    default: throw new Error(USAGE);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
