import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validateConfig, taskPaths, writeAtomic, lockTask, requireLock, unlockTask,
  createTask, loadTask, savePlan, approvePlan, startTask, checkpoint, bindPR,
  checkWorktree, recordReview, verifyIntegration, checkMerge,
} from '../scripts/state.mjs';
import { verify } from '../scripts/verify.mjs';

const BASE = 'a'.repeat(40), HEAD = 'b'.repeat(40), NEXT = 'c'.repeat(40);
const INTEGRATION = 'd'.repeat(40), TREE = 'e'.repeat(40);

function fixture(t, id = 'large-feature') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-state-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main'), root = path.join(directory, 'runtime');
  fs.mkdirSync(main);
  const config = { version: 1, repo: { path: main, remote: 'Owner/Repo', baseBranch: 'main', verify: ['check acceptance criteria'] }, worktreeRoot: root };
  const paths = taskPaths(config, id);
  return { directory, main, root, config, paths };
}

function proposal(f) {
  const owner = lockTask(f.paths, 'state-test-session');
  const task = createTask(f.config, f.paths, owner.token, { title: 'Deliver one feature', request: 'Implement the requested feature and acceptance tests', baseSha: BASE });
  fs.writeFileSync(f.paths.plan, '# Plan\n\nAcceptance: the requested behavior works.\n');
  savePlan(f.paths, task, { baseSha: BASE });
  return { owner, task };
}

function approvedTask(f) {
  const result = proposal(f);
  approvePlan(f.paths, result.task, { planSha: result.task.planSha });
  return result;
}

