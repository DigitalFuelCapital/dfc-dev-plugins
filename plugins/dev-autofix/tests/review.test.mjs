import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireLock, processStart } from '../scripts/state.mjs';
import { createRuntime, verifyReview } from '../scripts/review.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40);

function fixture(t, { detached = false } = {}) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-review-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main'), root = path.join(directory, 'runtime'), wt = path.join(root, 'repo');
  fs.mkdirSync(main); fs.mkdirSync(wt, { recursive: true });
  const config = { version: 1, worktreeRoot: root, repos: [{ name: 'repo', path: main, remote: 'owner/repo', baseBranch: 'main', prepare: ['prepare fixture'], verify: ['verify acceptance'] }] };
  const token = acquireLock(path.join(root, '.locks', 'repo-repo'), { session: 'review-test', command: 'review' }, () => ({ pid: process.pid, processStart: processStart(process.pid), executable: process.execPath }));
  const input = { number: 42, headSha: HEAD, baseSha: BASE };
  const state = { head: BASE, branch: detached ? 'HEAD' : 'user-work', dirty: '', remoteBase: BASE, remoteHead: HEAD, calls: [], runs: [], refs: new Map([['refs/heads/user-work', BASE]]), pr: { number: 42, state: 'OPEN', isCrossRepository: false, baseRefName: 'main', headRefName: 'fix/auto-20261106-fix', headRefOid: HEAD } };
  const git = (cwd, args) => {
    state.calls.push({ cwd, args });
    const command = args.join(' ');
    if (command === 'remote get-url origin') return 'https://github.com/owner/repo.git';
    if (command === 'worktree list --porcelain -z') return `worktree ${main}\0HEAD ${BASE}\0branch refs/heads/main\0\0worktree ${wt}\0HEAD ${state.head}\0${state.branch === 'HEAD' ? 'detached' : `branch refs/heads/${state.branch}`}\0\0`;
    if (command === 'rev-parse --show-toplevel') return wt;
    if (command === 'rev-parse HEAD') return state.head;
    if (command === 'rev-parse --abbrev-ref HEAD') return state.branch;
    if (command === 'status --porcelain=v1 --untracked-files=all') return state.dirty;
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return path.join(wt, '.operations', args[2]);
    if (args[0] === 'for-each-ref') return [...state.refs].filter(([ref, sha]) => sha === state.head && args.slice(3).some(prefix => ref.startsWith(prefix))).map(([ref]) => ref).join('\n');
    if (args[0] === 'check-ref-format') return '';
    if (args[0] === 'fetch') {
      if (state.fetchError) throw new Error('Fetch failed');
      for (const spec of args.slice(3)) {
        const [source, destination] = spec.split(':');
        state.refs.set(destination, source === 'refs/heads/main' ? state.remoteBase : state.remoteHead);
      }
      return '';
    }
    if (args[0] === 'rev-parse' && state.refs.has(args[1])) return state.refs.get(args[1]);
    if (args[0] === 'update-ref') { state.refs.set(args[1], args[2]); return ''; }
    if (args[0] === 'checkout') {
      assert.equal(cwd, wt, 'never switch the main checkout');
      assert.ok(!args.includes('--force') && !args.includes('-f'));
      if (state.checkoutError && args[1] === '--detach') throw new Error('Checkout failed');
      if (args[1] === '--detach') { state.branch = 'HEAD'; state.head = args[2]; }
      else { state.branch = args[1]; state.head = state.refs.get(`refs/heads/${args[1]}`); }
      return '';
    }
    throw new Error(`Unexpected Git operation: ${cwd}: ${command}`);
  };
  const runtime = {
    git,
    readPR: async () => ({ ...state.pr }),
    readBase: async () => state.remoteBase,
    run: async (command, cwd, log, timeoutMs) => {
      assert.equal(state.head, HEAD, 'commands must execute at the exact reviewed head');
      assert.equal(state.branch, 'HEAD');
      assert.equal(cwd, wt);
      state.runs.push(command);
      fs.writeFileSync(log, `Executed ${command} at ${state.head}\n`);
      if (state.onRun) await state.onRun(command);
      return { exitCode: state.exitCode ?? 0, signal: state.signal ?? null, timedOut: state.timedOut ?? false, timeoutMs };
    },
  };
  const receipt = result => path.join(root, 'review', 'records', 'validation', `repo-pr42-${result.id}.json`);
  return { directory, main, root, wt, config, token, input, state, runtime, receipt };
}

