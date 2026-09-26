import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireLock as acquireRuntimeLock, releaseLock, inspectLock, resumeLock as resumeRuntimeLock, breakLock, validateConfig, recordPR, checkApproval, checkWorktree, githubRemote, detectLockOwner, lockInitializationTime, processStart } from '../scripts/state.mjs';

const testOwner = () => ({ pid: process.pid, processStart: processStart(process.pid), executable: process.execPath });
const acquireLock = (directory, identity = { session: 'test-session', command: 'test' }) => acquireRuntimeLock(directory, identity, testOwner);
const resumeLock = (directory, identity) => resumeRuntimeLock(directory, identity, testOwner);

const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const remote = 'owner/repo';
const url = `https://github.com/${remote}/pull/42#issuecomment-123`;
const comment = { kind: 'issue', url, author: 'reviewer', body: 'LGTM' };
const record = { remote, number: 42, headSha: sha, commentUrl: url, author: 'reviewer', body: 'LGTM' };
const approval = { remote, number: 42, headSha: sha, pending: [comment], reviewers: ['reviewer'], record };
const repo = { name: 'repo', path: '/tmp/repo', remote, baseBranch: 'staging', verify: ['npm test'] };
const temp = t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return fs.realpathSync(directory);
};

test('execution config requires real verification commands and safe unique repo names', () => {
  assert.equal(validateConfig({ version: 1, repos: [repo] }).repos[0], repo);
  for (const verify of [undefined, [], [''], ['   '], [1]]) {
    assert.throws(() => validateConfig({ version: 1, repos: [{ ...repo, verify }] }), /verify/);
  }
  for (const name of ['..', '../repo', '.', '']) {
    assert.throws(() => validateConfig({ version: 1, repos: [{ ...repo, name }] }), /names/);
  }
  assert.throws(() => validateConfig({ version: 1, repos: [repo, repo] }), /unique/);
});

test('schema verification pattern accepts actual commands and rejects blank commands', () => {
  const schema = JSON.parse(fs.readFileSync(new URL('../schema/autofix.config.schema.json', import.meta.url)));
  const command = new RegExp(schema.properties.repos.items.properties.verify.items.pattern);
  assert.ok(command.test('npm run lint'));
  assert.ok(!command.test(' \t\n'));
});

test('only the exact recorded, sole pending approval can authorize the current head', () => {
  assert.equal(checkApproval(approval), sha);
  assert.throws(() => checkApproval({ ...approval, headSha: newer }), /stale/);
  assert.throws(() => checkApproval({ ...approval, record: undefined }), /approval/);
  assert.throws(() => checkApproval({ ...approval, reviewers: ['other'] }), /reviewer/);
  assert.throws(() => checkApproval({ ...approval, pending: [] }), /only pending/);
  assert.throws(() => checkApproval({ ...approval, pending: [comment, { ...comment, body: 'Fix X' }] }), /only pending/);
  assert.throws(() => checkApproval({ ...approval, pending: [{ ...comment, body: 'LGTM but fix X' }] }), /exact/);
  assert.throws(() => checkApproval({ ...approval, pending: [{ ...comment, body: '/merge' }] }), /stale/);
  assert.throws(() => checkApproval({ ...approval, pending: [{ ...comment, kind: 'inline' }] }), /Inline/);
  assert.throws(() => checkApproval({ ...approval, number: 43 }), /stale/);
  assert.throws(() => checkApproval({ ...approval, approveTokens: ['/merge'] }), /token/);
});

test('formal review supplies commit evidence only while its state and head remain valid', () => {
  const review = { ...comment, kind: 'review', url: `https://github.com/${remote}/pull/42#pullrequestreview-7`, state: 'APPROVED', commitSha: sha };
  const input = { ...approval, record: undefined, pending: [review] };
  assert.equal(checkApproval(input), sha);
  assert.equal(checkApproval({ ...input, pending: [{ ...review, state: 'COMMENTED' }] }), sha);
  for (const state of ['DISMISSED', 'PENDING', 'CHANGES_REQUESTED']) {
    assert.throws(() => checkApproval({ ...input, pending: [{ ...review, state }] }), /Formal review/);
  }
  assert.throws(() => checkApproval({ ...input, headSha: newer }), /different head/);
});

