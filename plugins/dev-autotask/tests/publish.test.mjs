import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTask, createTask, listTasks, loadConfig, lockTask, showTask, unlockTask } from '../scripts/state.mjs';
import { publishCheck } from '../scripts/publish-check.mjs';
import { verify } from '../scripts/verify.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

// A real checkout with an origin and one task whose worktree is on its dev/autotask branch.
function fixture(t, { config = {} } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-publish-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main'), bare = path.join(dir, 'origin.git'), root = path.join(dir, 'runtime');
  const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  fs.mkdirSync(main);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
  git(main, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  git(main, ['add', '.']); git(main, ['commit', '-q', '-m', 'base']);
  git(main, ['remote', 'add', 'origin', bare]); git(main, ['push', '-q', '-u', 'origin', 'main']);
  const file = path.join(dir, 'autofix.config.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...config, repos: [{ name: 'main', path: main, remote: 'Owner/Repo', baseBranch: 'main', install: 'true', verify: ['true'] }] }));
  const loaded = loadConfig(file, { root, repo: 'main' });
  const task = createTask(loaded, 'add-export', 'Add export');
  fs.mkdirSync(path.dirname(task.worktree), { recursive: true });
  git(main, ['worktree', 'add', '-q', '-b', task.branch, task.worktree, 'origin/main']);
  const commit = (files, message = 'change') => {
    for (const [name, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(task.worktree, name)), { recursive: true });
      fs.writeFileSync(path.join(task.worktree, name), content);
    }
    git(task.worktree, ['add', '-A']); git(task.worktree, ['commit', '-q', '-m', message]);
    return git(task.worktree, ['rev-parse', 'HEAD']);
  };
  const check = (extra = {}) => publishCheck({ worktree: task.worktree, baseBranch: 'main', ...extra }, git);
  return { dir, main, root, file, task, git, commit, check, options: { root } };
}
const checks = result => [...new Set(result.failures.map(item => item.check))].sort();

test('publish check passes ordinary work and lists sensitive files for the reviewer', t => {
  const f = fixture(t);
  f.commit({ 'src/export.js': 'export const csv = rows => rows.join("\\n");\n', 'package.json': '{"name":"x"}\n', '.github/workflows/ci.yml': 'on: push\n', '.env.example': 'TOKEN=\n' });
  const result = f.check();
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.commits, 1);
  assert.equal(result.branch, 'dev/autotask-add-export');
  assert.deepEqual(result.signing, { required: false, unsigned: [result.head.slice(0, 8)] });
  assert.deepEqual(result.attention.map(item => `${item.file}: ${item.why}`).sort(), ['.github/workflows/ci.yml: CI or hook config', 'package.json: dependency manifest']);
});

test('publish check refuses uncommitted work, an empty branch and the wrong branch', t => {
  const f = fixture(t);
  assert.deepEqual(checks(f.check()), ['shape']);
  f.commit({ 'a.txt': 'two\n' });
  fs.writeFileSync(path.join(f.task.worktree, 'stray.txt'), 'wip\n');
  assert.deepEqual(checks(f.check()), ['clean']);
  fs.unlinkSync(path.join(f.task.worktree, 'stray.txt'));
  f.git(f.task.worktree, ['checkout', '-q', '-b', 'other']);
  assert.match(f.check().failures[0].detail, /expected a dev\/autotask-<id> branch/);
});

test('publish check finds credentials and .env files in any commit, without echoing them', t => {
  const f = fixture(t);
  const token = `ghp_${'A1b2'.repeat(9)}`;
  f.commit({ 'src/client.js': `const token = "${token}";\n`, '.env': 'SECRET=1\n', 'config/.env.production': 'X=1\n' });
  f.commit({ 'src/client.js': 'const token = process.env.TOKEN;\n', '.env': '', 'key.pem': '-----BEGIN RSA PRIVATE KEY-----\nabc\n' }, 'tidy');
  const result = f.check();
  assert.equal(result.ok, false);
  assert.equal(result.malware, false);
  assert.deepEqual(checks(result), ['env-file', 'secret']);
  const details = result.failures.map(item => item.detail).join('\n');
  assert.match(details, /src\/client\.js: looks like a github-token/);
  assert.match(details, /key\.pem: looks like a private-key/);
  assert.match(details, /commits \.env;/);
  assert.match(details, /commits config\/\.env\.production;/);
  assert.ok(!details.includes(token), 'the secret itself is never printed');
});

