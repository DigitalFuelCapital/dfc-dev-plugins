import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireLock, checkWorktree, quarantineWorktree, listRecovery, processStart } from '../scripts/state.mjs';
import { createRuntime, verifyMerge, checkVerifiedMerge, releaseVerification, waitForMergeability } from '../scripts/merge.mjs';

// All Git writes are confined to disposable fixtures; never use the project index.
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-workflow-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main'), root = path.join(dir, 'worktrees');
  fs.mkdirSync(main);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (args, input, cwd = main) => execFileSync('git', ['-C', cwd, ...args], { input, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  git(['init', '--initial-branch=staging']);
  git(['remote', 'add', 'origin', 'https://user@github.com/OWNER/Repo.git/']);
  const commit = (files, parents = []) => {
    const entries = Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, body]) => `100644 blob ${git(['hash-object', '-w', '--stdin'], body)}\t${name}\n`).join('');
    const tree = git(['mktree'], entries);
    return git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, ...parents.flatMap(sha => ['-p', sha]), '-m', 'Fixture']);
  };
  const files = { '.gitignore': 'ignored.txt\nnode_modules/\n', 'base.txt': 'initial\n' };
  const base = commit(files);
  git(['update-ref', 'refs/heads/staging', base]);
  git(['update-ref', 'refs/remotes/origin/staging', base]);
  const config = { version: 1, worktreeRoot: root, repos: [{ name: 'repo', path: main, remote: 'owner/repo', baseBranch: 'staging', verify: ["node -e \"if (!require('fs').existsSync('base.txt')) process.exit(1)\""] }] };
  const token = acquireLock(path.join(root, '.locks/repo-repo'), { session: 'fixture', command: 'test' }, () => ({ pid: process.pid, processStart: processStart(process.pid), executable: process.execPath }));
  const wt = path.join(root, 'repo');
  git(['worktree', 'add', '--detach', wt, base]);
  return { main, root, wt, config, token, git, commit, base, files, env };
}

function approved(number, headSha) {
  return {
    remote: 'owner/repo', number, headSha, headRef: `fix/auto-${number}`, reviewers: ['reviewer'],
    pending: [{ kind: 'review', author: 'reviewer', body: 'LGTM', state: 'APPROVED', commitSha: headSha, url: `https://github.com/owner/repo/pull/${number}#pullrequestreview-${number}` }],
  };
}

function simulation(f, approval, baseSha) {
  const pr = { number: approval.number, state: 'OPEN', isCrossRepository: false, headRefName: approval.headRef, headRefOid: approval.headSha, baseRefName: 'staging', baseRefOid: baseSha, mergeable: 'MERGEABLE' };
  const runtime = createRuntime(f.env);
  f.git(['update-ref', 'refs/heads/staging', baseSha]);
  runtime.readBase = repo => f.git(['ls-remote', '--exit-code', '--refs', f.main, `refs/heads/${repo.baseBranch}`]).split('\t')[0];
  runtime.readPR = async () => ({ ...pr });
  // Only the network boundary is replaced: real Git and configured commands still run.
  runtime.fetch = async () => {
    f.git(['update-ref', `refs/remotes/origin/${approval.headRef}`, approval.headSha]);
    f.git(['update-ref', 'refs/remotes/origin/staging', runtime.readBase(f.config.repos[0])]);
  };
  return { runtime, pr };
}