test('approval CLI fails closed and records cannot be rebound to a later head', t => {
  const directory = temp(t);
  const cli = fileURLToPath(new URL('../scripts/state.mjs', import.meta.url));
  const input = path.join(directory, 'input.json');
  const target = path.join(directory, 'approval.json');
  fs.writeFileSync(input, JSON.stringify(record));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  assert.equal(run('record-approval', target, input).status, 0);
  fs.writeFileSync(input, JSON.stringify(Object.fromEntries(Object.entries(record).reverse())));
  assert.equal(run('record-approval', target, input).status, 0);
  fs.writeFileSync(input, JSON.stringify({ ...record, headSha: newer }));
  assert.equal(run('record-approval', target, input).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(target)).headSha, sha);
  fs.writeFileSync(input, JSON.stringify({ ...approval, headSha: newer }));
  assert.equal(run('approval', input).status, 1);
});

test('locks reject competing ownership and incorrect releases', t => {
  const directory = path.join(temp(t), 'lock');
  const token = acquireLock(directory);
  assert.throws(() => acquireLock(directory), /EEXIST/);
  assert.throws(() => releaseLock(directory, 'different-session'), /mismatch/);
  assert.ok(fs.existsSync(directory));
  releaseLock(directory, token);
  assert.ok(!fs.existsSync(directory));
});

test('lock inspection and resume recover a token; break refuses live or changed ownership', t => {
  const directory = path.join(temp(t), 'lock');
  const identity = { session: 'persistent-session', command: 'dev-autofix:run' };
  const token = acquireLock(directory, identity);
  const snapshot = inspectLock(directory);
  assert.equal(snapshot.owner.host, os.hostname());
  assert.equal(snapshot.owner.command, identity.command);
  assert.equal(resumeLock(directory, identity), token);
  assert.throws(() => resumeLock(directory, { ...identity, session: 'other' }), /another session/);
  const confirmed = { fingerprint: snapshot.fingerprint, confirmedStopped: true, reason: 'Previous lead and workers exited' };
  assert.throws(() => breakLock(directory, confirmed), /still running/);
  releaseLock(directory, token);
  acquireLock(directory, identity);
  assert.throws(() => breakLock(directory, confirmed), /changed/);
});

test('checked break archives abandoned, legacy and ownerless locks without discarding evidence', t => {
  const root = temp(t);
  for (const kind of ['abandoned', 'legacy', 'ownerless']) {
    const directory = path.join(root, kind);
    fs.mkdirSync(directory);
    if (kind !== 'ownerless') {
      const owner = kind === 'legacy' ? { token: 'legacy-token' } : { token: 'abandoned-token', host: os.hostname(), pid: 2147483647 };
      fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify(owner));
    }
    const snapshot = inspectLock(directory);
    const confirmation = { fingerprint: snapshot.fingerprint, confirmedStopped: true, reason: 'Checked session and workers stopped' };
    assert.throws(() => breakLock(directory, { ...confirmation, confirmedStopped: false }), /Confirm/);
    if (kind === 'ownerless') {
      assert.throws(() => breakLock(directory, confirmation), /initializing/);
      t.mock.method(Date, 'now', () => Date.parse(snapshot.createdAt) + 61_000);
    }
    const result = breakLock(directory, confirmation);
    assert.ok(!fs.existsSync(directory));
    assert.ok(fs.existsSync(path.join(result.archive, 'recovery.json')));
    if (kind !== 'ownerless') assert.ok(fs.existsSync(path.join(result.archive, 'owner.json')));
    const token = acquireLock(directory);
    releaseLock(directory, token);
  }
});

test('manual LGTM uses contiguous server push history and never silently approves a later head', () => {
  const createdAt = '2026-09-26T12:00:00Z';
  const manual = { ...comment, createdAt, updatedAt: createdAt };
  const first = { ref: 'refs/heads/fix/auto-one', before: 'c'.repeat(40), after: sha, timestamp: '2026-09-26T11:00:00Z', activity_type: 'push' };
  const history = { remote, ref: first.ref, complete: true, observedHead: sha, activities: [first] };
  const input = { ...approval, record: undefined, headRef: 'fix/auto-one', pending: [manual], history };
  assert.equal(checkApproval(input), sha);
  const push = { ...first, before: sha, after: newer, timestamp: '2026-09-26T13:00:00Z', activity_type: 'force_push' };
  assert.throws(() => checkApproval({ ...input, headSha: newer, history: { ...history, observedHead: newer, activities: [push, first] } }), /different head/);
  for (const modified of [
    { ...history, complete: false },
    { ...history, activities: [] },
    { ...history, activities: [{ ...first, timestamp: createdAt }] },
    { ...history, remote: 'other/repo' },
    { ...history, activities: [first, { ...push, before: newer, after: sha }] },
    { ...history, activities: [first, { ...push, activity_type: 'branch_deletion' }] },
    { ...history, activities: [first, { ...push, activity_type: 'branch_creation', after: sha }] },
  ]) assert.throws(() => checkApproval({ ...input, history: modified }));
  assert.throws(() => checkApproval({ ...input, pending: [{ ...manual, updatedAt: '2026-09-26T12:01:00Z' }] }), /Edited/);
});

