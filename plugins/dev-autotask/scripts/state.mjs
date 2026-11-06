// Task records for dev-autotask. Git and GitHub are driven by the skills; this only
// reads the shared autofix.config.json, picks the repo, derives paths and keeps task.json.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// KEY-DECISION 2026-11-06: reuse dev-autofix's config (one file per workspace, a `repos`
// list) instead of a per-repo dev-autotask config; autotask-only settings are defaults.
const CONFIG = 'autofix.config.json';
export const ROOT = '~/.claude/dev-autotask';
const INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund'; // autofix schema's default
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
  return { ...repo, install: repo.install ?? INSTALL, prepare: repo.prepare ?? [], env: repo.env ?? [], forbidden: repo.forbidden ?? [], commandTimeoutSeconds: seconds };
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
  const repos = config.repos.map(repo => checkRepo(repo, file));
  need(new Set(repos.map(r => r.name)).size === repos.length, `${file}: repo names must be unique`);
  const root = expand(options.root ?? ROOT);
  need(path.isAbsolute(root), 'The dev-autotask root must be absolute');
  for (const r of repos) need(!inside(real(r.path), real(root)), `${root} must be outside every repo checkout (it is inside ${r.name})`);
  const repo = selectRepo(repos, file, options);
  return { file: path.resolve(file), root, forbidden: config.forbidden ?? [], repos: repos.map(r => r.name), repo };
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

// Every task under root, optionally only one repo's (by recorded name or remote).
export function listTasks({ root = ROOT, repo, remote } = {}) {
  const dir = path.join(expand(root), 'tasks');
  const dirs = p => fs.existsSync(p) ? fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) : [];
  const found = [];
  for (const owner of dirs(dir)) {
    for (const name of dirs(path.join(dir, owner))) {
      for (const id of dirs(path.join(dir, owner, name))) {
        const record = path.join(dir, owner, name, id, 'task.json');
        if (!fs.existsSync(record)) continue;
        const task = read(record);
        if ((!repo || task.repo === repo) && (!remote || task.remote.toLowerCase() === remote.toLowerCase())) found.push({ id, repo: task.repo, remote: task.remote, title: task.title, pr: task.pr, record });
      }
    }
  }
  return found;
}

function locate(id, options) {
  taskPaths('/', 'o/r', id); // validates the ID
  const hits = listTasks(options).filter(t => t.id === id);
  need(hits.length, `No task ${id}${options.repo ? ` for ${options.repo}` : ''}`);
  need(hits.length === 1, `Task ${id} exists for several repos (${hits.map(t => t.repo).join(', ')}); pass --repo <name>`);
  return hits[0].record;
}

// The task plus its plan path and, from its recorded config, the checkout path and rules.
// Fails if that config no longer maps the task's repo name to the same remote.
export function showTask(id, options = {}) {
  const task = read(locate(id, options));
  const config = loadConfig(task.config, { root: options.root, repo: task.repo });
  need(config.repo.remote.toLowerCase() === task.remote.toLowerCase(), `${task.config}: repo ${task.repo} is now ${config.repo.remote}, not ${task.remote}`);
  return { ...task, plan: taskPaths(config.root, task.remote, id).plan, path: config.repo.path, forbidden: [...config.forbidden, ...config.repo.forbidden] };
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

const USAGE = 'Usage: state.mjs [--repo <name> | --remote <owner/repo>] config | list | show <id> | create <id> <title> | pr <id> <number> | progress <id> <note>';
function main(argv) {
  const options = {}, args = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--repo' || argv[i] === '--remote') options[argv[i].slice(2)] = argv[++i];
    else args.push(argv[i]);
  }
  need(!('repo' in options && 'remote' in options) && Object.values(options).every(text), USAGE);
  const [command, id, ...rest] = args;
  switch (command) {
    case 'config': return loadConfig(findConfig(), options);
    case 'create': return createTask(loadConfig(findConfig(), options), id, rest.join(' '));
    case 'list': return listTasks(options);
    case 'show': return showTask(id, options);
    case 'pr': return setPR(id, rest[0], options);
    case 'progress': return addProgress(id, rest.join(' '), options);
    default: throw new Error(USAGE);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