test('review retains exact objects, executes configured checks and restores the original branch', async t => {
  const f = fixture(t);
  const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.deepEqual(f.state.runs, ['prepare fixture', 'verify acceptance']);
  assert.equal(result.restoration.status, 'restored');
  assert.equal(f.state.head, BASE); assert.equal(f.state.branch, 'user-work');
  // Fetches into the shared remote-tracking ref; a clean restore leaves no private refs.
  assert.equal(f.state.refs.get('refs/remotes/origin/fix/auto-20261106-fix'), HEAD);
  assert.ok(![...f.state.refs.keys()].some(ref => ref.startsWith('refs/autofix/')));
  assert.equal(result.retainedRef, undefined);
  assert.equal(result.commands[0].timeoutMs, 600000);
  assert.equal(JSON.parse(fs.readFileSync(f.receipt(result))).status, 'passed');
  assert.ok(!f.state.calls.some(({ args }) => ['merge', 'reset', 'clean', 'stash', 'commit', 'push'].includes(args[0])));
});

test('an originally detached retained commit is restored with its original attachment', async t => {
  const f = fixture(t, { detached: true });
  const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.equal(f.state.head, BASE); assert.equal(f.state.branch, 'HEAD');
  assert.equal(result.original.branch, null);
});

test('wrong ownership, a dirty tree, wrong PR identity and moved snapshots never start checks', async t => {
  for (const scenario of ['lock', 'dirty', 'fork', 'head', 'base', 'branch']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      if (scenario === 'dirty') f.state.dirty = '?? user-work.txt';
      if (scenario === 'fork') f.state.pr.isCrossRepository = true;
      if (scenario === 'head') f.state.pr.headRefOid = NEXT;
      if (scenario === 'base') f.state.remoteBase = NEXT;
      if (scenario === 'branch') f.state.pr.headRefName = 'unrelated-feature';
      const result = await verifyReview(f.config, 'repo', scenario === 'lock' ? 'wrong-token' : f.token, f.input, f.runtime);
      assert.equal(result.status, 'failed');
      assert.equal(result.restoration.status, 'not-needed');
      assert.equal(f.state.runs.length, 0);
      assert.equal(f.state.head, BASE); assert.equal(f.state.branch, 'user-work');
      assert.ok(!f.state.calls.some(({ args }) => args[0] === 'checkout'));
    });
  }
});

test('fetch races and failed checkouts preserve the original checkout', async t => {
  for (const scenario of ['fetch-failure', 'fetch-head-moved', 'checkout-failure']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      if (scenario === 'fetch-failure') f.state.fetchError = true;
      if (scenario === 'fetch-head-moved') f.state.remoteHead = NEXT;
      if (scenario === 'checkout-failure') f.state.checkoutError = true;
      const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
      assert.equal(result.status, 'failed');
      assert.equal(f.state.head, BASE); assert.equal(f.state.branch, 'user-work');
      assert.ok(['not-needed', 'unchanged'].includes(result.restoration.status));
      assert.equal(f.state.runs.length, 0);
    });
  }
});

test('failure, timeout and interruption stop remaining checks and restore the clean original', async t => {
  for (const scenario of ['nonzero', 'timeout', 'interrupt']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      if (scenario === 'nonzero') f.state.exitCode = 7;
      if (scenario === 'timeout') f.state.timedOut = true;
      if (scenario === 'interrupt') f.state.onRun = () => { process.emit('SIGTERM'); };
      const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
      assert.equal(result.status, 'failed');
      assert.equal(result.restoration.status, 'restored');
      assert.equal(f.state.runs.length, 1);
      assert.equal(f.state.head, BASE); assert.equal(f.state.branch, 'user-work');
    });
  }
});

test('dirty output and an advanced original branch are preserved as restoration blockers', async t => {
  for (const scenario of ['dirty', 'branch-moved', 'head-changed']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      f.state.onRun = () => {
        if (scenario === 'dirty') { fs.writeFileSync(path.join(f.wt, 'unfinished.txt'), 'preserve me'); f.state.dirty = '?? unfinished.txt'; }
        if (scenario === 'branch-moved') f.state.refs.set('refs/heads/user-work', NEXT);
        if (scenario === 'head-changed') { f.state.head = NEXT; f.state.refs.set('refs/heads/test-created', NEXT); }
      };
      const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
      assert.equal(result.status, 'failed');
      assert.equal(result.restoration.status, 'failed');
      assert.equal(f.state.branch, 'HEAD');
      // The preserved detached checkout keeps a private retaining ref.
      assert.equal(f.state.refs.get(result.retainedRef), f.state.head);
      if (scenario === 'dirty') assert.equal(fs.readFileSync(path.join(f.wt, 'unfinished.txt'), 'utf8'), 'preserve me');
      assert.ok(!f.state.calls.some(({ args }) => args[0] === 'checkout' && args[1] === 'user-work'));
    });
  }
});

