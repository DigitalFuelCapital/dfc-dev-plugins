import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateConfig } from '../scripts/state.mjs';
import { DEFAULT_DEPLOY_PATTERNS, MALWARE_PATTERNS, MALWARE_SIGNATURES, RISKY_CONSTRUCTS, checkPRFile, forbiddenPath, gatePatterns, renderBrief } from '../scripts/pr.mjs';

const matches = (patterns, line) => patterns.some(pattern => pattern.test(line));

test('signatures of a known campaign stop the run; constructs malware also uses only block the entry', () => {
  const { malware, risky } = gatePatterns();
  for (const line of ["const k = process.env.AUTH_API_KEY", "fetch('https://api.trongrid.io/v1')", "global['!'] = 1", 'atob(process.env.X)', 'start config.bat']) {
    assert.ok(matches(malware, line), line);
    assert.ok(!matches(risky, line), line);
  }
  for (const line of ["import { createRequire } from 'node:module'", 'const f = eval(code)', 'return new Function(body)']) {
    assert.ok(matches(risky, line), line);
    assert.ok(!matches(malware, line), line);
  }
  for (const line of ['retrieval(x)', 'obj.eval(x)', 'const evaluate = 1', 'createRequest()']) assert.ok(!matches([...malware, ...risky], line), line);
  assert.deepEqual(MALWARE_PATTERNS, Object.values(MALWARE_SIGNATURES));
  assert.deepEqual(Object.keys(MALWARE_SIGNATURES).filter(id => id in RISKY_CONSTRUCTS), []);
});

test('built-in patterns are switched off by id, and blockPatterns join the stop-the-run tier', () => {
  const custom = gatePatterns({ disabledPatterns: ['create-require', 'auth-api-key'], blockPatterns: ['internal-only-host'] });
  assert.ok(!matches(custom.risky, 'createRequire(import.meta.url)'));
  assert.ok(matches(custom.risky, 'eval(x)'));
  assert.ok(!matches(custom.malware, 'process.env.AUTH_API_KEY'));
  assert.ok(matches(custom.malware, 'https://internal-only-host/x'));
  assert.throws(() => gatePatterns({ disabledPatterns: ['createRequire'] }), /unknown pattern id createRequire; known ids: .*create-require/);
});

test('protected files cover dependency manifests, lockfiles, CI, build files and package manager config in any ecosystem', () => {
  const refused = {
    'pyproject.toml': 'dependency manifest', 'services/api/requirements-dev.txt': 'dependency manifest', 'go.mod': 'dependency manifest', 'crates/x/Cargo.toml': 'dependency manifest',
    'Gemfile': 'dependency manifest', 'pom.xml': 'dependency manifest', 'build.gradle.kts': 'dependency manifest',
    'uv.lock': 'uv.lock', 'poetry.lock': 'poetry.lock', 'go.sum': 'go.sum', 'Cargo.lock': 'Cargo.lock', 'Gemfile.lock': 'Gemfile.lock',
    '.npmrc': 'package manager config', 'apps/web/.yarnrc.yml': 'package manager config',
    'Makefile': 'build file', 'docker/Dockerfile.prod': 'build file', 'api.dockerfile': 'build file', 'docker-compose.override.yml': 'build file', 'compose.yaml': 'build file', 'justfile': 'build file',
    '.github/workflows/ci.yml': '.github', 'x/.husky/pre-commit': '.husky', '.circleci/config.yml': '.circleci', '.gitlab-ci.yml': '.gitlab-ci.yml', '.pre-commit-config.yaml': '.pre-commit-config.yaml',
    'package.json': 'package.json', '.gitignore': '.gitignore', 'apps/web/.env.local': '.env*', 'bin/run.sh': 'script', 'tsconfig.build.json': 'build/lint config',
    '.gitmodules': '.gitmodules', 'webpack.config.js': 'build/lint config', 'apps/web/jest.config.ts': 'build/lint config', 'vitest.config.mts': 'build/lint config', '.babelrc': 'build/lint config', 'tailwind.config.cjs': 'build/lint config',
  };
  for (const [file, why] of Object.entries(refused)) assert.equal(forbiddenPath(file), why, file);
  for (const file of ['src/makefile_parser.py', 'docs/Dockerfile.md', 'src/requirements.py', 'app/compose.tsx', 'src/setup.ts', 'README.md', 'internal/go.mod.go']) assert.equal(forbiddenPath(file), null, file);
});

