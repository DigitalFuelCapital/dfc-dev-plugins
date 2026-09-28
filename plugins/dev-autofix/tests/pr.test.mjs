import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acquireLock, processStart } from '../scripts/state.mjs';
import { createRuntime as createMergeRuntime } from '../scripts/merge.mjs';
import {
  createRuntime, parseQueue, nextEntry, setStatus, addInbox, addFallbackEntry, parseRawZ, renderBrief, sizeLimit, forbiddenPath,
  gate, publish, checkPRFile, buildApprovalInput, cleanup, removeWorktree, WORKTREE_REMOVE_TIMEOUT_MS,
  diffSize, sizeVerdict, sizeNote, prepare, land,
} from '../scripts/pr.mjs';

const QUEUE = `# Autofix queue

## Summary - repo

| slug | status | after | title |
|---|---|---|---|
| sec | ready | none | Rotate the thing |
| alpha | ready | none | Fix alpha |
| beta | ready | alpha | Fix beta |
| gamma | ready | none | Fix gamma |

## Inbox


## Entries

### sec · repo · Rotate the thing
- status: ready
- kind: security
- risk: high · size: ~5 changed lines · deps-change: no
- after: none

### alpha · repo · Fix alpha
- status: ready
- kind: bugfix
- risk: low · size: ~2 changed lines · deps-change: no
- after: none
- files: a.txt
- plan: 1. edit a.txt
- watch-outs: Deploy after merge with \`npx supabase functions deploy alpha-fn\`.

### beta · repo · Fix beta
- status: ready
- kind: refactor
- risk: low · size: ~10 changed lines · deps-change: no
- after: alpha

### gamma · repo · Fix gamma
- status: ready
- kind: mechanical
- risk: low · size: ~50 changed lines · deps-change: no
- after: none

## Dropped

- [repo] nothing yet
`;

// All Git writes are confined to disposable fixtures; the bare repo stands in for GitHub.
function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-pr-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const main = path.join(dir, 'main'), bare = path.join(dir, 'origin.git'), root = path.join(dir, 'worktrees');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const run = (cmd, args, cwd = dir) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trimEnd();
  const git = (args, cwd = main) => run('git', ['-C', cwd, ...args]);
  run('git', ['init', '--bare', '--initial-branch=staging', bare]);
  fs.mkdirSync(main);
  git(['init', '--initial-branch=staging']);
  git(['remote', 'add', 'origin', 'https://github.com/owner/repo.git']);
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', path.join(dir, 'key')]);
  fs.writeFileSync(path.join(dir, 'allowed'), `fixture@example.invalid namespaces="git" ${fs.readFileSync(path.join(dir, 'key.pub'), 'utf8')}`);
  for (const [key, value] of [['gpg.format', 'ssh'], ['user.signingkey', path.join(dir, 'key')], ['gpg.ssh.allowedSignersFile', path.join(dir, 'allowed')]]) git(['config', key, value]);
  fs.writeFileSync(path.join(main, 'a.txt'), 'one\n');
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules/\n');
  git(['add', '.']);
  git(['commit', '-S', '-q', '-m', 'Initial']);
  git(['push', '-q', bare, 'staging']);
  git(['fetch', '-q', bare, '+refs/heads/staging:refs/remotes/origin/staging']);
  const base = git(['rev-parse', 'HEAD']);
  const config = { version: 1, worktreeRoot: root, forbidden: ['Never edit generated types.'], repos: [{ name: 'repo', path: main, remote: 'owner/repo', baseBranch: 'staging', verify: ['true'], forbidden: ['Use the barrel.'] }] };
  const configFile = path.join(dir, 'autofix.config.json');
  fs.writeFileSync(configFile, JSON.stringify(config));
  fs.writeFileSync(path.join(dir, 'AUTOFIX_QUEUE.md'), QUEUE);
  const detect = () => ({ pid: process.pid, processStart: processStart(process.pid), executable: process.execPath });
  const token = acquireLock(path.join(root, '.locks/repo-repo'), { session: 'fixture', command: 'test' }, detect);
  const runToken = acquireLock(path.join(root, '.locks/run'), { session: 'fixture', command: 'test' }, detect);
  const wt = path.join(root, 'repo');
  git(['worktree', 'add', '-q', '--detach', wt, base]);

  const runtime = createRuntime(env);
  const realGit = runtime.git;
  // Only the network boundary moves: 'origin' becomes the local bare repo for fetch/ls-remote/push.
  runtime.git = (cwd, args, options) => realGit(cwd, ['fetch', 'ls-remote', 'push'].includes(args[0]) ? args.map(arg => arg === 'origin' ? bare : arg) : args, options);
  runtime.today = () => '2026-09-27';
  runtime.login = () => 'reviewer';
  const calls = [];
  runtime.gh = args => { calls.push(args); throw new Error(`unexpected gh ${args.join(' ')}`); };
  const commit = (files, { sign = true, message = 'Change' } = {}) => {
    for (const [name, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(wt, name)), { recursive: true });
      if (body === null) fs.rmSync(path.join(wt, name));
      else fs.writeFileSync(path.join(wt, name), body);
    }
    git(['add', '-A'], wt);
    git(sign ? ['commit', '-S', '-q', '-m', message] : ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message], wt);
    return git(['rev-parse', 'HEAD'], wt);
  };
  const queue = () => fs.readFileSync(path.join(dir, 'AUTOFIX_QUEUE.md'), 'utf8');
  return { dir, main, bare, root, wt, env, git, run, config, configFile, token, runToken, runtime, calls, commit, base, queue };
}

const lines = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n';

