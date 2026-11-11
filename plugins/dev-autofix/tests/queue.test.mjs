import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addFallbackEntry, addInbox, lintQueue, main, nextEntry, queueSkeleton, setStatus } from '../scripts/pr.mjs';

const config = { version: 1, repos: [{ name: 'app', path: '/tmp/app', remote: 'o/app', baseBranch: 'main', verify: ['true'] }, { name: 'api', path: '/tmp/api', remote: 'o/api', baseBranch: 'main', verify: ['true'] }] };
const entry = (slug, repo, lines = {}) => {
  const fields = { status: 'ready', kind: 'bugfix', risk: 'low · size: ~10 changed lines · deps-change: no', after: 'none', ...lines };
  return `### ${slug} · ${repo} · Title for ${slug}\n${Object.entries(fields).filter(([, value]) => value !== null).map(([key, value]) => `- ${key}: ${value}`).join('\n')}\n`;
};
const queue = (entries, { summary = true } = {}) => {
  let text = queueSkeleton(config);
  for (const [slug, repo, lines] of entries) {
    text = text.replace('## Entries\n', `## Entries\n\n${entry(slug, repo, lines)}`);
    if (summary) text = text.replace(new RegExp(`(## Summary - ${repo}\\n\\n\\|[^\\n]*\\n\\|[^\\n]*\\n)`), `$1| ${slug} | ${(lines?.status ?? 'ready').replace(/\s*\(.*$/, '')} | none | Title for ${slug} |\n`);
  }
  return text;
};

test('the skeleton is a valid empty queue that every queue helper accepts', () => {
  const text = queueSkeleton(config);
  assert.deepEqual(lintQueue(text, config), { ok: true, entries: 0, errors: [], warnings: [] });
  const withFallback = addFallbackEntry(text, 'api', 'lint-warning', 'Fix a lint warning', '2026-11-11');
  assert.match(withFallback, /## Summary - api\n\n\|[^\n]*\n\|[^\n]*\n\| lint-warning \| fallback \| none \| Fix a lint warning \|/);
  const withInbox = addInbox(withFallback, 'look at the retry loop');
  assert.match(withInbox, /## Inbox\n\n- look at the retry loop\n\n## Entries/);
  assert.equal(lintQueue(withInbox, config).ok, true);
  assert.deepEqual(lintQueue(withInbox, config).warnings, []);
  assert.equal(nextEntry(withInbox, 'api'), null, 'a fallback entry is tracked, never picked');
});

test('lint passes a well-formed queue and keeps the summary table in view', () => {
  const text = queue([['one', 'app'], ['two', 'api', { status: 'needs-human (keep the table?)' }]]);
  assert.deepEqual(lintQueue(text, config), { ok: true, entries: 2, errors: [], warnings: [] });
  const drifted = setStatus(text, 'one', 'pr-open (PR #4, 2026-11-11)').replace('| one | pr-open ', '| one | ready ');
  assert.match(lintQueue(drifted, config).warnings[0].problem, /summary table says `ready`/);
  assert.match(lintQueue(queue([['one', 'app']], { summary: false }), config).warnings[0].problem, /no row in the summary table/);
});

test('lint reports what would make a helper fail or an entry run when it should not', () => {
  const problems = (text, key = 'errors') => lintQueue(text, config)[key].map(item => item.problem).join('\n');
  assert.match(problems('# Autofix queue\n\n## app\n\n' + entry('one', 'app')), /missing the `## Inbox` heading[\s\S]*missing the `## Entries` heading/);
  assert.match(problems(queueSkeleton(config).replace('## Inbox', entry('early', 'app') + '\n## Inbox')), /before the `## Entries` heading/);
  assert.match(problems(queue([['one', 'app'], ['one', 'api']])), /duplicate slug/);
  assert.match(problems(queue([['Bad_Slug', 'app']])), /slug must be lowercase/);
  assert.match(problems(queue([['one', 'elsewhere']])), /repo `elsewhere` is not in the config/);
  assert.match(problems(queue([['one', 'app', { kind: 'Security' }]])), /kind must be one of/);
  assert.match(problems(queue([['one', 'app', { kind: null }]])), /kind must be one of/);
  assert.equal(lintQueue(queue([['one', 'app', { kind: 'Security' }]]), config).ok, false);
  assert.match(problems(queue([['one', 'app', { status: 'Ready' }]]), 'warnings'), /status `Ready` is not a form/);
  assert.match(problems(queue([['one', 'app', { after: 'missing' }]]), 'warnings'), /names no entry/);
  assert.match(problems(queue([['one', 'app', { risk: 'low' }]]), 'warnings'), /no `size: ~N`/);
});

test('a security entry is never picked, however its kind is capitalised', () => {
  for (const kind of ['security', 'Security', ' SECURITY ']) {
    assert.equal(nextEntry(queue([['one', 'app', { kind }]]), 'app'), null, kind);
  }
  assert.equal(nextEntry(queue([['one', 'app']]), 'app').slug, 'one');
});

test('queue init creates the skeleton once and lints an existing queue instead of replacing it', async t => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-queue-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const repo of config.repos) fs.mkdirSync(path.join(dir, repo.name));
  const local = { ...config, worktreeRoot: path.join(dir, 'worktrees'), repos: config.repos.map(repo => ({ ...repo, path: path.join(dir, repo.name) })) };
  const configFile = path.join(dir, 'autofix.config.json');
  fs.writeFileSync(configFile, JSON.stringify(local));
  const created = await main(['queue', 'init', configFile]);
  assert.deepEqual(created, { created: true, file: path.join(dir, 'AUTOFIX_QUEUE.md') });
  assert.equal(fs.readFileSync(created.file, 'utf8'), queueSkeleton(local));
  fs.appendFileSync(created.file, '\nkept\n');
  const again = await main(['queue', 'init', configFile]);
  assert.equal(again.created, false);
  assert.equal(again.ok, true);
  assert.match(fs.readFileSync(created.file, 'utf8'), /\nkept\n$/);
  assert.equal((await main(['queue', 'lint', configFile])).ok, true);
  fs.writeFileSync(created.file, '# Autofix queue\n');
  assert.equal((await main(['queue', 'lint', configFile])).ok, false);
});