test('protectedPaths adds project patterns, globally and per repo, and the brief tells the worker', () => {
  const config = { protectedPaths: ['^db/migrations/'], maxDiffLines: 150 }, repo = { name: 'app', path: '/tmp/app', baseBranch: 'main', verify: ['true'], protectedPaths: ['\\.generated\\.ts$'] };
  assert.equal(forbiddenPath('db/migrations/001.sql', repo, config), 'protectedPaths /^db/migrations//');
  assert.equal(forbiddenPath('src/api.generated.ts', repo, config), 'protectedPaths /\\.generated\\.ts$/');
  assert.equal(forbiddenPath('src/db/migrations.ts', repo, config), null);
  assert.equal(forbiddenPath('src/api.generated.ts', {}, config), null, 'a repo pattern applies to that repo only');
  const template = fs.readFileSync(new URL('../references/fix-brief.md', import.meta.url), 'utf8');
  const entry = { slug: 'one', text: '### one · app · Title' };
  const brief = values => renderBrief({ config: values.config, repo: values.repo, entry, worktree: '/tmp/wt', root: '/tmp/root', date: '2026-11-11', template }).brief;
  assert.match(brief({ config, repo }), /protected patterns: `\^db\/migrations\/`, `\\\.generated\\\.ts\$`\./);
  assert.match(brief({ config: {}, repo: { ...repo, protectedPaths: undefined } }), /protected patterns: none\./);
  assert.doesNotMatch(brief({ config, repo }), /\{\{/);
});

test('config validation rejects patterns that do not compile and ids that are not strings', () => {
  const base = { version: 1, worktreeRoot: path.join(os.homedir(), '.claude', 'autofix', 'worktrees'), repos: [{ name: 'repo', path: os.tmpdir(), remote: 'owner/repo', baseBranch: 'main', verify: ['true'] }] };
  assert.ok(validateConfig({ ...base, protectedPaths: ['^db/'], deployPatterns: ['fly deploy \\S+'], blockPatterns: ['x'], disabledPatterns: ['eval'], repos: [{ ...base.repos[0], protectedPaths: ['\\.sql$'] }] }));
  for (const key of ['protectedPaths', 'deployPatterns', 'blockPatterns']) {
    for (const value of ['^db/', ['('], [''], [3]]) assert.throws(() => validateConfig({ ...base, [key]: value }), new RegExp(`${key} must be a list of regular expressions`), `${key} ${JSON.stringify(value)}`);
  }
  assert.throws(() => validateConfig({ ...base, repos: [{ ...base.repos[0], protectedPaths: ['['] }] }), /repo: protectedPaths/);
  assert.throws(() => validateConfig({ ...base, disabledPatterns: 'eval' }), /disabledPatterns/);
});

test('the deploy-step check uses the configured patterns', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-deploy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pr.md');
  const entry = '- plan: 1. edit\n- watch-outs: run `fly deploy --app api-prod` and `npx supabase functions deploy alpha-fn` after merge';
  fs.writeFileSync(file, 'Fix alpha\n\nChanged a.txt.\n');
  assert.deepEqual(DEFAULT_DEPLOY_PATTERNS.length, 1);
  assert.deepEqual(checkPRFile(file, entry).problems, ['PR body must name the deploy step: supabase functions deploy alpha-fn']);
  const config = { deployPatterns: ['fly deploy --app [\\w-]+'] };
  assert.deepEqual(checkPRFile(file, entry, config).problems, ['PR body must name the deploy step: fly deploy --app api-prod']);
  fs.writeFileSync(file, 'Fix alpha\n\n**Deploy:** `fly deploy --app api-prod`\n');
  assert.deepEqual(checkPRFile(file, entry, config).problems, []);
  assert.deepEqual(checkPRFile(file, entry, { deployPatterns: [] }).problems, []);
});