test('queue picks the first ready, non-security entry whose prerequisite is merged, and updates entry and summary together', () => {
  assert.equal(nextEntry(QUEUE, 'repo').slug, 'alpha');
  assert.equal(nextEntry(QUEUE, 'other'), null);
  const entries = parseQueue(QUEUE);
  assert.equal(entries.find(e => e.slug === 'gamma').statedSize, 50);
  assert.ok(!entries.at(-1).text.includes('## Dropped'), 'the last entry must not swallow later sections');
  let text = setStatus(QUEUE, 'alpha', 'pr-open (PR #7, 2026-09-27)');
  assert.equal(nextEntry(text, 'repo').slug, 'gamma', 'beta waits while alpha is only pr-open');
  text = setStatus(text, 'alpha', 'merged (PR #7, 2026-09-27)');
  assert.match(text, /^### alpha · repo · Fix alpha\n- status: merged \(PR #7, 2026-09-27\)$/m);
  assert.match(text, /^\| alpha \| merged \| none \|/m);
  assert.equal(nextEntry(text, 'repo').slug, 'beta');
  assert.throws(() => setStatus(QUEUE, 'missing', 'ready'), /not found/);
  const inboxed = addInbox(addInbox(QUEUE, 'first candidate'), '- second candidate');
  assert.match(inboxed, /## Inbox\n\n- first candidate\n- second candidate\n\n## Entries/);
});

test('brief carries the verbatim entry, every project rule and the deploy requirement, with no unfilled placeholders', () => {
  const template = fs.readFileSync(new URL('../references/fix-brief.md', import.meta.url), 'utf8');
  const config = { maxDiffLines: 120, coAuthor: 'Bot <bot@example.invalid>', forbidden: ['Global rule.'] };
  const repo = { name: 'repo', path: '/src/repo', baseBranch: 'staging', verify: ['npm run lint', 'npm test'], testCommand: 'npx vitest related --run {files}', forbidden: ['Repo rule.'] };
  const entry = parseQueue(QUEUE).find(e => e.slug === 'alpha');
  const { branch, prFile, brief } = renderBrief({ config, repo, entry, worktree: '/wt/repo', root: '/wt', date: '2026-09-27', template });
  assert.equal(branch, 'fix/auto-20260927-alpha');
  assert.equal(prFile, '/wt/pr/alpha.md');
  assert.ok(brief.includes(entry.text));
  for (const expected of ['- Global rule.', '- Repo rule.', 'diff under 120 lines', '`npm run lint`, `npm test`, and `npx vitest related --run {files}`', 'Co-Authored-By: Bot <bot@example.invalid>', 'supabase functions deploy', 'never touch /src/repo']) assert.ok(brief.includes(expected), expected);
  assert.doesNotMatch(brief, /\{\{\w+\}\}/);
});

test('size limit is maxDiffLines unless the entry states a larger size', () => {
  assert.equal(sizeLimit({}, 2), 150);
  assert.equal(sizeLimit({}, 50), 150);
  assert.equal(sizeLimit({}, 150), 225);
  assert.equal(sizeLimit({ maxDiffLines: 40 }, null), 40);
});

test('forbidden paths cover config, secrets, lockfiles, CI, hooks, scripts and tool config at any depth', () => {
  for (const file of ['.gitignore', 'apps/web/.env.local', 'package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml', 'x/.husky/pre-commit', 'bin/run.sh', 'tools/x.ps1', 'eslint.config.js', 'tsconfig.build.json', 'wrangler.toml', '.graphqlrc.yml']) {
    assert.ok(forbiddenPath(file), file);
  }
  for (const file of ['app/page.tsx', 'README.md', 'docs/github.md', 'environment.ts']) assert.equal(forbiddenPath(file), null, file);
  assert.ok(forbiddenPath('deps.lock', { lockfile: 'deps.lock' }));
});

test('run gate passes a small signed branch and measures the net diff against the fetched base', t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'a.txt': 'one\ntwo\nthree\nfour\n', 'b.txt': 'x\ny\nz\nw\n' });
  const result = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'run', statedSize: 2, expectBranch: 'fix/auto-20260927-alpha' }, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.size.raw, 7);
  assert.equal(result.size.limit, 150);
  assert.equal(result.size.autoPassed, false);
});

test('run gate refuses payloads hidden by a later commit, forbidden paths, exec bits, unsigned commits, oversize and the wrong branch', t => {
  const f = fixture(t);
  const repo = f.config.repos[0];
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'c.js': "const k = process.env.AUTH_API_KEY;\n" });
  f.commit({ 'c.js': null });
  f.commit({ 'package.json': '{}\n' });
  fs.writeFileSync(path.join(f.wt, 'tool.js'), 'x\n');
  fs.chmodSync(path.join(f.wt, 'tool.js'), 0o755);
  f.commit({}, { message: 'exec' });
  f.commit({ 'big.txt': lines(160) }, { sign: false });
  const result = gate({ config: f.config, repo, token: f.token, mode: 'run', statedSize: 2, expectBranch: 'fix/auto-20260927-other' }, f.runtime);
  assert.equal(result.ok, false);
  assert.equal(result.malware, true);
  const checks = new Set(result.failures.map(item => item.check));
  for (const check of ['malware', 'files', 'signed', 'size', 'shape']) assert.ok(checks.has(check), check);
  assert.ok(result.failures.some(item => /executable/.test(item.detail)));
  assert.ok(result.failures.some(item => /package\.json/.test(item.detail)));
});

test('run gate reports unfinished work as a clean failure without touching it', t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'a.txt': 'two\n' });
  fs.writeFileSync(path.join(f.wt, 'stray.txt'), 'wip\n');
  const result = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'run' }, f.runtime);
  assert.deepEqual(result.failures.map(item => item.check), ['clean']);
  assert.ok(fs.existsSync(path.join(f.wt, 'stray.txt')));
});

