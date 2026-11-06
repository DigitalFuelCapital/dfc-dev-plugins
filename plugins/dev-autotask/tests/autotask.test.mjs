import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findConfig, loadConfig, selectRepo, taskPaths, createTask, showTask, setPR, addProgress, listTasks } from '../scripts/state.mjs';
import { verify } from '../scripts/verify.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

// A workspace with an autofix.config.json listing one repo (or `extra` more) and a task root.
function fixture(t, repo = {}, extra = []) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  fs.mkdirSync(path.join(main, 'nested'), { recursive: true });
  const repos = [{ name: 'main', path: main, remote: 'Owner/Repo', baseBranch: 'main', install: 'true', verify: ['true'], ...repo }, ...extra];
  for (const r of extra) fs.mkdirSync(r.path, { recursive: true });
  const raw = { version: 1, maxFixesPerRun: 5, repos };
  const file = path.join(dir, 'autofix.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  const root = path.join(dir, 'runtime');
  return { dir, main, raw, file, root, config: loadConfig(file, { root, repo: 'main' }) };
}
function other(dir, name, extra = {}) {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  return { name, path: path.join(dir, name), remote: `Owner/${name}`, baseBranch: 'main', install: 'true', verify: ['true'], ...extra };
}
const rewrite = (f, raw) => fs.writeFileSync(f.file, JSON.stringify(raw));

test('findConfig walks up from the start directory, then falls back to ~/.claude', t => {
  const f = fixture(t);
  assert.equal(findConfig(path.join(f.main, 'nested')), f.file);
  const home = path.join(f.dir, 'home'), previous = process.env.HOME;
  t.after(() => { process.env.HOME = previous; });
  process.env.HOME = home;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-none-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  assert.throws(() => findConfig(isolated), /No autofix.config.json/);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.copyFileSync(f.file, path.join(home, '.claude', 'autofix.config.json'));
  assert.equal(findConfig(isolated), path.join(home, '.claude', 'autofix.config.json'));
  // A workspace config wins over ~/.claude.
  assert.equal(findConfig(f.main), f.file);
});

test('loadConfig applies defaults and rejects invalid configs', t => {
  const f = fixture(t, { install: undefined });
  assert.equal(f.config.repo.commandTimeoutSeconds, 600);
  assert.equal(f.config.repo.install, 'npm ci --ignore-scripts --no-audit --no-fund');
  assert.deepEqual([f.config.repo.prepare, f.config.repo.env, f.config.forbidden], [[], [], []]);
  assert.equal(f.config.root, f.root);
  assert.match(loadConfig(f.file, { repo: 'main' }).root, /\.claude\/dev-autotask$/);
  const bad = (repo, pattern) => {
    rewrite(f, { ...f.raw, repos: [{ ...f.raw.repos[0], ...repo }] });
    assert.throws(() => loadConfig(f.file, { root: f.root }), pattern);
  };
  bad({ verify: [] }, /verify needs/);
  bad({ remote: 'not a remote' }, /owner\/repo/);
  bad({ path: 'relative' }, /absolute/);
  bad({ name: '../x' }, /needs a name/);
  bad({ commandTimeoutSeconds: 0 }, /1-3600/);
  bad({ env: ['NOT VALID'] }, /env must/);
  rewrite(f, { ...f.raw, repos: [] });
  assert.throws(() => loadConfig(f.file, { root: f.root }), /expected version 1/);
  rewrite(f, { ...f.raw, repos: [f.raw.repos[0], f.raw.repos[0]] });
  assert.throws(() => loadConfig(f.file, { root: f.root, repo: 'main' }), /unique/);
});