test('publish check stops on a malware signature unless that id is disabled in the config', t => {
  const f = fixture(t);
  f.commit({ 'src/x.js': 'const k = process.env.AUTH_API_KEY;\n' });
  const result = f.check();
  assert.equal(result.malware, true);
  assert.match(result.failures[0].detail, /malware signature auth-api-key/);
  assert.equal(f.check({ disabledPatterns: ['auth-api-key'] }).ok, true);
});

test('publish check requires signatures only where the repository does', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  assert.equal(f.check().ok, true);
  f.git(f.main, ['config', 'commit.gpgsign', 'true']);
  const result = f.check();
  assert.deepEqual(checks(result), ['signed']);
  assert.equal(result.signing.required, true);
});

// Advances origin/main from the main checkout and fetches it into the task worktree.
function advanceBase(f, file = 'base.txt') {
  fs.writeFileSync(path.join(f.main, file), 'base moved\n');
  f.git(f.main, ['add', '.']); f.git(f.main, ['commit', '-q', '-m', 'base moves']); f.git(f.main, ['push', '-q', 'origin', 'main']);
  f.git(f.task.worktree, ['fetch', '-q', 'origin']);
}

test('publish check inspects what a merge resolution adds, like finish does on conflicts', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  advanceBase(f);
  f.git(f.task.worktree, ['merge', '-q', '--no-edit', 'origin/main']);
  assert.equal(f.check().ok, true, 'a clean merge of the base passes');
  assert.equal(f.check().commits, 2, 'the task commit and the merge');
  advanceBase(f, 'base2.txt');
  f.git(f.task.worktree, ['merge', '-q', '--no-commit', 'origin/main']);
  fs.writeFileSync(path.join(f.task.worktree, '.env'), 'REVIEW_SENTINEL=1\n');
  fs.writeFileSync(path.join(f.task.worktree, 'src.js'), 'const k = process.env.AUTH_API_KEY;\n');
  f.git(f.task.worktree, ['add', '-A']); f.git(f.task.worktree, ['commit', '-q', '--no-edit']);
  const merge = f.git(f.task.worktree, ['rev-parse', 'HEAD']).slice(0, 8);
  const result = f.check();
  assert.deepEqual(checks(result), ['env-file', 'malware']);
  assert.match(result.failures.map(item => item.detail).join('\n'), new RegExp(`${merge} resolves a merge with \\.env;`));
  assert.ok(result.signing.unsigned.includes(merge), 'merges go through signature verification');
  f.git(f.main, ['config', 'commit.gpgsign', 'true']);
  assert.match(f.check().failures.find(item => item.check === 'signed').detail, new RegExp(merge));
});

test('publish check refuses a merge that pulls in anything but the base', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  f.git(f.task.worktree, ['checkout', '-q', '-b', 'side', 'origin/main']);
  fs.writeFileSync(path.join(f.task.worktree, 'side.txt'), 'side\n');
  f.git(f.task.worktree, ['add', '.']); f.git(f.task.worktree, ['commit', '-q', '-m', 'side']);
  f.git(f.task.worktree, ['checkout', '-q', f.task.branch]);
  f.git(f.task.worktree, ['merge', '-q', '--no-edit', 'side']);
  const result = f.check();
  assert.deepEqual(checks(result), ['shape']);
  assert.match(result.failures[0].detail, /pulls in .* which is not on origin\/main/);
});

test('publish check sees a .env renamed into place, in a merge or an ordinary commit', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n', '.env.example': 'REVIEW_SENTINEL=1\n' });
  advanceBase(f);
  f.git(f.task.worktree, ['merge', '-q', '--no-commit', 'origin/main']);
  f.git(f.task.worktree, ['mv', '.env.example', '.env']);
  f.git(f.task.worktree, ['commit', '-q', '--no-edit']);
  const merge = f.git(f.task.worktree, ['rev-parse', 'HEAD']).slice(0, 8);
  assert.match(f.check().failures.map(item => item.detail).join('\n'), new RegExp(`${merge} resolves a merge with \\.env;`));
  f.git(f.task.worktree, ['reset', '-q', '--hard', 'HEAD^']);
  f.git(f.task.worktree, ['mv', '.env.example', '.env']);
  f.git(f.task.worktree, ['commit', '-q', '-m', 'rename']);
  assert.deepEqual(checks(f.check()), ['env-file']);
});