// The guard is exercised against actual fixture paths and operation files. Git's
// read-only responses are explicit so these tests never touch a real checkout.
function worktree(f, task) {
  fs.mkdirSync(f.paths.worktree, { recursive: true });
  const state = { head: HEAD, branchHead: HEAD, remoteBase: BASE, parents: `${HEAD} ${BASE}`, recomputedTree: TREE, syntheticTree: TREE, attachment: task.branch, status: '', retained: true, registered: true, locked: false, origin: 'git@github.com:Owner/Repo.git', common: path.join(f.main, '.git'), top: f.paths.worktree, refs: new Map([[`refs/heads/${task.branch}`, HEAD]]), calls: [] };
  const execute = (cwd, args) => {
    state.calls.push({ cwd, args });
    const command = args.join(' ');
    if (command === 'remote get-url origin') return state.origin;
    if (command === 'worktree list --porcelain -z') return state.registered ? `worktree ${f.paths.worktree}\0HEAD ${state.head}\0branch refs/heads/${task.branch}\0${state.locked ? 'locked fixture\0' : ''}\0` : '';
    if (command === 'rev-parse --show-toplevel') return state.top;
    if (command === 'rev-parse --git-common-dir') return state.common;
    if (command === 'rev-parse HEAD') return state.head;
    if (command === 'rev-parse --abbrev-ref HEAD') return state.attachment;
    if (command.startsWith('for-each-ref ')) return state.retained ? [...state.refs].filter(([, sha]) => sha === state.head).map(([ref]) => ref).join('\n') : '';
    if (command === 'status --porcelain=v1 --untracked-files=all') return state.status;
    if (args[0] === 'rev-parse' && args[1] === '--git-path') return path.join(f.paths.worktree, '.operations', args[2]);
    if (command === `rev-parse refs/dev-autotask/${task.id}/fixture`) return INTEGRATION;
    if (command === `rev-parse ${INTEGRATION}^{tree}`) return state.syntheticTree;
    if (command === `rev-parse refs/heads/${task.branch}`) return state.branchHead;
    if (command === 'rev-parse refs/remotes/origin/main') return state.remoteBase;
    if (command === 'check-ref-format refs/heads/main') return '';
    if (command === 'ls-remote --exit-code --refs origin refs/heads/main') return `${state.remoteBase}\trefs/heads/main`;
    if (command === `merge-tree --write-tree ${HEAD} ${BASE}`) return state.recomputedTree;
    if (command === `show -s --format=%P ${INTEGRATION}`) return state.parents;
    if (args[0] === 'fetch') {
      if (state.fetchError) throw new Error('Fixture fetch failed');
      assert.deepEqual(args, ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
      return '';
    }
    if (args[0] === '-c' && args[2] === 'commit-tree') {
      assert.deepEqual(args, ['-c', 'commit.gpgsign=false', 'commit-tree', TREE, '-p', HEAD, '-p', BASE, '-m', `Dev autotask local verification ${task.id}`]);
      return INTEGRATION;
    }
    if (args[0] === 'update-ref') {
      assert.ok(args[1].startsWith(`refs/dev-autotask/${task.id}/`));
      assert.equal(args[2], INTEGRATION);
      assert.equal(args[3], '0'.repeat(40));
      assert.ok(!state.refs.has(args[1]));
      state.refs.set(args[1], args[2]);
      return '';
    }
    if (args[0] === 'checkout') {
      if (args[1] === '--detach') {
        assert.equal(args[2], INTEGRATION);
        assert.ok([...state.refs.values()].includes(INTEGRATION), 'Retain the synthetic commit before checkout');
        state.head = INTEGRATION;
        state.attachment = 'HEAD';
      } else {
        assert.deepEqual(args, ['checkout', task.branch]);
        state.head = state.branchHead;
        state.attachment = task.branch;
      }
      return '';
    }
    throw new Error(`Unexpected fixture Git command: ${cwd}: ${command}`);
  };
  return { state, execute };
}

async function receipt(f, task, w, head = HEAD) {
  const previous = w.state.head;
  w.state.head = head;
  try {
    const result = await verify(f.config, f.paths, task, {
      git: w.execute,
      run: async (command, options) => {
        fs.writeFileSync(options.log, `Executed fixture acceptance check: ${command}\n`);
        return { exitCode: 0, signal: null, timedOut: false, timeoutMs: options.timeoutMs };
      },
    });
    assert.equal(result.status, 'passed');
  } finally { w.state.head = previous; }
}

test('config rejects missing checks, relative or overlapping roots, and escaping lockfiles', t => {
  const f = fixture(t);
  assert.equal(validateConfig(f.config), f.config);
  const config = changes => ({ ...f.config, ...changes });
  const repo = changes => config({ repo: { ...f.config.repo, ...changes } });
  for (const verify of [undefined, [], [''], ['  ']]) assert.throws(() => validateConfig(repo({ verify })), /verify/);
  assert.throws(() => validateConfig(repo({ path: 'relative' })), /absolute/);
  assert.throws(() => validateConfig(config({ worktreeRoot: 'relative' })), /absolute/);
  assert.throws(() => validateConfig(config({ worktreeRoot: f.main })), /separate/);
  assert.throws(() => validateConfig(config({ worktreeRoot: path.join(f.main, 'nested') })), /separate/);
  assert.throws(() => validateConfig(config({ worktreeRoot: f.directory })), /separate/);
  for (const lockfile of ['/outside/package-lock.json', '../package-lock.json', 'nested/../../lock', '..\\package-lock.json']) assert.throws(() => validateConfig(repo({ lockfile })), /inside/);
  for (const seconds of [0, 3601, 1.5]) assert.throws(() => validateConfig(repo({ commandTimeoutSeconds: seconds })), /commandTimeoutSeconds/);
});

test('task paths reject traversal IDs and remote path segments', t => {
  const f = fixture(t);
  assert.equal(f.paths.branch, 'dev/autotask-large-feature');
  assert.equal(f.paths.taskDir, path.join(f.root, 'tasks', 'owner', 'repo', 'large-feature'));
  assert.notEqual(taskPaths(f.config, 'other-feature').worktree, f.paths.worktree);
  for (const id of ['../escape', '..', 'Uppercase', 'nested/id', 'x'.repeat(65), '']) assert.throws(() => taskPaths(f.config, id), /Task ID/);
  for (const remote of ['../..', '../repo', 'owner/..', './repo', 'owner/.']) assert.throws(() => taskPaths({ ...f.config, repo: { ...f.config.repo, remote } }, 'safe-id'), /remote|path|separate/i);
});

test('canonical checks reject roots inside a symlinked main and symlinked managed paths', t => {
  const f = fixture(t);
  const alias = path.join(f.directory, 'main-alias');
  fs.symlinkSync(f.main, alias, 'dir');
  assert.throws(() => validateConfig({ ...f.config, worktreeRoot: path.join(alias, 'runtime') }), /separate/);
  const escape = path.join(f.directory, 'escape');
  fs.mkdirSync(escape);
  fs.mkdirSync(f.root);
  fs.symlinkSync(escape, path.join(f.root, 'tasks'), 'dir');
  assert.throws(() => taskPaths(f.config, 'escaped-task'), /symlink/);
  fs.unlinkSync(path.join(f.root, 'tasks'));
  fs.symlinkSync(escape, path.join(f.root, 'worktrees'), 'dir');
  assert.throws(() => taskPaths(f.config, 'escaped-task'), /symlink/);
});

test('exclusive writes and task creation preserve existing records; locks reject other owners', t => {
  const f = fixture(t);
  const target = path.join(f.directory, 'record.json');
  writeAtomic(target, { original: true }, true);
  assert.throws(() => writeAtomic(target, { replacement: true }, true), /EEXIST/);
  assert.deepEqual(JSON.parse(fs.readFileSync(target)), { original: true });
  const { task, owner } = proposal(f);
  assert.throws(() => lockTask(f.paths, 'other-session'), /locked/);
  assert.throws(() => requireLock(f.paths, 'wrong-token'), /ownership/);
  assert.throws(() => unlockTask(f.paths, 'wrong-token'), /ownership/);
  assert.ok(fs.existsSync(path.join(f.paths.lock, 'owner.json')));
  assert.throws(() => createTask(f.config, f.paths, owner.token, { title: 'Replacement', request: 'Different task', baseSha: BASE }), /EEXIST/);
  assert.equal(loadTask(f.config, f.paths).request, task.request);
  unlockTask(f.paths, owner.token);
  assert.ok(!fs.existsSync(f.paths.lock));
  const next = lockTask(f.paths, 'next-session');
  assert.notEqual(next.token, owner.token);
  unlockTask(f.paths, next.token);
});

test('plan approval binds exact bytes and revising the plan clears approval and review evidence', t => {
  const f = fixture(t), { task } = proposal(f);
  assert.throws(() => startTask(f.paths, task), /approval/);
  assert.throws(() => approvePlan(f.paths, task, { planSha: NEXT }), /unchanged/);
  approvePlan(f.paths, task, { planSha: task.planSha });
  startTask(f.paths, task);
  assert.equal(task.phase, 'implementing');
  fs.appendFileSync(f.paths.plan, '\nChanged acceptance criterion.\n');
  assert.throws(() => startTask(f.paths, task), /approval/);
  task.review = { outcome: 'clean', headSha: HEAD };
  task.integration = { headSha: HEAD, baseSha: BASE };
  savePlan(f.paths, task, { baseSha: NEXT });
  assert.equal(task.approvedPlanSha, null);
  assert.equal(task.review, null);
  assert.equal(task.integration, null);
  assert.equal(task.phase, 'planned');
  assert.throws(() => startTask(f.paths, task), /approval/);
  approvePlan(f.paths, task, { planSha: task.planSha });
  assert.equal(task.approvedPlanSha, task.planSha);
});

test('checkpoints resume the same task and PR binding cannot replace its PR', t => {
  const f = fixture(t), { task } = approvedTask(f);
  startTask(f.paths, task);
  checkpoint(f.paths, task, { summary: 'Milestone one implemented; acceptance checks next' });
  const resumed = loadTask(f.config, f.paths);
  assert.equal(resumed.id, task.id);
  assert.equal(resumed.progress.length, 1);
  assert.equal(resumed.progress[0].summary, task.progress[0].summary);
  const pr = { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD };
  bindPR(f.paths, resumed, pr);
  resumed.review = { outcome: 'clean' };
  resumed.integration = { headSha: HEAD };
  bindPR(f.paths, resumed, { ...pr, headSha: NEXT });
  assert.equal(resumed.pr.number, 42);
  assert.equal(resumed.pr.headSha, NEXT);
  assert.equal(resumed.review, null);
  assert.equal(resumed.integration, null);
  assert.throws(() => bindPR(f.paths, resumed, { ...pr, number: 43, url: 'https://github.com/Owner/Repo/pull/43' }), /existing task PR/);
  assert.throws(() => bindPR(f.paths, resumed, { ...pr, url: 'https://github.com/Other/Repo/pull/42' }), /PR identity/);
  assert.throws(() => loadTask({ ...f.config, repo: { ...f.config.repo, baseBranch: 'staging' } }, f.paths), /identity/);
});

test('worktree guard rejects wrong repository, unregistered trees, unfinished work and lost refs', t => {
  const f = fixture(t), { task } = approvedTask(f), w = worktree(f, task);
  assert.equal(checkWorktree(f.config, f.paths, task, { headSha: HEAD, execute: w.execute }), HEAD);
  for (const [key, value, expected] of [
    ['origin', 'git@github.com:Other/Repo.git', /Origin/],
    ['registered', false, /unregistered/],
    ['locked', true, /locked/],
    ['status', '?? unfinished.txt', /unfinished/],
    ['attachment', 'unrelated-branch', /attachment/],
    ['retained', false, /retaining/],
    ['head', NEXT, /HEAD changed/],
  ]) {
    const original = w.state[key];
    w.state[key] = value;
    assert.throws(() => checkWorktree(f.config, f.paths, task, { headSha: HEAD, execute: w.execute }), expected);
    w.state[key] = original;
  }
  w.state.status = ' M ongoing.txt';
  assert.equal(checkWorktree(f.config, f.paths, task, { clean: false, execute: w.execute }), HEAD);
  w.state.status = '';
  const operation = path.join(f.paths.worktree, '.operations', 'MERGE_HEAD');
  fs.mkdirSync(path.dirname(operation));
  fs.writeFileSync(operation, BASE);
  assert.throws(() => checkWorktree(f.config, f.paths, task, { execute: w.execute }), /Active Git operation/);
});

test('reviews reject stale input or checkout heads and clean outcomes require executed verification', async t => {
  const f = fixture(t), { task } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  const input = { headSha: HEAD, baseSha: BASE, outcome: 'clean', report: 'Every acceptance criterion was checked.', findings: [] };
  assert.throws(() => recordReview(f.config, f.paths, task, { ...input, headSha: NEXT }, w.execute), /current task PR head/);
  w.state.head = NEXT;
  assert.throws(() => recordReview(f.config, f.paths, task, input, w.execute), /HEAD changed/);
  w.state.head = HEAD;
  assert.throws(() => recordReview(f.config, f.paths, task, { ...input, findings: ['Unresolved defect'] }, w.execute), /unresolved findings/);
  assert.throws(() => recordReview(f.config, f.paths, task, input, w.execute), /ENOENT|Verification/);
  await receipt(f, task, w);
  recordReview(f.config, f.paths, task, input, w.execute);
  assert.equal(loadTask(f.config, f.paths).review.headSha, HEAD);
  assert.equal(task.phase, 'reviewed');
});

test('merge gate requires explicit intent, a clean current review and matching verified integration', async t => {
  const f = fixture(t), { task } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  const input = { number: 42, headSha: HEAD, baseSha: BASE, mergeRequested: true };
  assert.throws(() => checkMerge(f.config, f.paths, task, { ...input, mergeRequested: false }, w.execute), /explicit/);
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /clean review/);
  task.review = { outcome: 'clean', headSha: NEXT };
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /clean review/);
  task.review = { outcome: 'findings', headSha: HEAD };
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /clean review/);
  task.review = { outcome: 'clean', headSha: HEAD };
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /integration/);
  task.integration = { headSha: HEAD, baseSha: NEXT, commitSha: INTEGRATION, treeSha: TREE, ref: `refs/dev-autotask/${task.id}/fixture` };
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /integration/);
  task.integration.baseSha = BASE;
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /ENOENT|Verification/);
  await receipt(f, task, w, INTEGRATION);
  assert.deepEqual(checkMerge(f.config, f.paths, task, input, w.execute), { number: 42, approvedHead: HEAD, baseSha: BASE });
  w.state.remoteBase = NEXT;
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /Remote base moved/);
  w.state.remoteBase = BASE;
  w.state.parents = `${HEAD} ${NEXT}`;
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /parents changed/);
  w.state.parents = `${HEAD} ${BASE}`;
  w.state.recomputedTree = NEXT;
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /matches the head and base/);
  w.state.recomputedTree = TREE;
  w.state.syntheticTree = NEXT;
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /ref or tree changed/);
  w.state.syntheticTree = TREE;
  assert.throws(() => checkMerge(f.config, f.paths, task, { ...input, headSha: NEXT }, w.execute), /PR identity/);
  f.config.repo.verify.push('additional acceptance check');
  assert.throws(() => checkMerge(f.config, f.paths, task, input, w.execute), /configuration changed/);
});

