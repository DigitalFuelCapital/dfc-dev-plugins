import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkRuntime, validateConfig } from '../scripts/state.mjs';
import { COMMAND_ENV_PASS, commandEnv, createRuntime } from '../scripts/merge.mjs';
import { preflight } from '../scripts/preflight.mjs';

test('the runtime check names an old Git or Windows instead of failing later with usage text', () => {
  assert.deepEqual(checkRuntime({ platform: 'darwin', gitVersion: () => 'git version 2.39.5 (Apple Git-154)\n' }), { platform: 'darwin', git: '2.39' });
  assert.deepEqual(checkRuntime({ platform: 'linux', gitVersion: () => 'git version 2.36.0' }), { platform: 'linux', git: '2.36' });
  assert.equal(checkRuntime({ platform: 'linux', gitVersion: () => 'git version 3.0.1' }).git, '3.0');
  assert.throws(() => checkRuntime({ platform: 'linux', gitVersion: () => 'git version 2.34.1' }), /Git 2\.34 is too old: dev-autofix needs Git 2\.36/);
  assert.throws(() => checkRuntime({ platform: 'win32', gitVersion: () => 'git version 2.47.0.windows.1' }), /WSL/);
  assert.throws(() => checkRuntime({ platform: 'linux', gitVersion: () => 'not git' }), /Cannot read the Git version/);
  assert.equal(checkRuntime().platform, process.platform);
});

test('preflight reports a failed runtime check with its own message', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-runtime-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'main'));
  const config = { version: 1, worktreeRoot: path.join(directory, 'worktrees'), repos: [{ name: 'repo', path: path.join(directory, 'main'), remote: 'owner/repo', baseBranch: 'main', verify: ['true'] }] };
  const runtime = {
    publishingHost: 'github.com', login: () => 'me', permission: () => 'WRITE', git: () => 'https://github.com/owner/repo.git',
    readBase: () => 'a'.repeat(40), signingProbe: () => ({ verified: true }),
    checkRuntime: () => checkRuntime({ platform: 'linux', gitVersion: () => 'git version 2.34.1' }),
  };
  const failed = await preflight(config, [], runtime);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.checks[0], { repo: null, check: 'runtime', ok: false, message: 'Git 2.34 is too old: dev-autofix needs Git 2.36 or newer' });
  const passed = await preflight(config, [], { ...runtime, checkRuntime: () => checkRuntime({ platform: 'linux', gitVersion: () => 'git version 2.43.0' }) });
  assert.equal(passed.ok, true);
  assert.equal(passed.checks[0].check, 'runtime');
});

test('commands get a minimal environment plus only the names the repo lists', () => {
  const source = { PATH: '/bin', HOME: '/home/me', GH_TOKEN: 'secret', NPM_TOKEN: 'npm-secret', DATABASE_URL: 'postgres://x', CI: '0' };
  assert.deepEqual(commandEnv(source), { PATH: '/bin', HOME: '/home/me', CI: '1' });
  assert.deepEqual(commandEnv(source, ['DATABASE_URL', 'MISSING']), { PATH: '/bin', HOME: '/home/me', DATABASE_URL: 'postgres://x', CI: '1' });
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'NPM_TOKEN']) assert.ok(!COMMAND_ENV_PASS.includes(name), name);
});

test('the command runner does not leak the caller environment into install, prepare or verify', async t => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-env-')));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const runtime = createRuntime({ ...process.env, AUTOFIX_TEST_SECRET: 'leak-me', AUTOFIX_TEST_ALLOWED: 'passed-through' });
  const first = path.join(directory, 'first.log'), second = path.join(directory, 'second.log');
  const command = 'echo "secret=${AUTOFIX_TEST_SECRET:-unset} allowed=${AUTOFIX_TEST_ALLOWED:-unset} ci=$CI"';
  assert.equal((await runtime.run(command, directory, first, 5000)).exitCode, 0);
  assert.match(fs.readFileSync(first, 'utf8'), /secret=unset allowed=unset ci=1/);
  assert.equal((await runtime.run(command, directory, second, 5000, ['AUTOFIX_TEST_ALLOWED'])).exitCode, 0);
  assert.match(fs.readFileSync(second, 'utf8'), /secret=unset allowed=passed-through ci=1/);
});

test('config validation accepts env names and rejects values or malformed names', () => {
  const repo = { name: 'repo', path: os.tmpdir(), remote: 'owner/repo', baseBranch: 'main', verify: ['true'] };
  const config = env => ({ version: 1, worktreeRoot: path.join(os.homedir(), '.claude', 'autofix', 'worktrees'), repos: [{ ...repo, env }] });
  assert.ok(validateConfig(config(['DATABASE_URL', 'NPM_TOKEN'])));
  assert.ok(validateConfig(config(undefined)));
  for (const env of ['DATABASE_URL', ['A=b'], ['1BAD'], [''], [3]]) assert.throws(() => validateConfig(config(env)), /env must be a list of variable names/);
});