test('verification helper executes five PR integrations against successive bases, without changing heads', async t => {
  const f = fixture(t);
  const heads = Array.from({ length: 5 }, (_, i) => f.commit({ ...f.files, [`fix${i}.txt`]: `fix ${i}\n` }, [f.base]));
  let base = f.base, files = { ...f.files };
  for (const [i, head] of heads.entries()) {
    const approval = approved(i + 1, head);
    f.git(['update-ref', `refs/heads/${approval.headRef}`, head]);
    files[`fix${i}.txt`] = `fix ${i}\n`;
    // The actual verification command checks the entire cumulative integration contents.
    const expected = JSON.stringify(files);
    f.config.repos[0].verify = [`node -e 'const fs=require("fs"); for (const [p,v] of Object.entries(${expected})) if(fs.readFileSync(p,"utf8")!==v) process.exit(1); console.log("verified integration");'`];
    const { runtime, pr } = simulation(f, approval, base);
    const result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
    assert.equal(result.status, 'passed', result.error);
    assert.equal(result.commands[0].exitCode, 0);
    assert.match(fs.readFileSync(result.commands[0].log, 'utf8'), /verified integration/);
    assert.equal(f.git(['show', '-s', '--format=%G?', result.commitSha]), 'N');
    assert.equal(f.git(['for-each-ref', '--format=%(refname)', 'refs/heads/autofix-verify']), '');
    assert.equal(f.git(['rev-parse', result.ref]), result.commitSha);
    assert.equal(f.git(['rev-parse', 'HEAD'], undefined, f.wt), head);
    let polls = 0;
    runtime.readPR = async () => ({ ...pr, mergeable: ++polls < 3 ? 'UNKNOWN' : 'MERGEABLE' });
    runtime.sleep = async () => {};
    assert.equal((await checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime)).approvedHead, head);
    assert.equal(polls, 3);
    const advanced = f.commit(files, [base]);
    pr.baseRefOid = advanced;
    f.git(['update-ref', 'refs/heads/staging', advanced]);
    await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime), /changed since verification/);
    assert.equal(f.git(['rev-parse', `refs/heads/${approval.headRef}`]), head);
    releaseVerification(f.config, 'repo', f.token, result.id, runtime);
    assert.equal(f.git(['for-each-ref', '--format=%(refname)', result.ref]), '');
    base = advanced;
    f.git(['update-ref', 'refs/heads/staging', base]);
  }
});

test('helper conflicts and failed commands cannot produce accepted verification evidence', async t => {
  const f = fixture(t);
  const head = f.commit({ ...f.files, 'base.txt': 'PR change\n' }, [f.base]);
  const base = f.commit({ ...f.files, 'base.txt': 'base change\n' }, [f.base]);
  const approval = approved(1, head);
  const { runtime, pr } = simulation(f, approval, base);
  const conflict = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(conflict.status, 'conflict');
  assert.equal(f.git(['rev-parse', 'HEAD'], undefined, f.wt), f.base);
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, conflict.id, runtime), /did not pass/);
  pr.baseRefOid = f.base;
  f.git(['update-ref', 'refs/heads/staging', f.base]);
  f.config.repos[0].verify = ['node -e "console.log(123);process.exit(7)"'];
  const failed = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.commands[0].exitCode, 7);
  assert.match(fs.readFileSync(failed.commands[0].log, 'utf8'), /123/);
  // Private verification refs retain the failed HEAD without polluting branches.
  assert.equal(checkWorktree(f.config, 'repo', f.token, runtime.git).headSha, failed.commitSha);
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, failed.id, runtime), /did not pass/);
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, { passed: true }, runtime), /verification ID/);
});

test('verification detects dirty outputs, changed commands, and modified execution logs', async t => {
  const f = fixture(t), approval = approved(1, f.base);
  const { runtime } = simulation(f, approval, f.base);
  let result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  fs.appendFileSync(result.commands[0].log, 'altered');
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime), /log changed/);
  f.config.repos[0].verify = ['node -e "require(\'fs\').writeFileSync(\'unfinished.txt\',\'kept\')"'];
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime), /commands changed/);
  result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'failed');
  assert.match(result.error, /unfinished/);
  assert.equal(fs.readFileSync(path.join(f.wt, 'unfinished.txt'), 'utf8'), 'kept');
});

test('mergeability polling is bounded and never retries known conflicts', async () => {
  let reads = 0, sleeps = 0;
  await assert.rejects(waitForMergeability(async () => { reads++; return { state: 'OPEN', mergeable: 'UNKNOWN' }; }, async () => { sleeps++; }, 3, 0), /bounded polling/);
  assert.equal(reads, 3); assert.equal(sleeps, 2);
  const conflict = await waitForMergeability(async () => ({ state: 'OPEN', mergeable: 'CONFLICTING' }), async () => { throw new Error('must not wait'); });
  assert.equal(conflict.mergeable, 'CONFLICTING');
});