test('integration verifies a retained synthetic commit and restores the original task branch', async t => {
  const f = fixture(t), { task, owner } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  task.review = { outcome: 'clean', headSha: HEAD };
  let verified = false;
  const integration = await verifyIntegration(f.config, f.paths, task, owner.token, {
    execute: w.execute,
    runVerify: async () => {
      assert.equal(w.state.head, INTEGRATION);
      assert.equal(w.state.attachment, 'HEAD');
      assert.ok([...w.state.refs].some(([ref, sha]) => ref.startsWith('refs/dev-autotask/') && sha === INTEGRATION));
      await receipt(f, task, w, INTEGRATION);
      verified = true;
      return JSON.parse(fs.readFileSync(path.join(f.paths.taskDir, 'verification.json')));
    },
  });
  assert.ok(verified);
  assert.equal(integration.headSha, HEAD);
  assert.equal(integration.baseSha, BASE);
  assert.equal(integration.commitSha, INTEGRATION);
  assert.equal(integration.treeSha, TREE);
  assert.equal(w.state.refs.get(integration.ref), INTEGRATION);
  assert.equal(w.state.head, HEAD);
  assert.equal(w.state.attachment, task.branch);
  assert.equal(loadTask(f.config, f.paths).integration.commitSha, INTEGRATION);
  const checkouts = w.state.calls.filter(call => call.args[0] === 'checkout').map(call => call.args);
  assert.deepEqual(checkouts, [['checkout', '--detach', INTEGRATION], ['checkout', task.branch]]);
});