test('head or base movement during checks invalidates the receipt while restoring safely', async t => {
  for (const scenario of ['head', 'base']) {
    await t.test(scenario, async t => {
      const f = fixture(t);
      f.state.onRun = () => { if (scenario === 'head') f.state.pr.headRefOid = NEXT; else f.state.remoteBase = NEXT; };
      const result = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
      assert.equal(result.status, 'failed'); assert.equal(result.restoration.status, 'restored');
    });
  }
});

test('default npm install skips lifecycle scripts and writes only the shared digest cache', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.wt, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(f.wt, 'package-lock.json'), '{}\n');
  const first = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
  assert.equal(first.status, 'passed', first.error);
  assert.equal(first.commands[0].command, 'npm ci --ignore-scripts --no-audit --no-fund');
  assert.match(fs.readFileSync(path.join(f.root, 'repo.lock.sha'), 'utf8'), /^[a-f0-9]{64}\n$/);
  fs.mkdirSync(path.join(f.wt, 'node_modules'));
  const second = await verifyReview(f.config, 'repo', f.token, f.input, f.runtime);
  assert.equal(second.status, 'passed', second.error);
  assert.deepEqual(second.commands.map(item => item.phase), ['prepare', 'verify']);
  // A failed install drops the cache so a partial node_modules cannot skip the retry.
  fs.rmSync(path.join(f.wt, 'node_modules'), { recursive: true });
  f.state.exitCode = 1;
  f.state.onRun = () => fs.mkdirSync(path.join(f.wt, 'node_modules'), { recursive: true });
  assert.equal((await verifyReview(f.config, 'repo', f.token, f.input, f.runtime)).status, 'failed');
  assert.equal(fs.existsSync(path.join(f.root, 'repo.lock.sha')), false);
});

test('real Git and commands verify the exact PR bytes and restore the user branch without touching the main checkout', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-review-git-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main'), root = path.join(directory, 'runtime'), wt = path.join(root, 'repo');
  fs.mkdirSync(main); fs.mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args, input, cwd = main) => execFileSync('git', ['-C', cwd, ...args], { env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  git(['init', '--initial-branch=main']);
  git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  const commit = (source, parents = []) => {
    const blob = git(['hash-object', '-w', '--stdin'], source);
    const tree = git(['mktree'], `100644 blob ${blob}\tsource.txt\n`);
    return git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap(sha => ['-p', sha]), '-m', 'Review fixture']);
  };
  const base = commit('original branch\n'), head = commit('reviewed head\n', [base]);
  const branch = 'fix/auto-20261106-real';
  git(['update-ref', 'refs/heads/main', base]);
  git(['update-ref', `refs/heads/${branch}`, head]);
  git(['worktree', 'add', '-b', 'user-work', wt, base]);
  const config = { version: 1, worktreeRoot: root, repos: [{ name: 'repo', path: main, remote: 'owner/repo', baseBranch: 'main', verify: [String.raw`node -e 'if (require("fs").readFileSync("source.txt", "utf8") !== "reviewed head\n") process.exit(2); console.log("head verified");'`] }] };
  const token = acquireLock(path.join(root, '.locks', 'repo-repo'), { session: 'review-git-fixture', command: 'review' }, () => ({ pid: process.pid, processStart: processStart(process.pid), executable: process.execPath }));
  const runtime = createRuntime(env), execute = runtime.git;
  // Only GitHub metadata and the fetch transport are replaced. Identity guards,
  // retaining refs, detach/restore, files, command exits and logs are real.
  runtime.readPR = async () => ({ number: 42, state: 'OPEN', isCrossRepository: false, baseRefName: 'main', headRefName: branch, headRefOid: head });
  runtime.readBase = async () => git(['rev-parse', 'refs/heads/main']);
  runtime.git = (cwd, args) => execute(cwd, args[0] === 'fetch' ? args.map(arg => arg === 'origin' ? main : arg) : args);
  const input = { number: 42, headSha: head, baseSha: base };
  const result = await verifyReview(config, 'repo', token, input, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.equal(result.restoration.status, 'restored');
  assert.match(fs.readFileSync(result.commands[0].log, 'utf8'), /head verified/);
  assert.equal(git(['rev-parse', 'HEAD'], undefined, wt), base);
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD'], undefined, wt), 'user-work');
  assert.equal(fs.readFileSync(path.join(wt, 'source.txt'), 'utf8'), 'original branch\n');
  assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  assert.ok(!fs.existsSync(path.join(main, 'source.txt')));
  assert.equal(git(['for-each-ref', '--format=%(refname)', 'refs/autofix']), '');
});