test('failed worker quarantine preserves files and index, then permits a fresh managed tree', t => {
  const f = fixture(t);
  const indexPath = f.git(['rev-parse', '--git-path', 'index'], undefined, f.wt);
  const index = fs.readFileSync(indexPath);
  fs.writeFileSync(path.join(f.wt, 'base.txt'), 'unfinished tracked edit\n');
  fs.writeFileSync(path.join(f.wt, 'unfinished.txt'), 'untracked artifact');
  fs.writeFileSync(path.join(f.wt, 'ignored.txt'), 'ignored artifact');
  assert.throws(() => checkWorktree(f.config, 'repo', f.token), /unfinished/);
  const failure = { headSha: f.base, workersStopped: true, reason: 'scope problem' };
  assert.throws(() => quarantineWorktree(f.config, 'repo', f.token, { ...failure, headSha: '0'.repeat(40) }), /HEAD changed/);
  assert.throws(() => quarantineWorktree(f.config, 'repo', f.token, { ...failure, workersStopped: false }), /stopped workers/);
  const moved = quarantineWorktree(f.config, 'repo', f.token, failure);
  assert.equal(fs.readFileSync(path.join(moved.destination, 'base.txt'), 'utf8'), 'unfinished tracked edit\n');
  assert.equal(fs.readFileSync(path.join(moved.destination, 'unfinished.txt'), 'utf8'), 'untracked artifact');
  assert.equal(fs.readFileSync(path.join(moved.destination, 'ignored.txt'), 'utf8'), 'ignored artifact');
  assert.deepEqual(fs.readFileSync(indexPath), index);
  assert.equal(JSON.parse(fs.readFileSync(moved.receipt)).status, 'moved');
  const usage = listRecovery(f.config);
  assert.equal(usage.entries[0].path, moved.destination);
  assert.equal(usage.entries[0].reason, failure.reason);
  assert.ok(usage.allocatedBytes > 0);
  assert.equal(fs.readFileSync(path.join(moved.destination, 'ignored.txt'), 'utf8'), 'ignored artifact');
  assert.deepEqual(checkWorktree(f.config, 'repo', f.token), { path: f.wt, exists: false, registered: false });
  f.git(['worktree', 'add', '--detach', f.wt, f.base]);
  assert.equal(checkWorktree(f.config, 'repo', f.token).headSha, f.base);
});

test('deleted tree registrations can be pruned while locked missing trees remain preserved', t => {
  const f = fixture(t);
  const absent = path.join(f.root, 'absent');
  f.git(['worktree', 'add', '--detach', absent, f.base]);
  f.git(['worktree', 'lock', '--reason', 'external volume', absent]);
  fs.rmSync(absent, { recursive: true });
  // A stale unrelated path must not make realpath throw for the valid shared tree.
  assert.equal(checkWorktree(f.config, 'repo', f.token).headSha, f.base);
  fs.rmSync(f.wt, { recursive: true });
  assert.equal(checkWorktree(f.config, 'repo', f.token).registered, true);
  f.git(['worktree', 'prune', '--dry-run', '--verbose', '--expire', 'now']);
  f.git(['worktree', 'prune', '--verbose', '--expire', 'now']);
  assert.equal(checkWorktree(f.config, 'repo', f.token).registered, false);
  assert.ok(f.git(['worktree', 'list', '--porcelain']).includes(absent));
  f.git(['worktree', 'add', '--detach', f.wt, f.base]);
  assert.equal(checkWorktree(f.config, 'repo', f.token).headSha, f.base);
});

test('helper refreshes dependencies and executes preparation before configured verification', async t => {
  const f = fixture(t), approval = approved(1, f.base);
  const { runtime, pr } = simulation(f, approval, f.base);
  f.config.repos[0].install = 'node -e "const fs=require(\'fs\');fs.mkdirSync(\'node_modules\',{recursive:true});fs.writeFileSync(\'node_modules/installed\',\'yes\')"';
  f.config.repos[0].prepare = ['node -e "const fs=require(\'fs\');if(!fs.existsSync(\'node_modules/installed\'))process.exit(1);fs.writeFileSync(\'ignored.txt\',\'prepared\')"'];
  f.config.repos[0].verify = ['node -e "if(require(\'fs\').readFileSync(\'ignored.txt\',\'utf8\')!==\'prepared\')process.exit(1)"'];
  let result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.deepEqual(result.commands.map(command => command.phase), ['install', 'prepare', 'verify']);
  result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.deepEqual(result.commands.map(command => command.phase), ['prepare', 'verify']);
  pr.baseRefOid = f.commit({ ...f.files, 'package-lock.json': '{"fixture":true}\n' }, [f.base]);
  f.git(['update-ref', 'refs/heads/staging', pr.baseRefOid]);
  result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.deepEqual(result.commands.map(command => command.phase), ['install', 'prepare', 'verify']);
  assert.equal((await checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime)).approvedHead, approval.headSha);
  const cache = path.join(f.root, 'repo.lock.sha');
  const digest = fs.readFileSync(cache, 'utf8');
  assert.match(digest, /^[a-f0-9]{64}\n$/);
  // Older run output remains readable, so finish does not reinstall for a path suffix.
  fs.writeFileSync(cache, `${digest.trim()}  /old/worktree/package-lock.json\n`);
  result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.deepEqual(result.commands.map(command => command.phase), ['prepare', 'verify']);
});