test('failed clean integration restores the task branch and leaves no passing integration', async t => {
  const f = fixture(t), { task, owner } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  task.review = { outcome: 'clean', headSha: HEAD };
  await assert.rejects(verifyIntegration(f.config, f.paths, task, owner.token, {
    execute: w.execute,
    runVerify: async () => ({ status: 'failed', error: 'Fixture acceptance check failed' }),
  }), /Fixture acceptance check failed/);
  assert.equal(w.state.head, HEAD);
  assert.equal(w.state.attachment, task.branch);
  assert.equal(task.integration, null);
  assert.equal(loadTask(f.config, f.paths).integration, null);
  assert.ok([...w.state.refs.values()].includes(INTEGRATION), 'Preserve the failed synthetic commit for inspection');
});

test('dirty integration failure preserves detached output instead of discarding it to restore', async t => {
  const f = fixture(t), { task, owner } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  task.review = { outcome: 'clean', headSha: HEAD };
  const artifact = path.join(f.paths.worktree, 'unfinished.txt');
  await assert.rejects(verifyIntegration(f.config, f.paths, task, owner.token, {
    execute: w.execute,
    runVerify: async () => {
      fs.writeFileSync(artifact, 'Preserve this failed verification output.\n');
      w.state.status = '?? unfinished.txt';
      return { status: 'failed', error: 'Fixture verification left output' };
    },
  }), /unfinished changes/);
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'Preserve this failed verification output.\n');
  assert.equal(w.state.head, INTEGRATION);
  assert.equal(w.state.attachment, 'HEAD');
  assert.equal(task.integration, null);
  assert.ok(!w.state.calls.some(call => call.args[0] === 'checkout' && call.args[1] === task.branch));
});

test('a new integration attempt invalidates old evidence before a failed remote fetch', async t => {
  const f = fixture(t), { task, owner } = approvedTask(f), w = worktree(f, task);
  bindPR(f.paths, task, { number: 42, url: 'https://github.com/Owner/Repo/pull/42', headSha: HEAD });
  task.review = { outcome: 'clean', headSha: HEAD };
  task.integration = { headSha: HEAD, baseSha: BASE, commitSha: INTEGRATION, treeSha: TREE };
  checkpoint(f.paths, task, { summary: 'Previous integration receipt present' });
  assert.ok(loadTask(f.config, f.paths).integration);
  w.state.fetchError = true;
  await assert.rejects(verifyIntegration(f.config, f.paths, task, owner.token, {
    execute: w.execute,
    runVerify: async () => { throw new Error('Verification must not run after fetch failure'); },
  }), /Fixture fetch failed/);
  assert.equal(task.integration, null);
  assert.equal(loadTask(f.config, f.paths).integration, null);
  assert.equal(w.state.head, HEAD);
  assert.equal(w.state.attachment, task.branch);
  assert.ok(!w.state.calls.some(call => call.args[0] === 'checkout'));
});
