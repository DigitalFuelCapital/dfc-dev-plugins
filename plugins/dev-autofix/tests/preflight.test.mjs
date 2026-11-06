import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { preflight, probeSigning, createRuntime } from '../scripts/preflight.mjs';

const SHA = 'a'.repeat(40);

function fixture(t) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-preflight-test-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const main = path.join(directory, 'main');
  fs.mkdirSync(main);
  const config = { version: 1, worktreeRoot: path.join(directory, 'worktrees'), repos: [{ name: 'repo', path: main, remote: 'Owner/Repo', baseBranch: 'main', verify: ['true'] }] };
  const state = { login: 'Publisher', permission: 'WRITE', origin: 'https://github.com/owner/repo.git', signed: true, verified: true, host: 'github.com', bases: [], probes: [], remotes: [] };
  const runtime = {
    get publishingHost() { return state.host; },
    login: () => { if (!state.login) throw new Error('private authentication error must not leak'); return state.login; },
    permission: repo => { state.remotes.push(repo.remote); return state.permission; },
    git: (cwd, args) => { assert.deepEqual(args, ['remote', 'get-url', 'origin']); return state.origin; },
    readBase: repo => { state.bases.push(repo.name); return SHA; },
    signingProbe: repo => { state.probes.push(repo.name); if (!state.signed) throw new Error('private key details must not leak'); return { verified: state.verified }; },
  };
  return { directory, main, config, state, runtime };
}

test('preflight resolves the gh author and checks signing, transport and write permission', async t => {
  const f = fixture(t);
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.author, 'Publisher');
  assert.deepEqual(result.reviewers, ['Publisher']);
  assert.equal(result.authorIsReviewer, true);
  assert.deepEqual(result.checks.map(item => item.check), ['publishing-host', 'identity', 'signing', 'signature-verify', 'origin', 'remote-base', 'push-permission']);
  assert.deepEqual(result.warnings, []);
});

test('reviewer mismatch is a warning, not a failure', async t => {
  const f = fixture(t);
  f.config.reviewers = ['HumanReviewer'];
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, true);
  assert.equal(result.authorIsReviewer, false);
  assert.ok(result.warnings.some(message => /cannot authorize finish/.test(message)));
  f.config.reviewers = ['publisher'];
  assert.equal((await preflight(f.config, [], f.runtime)).authorIsReviewer, true);
});

test('a signature that git verify-commit rejects fails preflight like the publish gate', async t => {
  const f = fixture(t);
  f.state.verified = false;
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find(item => item.check === 'signing').ok, true);
  assert.match(result.checks.find(item => item.check === 'signature-verify').message, /allowedSignersFile/);
  assert.deepEqual(result.warnings, []);
});

test('invalid origins skip transport and read-only roles cannot publish', async t => {
  const f = fixture(t);
  f.state.origin = 'https://github.com/Other/Repo.git';
  f.state.permission = 'READ';
  const result = await preflight(f.config, [], f.runtime);
  assert.equal(result.ok, false);
  assert.deepEqual(f.state.bases, []);
  assert.equal(result.checks.find(item => item.check === 'origin').ok, false);
  assert.equal(result.checks.find(item => item.check === 'push-permission').ok, false);
});

test('missing authentication or signing fails without exposing raw errors', async t => {
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

test('wrong gh host fails; filters select repos and signing is probed once per batch', async t => {
  const f = fixture(t);
  f.state.host = 'enterprise.example.invalid';
  assert.equal((await preflight(f.config, [], f.runtime)).ok, false);
  const other = path.join(f.directory, 'other'); fs.mkdirSync(other);
  f.config.repos.push({ ...f.config.repos[0], name: 'other', path: other, remote: 'Owner/Other' });
  f.state.host = 'github.com'; f.state.probes = []; f.state.origin = 'https://github.com/owner/other.git';
  assert.equal((await preflight(f.config, ['other'], f.runtime)).ok, true);
  assert.deepEqual(f.state.probes, ['other']);
  f.state.probes = [];
  await preflight(f.config, [], f.runtime);
  assert.deepEqual(f.state.probes, ['repo']);
  await assert.rejects(preflight(f.config, ['missing'], f.runtime), /Unknown repository/);
});

function signedRepo(t) {
  const f = fixture(t);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const run = (file, args) => execFileSync(file, args, { cwd: f.directory, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  const git = args => run('git', ['-C', f.main, ...args]);
  git(['init', '--quiet', '--initial-branch=main']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path.join(f.main, 'probe-key')]);
  fs.writeFileSync(path.join(f.main, 'allowed'), `fixture@example.invalid namespaces="git" ${fs.readFileSync(path.join(f.main, 'probe-key.pub'), 'utf8')}`);
  for (const [key, value] of [['gpg.format', 'ssh'], ['user.signingkey', 'probe-key'], ['commit.gpgsign', 'false']]) git(['config', key, value]);
  return { ...f, git, probe: () => probeSigning(f.main, createRuntime(env).git) };
}

test('real SSH probe signs explicitly in the source repo without changing refs, config or files', t => {
  const f = signedRepo(t);
  const config = fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8');
  const status = f.git(['status', '--porcelain=v1', '--untracked-files=all']);
  // No allowedSignersFile: signed, but git verify-commit (the publish gate) rejects it.
  assert.deepEqual(f.probe(), { verified: false });
  f.git(['config', 'gpg.ssh.allowedSignersFile', 'allowed']);
  assert.deepEqual(f.probe(), { verified: true });
  f.git(['config', '--unset', 'gpg.ssh.allowedSignersFile']);
  assert.equal(fs.readFileSync(path.join(f.main, '.git', 'config'), 'utf8'), config);
  assert.equal(f.git(['status', '--porcelain=v1', '--untracked-files=all']), status);
  assert.equal(f.git(['for-each-ref', '--format=%(refname)']), '');
});

test('a missing signing key fails the real probe', t => {
  const f = signedRepo(t);
  f.git(['config', 'user.signingkey', 'missing-key']);
  assert.throws(() => f.probe());
});