test('verification uses the actual branch tip even while PR base metadata is stale', async t => {
  const f = fixture(t), approval = approved(1, f.base);
  const advanced = f.commit({ ...f.files, 'next.txt': 'already merged\n' }, [f.base]);
  const { runtime, pr } = simulation(f, approval, advanced);
  pr.baseRefOid = f.base;
  const result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'passed', result.error);
  assert.equal(result.baseSha, advanced);
  assert.equal((await checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime)).baseSha, advanced);
  const next = f.commit({ ...f.files, 'later.txt': 'new base\n' }, [advanced]);
  f.git(['update-ref', 'refs/heads/staging', next]);
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime), /changed since verification/);
});

test('production branch reader queries the remote ref and fails if that branch is missing', t => {
  const f = fixture(t);
  // The real ls-remote implementation talks to a local fixture repository, without network.
  f.git(['remote', 'set-url', 'origin', f.main]);
  const runtime = createRuntime(f.env);
  assert.equal(runtime.readBase(f.config.repos[0]), f.base);
  const next = f.commit({ ...f.files, 'later.txt': 'new base\n' }, [f.base]);
  f.git(['update-ref', 'refs/heads/staging', next]);
  assert.equal(runtime.readBase(f.config.repos[0]), next);
  assert.throws(() => runtime.readBase({ ...f.config.repos[0], baseBranch: 'missing' }));
});

test('command timeout kills the process group, including children that ignore SIGTERM', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-timeout-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = path.join(directory, 'timeout.log');
  const runtime = createRuntime();
  const result = await runtime.run(`trap '' TERM; echo "leader=$$"; sh -c 'trap "" TERM; echo "descendant=$$"; while :; do sleep 1; done' & wait`, directory, log, 500);
  assert.equal(result.timedOut, true);
  assert.equal(result.timeoutMs, 500);
  assert.equal(result.signal, 'SIGKILL');
  const output = fs.readFileSync(log, 'utf8');
  assert.match(output, /Command timed out/);
  const pids = [...output.matchAll(/(?:leader|descendant)=(\d+)/g)].map(match => Number(match[1]));
  assert.equal(pids.length, 2);
  const running = pid => {
    try { return !execFileSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().startsWith('Z'); }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  for (let i = 0; i < 20 && pids.some(running); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(pids.every(pid => !running(pid)), 'No running command or descendant may remain');
});

for (const exitCode of [0, 7]) test(`command exit ${exitCode} cleans up resistant background processes without changing its result`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-background-'));
  const ready = path.join(directory, 'ready');
  t.after(() => {
    if (fs.existsSync(ready)) {
      try { process.kill(Number(fs.readFileSync(ready, 'utf8')), 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const log = path.join(directory, 'command.log');
  const result = await createRuntime().run(
    `node -e 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); require("fs").writeFileSync("ready", String(process.pid))' & while [ ! -f ready ]; do sleep 0.01; done; exit ${exitCode}`,
    directory, log, 1500
  );
  assert.equal(result.exitCode, exitCode);
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.match(fs.readFileSync(log, 'utf8'), /terminating remaining background processes/);
  const pid = fs.readFileSync(ready, 'utf8');
  const running = () => {
    try { return !execFileSync('ps', ['-p', pid, '-o', 'stat='], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim().startsWith('Z'); }
    catch (error) { if (error.status === 1) return false; throw error; }
  };
  for (let i = 0; i < 20 && running(); i++) await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(running(), false, 'Background process must stop before verification continues');
});

test('timeout is recorded as failed even if the command exits zero on SIGTERM; CI is enabled', async t => {
  const f = fixture(t), approval = approved(1, f.base);
  const { runtime } = simulation(f, approval, f.base);
  f.config.repos[0].commandTimeoutSeconds = 1;
  f.config.repos[0].verify = [`test "$CI" = 1 || exit 9; trap 'exit 0' TERM; while :; do sleep 1; done`];
  const result = await verifyMerge(f.config, 'repo', f.token, approval, runtime);
  assert.equal(result.status, 'failed');
  assert.equal(result.commands[0].timedOut, true);
  assert.equal(result.commands[0].exitCode, 0);
  assert.equal(result.commands[0].timeoutMs, 1000);
  assert.match(result.error, /timed out/);
  await assert.rejects(checkVerifiedMerge(f.config, 'repo', f.token, approval, result.id, runtime), /did not pass/);
  assert.ok(fs.existsSync(result.commands[0].log));
});
