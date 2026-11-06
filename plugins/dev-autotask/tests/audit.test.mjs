import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { status, merge, finalize } from '../scripts/audit.mjs';
import { commandEnv } from '../scripts/verify.mjs';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const finding = (id, extra = {}) => ({ id, severity: 'high', title: `T ${id}`, location: 'src/a.js:3', trigger: 'input', proof: 'trace', ...extra });

function audit(t, { agents = {}, reviews = {}, src = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dev-autotask-audit-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [sub, files] of [['agents', agents], ['reviews', reviews]]) {
    fs.mkdirSync(path.join(dir, sub));
    for (const [name, items] of Object.entries(files)) fs.writeFileSync(path.join(dir, sub, `${name}.json`), JSON.stringify(items));
  }
  if (src) {
    const git = (...args) => execFileSync('git', ['-C', path.join(dir, 'src'), ...args], { encoding: 'utf8' }).trim();
    fs.mkdirSync(path.join(dir, 'src'));
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://user:secret@github.com/Owner/Repo.git');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'x');
    return { dir, sha: git('rev-parse', 'HEAD') };
  }
  return { dir };
}

test('status needs a confirming review and no rejection', () => {
  const r = verdict => ({ agent: 'x', verdict, reason: 'r' });
  assert.equal(status([r('confirmed')]), 'confirmed');
  assert.equal(status([r('confirmed'), r('needs-evidence')]), 'confirmed');
  assert.equal(status([r('confirmed'), r('rejected')]), 'disputed');
  assert.equal(status([r('rejected')]), 'rejected');
  assert.equal(status([r('needs-evidence')]), 'unverified');
  assert.equal(status([]), 'unverified');
});

test('merge takes agents from file names and rejects self-review, duplicates and bad fields', t => {
  const ok = audit(t, { src: false, agents: { 'sec-a': [finding('sec-a-1')], 'sec-b': [] }, reviews: { 'sec-b': [{ id: 'sec-a-1', verdict: 'confirmed', reason: 'reproduced' }] } });
  const [f] = merge(ok.dir);
  assert.equal(f.agent, 'sec-a');
  assert.deepEqual(f.reviews, [{ agent: 'sec-b', verdict: 'confirmed', reason: 'reproduced' }]);
  assert.equal(f.status, 'confirmed');

  const bad = (opts, pattern) => assert.throws(() => merge(audit(t, { src: false, ...opts }).dir), pattern);
  bad({ agents: { 'sec-a': [finding('sec-a-1')] }, reviews: { 'sec-a': [{ id: 'sec-a-1', verdict: 'confirmed', reason: 'mine' }] } }, /cannot review its own/);
  bad({ agents: { 'sec-a': [finding('dup')], 'sec-b': [finding('dup')] } }, /Duplicate/);
  bad({ agents: { 'sec-a': [finding('x', { proof: '' })] } }, /needs proof/);
  bad({ agents: { 'sec-a': [finding('x', { severity: 'severe' })] } }, /severity/);
  bad({ agents: { 'sec-a': [finding('x')] }, reviews: { 'sec-b': [{ id: 'y', verdict: 'confirmed', reason: 'r' }] } }, /unknown finding/);
  bad({ agents: { 'sec-a': [finding('x')] }, reviews: { 'sec-b': [{ id: 'x', verdict: 'agree', reason: 'r' }] } }, /verdict/);
  bad({ agents: { 'sec-a': {} } }, /JSON array/);
});

test('CLI records the checked-out commit and writes a report of confirmed findings', t => {
  const { dir, sha } = audit(t, {
    agents: { 'sec-a': [finding('sec-a-1', { severity: 'low' }), finding('sec-a-2')], 'sec-b': [finding('sec-b-1', { severity: 'critical' })] },
    reviews: { 'sec-b': [{ id: 'sec-a-1', verdict: 'confirmed', reason: 'ok' }, { id: 'sec-a-2', verdict: 'rejected', reason: 'guarded' }], 'sec-a': [{ id: 'sec-b-1', verdict: 'confirmed', reason: 'ok' }] },
  });
  fs.writeFileSync(path.join(dir, 'scope.md'), 'Auth only.');
  const out = JSON.parse(execFileSync('node', [path.join(scripts, 'audit.mjs'), dir], { encoding: 'utf8' }));
  assert.deepEqual({ ...out, report: undefined }, { report: undefined, commit: sha, confirmed: 2, disputed: 0, unverified: 0, rejected: 1 });
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'findings.json'), 'utf8'));
  assert.equal(json.commit, sha);
  assert.equal(json.remote, 'https://github.com/Owner/Repo.git');
  const md = fs.readFileSync(out.report, 'utf8');
  assert.match(md, new RegExp(`Audited commit: ${sha}`));
  assert.match(md, /Source: infiltrate/);
  assert.match(md, /Auth only\./);
  assert.ok(md.indexOf('### sec-b-1') < md.indexOf('### sec-a-1'), 'sorted by severity');
  assert.match(md, /- sec-a-2 \(rejected, high\)/);
  assert.doesNotMatch(md, /secret/);
});

test('CLI fails when the audit checkout is gone', t => {
  const { dir } = audit(t, { src: false });
  assert.throws(() => finalize(dir), /src is missing/);
});

test('verify passes a minimal environment, not the caller\'s secrets', () => {
  const env = commandEnv({ PATH: '/bin', HOME: '/h', LANG: 'C', GITHUB_TOKEN: 't', AWS_SECRET_ACCESS_KEY: 's', npm_config_cache: '/c' });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/h', LANG: 'C', npm_config_cache: '/c', CI: '1' });
  assert.equal(commandEnv({ GITHUB_TOKEN: 't', DATABASE_URL: 'd' }, ['DATABASE_URL', 'MISSING']).DATABASE_URL, 'd');
  assert.equal(commandEnv({ GITHUB_TOKEN: 't' }, ['DATABASE_URL']).GITHUB_TOKEN, undefined);
});