test('selectRepo picks by name, remote, cwd or the only repo, and lists names when ambiguous', t => {
  const f = fixture(t);
  const a = other(f.dir, 'alpha'), b = other(f.dir, 'beta');
  fs.mkdirSync(path.join(b.path, 'deep', 'er'), { recursive: true });
  rewrite(f, { ...f.raw, repos: [a, b] });
  const pick = options => loadConfig(f.file, { root: f.root, ...options }).repo.name;
  assert.equal(pick({ repo: 'beta', cwd: a.path }), 'beta');
  assert.equal(pick({ remote: 'owner/ALPHA', cwd: b.path }), 'alpha');
  assert.equal(pick({ cwd: path.join(b.path, 'deep', 'er') }), 'beta');
  assert.throws(() => pick({ cwd: f.dir }), /Several repos in .*: alpha, beta/);
  assert.throws(() => pick({ repo: 'gamma' }), /No repo named gamma.*alpha, beta/);
  assert.throws(() => pick({ remote: 'Owner/gamma' }), /No repo with remote/);
  // The only repo is used from anywhere; a cwd inside the nearer (nested) checkout wins.
  assert.equal(selectRepo([a], f.file, { cwd: '/' }).name, 'alpha');
  const nested = { ...b, name: 'nested', path: path.join(b.path, 'deep') };
  assert.equal(selectRepo([b, nested], f.file, { cwd: path.join(b.path, 'deep', 'er') }).name, 'nested');
});

test('the task root must resolve outside every configured repo, including through symlinks', t => {
  const f = fixture(t);
  const a = other(f.dir, 'alpha'), b = other(f.dir, 'beta');
  rewrite(f, { ...f.raw, repos: [a, b] });
  assert.throws(() => loadConfig(f.file, { root: path.join(b.path, 'runtime'), repo: 'alpha' }), /outside every repo checkout \(it is inside beta\)/);
  const link = path.join(f.dir, 'elsewhere');
  fs.symlinkSync(b.path, link);
  assert.throws(() => loadConfig(f.file, { root: link, repo: 'alpha' }), /inside beta/);
  assert.throws(() => loadConfig(f.file, { root: path.join(link, 'not', 'yet', 'created'), repo: 'alpha' }), /inside beta/);
});

test('create, show, progress and PR recording keep one task and one PR', t => {
  const f = fixture(t, { forbidden: ['repo rule'] }), { config, root } = f;
  rewrite(f, { ...f.raw, forbidden: ['global rule'] });
  assert.throws(() => taskPaths(root, 'Owner/Repo', 'Bad ID'), /lowercase slug/);
  const task = createTask(config, 'big-feature', 'Deliver the feature');
  const worktree = path.join(root, 'worktrees', 'owner/repo', 'big-feature');
  assert.deepEqual(
    { ...task, plan: undefined },
    { id: 'big-feature', title: 'Deliver the feature', config: f.file, repo: 'main', remote: 'Owner/Repo', baseBranch: 'main', branch: 'dev/autotask-big-feature', worktree, pr: null, progress: [], plan: undefined },
  );
  assert.equal(task.plan, path.join(root, 'tasks', 'owner/repo', 'big-feature', 'plan.md'));
  assert.throws(() => createTask(config, 'big-feature', 'Again'), /already exists/);
  assert.deepEqual(listTasks({ root }).map(x => x.id), ['big-feature']);
  const shown = showTask('big-feature', { root });
  assert.deepEqual([shown.plan, shown.path, shown.forbidden], [task.plan, f.main, ['global rule', 'repo rule']]);

  addProgress('big-feature', 'Milestone 1 done', { root });
  assert.equal(showTask('big-feature', { root }).progress[0].note, 'Milestone 1 done');
  assert.equal(setPR('big-feature', '42', { root }).pr, 42);
  assert.equal(setPR('big-feature', 42, { root }).pr, 42);
  assert.throws(() => setPR('big-feature', 43, { root }), /keep one PR/);
  assert.throws(() => setPR('big-feature', 'x', { root }), /positive number/);
  assert.throws(() => showTask('missing', { root }), /No task missing/);

  // The recorded config must still map the task's repo name to the same remote.
  rewrite(f, { ...f.raw, repos: [{ ...f.raw.repos[0], remote: 'Owner/Other' }] });
  assert.throws(() => showTask('big-feature', { root }), /is now Owner\/Other/);
});