test('remote parsing accepts GitHub spelling variants and resolved SSH aliases only', () => {
  for (const url of ['https://GitHub.com/OWNER/Repo.git/', 'https://user@github.com/owner/repo/', 'git@github.com-work:Owner/REPO.git', 'ssh://git@github.com-work/owner/repo.git/']) {
    assert.equal(githubRemote(url, host => host === 'github.com-work' ? 'github.com' : host), remote);
  }
  for (const url of ['https://evil.example/owner/repo', 'git@github.com-work:owner/repo', 'https://github.com/owner/repo/extra', 'https://github.com/owner/repo?redirect=other']) {
    assert.throws(() => githubRemote(url, host => host));
  }
  assert.throws(() => githubRemote('git@github.com:owner/repo', () => 'evil.example'));
  assert.equal(githubRemote('git@github.com:owner/repo', () => 'ssh.github.com'), remote);
  assert.equal(githubRemote('ssh://git@ssh.github.com:443/owner/repo', host => host), remote);
  assert.throws(() => githubRemote('https://ssh.github.com/owner/repo'));
});

test('config rejects a future worktree root inside a main checkout, including symlink aliases', t => {
  const directory = temp(t);
  const main = path.join(directory, 'main');
  const alias = path.join(directory, 'alias');
  fs.mkdirSync(main); fs.symlinkSync(main, alias);
  for (const root of [path.join(main, 'new-worktrees'), path.join(alias, 'new-worktrees')]) {
    assert.throws(() => validateConfig({ version: 1, repos: [{ ...repo, path: main }], worktreeRoot: root }), /outside/);
    assert.ok(!fs.existsSync(root));
  }
  assert.throws(() => validateConfig({ version: 1, repos: [{ ...repo, name: 'main', path: main }], worktreeRoot: directory }), /outside/);
});

test('recovered PR registration starts a batch, deduplicates retries, and preserves corrupt state', t => {
  const root = temp(t);
  const runToken = acquireLock(path.join(root, '.locks/run'));
  // Old interrupted inner locks cannot block serialized lead registrations anymore.
  fs.mkdirSync(path.join(root, '.locks/manifest'));
  const first = { repo: 'repo', number: 42, branch: 'fix/auto-example', url: 'https://github.com/owner/repo/pull/42' };
  const second = { ...first, number: 43, url: 'https://github.com/owner/repo/pull/43' };
  const started = '2026-09-26T12:00:00Z';
  assert.equal(recordPR(root, started, first, runToken).prs.length, 1);
  assert.equal(recordPR(root, started, first, runToken).prs.length, 1);
  assert.equal(recordPR(root, started, second, runToken).prs.length, 2);
  assert.deepEqual(recordPR(root, '2026-09-27T12:00:00Z', first, runToken).prs, [first]);
  assert.throws(() => recordPR(root, started, second, 'other-session'), /mismatch/);
  const file = path.join(root, 'last-run.json');
  fs.writeFileSync(file, '{interrupted');
  assert.throws(() => recordPR(root, started, first, runToken));
  assert.equal(fs.readFileSync(file, 'utf8'), '{interrupted');
});

