import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findConfig, loadConfig, taskPaths, createTask, showTask, setPR, addProgress, listTasks } from '../scripts/state.mjs';
import { verify } from '../scripts/verify.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');

function fixture(t, repo = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main');
  fs.mkdirSync(path.join(main, 'nested'), { recursive: true });
  const raw = { version: 1, repo: { path: main, remote: 'Owner/Repo', baseBranch: 'main', verify: ['true'], ...repo }, worktreeRoot: path.join(dir, 'runtime') };
  const file = path.join(dir, 'dev-autotask.config.json');
  fs.writeFileSync(file, JSON.stringify(raw));
  return { dir, main, raw, file, config: loadConfig(file) };
}

test('findConfig walks up from the start directory, then falls back to ~/.claude', t => {
  const f = fixture(t);
  assert.equal(findConfig(path.join(f.main, 'nested')), f.file);
  const home = path.join(f.dir, 'home'), previous = process.env.HOME;
  t.after(() => { process.env.HOME = previous; });
  process.env.HOME = home;
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-none-'));
  t.after(() => fs.rmSync(isolated, { recursive: true, force: true }));
  assert.throws(() => findConfig(isolated), /No dev-autotask.config.json/);
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.copyFileSync(f.file, path.join(home, '.claude', 'dev-autotask.config.json'));
  assert.equal(findConfig(isolated), path.join(home, '.claude', 'dev-autotask.config.json'));
});

test('loadConfig applies defaults and rejects invalid configs', t => {
  const f = fixture(t);
  assert.equal(f.config.repo.commandTimeoutSeconds, 600);
  assert.equal(f.config.root, path.join(f.dir, 'runtime'));
  const bad = (change, pattern) => {
    fs.writeFileSync(f.file, JSON.stringify({ ...f.raw, ...change, repo: { ...f.raw.repo, ...change.repo } }));
    assert.throws(() => loadConfig(f.file), pattern);
  };
  bad({ repo: { verify: [] } }, /repo.verify/);
  bad({ repo: { remote: 'not a remote' } }, /owner\/repo/);
  bad({ repo: { path: 'relative' } }, /absolute/);
  bad({ repo: { commandTimeoutSeconds: 0 } }, /1-3600/);
  bad({ worktreeRoot: 'relative' }, /worktreeRoot/);
  bad({ repo: { env: ['NOT VALID'] } }, /repo.env/);
  bad({ worktreeRoot: path.join(f.main, 'runtime') }, /outside repo.path/);
});

test('loadConfig resolves symlinks before checking worktreeRoot is outside repo.path', t => {
  const f = fixture(t);
  const link = path.join(f.dir, 'elsewhere');
  fs.symlinkSync(f.main, link);
  const write = worktreeRoot => fs.writeFileSync(f.file, JSON.stringify({ ...f.raw, worktreeRoot }));
  write(link);
  assert.throws(() => loadConfig(f.file), /outside repo.path/);
  write(path.join(link, 'not', 'yet', 'created'));
  assert.throws(() => loadConfig(f.file), /outside repo.path/);
});

test('create, show, progress and PR recording keep one task and one PR', t => {
  const f = fixture(t), { config } = f;
  assert.throws(() => taskPaths(config, 'Bad ID'), /lowercase slug/);
  const task = createTask(config, 'big-feature', 'Deliver the feature');
  assert.deepEqual(
    { ...task, plan: undefined },
    { id: 'big-feature', title: 'Deliver the feature', config: f.file, repo: 'Owner/Repo', baseBranch: 'main', branch: 'dev/autotask-big-feature', worktree: path.join(config.root, 'worktrees', 'owner/repo', 'big-feature'), pr: null, progress: [], plan: undefined },
  );
  assert.equal(task.plan, path.join(config.root, 'tasks', 'owner/repo', 'big-feature', 'plan.md'));
  assert.throws(() => createTask(config, 'big-feature', 'Again'), /already exists/);
  assert.deepEqual(listTasks(config), ['big-feature']);

  addProgress(config, 'big-feature', 'Milestone 1 done');
  assert.equal(showTask(config, 'big-feature').progress[0].note, 'Milestone 1 done');
  assert.equal(setPR(config, 'big-feature', '42').pr, 42);
  assert.equal(setPR(config, 'big-feature', 42).pr, 42);
  assert.throws(() => setPR(config, 'big-feature', 43), /keep one PR/);
  assert.throws(() => setPR(config, 'big-feature', 'x'), /positive number/);
});

test('state CLI finds the config from the working directory', t => {
  const f = fixture(t);
  const run = (...args) => JSON.parse(execFileSync('node', [path.join(scripts, 'state.mjs'), ...args], { cwd: f.main, encoding: 'utf8' }));
  assert.equal(run('create', 'cli-task', 'CLI', 'task').title, 'CLI task');
  assert.equal(run('pr', 'cli-task', '7').pr, 7);
  assert.equal(run('show', 'cli-task').pr, 7);
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
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].code, 3);
  assert.equal(fs.existsSync(path.join(f.main, 'ran')), false);
});

test('verify fails a command that exceeds its timeout', async t => {
  const f = fixture(t, { verify: ['sleep 30'], commandTimeoutSeconds: 1 });
  const started = Date.now();
  const result = await verify(f.config, f.main, quiet);
  assert.equal(result.passed, false);
  assert.equal(result.results[0].timedOut, true);
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
  assert.equal(timeout.results[0].timedOut, true);
  await new Promise(r => setTimeout(r, started + 5000 - Date.now()));
  assert.equal(fs.existsSync(path.join(f.main, 'late')), false);
  assert.equal(fs.existsSync(path.join(g.main, 'late')), false);
});

test('verify CLI uses the explicit config, not one found from the working directory', t => {
  const f = fixture(t, { verify: ['touch real'] });
  const decoy = fixture(t, { verify: ['touch decoy'] });
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-wt-'));
  t.after(() => fs.rmSync(worktree, { recursive: true, force: true }));
  execFileSync('node', [path.join(scripts, 'verify.mjs'), worktree, f.file], { cwd: decoy.main, stdio: 'ignore' });
  assert.deepEqual(fs.readdirSync(worktree), ['real']);
});

test('cancelling the verify CLI stops the running command\'s children and fails', async t => {
  const f = fixture(t, { verify: ['(trap "" TERM; sleep 4; touch late) & touch started; sleep 30'] });
  const helper = spawn('node', [path.join(scripts, 'verify.mjs'), f.main, f.file], { stdio: 'ignore' });
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
  const helper = spawn('node', [path.join(scripts, 'verify.mjs'), f.main, f.file], { stdio: 'ignore' });
  const exited = new Promise(resolve => helper.on('exit', code => resolve(code)));
  while (!fs.existsSync(path.join(f.main, 'started'))) await new Promise(r => setTimeout(r, 50));
  helper.kill('SIGTERM');
  assert.notEqual(await exited, 0);
  await new Promise(r => setTimeout(r, 1500));
  assert.equal(fs.existsSync(path.join(f.main, 'next')), false);
});

test('verify CLI exits non-zero on failure', t => {
  const f = fixture(t, { verify: ['false'] });
  assert.throws(() => execFileSync('node', [path.join(scripts, 'verify.mjs'), f.main, f.file], { stdio: 'ignore' }));
  fs.writeFileSync(f.file, JSON.stringify({ ...f.raw, repo: { ...f.raw.repo, verify: ['true'] } }));
  execFileSync('node', [path.join(scripts, 'verify.mjs'), f.main, f.file], { stdio: 'ignore' });
});