test('the same task ID in two repos does not collide', t => {
  const f = fixture(t);
  const a = other(f.dir, 'alpha'), b = other(f.dir, 'beta');
  rewrite(f, { ...f.raw, repos: [a, b] });
  const { root } = f;
  const ta = createTask(loadConfig(f.file, { root, repo: 'alpha' }), 'export', 'A');
  const tb = createTask(loadConfig(f.file, { root, repo: 'beta' }), 'export', 'B');
  assert.notEqual(ta.plan, tb.plan);
  assert.notEqual(ta.worktree, tb.worktree);
  assert.equal(listTasks({ root }).length, 2);
  assert.throws(() => showTask('export', { root }), /several repos \((alpha, beta|beta, alpha)\)/);
  assert.equal(showTask('export', { root, repo: 'beta' }).title, 'B');
  assert.equal(setPR('export', 5, { root, remote: 'owner/alpha' }).pr, 5);
  assert.equal(showTask('export', { root, repo: 'beta' }).pr, null);
});

test('state CLI selects the repo from --repo or the working directory', t => {
  const f = fixture(t);
  const a = other(f.dir, 'alpha'), b = other(f.dir, 'beta');
  rewrite(f, { ...f.raw, repos: [a, b] });
  const env = { ...process.env, HOME: path.join(f.dir, 'home') };
  const run = (cwd, ...args) => JSON.parse(execFileSync('node', [path.join(scripts, 'state.mjs'), ...args], { cwd, env, encoding: 'utf8' }));
  assert.equal(run(b.path, 'create', 'cli-task', 'CLI', 'task').repo, 'beta');
  assert.equal(run(f.dir, '--repo', 'alpha', 'create', 'cli-task', 'Other').repo, 'alpha');
  assert.throws(() => execFileSync('node', [path.join(scripts, 'state.mjs'), 'config'], { cwd: f.dir, env, stdio: 'pipe' }), /alpha, beta/);
  assert.equal(run(f.dir, 'pr', 'cli-task', '7', '--repo', 'beta').pr, 7);
  assert.equal(run(f.dir, '--repo', 'beta', 'show', 'cli-task').pr, 7);
  assert.equal(run(f.dir, 'list').length, 2);
});

const quiet = { stdio: 'ignore', log: () => {} };

test('verify runs install first, then verify commands, with CI=1', async t => {
  const f = fixture(t, { install: 'echo install >> order', verify: ['echo "verify $CI" >> order', 'echo second >> order'] });
  const result = await verify(f.config, f.main, quiet);
  assert.equal(result.passed, true);
  assert.equal(fs.readFileSync(path.join(f.main, 'order'), 'utf8'), 'install\nverify 1\nsecond\n');
});

test('verify commands do not inherit the caller\'s environment', async t => {
  const f = fixture(t, { verify: ['echo "[$DEV_AUTOTASK_SECRET][$CI][${HOME:+home}]" > env'] });
  process.env.DEV_AUTOTASK_SECRET = 'leak';
  t.after(() => { delete process.env.DEV_AUTOTASK_SECRET; });
  assert.equal((await verify(f.config, f.main, quiet)).passed, true);
  assert.equal(fs.readFileSync(path.join(f.main, 'env'), 'utf8'), '[][1][home]\n');
  const g = fixture(t, { env: ['DEV_AUTOTASK_SECRET'], verify: ['echo "[$DEV_AUTOTASK_SECRET]" > env'] });
  assert.equal((await verify(g.config, g.main, quiet)).passed, true);
  assert.equal(fs.readFileSync(path.join(g.main, 'env'), 'utf8'), '[leak]\n');
});

test('verify stops at the first failure', async t => {
  const f = fixture(t, { verify: ['exit 3', 'touch ran'] });
  const result = await verify(f.config, f.main, quiet);
  assert.equal(result.passed, false);
  assert.deepEqual(result.results.map(r => r.command), ['true', 'exit 3']);
  assert.equal(result.results[1].code, 3);
  assert.equal(fs.existsSync(path.join(f.main, 'ran')), false);
});

test('verify fails a command that exceeds its timeout', async t => {
  const f = fixture(t, { verify: ['sleep 30'], commandTimeoutSeconds: 1 });
  const started = Date.now();
  const result = await verify(f.config, f.main, quiet);
  assert.equal(result.passed, false);
  assert.equal(result.results.at(-1).timedOut, true);
  assert.ok(Date.now() - started < 10000);
});

