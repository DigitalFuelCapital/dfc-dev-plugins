// Read-only check of a task branch before it is pushed. dev-autotask has no push gate like
// dev-autofix's (a large task may legitimately touch package.json or CI), so this refuses only
// what is never right to publish: uncommitted work, a known malware signature, a credential, a
// committed .env file, or an unsigned commit in a repository that requires signing. Sensitive
// files the branch touches are listed under `attention` for the PR body and the reviewer.
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './state.mjs';

// Same ids and patterns as MALWARE_SIGNATURES in dev-autofix's scripts/lib/gate.mjs. The plugins install
// separately, so the list is repeated here; tests/repo.test.mjs fails if the two drift.
export const MALWARE_SIGNATURES = {
  'global-bang': String.raw`global\[['"]!['"]\]`, 'fromcharcode-127': String.raw`String\.fromCharCode\(127\)`,
  'auth-api-key': 'AUTH_API_KEY', 'auth-confirm-nine': 'auth-confirm-nine', 'trongrid': String.raw`api\.trongrid\.io`,
  'bsc-dataseed': 'bsc-dataseed', 'aptoslabs': String.raw`aptoslabs\.com`, 'atob-env': String.raw`atob\(process\.env`,
  'config-bat': String.raw`config\.bat`,
};
// High-precision credential shapes only; a miss here is what review and secret scanning are for.
export const SECRET_PATTERNS = {
  'private-key': String.raw`-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----`,
  'github-token': String.raw`\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})`,
  'aws-access-key': String.raw`\bAKIA[0-9A-Z]{16}\b`,
  'anthropic-key': String.raw`\bsk-ant-[A-Za-z0-9_-]{20,}`,
  'openai-key': String.raw`\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}`,
  'slack-token': String.raw`\bxox[abprs]-[A-Za-z0-9-]{20,}`,
  'slack-webhook': String.raw`hooks\.slack\.com/services/[A-Za-z0-9/]{20,}`,
};
const ENV_FILE = /^\.env(\..+)?$/, ENV_TEMPLATE = /\.(example|sample|template|dist)$/;
const ATTENTION = [
  [/(^|\/)(\.github|\.husky|\.circleci)\/|(^|\/)(\.gitlab-ci\.yml|\.pre-commit-config\.yaml)$/, 'CI or hook config'],
  [/(^|\/)(package\.json|pyproject\.toml|requirements[^/]*\.txt|go\.mod|Cargo\.toml|Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/, 'dependency manifest'],
  [/(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/, 'lockfile'],
  [/(^|\/)(\.npmrc|\.yarnrc(\.yml)?)$/, 'package manager config'],
  [/\.(sh|bash|zsh|ps1|bat|cmd)$/i, 'script'],
  [/(^|\/)(makefile|justfile|dockerfile(\.(?!md$)[^/]+)?|[^/]+\.dockerfile|(docker-)?compose(\.[^/]+)?\.ya?ml)$/i, 'build file'],
];

const defaultGit = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
const compile = table => Object.entries(table).map(([id, source]) => [id, new RegExp(source)]);

export function publishCheck({ worktree, baseBranch, disabledPatterns = [] }, git = defaultGit) {
  const failures = [], attention = new Map();
  const fail = (check, detail) => failures.push({ check, detail });
  const base = `refs/remotes/origin/${baseBranch}`;
  const branch = git(worktree, ['branch', '--show-current']);
  if (!branch.startsWith('dev/autotask-')) fail('shape', `on '${branch || 'a detached HEAD'}', expected a dev/autotask-<id> branch`);
  const dirty = git(worktree, ['status', '--porcelain']);
  if (dirty) fail('clean', `uncommitted changes: ${dirty.split('\n').slice(0, 10).join('; ')}`);
  // Merges too: `finish` merges the base in to resolve conflicts, and a resolution can add anything.
  const commits = git(worktree, ['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
  const merges = new Set(git(worktree, ['rev-list', '--merges', `${base}..HEAD`]).split('\n').filter(Boolean));
  if (!commits.length) fail('shape', `no commits ahead of origin/${baseBranch}`);
  const mustSign = (() => { try { return git(worktree, ['config', '--get', '--type=bool', 'commit.gpgsign']) === 'true'; } catch { return false; } })();
  const unsigned = [];
  // config.disabledPatterns (shared with dev-autofix) switches a built-in signature off by id.
  const malware = compile(MALWARE_SIGNATURES).filter(([id]) => !disabledPatterns.includes(id)), secrets = compile(SECRET_PATTERNS);
  const ancestor = (a, b) => { try { git(worktree, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  const checkFiles = (short, files, what) => {
    for (const file of files.split('\0').filter(Boolean)) {
      const name = path.posix.basename(file);
      if (ENV_FILE.test(name) && !ENV_TEMPLATE.test(name)) fail('env-file', `${short} ${what} ${file}; .env files hold secrets and must not be published`);
      for (const [pattern, label] of ATTENTION) if (pattern.test(file)) attention.set(file, label);
    }
  };
  const scanPatch = (short, patch) => {
    let file = null;
    for (const line of patch.split('\n')) {
      if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
      if (!line.startsWith('+')) continue;
      const added = line.slice(1);
      for (const [id, pattern] of malware) if (pattern.test(added)) fail('malware', `${short} ${file}: malware signature ${id}`);
      // Never echo the matched text: the output of this check ends up in transcripts and reports.
      for (const [id, pattern] of secrets) if (pattern.test(added)) fail('secret', `${short} ${file}: looks like a ${id}`);
    }
  };
  // Every commit, not just the net diff: a secret added and removed again is still published.
  for (const commit of commits) {
    const short = commit.slice(0, 8);
    try { git(worktree, ['verify-commit', commit]); } catch { unsigned.push(short); }
    if (merges.has(commit)) {
      const parents = git(worktree, ['rev-list', '--parents', '-n1', commit]).split(' ').slice(1);
      // Git skips --remerge-diff for octopus merges, so their content could not be inspected.
      if (parents.length !== 2) { fail('shape', `merge ${short} has ${parents.length} parents; only a two-parent merge of origin/${baseBranch} can be checked`); continue; }
      // Only the base may be merged in; anything else would publish unreviewed history.
      if (!ancestor(parents[1], base)) fail('shape', `merge ${short} pulls in ${parents[1].slice(0, 8)}, which is not on origin/${baseBranch}`);
      // --remerge-diff shows what the merge itself changed beyond a clean automatic merge.
      // --no-renames: a rename (.env.example -> .env) is then an added .env, not an R entry.
      checkFiles(short, git(worktree, ['show', '--remerge-diff', '--no-renames', '--format=', '--name-only', '--diff-filter=AM', '-z', commit]), 'resolves a merge with');
      scanPatch(short, git(worktree, ['show', '--remerge-diff', '--no-renames', '--format=', '-U0', commit]));
      continue;
    }
    checkFiles(short, git(worktree, ['diff-tree', '--no-renames', '--no-commit-id', '--root', '-r', '--name-only', '--diff-filter=AM', '-z', commit]), 'commits');
    scanPatch(short, git(worktree, ['diff-tree', '--no-renames', '--no-commit-id', '--root', '-r', '-p', '-U0', commit]));
  }
  if (mustSign && unsigned.length) fail('signed', `commit.gpgsign is on for this repository, but these commits have no valid signature: ${unsigned.join(' ')}`);
  return {
    ok: failures.length === 0, malware: failures.some(item => item.check === 'malware'), branch, head: git(worktree, ['rev-parse', 'HEAD']), commits: commits.length,
    signing: { required: mustSign, unsigned }, failures, attention: [...attention].map(([file, why]) => ({ file, why })),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [worktree, configFile, repo] = process.argv.slice(2);
    if (!worktree || !configFile || !repo) throw new Error('Usage: publish-check.mjs <worktree> <config-file> <repo-name>');
    const config = loadConfig(configFile, { repo });
    const result = publishCheck({ worktree: path.resolve(worktree), baseBranch: config.repo.baseBranch, disabledPatterns: config.disabledPatterns });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
