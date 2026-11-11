import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkRuntime, githubRemote, validateConfig } from './state.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const shaOK = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);

// Signs an empty, unreferenced commit in the real repo (a harmless loose object) with the
// user's own signing config, then applies the publish gate's own `git verify-commit` check.
export function probeSigning(repoPath, git) {
  const tree = git(repoPath, ['hash-object', '-t', 'tree', '-w', '--stdin'], { input: '' });
  const commit = git(repoPath, ['commit-tree', '-S', tree, '-m', 'dev-autofix signing probe'], { timeout: 60000 });
  requireValue(shaOK(commit) && /^gpgsig(?:-sha256)? /m.test(git(repoPath, ['cat-file', 'commit', commit])), 'Probe commit carries no signature');
  try { git(repoPath, ['verify-commit', commit]); return { verified: true }; } catch { return { verified: false }; }
}

export function createRuntime(env = process.env) {
  const execute = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, timeout: 15000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trimEnd();
  const git = (cwd, args, options) => execute('git', ['-C', cwd, ...args], options);
  return {
    publishingHost: env.GH_HOST ?? 'github.com',
    checkRuntime: () => checkRuntime(),
    git,
    login: () => execute('gh', ['api', 'user', '--jq', '.login']),
    permission: repo => JSON.parse(execute('gh', ['repo', 'view', `https://github.com/${repo.remote}`, '--json', 'viewerPermission'])).viewerPermission,
    readBase: repo => {
      const ref = `refs/heads/${repo.baseBranch}`;
      git(repo.path, ['check-ref-format', ref]);
      const rows = git(repo.path, ['ls-remote', '--exit-code', '--refs', 'origin', ref]).split('\n').map(row => row.split('\t')).filter(([, name]) => name === ref);
      requireValue(rows.length === 1 && shaOK(rows[0][0]), 'Cannot determine configured remote base');
      return rows[0][0];
    },
    signingProbe: repo => probeSigning(repo.path, git),
  };
}

export async function preflight(config, names = [], runtime = createRuntime()) {
  validateConfig(config);
  requireValue(Array.isArray(names) && names.every(nonempty), 'Repository filters must be names');
  for (const name of names) requireValue(config.repos.some(repo => repo.name === name), `Unknown repository ${name}`);
  const repos = names.length ? config.repos.filter(repo => names.includes(repo.name)) : config.repos;
  const checks = [], warnings = [];
  // Raw errors may carry key or auth details; report only the fixed failure message.
  const check = async (repo, name, action, failure) => {
    try { const result = await action(); checks.push({ repo, check: name, ok: true }); return result ?? true; }
    catch { checks.push({ repo, check: name, ok: false, message: failure }); return null; }
  };
  // Platform and Git version first: an old Git otherwise fails mid-run with usage text.
  if (runtime.checkRuntime) {
    try { runtime.checkRuntime(); checks.push({ repo: null, check: 'runtime', ok: true }); }
    catch (error) { checks.push({ repo: null, check: 'runtime', ok: false, message: error.message }); }
  }
  const hostOK = (runtime.publishingHost ?? 'github.com').toLowerCase() === 'github.com';
  checks.push({ repo: null, check: 'publishing-host', ok: hostOK, ...(hostOK ? {} : { message: 'gh must target github.com' }) });
  const author = hostOK ? await check(null, 'identity', () => { const login = runtime.login(); requireValue(nonempty(login), 'No login'); return login; }, 'Cannot resolve the gh login; authenticate gh first') : null;
  const reviewers = config.reviewers ?? (author ? [author] : []);
  const authorIsReviewer = author !== null && reviewers.some(login => login.toLowerCase() === author.toLowerCase());
  if (author && !authorIsReviewer) warnings.push(`gh author ${author} is not in reviewers; fine for run, but its review comments cannot authorize finish.`);
  // Signing config is almost always global, so one probe covers the batch.
  if (repos.length) {
    const signing = await check(null, 'signing', () => runtime.signingProbe(repos[0]), 'Cannot create a signed commit; check the signing key and agent');
    // publish requires `git verify-commit`, so an unverifiable signature fails here, not after the work.
    if (signing) checks.push({ repo: null, check: 'signature-verify', ok: signing.verified === true, ...(signing.verified === true ? {} : { message: 'Probe commit is signed but git verify-commit rejects it, so publish would fail. SSH: set gpg.ssh.allowedSignersFile to a file listing your key. GPG: trust the signing key.' }) });
  }
  for (const repo of repos) {
    const origin = await check(repo.name, 'origin', () => requireValue(githubRemote(runtime.git(repo.path, ['remote', 'get-url', 'origin'])) === repo.remote.toLowerCase(), 'Wrong origin'), 'Origin does not match the configured repository');
    if (origin) await check(repo.name, 'remote-base', () => requireValue(shaOK(runtime.readBase(repo)), 'Invalid remote base'), 'Cannot read the remote base; check Git access and baseBranch');
    if (author) await check(repo.name, 'push-permission', () => requireValue(['WRITE', 'MAINTAIN', 'ADMIN'].includes(runtime.permission(repo)), 'No push permission'), 'gh login lacks write permission on this repository');
  }
  return { ok: checks.every(item => item.ok), author, reviewers, authorIsReviewer, checks, warnings };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [configFile, ...names] = process.argv.slice(2);
    requireValue(nonempty(configFile), 'Usage: preflight.mjs <config-file> [repo-name ...]');
    const result = await preflight(JSON.parse(fs.readFileSync(configFile, 'utf8')), names);
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