test('verify stops background children after a pass and after a timeout', async t => {
  // The child ignores SIGTERM, so only the SIGKILL after the grace period stops it.
  const late = '(trap "" TERM; sleep 4; touch late) &';
  const f = fixture(t, { verify: [late] });
  const g = fixture(t, { verify: [`${late} sleep 30`], commandTimeoutSeconds: 1 });
  const started = Date.now();
  const [pass, timeout] = await Promise.all([verify(f.config, f.main, quiet), verify(g.config, g.main, quiet)]);
  assert.equal(pass.passed, true);
  assert.equal(timeout.results.at(-1).timedOut, true);
  await new Promise(r => setTimeout(r, started + 5000 - Date.now()));
  assert.equal(fs.existsSync(path.join(f.main, 'late')), false);
  assert.equal(fs.existsSync(path.join(g.main, 'late')), false);
});

test('verify CLI uses the explicit config, not one found from the working directory', t => {
  const f = fixture(t, { verify: ['touch real'] });
  const decoy = fixture(t, { verify: ['touch decoy'] });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  execFileSync('node', [path.join(scripts, 'verify.mjs'), worktree, f.file, 'main'], { cwd: decoy.main, stdio: 'ignore' });
  assert.deepEqual(fs.readdirSync(worktree), ['real']);
});

test('verify CLI runs only the named repo of a multi-repo config, and requires the name', t => {
  const f = fixture(t, { verify: ['touch main'] }, []);
  rewrite(f, { ...f.raw, repos: [f.raw.repos[0], other(f.dir, 'beta', { install: 'touch install', prepare: ['touch prepare'], verify: ['touch beta'] })] });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  const cli = (...args) => execFileSync('node', [path.join(scripts, 'verify.mjs'), worktree, ...args], { cwd: f.main, stdio: 'ignore' });
  cli(f.file, 'beta');
  assert.deepEqual(fs.readdirSync(worktree).sort(), ['beta', 'install', 'prepare']);
  assert.throws(() => cli(f.file));
  assert.throws(() => cli(f.file, 'gamma'));
  assert.equal(fs.existsSync(path.join(worktree, 'main')), false);
});

test('cancelling the verify CLI stops the running command\'s children and fails', async t => {
  const f = fixture(t, { verify: ['(trap "" TERM; sleep 4; touch late) & touch started; sleep 30'] });
  const helper = spawn('node', [path.join(scripts, 'verify.mjs'), f.main, f.file, 'main'], { stdio: 'ignore' });
  const exited = new Promise(resolve => helper.on('exit', code => resolve(code)));
  const started = Date.now();
  while (!fs.existsSync(path.join(f.main, 'started'))) await new Promise(r => setTimeout(r, 50));
  helper.kill('SIGTERM');
  assert.notEqual(await exited, 0);
  await new Promise(r => setTimeout(r, started + 5000 - Date.now()));
  assert.equal(fs.existsSync(path.join(f.main, 'late')), false);
});

test('cancelling the verify CLI never starts the next command', async t => {
  const f = fixture(t, { verify: ["trap 'exit 0' TERM; touch started; sleep 30 & wait", 'touch next'] });
  const helper = spawn('node', [path.join(scripts, 'verify.mjs'), f.main, f.file, 'main'], { stdio: 'ignore' });
  const exited = new Promise(resolve => helper.on('exit', code => resolve(code)));
  while (!fs.existsSync(path.join(f.main, 'started'))) await new Promise(r => setTimeout(r, 50));
  helper.kill('SIGTERM');
  assert.notEqual(await exited, 0);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(fs.existsSync(path.join(f.main, 'next')), false);
});

test('verify CLI exits non-zero on failure', t => {
  const f = fixture(t, { verify: ['false'] });
  assert.throws(() => execFileSync('node', [path.join(scripts, 'verify.mjs'), f.main, f.file, 'main'], { stdio: 'ignore' }));
  rewrite(f, { ...f.raw, repos: [{ ...f.raw.repos[0], verify: ['true'] }] });
  execFileSync('node', [path.join(scripts, 'verify.mjs'), f.main, f.file, 'main'], { stdio: 'ignore' });
});
