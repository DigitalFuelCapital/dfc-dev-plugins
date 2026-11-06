// Task records for dev-autotask. Git and GitHub are driven by the skills; this only
// finds the config, derives paths and keeps task.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG = 'dev-autotask.config.json';
const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim() !== '';
const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const inside = (parent, child) => !path.relative(parent, child).startsWith('..');
// Real path, resolving symlinks; for a path that does not exist yet, the nearest existing
// ancestor's real path plus the rest, so a symlinked worktreeRoot cannot hide inside repo.path.
const real = p => {
  const missing = [];
  for (let dir = path.resolve(p); ; dir = path.dirname(dir)) {
    if (fs.existsSync(dir)) return path.join(fs.realpathSync(dir), ...missing);
    if (path.dirname(dir) === dir) return path.resolve(p);
    missing.unshift(path.basename(dir));
  }
};

// Nearest dev-autotask.config.json from `start` upward, else ~/.claude/<name>.
export function findConfig(start = process.cwd()) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, CONFIG))) return path.join(dir, CONFIG);
    if (path.dirname(dir) === dir) break;
  }
  const home = path.join(os.homedir(), '.claude', CONFIG);
  need(fs.existsSync(home), `No ${CONFIG} found from ${start} upward or in ~/.claude`);
  return home;
}

export function loadConfig(file = findConfig()) {
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  const repo = config?.repo;
  need(config?.version === 1 && repo, `${file}: expected version 1 and a repo`);
  need(text(repo.path) && path.isAbsolute(repo.path), 'repo.path must be absolute');
  need(/^[\w.-]+\/[\w.-]+$/.test(repo.remote ?? ''), 'repo.remote must be owner/repo');
  need(text(repo.baseBranch), 'repo.baseBranch is required');
  need(Array.isArray(repo.verify) && repo.verify.length && repo.verify.every(text), 'repo.verify needs at least one command');
  need(repo.install === undefined || text(repo.install), 'repo.install must be a command');
  need(repo.env === undefined || (Array.isArray(repo.env) && repo.env.every(n => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))), 'repo.env must be a list of variable names');
  const seconds = repo.commandTimeoutSeconds ?? 600;
  need(Number.isInteger(seconds) && seconds >= 1 && seconds <= 3600, 'commandTimeoutSeconds must be 1-3600');
  const root = expand(config.worktreeRoot ?? '~/.claude/dev-autotask');
  need(path.isAbsolute(root), 'worktreeRoot must be absolute or start with ~/');
  need(!inside(real(repo.path), real(root)), 'worktreeRoot must be outside repo.path');
  return { ...config, file: path.resolve(file), root, repo: { ...repo, commandTimeoutSeconds: seconds } };
}

export function taskPaths(config, id) {
  need(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id ?? ''), 'Task ID must be a lowercase slug (max 64)');
  const repo = config.repo.remote.toLowerCase();
  const taskDir = path.join(config.root, 'tasks', repo, id);
  return {
    taskDir, record: path.join(taskDir, 'task.json'), plan: path.join(taskDir, 'plan.md'),
    worktree: path.join(config.root, 'worktrees', repo, id), branch: `dev/autotask-${id}`,
  };
}

const write = (file, task) => fs.writeFileSync(file, `${JSON.stringify(task, null, 2)}\n`);
export const showTask = (config, id) => JSON.parse(fs.readFileSync(taskPaths(config, id).record, 'utf8'));

export function createTask(config, id, title) {
  need(text(title), 'A task title is required');
  const p = taskPaths(config, id);
  need(!fs.existsSync(p.record), `Task ${id} already exists; resume it instead`);
  fs.mkdirSync(p.taskDir, { recursive: true });
  // config: the file this task was created from; verify.mjs gets it explicitly, since
  // discovery from a worktree outside the checkout would miss it or find another config.
  const task = { id, title, config: config.file, repo: config.repo.remote, baseBranch: config.repo.baseBranch, branch: p.branch, worktree: p.worktree, pr: null, progress: [] };
  write(p.record, task);
  return { ...task, plan: p.plan };
}

export function setPR(config, id, number) {
  const task = showTask(config, id);
  const pr = Number(number);
  need(Number.isInteger(pr) && pr > 0, 'PR must be a positive number');
  need(task.pr === null || task.pr === pr, `Task already has PR #${task.pr}; keep one PR per task`);
  task.pr = pr;
  write(taskPaths(config, id).record, task);
  return task;
}

export function addProgress(config, id, note) {
  need(text(note), 'Progress note is required');
  const task = showTask(config, id);
  task.progress.push({ at: new Date().toISOString(), note });
  write(taskPaths(config, id).record, task);
  return task;
}

export function listTasks(config) {
  const dir = path.join(config.root, 'tasks', config.repo.remote.toLowerCase());
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter(id => fs.existsSync(path.join(dir, id, 'task.json'))) : [];
}

const USAGE = 'Usage: state.mjs config | list | paths <id> | show <id> | create <id> <title> | pr <id> <number> | progress <id> <note>';
function main([command, id, ...rest]) {
  const config = loadConfig();
  switch (command) {
    case 'config': return config;
    case 'list': return listTasks(config);
    case 'paths': return taskPaths(config, id);
    case 'show': return showTask(config, id);
    case 'create': return createTask(config, id, rest.join(' '));
    case 'pr': return setPR(config, id, rest[0]);
    case 'progress': return addProgress(config, id, rest.join(' '));
    default: throw new Error(USAGE);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
