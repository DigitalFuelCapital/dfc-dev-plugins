import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkVersions, newer, pendingReleases, pluginNames, releaseNotes, tagFor } from '../tools/release.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'release-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), text); };
  const manifest = (name, version) => write(`plugins/${name}/.claude-plugin/plugin.json`, JSON.stringify({ name, version }));
  const commit = message => { git('add', '-A'); git('commit', '-q', '-m', message); };
  git('init', '-q', '-b', 'main');
  for (const name of ['alpha', 'beta']) {
    manifest(name, '1.0.0');
    write(`plugins/${name}/scripts/tool.mjs`, 'export const one = 1;\n');
    write(`plugins/${name}/skills/run/SKILL.md`, 'Do the thing.\n');
    write(`plugins/${name}/README.md`, `# ${name}\n`);
    write(`plugins/${name}/CHANGELOG.md`, `# Changelog\n\n## 1.0.0\n\n- First release of ${name}.\n`);
  }
  commit('base');
  git('checkout', '-q', '-b', 'work');
  return { root, git, write, manifest, commit, check: () => checkVersions(root, 'main', git) };
}

test('version comparison is numeric, not lexical', () => {
  assert.ok(newer('1.10.0', '1.9.9'));
  assert.ok(newer('2.0.0', '1.99.99'));
  assert.ok(!newer('1.0.0', '1.0.0'));
  assert.ok(!newer('1.0.0', '1.0.1'));
  assert.throws(() => newer('1.0', '1.0.0'), /Not a version/);
});

test('a plugin whose behaviour files changed must carry a higher version', t => {
  const f = fixture(t);
  assert.equal(f.check().ok, true, 'nothing changed');
  f.write('plugins/alpha/README.md', '# alpha, reworded\n');
  f.write('plugins/alpha/tests/tool.test.mjs', '// new test\n');
  f.write('plugins/alpha/examples/sample.json', '{}\n');
  f.commit('docs and tests');
  assert.equal(f.check().ok, true, 'README, tests and examples never need a bump');

  f.write('plugins/alpha/skills/run/SKILL.md', 'Do the thing, carefully.\n');
  f.commit('reword a skill');
  const skill = f.check();
  assert.equal(skill.ok, false, 'a SKILL.md edit changes behaviour');
  assert.match(skill.problems[0], /^alpha: 1 file\(s\) changed since main \(skills\/run\/SKILL\.md\) but the version is still 1\.0\.0/);
  assert.equal(skill.problems.length, 1, 'beta is untouched');

  f.manifest('alpha', '0.9.0');
  f.commit('wrong direction');
  assert.equal(f.check().ok, false, 'a lower version is not a bump');
  f.manifest('alpha', '1.0.1');
  f.commit('bump');
  assert.deepEqual(f.check().checked.find(item => item.plugin === 'alpha'), { plugin: 'alpha', before: '1.0.0', now: '1.0.1', changed: 2 });
  assert.equal(f.check().ok, true);
});

test('a plugin that is new on the branch needs no bump', t => {
  const f = fixture(t);
  f.manifest('gamma', '0.1.0');
  f.write('plugins/gamma/scripts/tool.mjs', 'export const one = 1;\n');
  f.commit('add gamma');
  assert.equal(f.check().ok, true);
  assert.deepEqual(pluginNames(f.root), ['alpha', 'beta', 'gamma']);
});

test('release notes are the changelog section for the current version, and pending lists untagged versions', t => {
  const f = fixture(t);
  f.manifest('alpha', '1.1.0');
  f.write('plugins/alpha/CHANGELOG.md', '# Changelog\n\n## 1.1.0\n\nBetter.\n\n- one\n- two\n\n## 1.0.0\n\n- First release.\n');
  f.commit('release alpha 1.1.0');
  assert.equal(releaseNotes(f.root, 'alpha'), 'Better.\n\n- one\n- two');
  assert.equal(releaseNotes(f.root, 'beta'), '- First release of beta.');
  f.manifest('beta', '1.2.0');
  assert.throws(() => releaseNotes(f.root, 'beta'), /has no "## 1\.2\.0" section/);
  f.manifest('beta', '1.0.0');
  assert.deepEqual(pendingReleases(f.root, f.git).map(item => item.tag), ['alpha-v1.1.0', 'beta-v1.0.0']);
  f.git('tag', tagFor('beta', '1.0.0'));
  assert.deepEqual(pendingReleases(f.root, f.git), [{ plugin: 'alpha', version: '1.1.0', tag: 'alpha-v1.1.0' }]);
});

test('this repository has release notes for every plugin version it would tag', () => {
  for (const name of pluginNames(ROOT)) assert.ok(releaseNotes(ROOT, name).length > 20, name);
});

// Releases publish whatever the push carries, so they must wait for its validation. Only
// one workflow may create releases, and its release job must need lint and every test cell.
test('releases are created only after lint and tests pass for the same push', () => {
  const dir = path.join(ROOT, '.github', 'workflows');
  const releasing = fs.readdirSync(dir).filter(name => fs.readFileSync(path.join(dir, name), 'utf8').includes('gh release create'));
  assert.deepEqual(releasing, ['test.yml']);
  const workflow = fs.readFileSync(path.join(dir, 'test.yml'), 'utf8');
  const job = /^ {2}release:\n((?: {4}.*\n|\s*\n)+)/m.exec(workflow)?.[1] ?? '';
  assert.match(job, /^ {4}needs: \[lint, test\]$/m);
  assert.match(job, /^ {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'$/m);
  assert.ok(job.includes('gh release create'), 'the needs line belongs to the job that releases');
});