test('finish gate checks only commits added on top of the remote PR head', t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'a.txt': 'two\n' });
  f.git(['push', '-q', f.bare, 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'a.txt': 'three\n' });
  const ok = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'finish', headRef: 'fix/auto-20260927-alpha' }, f.runtime);
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));
  assert.equal(ok.commits.length, 1);
  f.commit({ 'd.js': 'eval(x)\n' });
  const bad = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'finish', headRef: 'fix/auto-20260927-alpha' }, f.runtime);
  assert.equal(bad.malware, true);
});

test('PR file check requires a short title, no draft wording and every deploy step the entry names', t => {
  const f = fixture(t);
  const entry = parseQueue(QUEUE).find(e => e.slug === 'alpha');
  const file = path.join(f.dir, 'pr.md');
  fs.writeFileSync(file, 'Fix alpha\n\nChanged a.txt.\n');
  assert.deepEqual(checkPRFile(file, entry.text).problems, ['PR body must name the deploy step: supabase functions deploy alpha-fn']);
  fs.writeFileSync(file, 'Fix alpha draft\n\n**Deploy:** `npx supabase functions deploy alpha-fn`\n');
  assert.deepEqual(checkPRFile(file, entry.text).problems, ['remove the word "draft" from the title and body']);
  fs.writeFileSync(file, 'Fix alpha\n\n**Deploy:** `npx supabase functions deploy alpha-fn`\n');
  assert.deepEqual(checkPRFile(file, entry.text).problems, []);
});

function publishable(f) {
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  const head = f.commit({ 'a.txt': 'two\n' });
  fs.mkdirSync(path.join(f.root, 'pr'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'pr', 'alpha.md'), 'Fix alpha\n\nWhat changed.\n\n**Deploy:** `npx supabase functions deploy alpha-fn`\n');
  const view = { number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: 'fix/auto-20260927-alpha', headRefOid: head, baseRefName: 'staging', url: 'https://github.com/owner/repo/pull/7' };
  f.runtime.readPR = () => ({ ...view });
  return { head, args: { configFile: f.configFile, config: f.config, repo: f.config.repos[0], repoToken: f.token, runToken: f.runToken, startedAt: '2026-09-27T17:34:03Z', slug: 'alpha' } };
}

test('publish pushes, records pushed before creating the PR, registers it, then marks pr-open', t => {
  const f = fixture(t);
  const { head, args } = publishable(f);
  let created = false;
  f.runtime.gh = ghArgs => {
    if (ghArgs[1] === 'list') return JSON.stringify(created ? [{ number: 7, url: 'https://github.com/owner/repo/pull/7' }] : []);
    if (ghArgs[1] === 'create') {
      assert.match(f.queue(), /^### alpha[^\n]*\n- status: pushed \(fix\/auto-20260927-alpha, 2026-09-27\)$/m, 'pushed must be recorded before create');
      assert.ok(ghArgs.includes('--draft'));
      created = true;
      return 'https://github.com/owner/repo/pull/7';
    }
    throw new Error(`unexpected gh ${ghArgs.join(' ')}`);
  };
  const result = publish(args, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(f.git(['rev-parse', 'refs/heads/fix/auto-20260927-alpha'], f.bare), head);
  assert.match(f.queue(), /- status: pr-open \(PR #7, 2026-09-27\)/);
  assert.match(f.queue(), /^\| alpha \| pr-open \| none \|/m);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root, 'last-run.json'), 'utf8')).prs, [{ repo: 'repo', number: 7, branch: 'fix/auto-20260927-alpha', url: 'https://github.com/owner/repo/pull/7' }]);
});

test('publish discovers an existing PR instead of creating a second one', t => {
  const f = fixture(t);
  const { args } = publishable(f);
  f.runtime.gh = ghArgs => {
    assert.equal(ghArgs[1], 'list', 'create must not run when a PR exists');
    return JSON.stringify([{ number: 7, url: 'https://github.com/owner/repo/pull/7' }]);
  };
  assert.equal(publish(args, f.runtime).ok, true);
});