test('worktree guard blocks dirty, busy, unretained, foreign and escaped work without changing files', t => {
  const directory = temp(t);
  const main = path.join(directory, 'main');
  const root = path.join(directory, 'worktrees');
  const wt = path.join(root, 'repo');
  fs.mkdirSync(main);
  const token = acquireLock(path.join(root, '.locks/repo-repo'));
  const config = { version: 1, worktreeRoot: root, repos: [{ ...repo, path: main }] };
  let status = '', origin = `https://github.com/${remote}.git`, retained = true, registered = true;
  const git = (cwd, args) => {
    if (args[0] === 'remote') return origin;
    if (args[0] === 'worktree') return `worktree ${main}\0\0${registered ? `worktree ${wt}\0\0` : ''}`;
    if (args[0] === 'status') return status;
    if (args[0] === 'for-each-ref') return retained ? 'refs/remotes/origin/staging' : '';
    if (args[1] === '--show-toplevel') return wt;
    if (args[1] === '--git-path') return path.join(wt, '.git-data', args[2]);
    if (args[1] === 'HEAD') return sha;
    throw new Error(`Unexpected Git read: ${cwd} ${args}`);
  };
  assert.equal(checkWorktree(config, 'repo', token, git).exists, false);
  fs.mkdirSync(wt);
  assert.equal(checkWorktree(config, 'repo', token, git).headSha, sha);
  assert.throws(() => checkWorktree(config, 'repo', 'wrong-token', git), /mismatch/);
  const artifact = path.join(wt, 'unfinished.txt');
  fs.writeFileSync(artifact, 'preserve me'); status = '?? unfinished.txt';
  assert.throws(() => checkWorktree(config, 'repo', token, git), /unfinished/);
  assert.equal(fs.readFileSync(artifact, 'utf8'), 'preserve me'); status = '';
  retained = false;
  assert.throws(() => checkWorktree(config, 'repo', token, git), /retaining branch/); retained = true;
  fs.mkdirSync(path.join(wt, '.git-data/rebase-merge'), { recursive: true });
  assert.throws(() => checkWorktree(config, 'repo', token, git), /active rebase/);
  fs.rmdirSync(path.join(wt, '.git-data/rebase-merge'));
  origin = 'https://github.com/other/repo.git';
  assert.throws(() => checkWorktree(config, 'repo', token, git), /Origin/); origin = `https://github.com/${remote}.git`;
  registered = false;
  assert.throws(() => checkWorktree(config, 'repo', token, git), /not registered/); registered = true;
  fs.renameSync(wt, `${wt}-saved`); fs.symlinkSync(main, wt);
  assert.throws(() => checkWorktree(config, 'repo', token, git), /outside|symlink/);
  assert.equal(fs.readFileSync(path.join(`${wt}-saved`, 'unfinished.txt'), 'utf8'), 'preserve me');
});


test('lock owner detection skips shells and uses only Claude/Codex ancestors', () => {
  const tree = new Map([
    [30, { ppid: 20, executable: '/bin/zsh', processStart: 'shell-start' }],
    [20, { ppid: 10, executable: '/opt/codex', processStart: 'runtime-start' }],
    [10, { ppid: 1, executable: '/Applications/Codex.app/Contents/MacOS/Codex', processStart: 'app-start' }],
  ]);
  assert.deepEqual(detectLockOwner(30, pid => tree.get(pid)), { pid: 20, executable: '/opt/codex', processStart: 'runtime-start' });
  tree.set(20, { ppid: 1, executable: '/bin/node', args: 'node /opt/node_modules/@anthropic-ai/claude-code/cli.js', processStart: 'claude-start' });
  assert.equal(detectLockOwner(30, pid => tree.get(pid)).pid, 20);
  tree.set(20, { ppid: 1, executable: '/home/test/.local/share/claude/versions/2.1.283', processStart: 'native-claude-start' });
  assert.equal(detectLockOwner(30, pid => tree.get(pid)).pid, 20);
  tree.set(20, { ppid: 1, executable: '/bin/sh', args: 'sh -c echo codex', processStart: 'shell' });
  assert.throws(() => detectLockOwner(30, pid => tree.get(pid)), /No persistent/);
});

test('callers cannot choose an ephemeral lock PID and missing owners have a useful error', t => {
  assert.throws(() => acquireRuntimeLock(path.join(temp(t), 'lock'), { session: 'test', command: 'run', pid: process.pid }), /automatically/);
  assert.throws(() => processStart(2147483647), /not running/);
});

test('ownerless locks keep their grace period when Linux birthtime is zero', () => {
  const now = Date.now();
  assert.equal(lockInitializationTime({ birthtimeMs: 0, mtimeMs: now - 1000, ctimeMs: now }), now);
});


test('command timeout configuration rejects unbounded and invalid limits', () => {
  for (const commandTimeoutSeconds of [0, -1, 1.5, 3601, '600', null]) {
    assert.throws(() => validateConfig({ version: 1, repos: [{ ...repo, commandTimeoutSeconds }] }), /commandTimeoutSeconds/);
  }
  assert.equal(validateConfig({ version: 1, repos: [{ ...repo, commandTimeoutSeconds: 1 }] }).repos[0].commandTimeoutSeconds, 1);
  assert.equal(validateConfig({ version: 1, repos: [{ ...repo, commandTimeoutSeconds: 3600 }] }).repos[0].commandTimeoutSeconds, 3600);
});
