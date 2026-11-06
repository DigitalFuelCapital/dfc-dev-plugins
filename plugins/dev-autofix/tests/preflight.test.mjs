import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflight, probeSigning, createRuntime } from '../scripts/preflight.mjs';
import { createRuntime as createCommandRuntime } from '../scripts/merge.mjs';

const SHA = 'a'.repeat(40);

function fixture(t, mainName = 'main') {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-preflight-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, mainName);
  fs.mkdirSync(main);
  const config = { version: 1, worktreeRoot: path.join(directory, 'worktrees'), repos: [{ name: 'repo', path: main, remote: 'Owner/Repo', baseBranch: 'main', verify: ['true'] }] };
  const state = { login: 'Publisher', permission: 'WRITE', origin: 'https://github.com/owner/repo.git', signed: true, host: 'github.com', bases: [], probes: [], remotes: [] };
  const runtime = {
    get publishingHost() { return state.host; },
    login: () => { if (!state.login) throw new Error('private authentication error must not leak'); return state.login; },
    permission: repo => { state.remotes.push(repo.remote); return state.permission; },
    git: (cwd, args) => { assert.deepEqual(args, ['remote', 'get-url', 'origin']); assert.equal(cwd, main); return state.origin; },
    readBase: repo => { state.bases.push(repo.name); return SHA; },
    signingProbe: async repo => { state.probes.push(repo.name); if (!state.signed) throw new Error('private key details must not leak'); return { trusted: true, format: 'ssh' }; },
  };
  return { directory, main, config, state, runtime };
}

test('preflight resolves actual gh author and checks transport, write permission and local signing', async t => {
  const f = fixture(t);
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.author, 'Publisher');
  assert.deepEqual(result.reviewers, ['Publisher']);
  assert.equal(result.authorIsReviewer, true);
  assert.deepEqual(result.checks.map(item => item.check), ['publishing-host', 'identity', 'origin', 'remote-base', 'push-permission', 'signing']);
  assert.ok(result.limitations.some(message => /does not prove GitHub/.test(message)));
  assert.ok(result.limitations.some(message => /connector/.test(message)));
  assert.deepEqual(f.state.probes, ['repo']);
});

test('a different publishing author and human reviewer is supported without allowing author review approval', async t => {
  const f = fixture(t);
  f.config.reviewers = ['HumanReviewer'];
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.authorIsReviewer, false);
  assert.deepEqual(result.reviewers, ['HumanReviewer']);
  assert.ok(result.limitations.some(message => /cannot authorize finish/.test(message)));
  f.config.reviewers = ['publisher'];
  assert.equal((await preflight(f.config, [], f.runtime)).authorIsReviewer, true);
});

test('invalid origins are blocked before attempting Git transport and read-only GitHub roles cannot publish', async t => {
  const f = fixture(t);
  f.state.origin = 'https://github.com/Other/Repo.git';
  f.state.permission = 'READ';
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, false);
  assert.deepEqual(f.state.bases, []);
  assert.equal(result.checks.find(item => item.check === 'origin').ok, false);
  assert.equal(result.checks.find(item => item.check === 'push-permission').ok, false);
  assert.equal(result.checks.find(item => item.check === 'signing').ok, true);
});

test('missing authentication or signing stops readiness without exposing raw errors', async t => {
  const f = fixture(t);
  f.state.login = null;
  f.state.signed = false;
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, false);
  assert.equal(result.author, null);
  assert.ok(result.checks.some(item => item.check === 'identity' && !item.ok));
  assert.ok(result.checks.some(item => item.check === 'signing' && !item.ok));
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.deepEqual(f.state.remotes, []);
});

test('publishing must target the same GitHub host and repository filtering checks only selected repositories', async t => {
  const f = fixture(t);
  f.state.host = 'enterprise.example.invalid';
  assert.equal((await preflight(f.config, [], f.runtime)).ok, false);
  const other = path.join(f.directory, 'other'); fs.mkdirSync(other);
  f.config.repos.push({ ...f.config.repos[0], name: 'other', path: other, remote: 'Owner/Other' });
  f.state.host = 'github.com'; f.state.probes = [];
  assert.equal((await preflight(f.config, ['repo'], f.runtime)).ok, true);
  assert.deepEqual(f.state.probes, ['repo']);
  await assert.rejects(preflight(f.config, ['missing'], f.runtime), /Unknown repository/);
});

test('an unavailable base or missing trusted signing evidence fails preflight', async t => {
  const f = fixture(t);
  f.runtime.readBase = () => '';
  f.runtime.signingProbe = () => ({ trusted: false });
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(item => item.check === 'remote-base').ok, false);
  assert.equal(result.checks.find(item => item.check === 'signing').ok, false);
});