test('publish refuses a PR file that drops the deploy step, before pushing anything', t => {
  const f = fixture(t);
  const { args } = publishable(f);
  fs.writeFileSync(path.join(f.root, 'pr', 'alpha.md'), 'Fix alpha\n\nNo deploy line.\n');
  const result = publish(args, f.runtime);
  assert.equal(result.stage, 'pr-file');
  assert.equal(f.git(['ls-remote', f.bare, 'refs/heads/fix/auto-20260927-alpha']), '');
  assert.match(f.queue(), /^### alpha[^\n]*\n- status: ready$/m);
});

test('publish leaves the entry pushed when registration fails, and blocks it when the gate refuses', t => {
  const f = fixture(t);
  const { args } = publishable(f);
  f.runtime.gh = () => JSON.stringify([{ number: 7, url: 'https://github.com/owner/repo/pull/7' }]);
  const result = publish({ ...args, runToken: 'not-the-run-token' }, f.runtime);
  assert.equal(result.stage, 'register');
  assert.match(f.queue(), /- status: pushed \(fix\/auto-20260927-alpha, 2026-09-27\)/);

  const g = fixture(t);
  const second = publishable(g);
  g.commit({ 'package.json': '{}\n' });
  const refused = publish(second.args, g.runtime);
  assert.equal(refused.stage, 'gate');
  assert.match(g.queue(), /- status: blocked \(push gate: files\)/);

  const h = fixture(t);
  const third = publishable(h);
  fs.writeFileSync(path.join(h.wt, 'stray.txt'), 'wip\n');
  const dirty = publish(third.args, h.runtime);
  assert.equal(dirty.stage, 'gate');
  assert.deepEqual(dirty.failures.map(item => item.check), ['clean']);
  assert.ok(fs.existsSync(path.join(h.wt, 'stray.txt')));
});

function approvalRuntime({ head = 'a'.repeat(40), issues = [], reviews = [], inline = [], activities = [] } = {}) {
  const runtime = createRuntime();
  runtime.readPR = () => ({ number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: 'fix/auto-20260927-alpha', headRefOid: head, baseRefName: 'staging', url: 'https://github.com/owner/repo/pull/7' });
  runtime.ghPages = api => {
    if (api.endsWith('/issues/7/comments')) return issues;
    if (api.endsWith('/pulls/7/reviews')) return reviews;
    if (api.endsWith('/pulls/7/comments')) return inline;
    if (api.includes('/activity?')) return activities;
    throw new Error(`unexpected api ${api}`);
  };
  return runtime;
}
const comment = (id, body, at, extra = {}) => ({ id, body, user: { login: 'reviewer' }, html_url: `https://github.com/owner/repo/pull/7#issuecomment-${id}`, created_at: at, updated_at: at, ...extra });
const approvalConfig = { version: 1, reviewers: ['reviewer'], repos: [] };
const approvalRepo = { name: 'repo', remote: 'owner/repo', baseBranch: 'staging' };

test('approval input prefers the review record over push history', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const head = 'b'.repeat(40);
  const record = { remote: 'owner/repo', number: 7, headSha: head, commentUrl: 'https://github.com/owner/repo/pull/7#issuecomment-11', author: 'reviewer', body: 'LGTM' };
  fs.mkdirSync(path.join(root, 'review', 'records'), { recursive: true });
  fs.writeFileSync(path.join(root, 'review', 'records', 'repo-pr7-comment11.approval.json'), JSON.stringify(record));
  const runtime = approvalRuntime({ head, issues: [comment(11, 'LGTM', '2026-09-27T18:00:00Z'), { ...comment(12, 'bot noise', '2026-09-27T18:01:00Z'), user: { login: 'coderabbitai[bot]' } }] });
  runtime.ghPages = (inner => api => { assert.ok(!api.includes('/activity?'), 'history must not be fetched when a record exists'); return inner(api); })(runtime.ghPages);
  const result = buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, runtime);
  assert.equal(result.classification, 'approve');
  assert.equal(result.evidence, 'record');
  assert.equal(result.approvedHead, head);

  record.headSha = 'c'.repeat(40);
  fs.writeFileSync(path.join(root, 'review', 'records', 'repo-pr7-comment11.approval.json'), JSON.stringify(record));
  assert.equal(buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, runtime).classification, 'stale');
});

test('approval input falls back to complete push history, and refuses edited comments', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const head = 'd'.repeat(40);
  const activities = [{ timestamp: '2026-09-27T17:38:33Z', before: '0'.repeat(40), after: head, ref: 'refs/heads/fix/auto-20260927-alpha', activity_type: 'branch_creation' }];
  const ok = buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, approvalRuntime({ head, activities, issues: [comment(21, ' lgtm ', '2026-09-27T18:00:00Z')] }));
  assert.equal(ok.classification, 'approve');
  assert.equal(ok.evidence, 'push-history');
  const edited = buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, approvalRuntime({ head, activities, issues: [comment(22, 'LGTM', '2026-09-27T18:00:00Z', { updated_at: '2026-09-27T18:05:00Z' })] }));
  assert.equal(edited.classification, 'evidence-unavailable');
});

test('approval input honours addressed markers and classifies mixed reviews as address', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-approval-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = comment(32, '**Review addressed**\n<!-- dev-autofix:review addressed=31 -->', '2026-09-27T18:10:00Z');
  const awaiting = buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, approvalRuntime({ issues: [comment(31, 'rename x', '2026-09-27T18:00:00Z'), marker] }));
  assert.equal(awaiting.classification, 'awaiting review');
  const inline = [{ id: 41, body: 'nit', user: { login: 'reviewer' }, html_url: 'https://github.com/owner/repo/pull/7#discussion_r41', path: 'a.txt', line: 1, created_at: '2026-09-27T18:20:00Z' }];
  const address = buildApprovalInput({ config: approvalConfig, repo: approvalRepo, number: 7, root }, approvalRuntime({ issues: [comment(31, 'rename x', '2026-09-27T18:00:00Z'), marker, comment(33, 'LGTM', '2026-09-27T18:15:00Z')], inline }));
  assert.equal(address.classification, 'address');
  assert.deepEqual(address.pending.map(item => item.id), [33, 41]);
});

function merged(f, { deleteRemote = false, advanceLocal = false } = {}) {
  const branch = 'fix/auto-20260927-alpha';
  f.git(['checkout', '-q', '-b', branch], f.wt);
  const head = f.commit({ 'a.txt': 'two\n' });
  f.git(['push', '-q', f.bare, branch], f.wt);
  // Squash merge: a new commit on staging with the PR's tree.
  const squash = f.git(['-c', 'commit.gpgsign=false', 'commit-tree', `${head}^{tree}`, '-p', f.base, '-m', 'Fix alpha (#7)']);
  f.git(['push', '-q', f.bare, `${squash}:refs/heads/staging`]);
  if (deleteRemote) f.git(['push', '-q', f.bare, `:refs/heads/${branch}`]);
  if (advanceLocal) f.commit({ 'a.txt': 'three\n' });
  fs.writeFileSync(path.join(f.dir, 'AUTOFIX_QUEUE.md'), setStatus(f.queue(), 'alpha', 'pr-open (PR #7, 2026-09-27)'));
  f.runtime.readPR = () => ({ number: 7, state: 'MERGED', isCrossRepository: false, headRefName: branch, headRefOid: head, baseRefName: 'staging', mergeCommit: { oid: squash } });
  return { branch, head, squash };
}

