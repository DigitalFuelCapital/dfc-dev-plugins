import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, verify, readVerified } from '../scripts/verify.mjs';

const head = 'a'.repeat(40);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-verify-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const paths = { worktree: path.join(directory, 'worktree'), taskDir: path.join(directory, 'task') };
  fs.mkdirSync(paths.worktree); fs.mkdirSync(paths.taskDir);
  const state = { head, dirty: false, operation: null };
  const calls = [];
  const git = (_cwd, args) => {
    if (args[0] === 'status') return state.dirty ? '?? unfinished.txt' : '';
    if (args[1] === '--git-path') return path.join(directory, args[2]);
    if (args[1] === 'HEAD') return state.head;
    throw new Error(`Unexpected git call: ${args}`);
  };
  const run = async (command, { log, timeoutMs }) => {
    calls.push(command);
    fs.writeFileSync(log, `ran ${command}\n`, { flag: 'wx' });
    return { exitCode: 0, signal: null, timedOut: false, timeoutMs };
  };
  const config = { repo: { prepare: ['generate-types'], verify: ['lint', 'test'], commandTimeoutSeconds: 2 } };
  return { directory, paths, state, calls, git, run, config, task: { id: 'large-feature' } };
}

test('verification records ordered preparation and checks at one exact commit', async t => {
  const f = fixture(t);
  const result = await verify(f.config, f.paths, f.task, f);
  assert.equal(result.status, 'passed');
  assert.deepEqual(f.calls, ['generate-types', 'lint', 'test']);
  assert.equal(readVerified(f.paths, head, f.config.repo).headSha, head);
  assert.ok(result.commands.every(item => item.timeoutMs === 2000));
});

test('failed and timed-out checks stop later checks and replace earlier passing evidence', async t => {
  const f = fixture(t);
  await verify(f.config, f.paths, f.task, f);
  for (const outcome of [{ exitCode: 1, signal: null, timedOut: false }, { exitCode: 0, signal: null, timedOut: true }]) {
    f.calls.length = 0;
    const run = async (command, options) => {
      const result = await f.run(command, options);
      return { ...result, ...outcome };
    };
    const result = await verify(f.config, f.paths, f.task, { git: f.git, run });
    assert.equal(result.status, 'failed');
    assert.deepEqual(f.calls, ['generate-types']);
    assert.throws(() => readVerified(f.paths, head, f.config.repo), /did not pass/);
  }
});

test('changed head, commands, deadlines and log contents invalidate a receipt', async t => {
  const f = fixture(t);
  const result = await verify(f.config, f.paths, f.task, f);
  assert.throws(() => readVerified(f.paths, 'b'.repeat(40), f.config.repo), /current head/);
  assert.throws(() => readVerified(f.paths, head, { ...f.config.repo, verify: ['lint'] }), /configuration changed/);
  assert.throws(() => readVerified(f.paths, head, { ...f.config.repo, commandTimeoutSeconds: 3 }), /configuration changed/);
  fs.appendFileSync(result.commands[0].log, 'altered');
  assert.throws(() => readVerified(f.paths, head, f.config.repo), /log changed/);
});

test('dirty output, changed HEAD and active Git operations cannot pass verification', async t => {
  for (const change of ['dirty', 'head', 'operation']) {
    const f = fixture(t);
    if (change === 'operation') {
      fs.writeFileSync(path.join(f.directory, 'MERGE_HEAD'), head);
      await assert.rejects(verify(f.config, f.paths, f.task, f), /active MERGE_HEAD/);
      assert.deepEqual(f.calls, []);
      continue;
    }
    const run = async (command, options) => {
      const result = await f.run(command, options);
      if (change === 'dirty') f.state.dirty = true;
      else f.state.head = 'b'.repeat(40);
      return result;
    };
    const result = await verify(f.config, f.paths, f.task, { git: f.git, run });
    assert.equal(result.status, 'failed');
    assert.match(result.error, change === 'dirty' ? /clean worktree/ : /changed HEAD/);
  }
});

test('default npm installation disables lifecycle scripts and caches only the lock digest', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.paths.worktree, 'package.json'), '{}');
  fs.writeFileSync(path.join(f.paths.worktree, 'package-lock.json'), '{"lockfileVersion":3}');
  const result = await verify(f.config, f.paths, f.task, f);
  assert.equal(result.status, 'passed');
  assert.equal(f.calls[0], 'npm ci --ignore-scripts --no-audit --no-fund');
  assert.match(fs.readFileSync(path.join(f.paths.taskDir, 'dependency.sha'), 'utf8'), /^[a-f0-9]{64}\n$/);
  fs.mkdirSync(path.join(f.paths.worktree, 'node_modules'));
  f.calls.length = 0;
  await verify(f.config, f.paths, f.task, f);
  assert.deepEqual(f.calls, ['generate-types', 'lint', 'test']);
  fs.appendFileSync(path.join(f.paths.worktree, 'package-lock.json'), '\n');
  f.calls.length = 0;
  await verify(f.config, f.paths, f.task, f);
  assert.match(f.calls[0], /npm ci/);
});

test('verification rejects lockfiles outside the worktree, including symlink escapes', async t => {
  for (const kind of ['traversal', 'symlink']) {
    const f = fixture(t);
    const outside = path.join(f.directory, 'outside-lock.json');
    fs.writeFileSync(outside, '{}');
    if (kind === 'traversal') f.config.repo.lockfile = '../outside-lock.json';
    else fs.symlinkSync(outside, path.join(f.paths.worktree, 'package-lock.json'));
    const result = await verify(f.config, f.paths, f.task, f);
    assert.equal(result.status, 'failed');
    assert.match(result.error, /escapes the worktree/);
    assert.deepEqual(f.calls, []);
  }
});

test('runner writes CI output and refuses to overwrite an existing log', async t => {
  const f = fixture(t);
  const log = path.join(f.directory, 'command.log');
  const result = await runCommand('printf "$CI"', { cwd: f.paths.worktree, log, timeoutMs: 5000 });
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.match(fs.readFileSync(log, 'utf8'), /^1/);
  await assert.rejects(runCommand('true', { cwd: f.paths.worktree, log, timeoutMs: 5000 }), /EEXIST/);
});

test('a command that traps termination and exits zero still fails its timeout', async t => {
  const f = fixture(t);
  const log = path.join(f.directory, 'timeout.log');
  const result = await runCommand("trap 'exit 0' TERM; while :; do sleep 1; done", { cwd: f.paths.worktree, log, timeoutMs: 100 });
  assert.equal(result.timedOut, true);
  assert.match(fs.readFileSync(log, 'utf8'), /timed out/);
});

test('runner stops background children that ignore TERM before returning', async t => {
  const f = fixture(t);
  const marker = path.join(f.directory, 'child-survived');
  const ready = path.join(f.directory, 'child-ready');
  const script = `process.on('SIGTERM',()=>{});require('fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'unexpected'),3200)`;
  const command = `${quote(process.execPath)} -e ${quote(script)} & while [ ! -f ${quote(ready)} ]; do sleep 0.01; done; exit 0`;
  const result = await runCommand(command, { cwd: f.paths.worktree, log: path.join(f.directory, 'background.log'), timeoutMs: 10000 });
  assert.equal(result.exitCode, 0);
  await delay(1400);
  assert.equal(fs.existsSync(marker), false, 'background child continued after verification returned');
});