function signedFixture(t, mainName) {
  const f = fixture(t, mainName);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const run = (file, args) => execFileSync(file, args, { cwd: f.directory, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  const git = args => run('git', ['-C', f.main, ...args]);
  git(['init', '--quiet', '--initial-branch=main']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(f.main, 'probe-key')]);
  fs.writeFileSync(path.join(f.main, 'allowed'), `fixture@example.invalid namespaces="git" ${fs.readFileSync(path.join(f.main, 'probe-key.pub'), 'utf8')}`);
  for (const [key, value] of [['commit.gpgsign', 'true'], ['gpg.format', 'ssh'], ['user.signingkey', 'probe-key'], ['gpg.ssh.allowedSignersFile', 'allowed']]) git(['config', key, value]);
  return { ...f, env, git };
}

test('real SSH probe signs and verifies trust using source-local relative paths without changing checkout objects or config', async t => {
  const f = signedFixture(t);
  const before = fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8');
  const objectsBefore = fs.readdirSync(path.join(f.main, '.git', 'objects')).sort();
  const statusBefore = f.git(['status', '--porcelain=v1', '--untracked-files=all']);
  const runtime = createRuntime(f.env);
  assert.deepEqual(await probeSigning(f.config.repos[0], { git: runtime.git, env: f.env }), { format: 'ssh', trusted: true });
  assert.equal(fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(f.main, '.git', 'objects')).sort(), objectsBefore);
  assert.equal(f.git(['status', '--porcelain=v1', '--untracked-files=all']), statusBefore);
  assert.equal(f.git(['for-each-ref', '--format=%(refname)']), '');
});

test('explicit signing works with disabled or unset default signing without changing configuration', async t => {
  const f = signedFixture(t), runtime = createRuntime(f.env);
  for (const value of ['false', null]) {
    if (value === null) f.git(['config', '--unset', 'commit.gpgsign']);
    else f.git(['config', 'commit.gpgsign', value]);
    const before = fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8');
    assert.deepEqual(await probeSigning(f.config.repos[0], { git: runtime.git, env: f.env }), { format: 'ssh', trusted: true });
    assert.equal(fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8'), before);
  }
});

test('missing or untrusted SSH verification fails the real probe', async t => {
  const f = signedFixture(t), runtime = createRuntime(f.env);
  f.git(['config', '--unset', 'gpg.ssh.allowedSignersFile']);
  await assert.rejects(probeSigning(f.config.repos[0], { git: runtime.git, env: f.env }), /allowedSignersFile/);
  fs.writeFileSync(path.join(f.main, 'allowed'), '');
  f.git(['config', 'gpg.ssh.allowedSignersFile', 'allowed']);
  await assert.rejects(probeSigning(f.config.repos[0], { git: runtime.git, env: f.env }), /verification failed|not trusted/);
});

test('source-relative SSH default key selectors retain their working directory in the disposable probe', async t => {
  const f = signedFixture(t, "main ' quoted");
  const run = (file, args, env = f.env) => execFileSync(file, args, { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  const agent = run('ssh-agent', ['-s']);
  const socket = /SSH_AUTH_SOCK=([^;]+);/.exec(agent)?.[1];
  const pid = /SSH_AGENT_PID=(\d+);/.exec(agent)?.[1];
  assert.ok(socket && pid, 'Disposable SSH agent must report its socket and PID');
  const env = { ...f.env, SSH_AUTH_SOCK: socket, SSH_AGENT_PID: pid };
  t.after(() => { run('ssh-agent', ['-k'], env); });
  run('ssh-add', [path.join(f.main, 'probe-key')], env);
  f.git(['config', '--unset', 'user.signingkey']);
  const selector = path.join(f.main, 'select-key');
  fs.writeFileSync(selector, '#!/bin/sh\nprintf "key::"\ncat ./probe-key.pub\n', { mode: 0o700 });
  f.git(['config', 'gpg.ssh.defaultKeyCommand', './select-key']);
  const before = fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8');
  const objectsBefore = fs.readdirSync(path.join(f.main, '.git', 'objects')).sort();
  const runtime = createRuntime(env);
  const bounded = createCommandRuntime(env).run;
  const diagnosticRun = async (command, cwd, log, timeout) => {
    const result = await bounded(command, cwd, log, timeout);
    assert.equal(result.exitCode, 0, fs.readFileSync(log, 'utf8'));
    return result;
  };
  assert.deepEqual(await probeSigning(f.config.repos[0], { git: runtime.git, env, run: diagnosticRun }), { format: 'ssh', trusted: true });
  assert.equal(fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8'), before);
  assert.deepEqual(fs.readdirSync(path.join(f.main, '.git', 'objects')).sort(), objectsBefore);
  assert.equal(f.git(['for-each-ref', '--format=%(refname)']), '');
});