test('publish check refuses an octopus merge, whose resolution git cannot show', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  // Two parents that are both on the base's history, so only the parent count can catch it.
  const side = name => {
    f.git(f.main, ['checkout', '-q', '-b', name, 'main']);
    fs.writeFileSync(path.join(f.main, `${name}.txt`), `${name}\n`);
    f.git(f.main, ['add', '.']); f.git(f.main, ['commit', '-q', '-m', name]);
    return f.git(f.main, ['rev-parse', 'HEAD']);
  };
  const p = side('p'), q = side('q');
  f.git(f.main, ['checkout', '-q', 'main']); f.git(f.main, ['merge', '-q', '--no-edit', 'p', 'q']); f.git(f.main, ['push', '-q', 'origin', 'main']);
  f.git(f.task.worktree, ['fetch', '-q', 'origin']);
  f.git(f.task.worktree, ['merge', '-q', '--no-commit', p, q]);
  fs.writeFileSync(path.join(f.task.worktree, '.env'), 'REVIEW_SENTINEL=1\n');
  f.git(f.task.worktree, ['add', '-A']); f.git(f.task.worktree, ['commit', '-q', '--no-edit']);
  const result = f.check();
  assert.equal(result.ok, false);
  assert.match(result.failures.map(item => item.detail).join('\n'), /has 3 parents; only a two-parent merge of origin\/main can be checked/);
});

test('publish-check CLI reads the base branch and disabled ids from the config and exits non-zero on failure', t => {
  const f = fixture(t, { config: { disabledPatterns: ['auth-api-key'] } });
  f.commit({ 'src/x.js': 'const k = process.env.AUTH_API_KEY;\n' });
  const run = () => spawnSync(process.execPath, [path.join(scripts, 'publish-check.mjs'), f.task.worktree, f.file, 'main'], { env, encoding: 'utf8' });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).ok, true);
  fs.writeFileSync(path.join(f.task.worktree, 'stray.txt'), 'wip\n');
  const bad = run();
  assert.equal(bad.status, 1);
  assert.deepEqual(checks(JSON.parse(bad.stdout)), ['clean']);
  assert.match(spawnSync(process.execPath, [path.join(scripts, 'publish-check.mjs')], { env, encoding: 'utf8' }).stderr, /Usage: publish-check\.mjs/);
});

test('a task lock admits one session, resumes for the same one, and is replaced only with force', t => {
  const f = fixture(t);
  const first = lockTask('add-export', 'session-a', f.options);
  assert.equal(first.locked, true);
  assert.equal(lockTask('add-export', 'session-a', f.options).resumed, true);
  assert.throws(() => lockTask('add-export', 'session-b', f.options), /locked by session session-a on .* confirm with the user, then repeat with --force/);
  assert.throws(() => unlockTask('add-export', 'session-b', f.options), /locked by another session/);
  assert.equal(listTasks(f.options)[0].locked, true);
  const forced = lockTask('add-export', 'session-b', { ...f.options, force: true });
  assert.equal(forced.replaced.session, 'session-a');
  assert.ok(fs.readdirSync(path.dirname(f.task.plan)).some(name => name.startsWith('lock.json.replaced-')), 'the replaced owner is kept');
  assert.deepEqual(unlockTask('add-export', 'session-b', f.options), { locked: false });
  assert.deepEqual(unlockTask('add-export', 'session-b', f.options), { locked: false });
  assert.equal(listTasks(f.options)[0].locked, false);
  assert.throws(() => lockTask('add-export', '', f.options), /session ID is required/);
});