test('cleanup marks merged, detaches the worktree, deletes exact-tip branches and treats an auto-deleted remote as done', t => {
  const f = fixture(t);
  const { branch, squash } = merged(f, { deleteRemote: true });
  const result = cleanup({ configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token, number: 7 }, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.remote, 'already deleted');
  assert.equal(result.local, 'deleted');
  assert.match(f.queue(), /- status: merged \(PR #7, 2026-09-27\)/);
  assert.equal(f.git(['rev-parse', 'HEAD'], f.wt), squash);
  assert.equal(f.git(['branch', '--list', branch]), '');

  const g = fixture(t);
  merged(g);
  assert.equal(cleanup({ configFile: g.configFile, config: g.config, repo: g.config.repos[0], token: g.token, number: 7 }, g.runtime).remote, 'deleted');
  assert.equal(g.git(['ls-remote', g.bare, `refs/heads/${branch}`]), '');
});

test('cleanup keeps branches that advanced past the merged head, and does nothing for an unmerged PR', t => {
  const f = fixture(t);
  const { branch } = merged(f, { advanceLocal: true });
  const result = cleanup({ configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token, number: 7 }, f.runtime);
  assert.match(result.local, /^kept: tip/);
  assert.notEqual(f.git(['branch', '--list', branch]), '');

  const g = fixture(t);
  merged(g);
  g.runtime.readPR = () => ({ number: 7, state: 'OPEN', headRefName: branch });
  const queued = cleanup({ configFile: g.configFile, config: g.config, repo: g.config.repos[0], token: g.token, number: 7 }, g.runtime);
  assert.equal(queued.ok, false);
  assert.match(g.queue(), /- status: pr-open \(PR #7/);
});

test('remove-worktree refuses while autofix work is unpublished or open, then removes a clean tree on the base', t => {
  const f = fixture(t);
  const args = { configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token };
  fs.writeFileSync(path.join(f.dir, 'AUTOFIX_QUEUE.md'), setStatus(f.queue(), 'alpha', 'pushed (fix/auto-20260927-alpha, 2026-09-27)'));
  assert.match(removeWorktree(args, f.runtime).reason, /queue has alpha/);
  fs.writeFileSync(path.join(f.dir, 'AUTOFIX_QUEUE.md'), QUEUE);
  f.runtime.gh = () => JSON.stringify([{ number: 9, headRefName: 'fix/auto-20260927-gamma' }]);
  assert.match(removeWorktree(args, f.runtime).reason, /open autofix PRs: #9/);
  f.runtime.gh = () => JSON.stringify([{ number: 10, headRefName: 'feature/other' }]);
  fs.writeFileSync(path.join(f.root, 'repo.lock.sha'), 'abc\n');
  assert.equal(removeWorktree(args, f.runtime).removed, true);
  assert.ok(!fs.existsSync(f.wt));
  assert.ok(!fs.existsSync(path.join(f.root, 'repo.lock.sha')));
});

test('fallback fixes get a trackable entry that queue selection never picks up', () => {
  const text = addFallbackEntry(QUEUE, 'repo', 'lint-warning', 'Fix a lint warning', '2026-09-27');
  const entry = parseQueue(text).find(e => e.slug === 'lint-warning');
  assert.equal(entry.status, 'fallback (unplanned, 2026-09-27)');
  assert.equal(entry.statedSize, null);
  assert.match(text, /\|---\|---\|---\|---\|\n\| lint-warning \| fallback \| none \| Fix a lint warning \|\n/);
  assert.match(text, /## Entries\n\n### lint-warning · repo · Fix a lint warning\n[\s\S]*?\n\n### sec · repo/);
  assert.equal(nextEntry(text, 'repo').slug, 'alpha');
  assert.match(setStatus(text, 'lint-warning', 'pr-open (PR #9, 2026-09-27)'), /- status: pr-open \(PR #9/);
  assert.throws(() => addFallbackEntry(text, 'repo', 'lint-warning', 'Again', '2026-09-27'), /already exists/);
});

test('NUL-delimited raw diff parsing keeps unusual paths literal', () => {
  const rows = parseRawZ(':000000 100644 0000 1111 A\0café/package.json\0:100644 100755 1111 2222 M\0bin/tool\0:100644 100644 3333 4444 R100\0old.txt\0.github/x.yml\0');
  assert.deepEqual(rows.map(r => r.file), ['café/package.json', 'bin/tool', 'old.txt', '.github/x.yml']);
  assert.equal(rows[1].newMode, '100755');
});

test('run gate catches forbidden files under non-ASCII directories that Git would quote', t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'café/package.json': '{}\n' });
  const result = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'run' }, f.runtime);
  assert.ok(result.failures.some(item => item.check === 'files' && item.detail.includes('café/package.json')), JSON.stringify(result.failures));
});

test('finish gate accepts signed worker commits on a detached HEAD', t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260927-alpha'], f.wt);
  f.commit({ 'a.txt': 'two\n' });
  f.git(['push', '-q', f.bare, 'fix/auto-20260927-alpha'], f.wt);
  f.git(['checkout', '-q', '--detach'], f.wt);
  f.git(['branch', '-D', 'fix/auto-20260927-alpha']);
  f.commit({ 'a.txt': 'three\n' });
  const result = gate({ config: f.config, repo: f.config.repos[0], token: f.token, mode: 'finish', headRef: 'fix/auto-20260927-alpha' }, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(result.commits.length, 1);
});

test('publish refuses a discovered PR that is no longer open', t => {
  const f = fixture(t);
  const { args } = publishable(f);
  const open = f.runtime.readPR;
  f.runtime.readPR = (...a) => ({ ...open(...a), state: 'CLOSED' });
  f.runtime.gh = () => JSON.stringify([{ number: 7, url: 'https://github.com/owner/repo/pull/7' }]);
  const result = publish(args, f.runtime);
  assert.equal(result.stage, 'identity');
  assert.match(f.queue(), /- status: pushed \(/);
});

test('cleanup reports a missing merge commit instead of passing it to git', t => {
  const f = fixture(t);
  f.runtime.readPR = () => ({ number: 7, state: 'MERGED', headRefName: 'fix/auto-20260927-alpha', headRefOid: 'a'.repeat(40), mergeCommit: null });
  const result = cleanup({ configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token, number: 7 }, f.runtime);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no valid merge commit/);
});

test('remove-worktree gives git worktree remove far longer than the default 120s command timeout', t => {
  const f = fixture(t);
  const seen = [];
  const inner = f.runtime.git;
  f.runtime.git = (cwd, args, options) => { if (args[0] === 'worktree' && args[1] === 'remove') seen.push(options); return inner(cwd, args, options); };
  f.runtime.gh = () => '[]';
  assert.equal(removeWorktree({ configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token }, f.runtime).removed, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].timeout, WORKTREE_REMOVE_TIMEOUT_MS);
  assert.ok(WORKTREE_REMOVE_TIMEOUT_MS >= 10 * 60 * 1000);
});

// ---------------------------------------------------------------- 3.2.0: move-aware size, prepare, land

const block = (tag, n) => Array.from({ length: n }, (_, i) => `const ${tag}${i} = compute('${tag}', ${i});`).join('\n') + '\n';

test('diffSize counts a contiguous moved block once, including across files', () => {
  const patch = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,5 +0,0 @@', '-alpha()', '-beta()', '-', '-gamma()', '-solo()',
    'diff --git a/y.js b/y.js', '--- a/y.js', '+++ b/y.js', '@@ -0,0 +1,6 @@', '+alpha()', '+beta()', '+', '+gamma()', '+new()', '+solo()'].join('\n');
  const size = diffSize(patch);
  assert.equal(size.raw, 11);
  assert.equal(size.moved, 4, 'alpha, beta, blank, gamma form one contiguous block; solo alone is not a move');
  assert.equal(size.effective, 7);
});

test('diffSize gives no discount for matching lines scattered across hunks', () => {
  // Three deletions and three additions that match, but each in its own hunk: not a move.
  const hunks = ['a()', 'b()', 'c()'].flatMap((text, i) => [`@@ -${i * 10 + 1} +${i * 10 + 1} @@`, `-${text}`, `+${text}`]);
  const patch = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', ...hunks].join('\n');
  assert.deepEqual(diffSize(patch), { raw: 6, moved: 0, effective: 6 });
  // The same lines deleted as one block and re-added as one block are a move.
  const block = ['diff --git a/x.js b/x.js', '--- a/x.js', '+++ b/x.js', '@@ -1,3 +0,0 @@', '-a()', '-b()', '-c()', '@@ -20,0 +18,3 @@', '+a()', '+b()', '+c()'].join('\n');
  assert.deepEqual(diffSize(block), { raw: 6, moved: 3, effective: 3 });
});

test('size verdict auto-passes move-heavy diffs within the ceiling and honours an explicit override', () => {
  const config = { maxDiffLines: 150 };
  assert.deepEqual(sizeVerdict({ raw: 160, moved: 28, effective: 132 }, 150, config), { raw: 160, moved: 28, effective: 132, limit: 150, ceiling: 225, override: null, autoPassed: true, ok: true });
  assert.equal(sizeVerdict({ raw: 160, moved: 5, effective: 155 }, 150, config).ok, false, 'mostly new code stays refused');
  assert.equal(sizeVerdict({ raw: 240, moved: 120, effective: 120 }, 150, config).ok, false, 'the 1.5x ceiling holds even for moves');
  const forced = sizeVerdict({ raw: 240, moved: 0, effective: 240 }, 150, config, 250);
  assert.equal(forced.ok, true);
  assert.equal(forced.override, 250);
  assert.match(sizeNote(forced), /^Size override: 250 lines, approved by the user/);
  assert.match(sizeNote(sizeVerdict({ raw: 160, moved: 28, effective: 132 }, 150, config)), /auto-passed the 150-line cap/);
  assert.equal(sizeNote(sizeVerdict({ raw: 7, moved: 0, effective: 7 }, 150, config)), '');
});

test('run gate auto-passes a function moved between files but refuses the same volume of new code', t => {
  const f = fixture(t);
  const config = { ...f.config, maxDiffLines: 40 };
  f.git(['checkout', '-q', '-b', 'fix/auto-20260928-alpha'], f.wt);
  // Base gets the function first, then the branch moves it (30 lines out, 30 in = raw 60, ceiling 60).
  f.git(['checkout', '-q', 'staging'], f.main);
  fs.writeFileSync(path.join(f.main, 'old.js'), block('m', 30));
  f.git(['add', 'old.js'], f.main);
  f.git(['commit', '-S', '-q', '-m', 'Base function'], f.main);
  f.git(['push', '-q', f.bare, 'staging'], f.main);
  f.git(['fetch', '-q', f.bare, '+refs/heads/staging:refs/remotes/origin/staging'], f.main);
  f.git(['reset', '-q', '--hard', 'refs/remotes/origin/staging'], f.wt);
  // Into an existing file, so Git's rename detection cannot pair it up; this is a true cross-file move.
  f.commit({ 'old.js': null, 'a.txt': `one\n${block('m', 30)}` });
  const moved = gate({ config, repo: config.repos[0], token: f.token, mode: 'run' }, f.runtime);
  assert.equal(moved.ok, true, JSON.stringify(moved.failures));
  assert.equal(moved.size.raw, 60);
  assert.equal(moved.size.moved, 30);
  assert.equal(moved.size.autoPassed, true);

  f.commit({ 'fresh.js': block('n', 45) });
  const fresh = gate({ config, repo: config.repos[0], token: f.token, mode: 'run' }, f.runtime);
  assert.ok(fresh.failures.some(item => item.check === 'size' && /auto-pass needs/.test(item.detail)), JSON.stringify(fresh.failures));
  const forced = gate({ config, repo: config.repos[0], token: f.token, mode: 'run', maxDiff: 120 }, f.runtime);
  assert.equal(forced.ok, true, JSON.stringify(forced.failures));
  assert.equal(forced.size.override, 120);
});

test('publish states an auto-passed size on the PR body', t => {
  const f = fixture(t);
  const { args } = publishable(f);
  const config = { ...f.config, maxDiffLines: 1 };
  const head = f.commit({ 'b.txt': 'b1\nb2\nb3\nb4\n' });
  const view = f.runtime.readPR();
  f.runtime.readPR = () => ({ ...view, headRefOid: head });
  let body = null;
  f.runtime.gh = ghArgs => {
    if (ghArgs[1] === 'list') return JSON.stringify(body === null ? [] : [{ number: 7, url: 'https://github.com/owner/repo/pull/7' }]);
    body = fs.readFileSync(ghArgs[ghArgs.indexOf('--body-file') + 1], 'utf8');
    return 'https://github.com/owner/repo/pull/7';
  };
  // Entry states ~2 lines, so the limit is 3 and the ceiling 3; raw 6 of new code is refused until overridden.
  const refused = publish({ ...args, config }, f.runtime);
  assert.equal(refused.stage, 'gate');
  assert.match(f.queue(), /- status: blocked \(push gate: size\)/);
  const result = publish({ ...args, config, maxDiff: 10 }, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.sizeOverride, 10);
  assert.match(body, /Size override: 10 lines, approved by the user \(6 changed, 0 moved\)/);
});

function preparable(f, extra = {}) {
  f.git(['worktree', 'remove', f.wt]);
  const counter = path.join(f.dir, 'install.count');
  const repo = { ...f.config.repos[0], install: `mkdir -p node_modules && echo x >> ${counter}`, prepare: ['mkdir -p node_modules && touch node_modules/.prepared'], ...extra };
  const config = { ...f.config, repos: [repo] };
  return { config, repo, installs: () => (fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').trim().split('\n').length : 0) };
}

test('prepare creates the worktree, installs once, runs prepare once, and reinstalls when the lockfile digest changes', async t => {
  const f = fixture(t);
  const { config, repo, installs } = preparable(f);
  const first = await prepare({ config, repo, token: f.token }, f.runtime);
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual([first.created, first.installed, first.prepared], [true, true, true]);
  assert.equal(first.head, f.base);
  assert.ok(fs.existsSync(path.join(f.wt, 'node_modules', '.prepared')));
  assert.equal(fs.readFileSync(path.join(f.root, 'repo.lock.sha'), 'utf8'), 'no-lockfile\n');
  const second = await prepare({ config, repo, token: f.token }, f.runtime);
  assert.deepEqual([second.created, second.installed, second.prepared], [false, false, false]);
  assert.equal(installs(), 1);
  fs.writeFileSync(path.join(f.root, 'repo.lock.sha'), 'stale\n');
  assert.equal((await prepare({ config, repo, token: f.token }, f.runtime)).installed, true);
  assert.equal(installs(), 2);
});

test('prepare checks out a PR head, and reports a stale registration instead of pruning it', async t => {
  const f = fixture(t);
  f.git(['checkout', '-q', '-b', 'fix/auto-20260928-alpha'], f.wt);
  const head = f.commit({ 'a.txt': 'two\n' });
  f.git(['push', '-q', f.bare, 'fix/auto-20260928-alpha'], f.wt);
  f.git(['checkout', '-q', '--detach', f.base], f.wt);
  const onHead = await prepare({ config: f.config, repo: f.config.repos[0], token: f.token, head: 'fix/auto-20260928-alpha' }, f.runtime);
  assert.equal(onHead.head, head);
  f.git(['checkout', '-q', '--detach', f.base], f.wt);
  fs.rmSync(f.wt, { recursive: true, force: true });
  const stale = await prepare({ config: f.config, repo: f.config.repos[0], token: f.token }, f.runtime);
  assert.equal(stale.stage, 'prune-needed');
  assert.match(stale.registration, /prunable/);
});

// A GitHub stand-in over the bare repo: approval via record, CI via gh pr checks, merge by squash.
function landable(f, { onChecks = () => '', onMerge = null } = {}) {
  const branch = 'fix/auto-20260928-alpha';
  f.git(['checkout', '-q', '-b', branch], f.wt);
  const head = f.commit({ 'a.txt': 'two\n' });
  f.git(['push', '-q', f.bare, branch], f.wt);
  fs.writeFileSync(path.join(f.dir, 'AUTOFIX_QUEUE.md'), setStatus(f.queue(), 'alpha', 'pr-open (PR #7, 2026-09-28)'));
  const record = { remote: 'owner/repo', number: 7, headSha: head, commentUrl: 'https://github.com/owner/repo/pull/7#issuecomment-11', author: 'reviewer', body: 'LGTM' };
  fs.mkdirSync(path.join(f.root, 'review', 'records'), { recursive: true });
  fs.writeFileSync(path.join(f.root, 'review', 'records', 'repo-pr7-comment11.approval.json'), JSON.stringify(record));
  const pr = { number: 7, state: 'OPEN', isDraft: true, isCrossRepository: false, headRefName: branch, headRefOid: head, baseRefName: 'staging', url: 'https://github.com/owner/repo/pull/7', mergeable: 'MERGEABLE', mergeCommit: null };
  const calls = [];
  f.runtime.readPR = () => ({ ...pr });
  f.runtime.sleep = async () => {};
  f.runtime.ghPages = api => api.endsWith('/issues/7/comments') ? [comment(11, 'LGTM', '2026-09-28T12:00:00Z')] : [];
  f.runtime.gh = args => {
    calls.push(args[1]);
    if (args[1] === 'ready') { pr.isDraft = false; return ''; }
    if (args[1] === 'checks') return onChecks(pr, calls);
    if (args[1] === 'merge') {
      assert.equal(args[args.indexOf('--match-head-commit') + 1], pr.headRefOid);
      if (onMerge) return onMerge(pr);
      const tip = f.git(['rev-parse', 'refs/heads/staging'], f.bare);
      const squash = f.git(['-c', 'commit.gpgsign=false', 'commit-tree', `${pr.headRefOid}^{tree}`, '-p', tip, '-m', 'Fix alpha (#7)']);
      f.git(['push', '-q', f.bare, `${squash}:refs/heads/staging`]);
      Object.assign(pr, { state: 'MERGED', mergeCommit: { oid: squash } });
      return '';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  const merge = createMergeRuntime(f.env);
  merge.readPR = async () => ({ ...pr });
  merge.readBase = () => f.git(['ls-remote', f.bare, 'refs/heads/staging']).split('\t')[0];
  merge.fetch = async () => f.git(['fetch', '-q', f.bare, '+refs/heads/staging:refs/remotes/origin/staging', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  merge.sleep = async () => {};
  f.runtime.merge = merge;
  return { pr, head, branch, calls, args: { configFile: f.configFile, config: f.config, repo: f.config.repos[0], token: f.token, number: 7 } };
}

test('land verifies, waits for CI, merges the approved head from its record, and cleans up', async t => {
  const f = fixture(t);
  const { args, calls, branch } = landable(f);
  const result = await land(args, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.evidence, 'record');
  assert.deepEqual(calls, ['ready', 'checks', 'merge']);
  assert.equal(result.cleanup.remote, 'deleted');
  assert.match(f.queue(), /- status: merged \(PR #7, 2026-09-27\)/);
  assert.equal(f.git(['ls-remote', f.bare, `refs/heads/${branch}`]), '');
});

test('land re-verifies when an earlier merge moves the base, without asking for re-review', async t => {
  const f = fixture(t);
  const { args } = landable(f, {
    onChecks: () => {
      // Another PR lands on staging while CI runs.
      const tip = f.git(['rev-parse', 'refs/heads/staging'], f.bare);
      const tree = f.git(['rev-parse', `${tip}^{tree}`]);
      const next = f.git(['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', tip, '-m', 'Other PR']);
      f.git(['push', '-q', f.bare, `${next}:refs/heads/staging`]);
      return '';
    },
  });
  const result = await land(args, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
});

test('land leaves approval pending on failed CI, returns stale for a new head, and queued when the merge is not confirmed', async t => {
  const f = fixture(t);
  const failed = landable(f, { onChecks: () => { const e = new Error('Command failed'); e.stdout = 'build\tfail'; throw e; } });
  assert.equal((await land(failed.args, f.runtime)).stage, 'ci');
  assert.match(f.queue(), /- status: pr-open \(PR #7/);

  const g = fixture(t);
  const stale = landable(g, { onChecks: pr => { pr.headRefOid = 'e'.repeat(40); return ''; } });
  assert.equal((await land(stale.args, g.runtime)).stage, 'stale');

  const h = fixture(t);
  const queued = landable(h, { onMerge: () => '' });
  const result = await land(queued.args, h.runtime);
  assert.equal(result.stage, 'queued');
  assert.match(h.queue(), /- status: pr-open \(PR #7/);
});

test('land proceeds when no checks ever register, after bounded retries', async t => {
  const f = fixture(t);
  let tries = 0;
  const { args } = landable(f, { onChecks: () => { tries++; const e = new Error('no checks reported on the branch'); throw e; } });
  const result = await land(args, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.noChecks, true);
  assert.equal(tries, 5);
});

test('prepare re-runs a failed preparation on retry instead of reporting success', async t => {
  const f = fixture(t);
  const gate = path.join(f.dir, 'allow-prepare');
  const { config, repo } = preparable(f, { prepare: [`test -f ${gate} && mkdir -p node_modules && touch node_modules/.prepared`] });
  const failed = await prepare({ config, repo, token: f.token }, f.runtime);
  assert.equal(failed.stage, 'prepare');
  const retry = await prepare({ config, repo, token: f.token }, f.runtime);
  assert.equal(retry.stage, 'prepare', 'the reused tree still has not been prepared');
  fs.writeFileSync(gate, '');
  const ok = await prepare({ config, repo, token: f.token }, f.runtime);
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.prepared, true);
  assert.equal((await prepare({ config, repo, token: f.token }, f.runtime)).prepared, false, 'success is remembered');
});

test('prepare --deps-only refreshes dependencies on an unretained local merge without moving HEAD', async t => {
  const f = fixture(t);
  const { config, repo, installs } = preparable(f);
  assert.equal((await prepare({ config, repo, token: f.token }, f.runtime)).ok, true);
  // Simulate finish's sync: a signed local merge commit that no ref retains.
  const tree = f.git(['rev-parse', `${f.base}^{tree}`]);
  const merge = f.git(['commit-tree', '-S', tree, '-p', f.base, '-m', 'Local sync'], f.wt);
  f.git(['checkout', '-q', '--detach', merge], f.wt);
  fs.writeFileSync(path.join(f.root, 'repo.lock.sha'), 'lockfile-changed\n');
  const result = await prepare({ config, repo, token: f.token, depsOnly: true }, f.runtime);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.installed, true);
  assert.equal(result.head, merge, 'HEAD stays on the local merge');
  assert.equal(installs(), 2);
});