test('cleanup removes a clean task worktree, marks the task done, and refuses to discard work', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  lockTask('add-export', 'session-a', f.options);
  assert.equal(listTasks(f.options)[0].worktree, f.task.worktree);
  fs.writeFileSync(path.join(f.task.worktree, 'stray.txt'), 'wip\n');
  assert.throws(() => cleanupTask('add-export', 'session-a', f.options, f.git), /uncommitted changes/);
  assert.ok(fs.existsSync(path.join(f.task.worktree, 'stray.txt')));
  fs.unlinkSync(path.join(f.task.worktree, 'stray.txt'));
  const cleaned = cleanupTask('add-export', 'session-a', f.options, f.git);
  assert.equal(cleaned.worktree, 'removed');
  assert.ok(!fs.existsSync(f.task.worktree));
  assert.ok(f.git(f.main, ['rev-parse', '--verify', 'refs/heads/dev/autotask-add-export']), 'the branch is kept');
  assert.ok(fs.existsSync(f.task.plan.replace('plan.md', 'task.json')));
  const listed = listTasks(f.options)[0];
  assert.equal(listed.done, cleaned.done);
  assert.equal(listed.worktree, null);
  assert.deepEqual(cleanupTask('add-export', 'session-a', f.options, f.git), { id: 'add-export', worktree: 'absent', done: cleaned.done, branch: 'dev/autotask-add-export' });
});

test('cleanup needs the task lock, and leaves another session\'s task untouched', t => {
  const f = fixture(t);
  f.commit({ 'a.txt': 'two\n' });
  const record = f.task.plan.replace('plan.md', 'task.json'), before = fs.readFileSync(record, 'utf8');
  assert.throws(() => cleanupTask('add-export', '', f.options, f.git), /session ID is required/);
  assert.throws(() => cleanupTask('add-export', 'session-b', f.options, f.git), /is not locked; take the lock/);
  lockTask('add-export', 'active-session', f.options);
  assert.throws(() => cleanupTask('add-export', 'session-b', f.options, f.git), /locked by another session; not cleaning it up/);
  assert.ok(fs.existsSync(f.task.worktree), 'the other session keeps its worktree');
  assert.equal(fs.readFileSync(record, 'utf8'), before, 'and its task record');
  assert.equal(cleanupTask('add-export', 'active-session', f.options, f.git).worktree, 'removed');
});

test('cleanup refuses a worktree whose HEAD the task branch does not contain', t => {
  const f = fixture(t);
  const onBranch = f.commit({ 'a.txt': 'two\n' });
  lockTask('add-export', 'session-a', f.options);
  f.git(f.task.worktree, ['checkout', '-q', '--detach']);
  const orphan = f.commit({ 'a.txt': 'three\n' }, 'detached work');
  assert.throws(() => cleanupTask('add-export', 'session-a', f.options, f.git), new RegExp(`at ${orphan.slice(0, 12)}, which dev/autotask-add-export does not contain`));
  assert.ok(fs.existsSync(f.task.worktree), 'the only copy of the commit survives');
  assert.equal(listTasks(f.options)[0].done, null);
  f.git(f.task.worktree, ['checkout', '-q', '--detach', onBranch]);
  assert.equal(cleanupTask('add-export', 'session-a', f.options, f.git).worktree, 'removed', 'a detached HEAD already on the branch is safe');
});

test('a task ID shared by two repositories resolves only with a remote', t => {
  const f = fixture(t);
  const config = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  config.repos.push({ ...config.repos[0], name: 'two', remote: 'Owner/Two' });
  fs.writeFileSync(f.file, JSON.stringify(config));
  createTask(loadConfig(f.file, { root: f.root, repo: 'two' }), 'add-export', 'Same ID elsewhere');
  assert.equal(listTasks({ ...f.options, remote: 'Owner/Repo' }).length, 1);
  assert.throws(() => showTask('add-export', f.options), /exists for several repos \(Owner\/Repo, Owner\/Two\); pass --repo/);
  assert.equal(showTask('add-export', { ...f.options, remote: 'Owner/Two' }).title, 'Same ID elsewhere');
});

test('reviewers come from the shared config, defaulting to the gh user', t => {
  assert.equal(showTask('add-export', fixture(t).options).reviewers, null);
  const f = fixture(t, { config: { reviewers: ['Reviewer-Bot'] } });
  assert.deepEqual(showTask('add-export', f.options).reviewers, ['Reviewer-Bot']);
  fs.writeFileSync(f.file, JSON.stringify({ ...JSON.parse(fs.readFileSync(f.file, 'utf8')), reviewers: 'someone' }));
  assert.throws(() => showTask('add-export', f.options), /reviewers must be a list/);
});

test('verify refuses Windows with a pointer to WSL', async t => {
  const f = fixture(t);
  await assert.rejects(verify(loadConfig(f.file, { root: f.root, repo: 'main' }), f.main, { platform: 'win32', log: () => {} }), /WSL/);
});
