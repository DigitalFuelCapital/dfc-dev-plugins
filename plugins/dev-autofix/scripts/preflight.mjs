import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { githubRemote, validateConfig } from './state.mjs';
import { createRuntime as createCommandRuntime } from './merge.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
const TIMEOUT_MS = 15000;
const SIGNING_KEYS = [
  'user.name', 'user.email', 'user.signingkey', 'commit.gpgsign', 'gpg.format',
  'gpg.program', 'gpg.openpgp.program', 'gpg.x509.program', 'gpg.ssh.program',
  'gpg.ssh.defaultKeyCommand', 'gpg.ssh.allowedSignersFile', 'gpg.ssh.revocationFile',
  'gpg.minTrustLevel',
];

function commandEnvironment(env) {
  const result = { ...env };
  // Keep authentication/agent variables, but never let an inherited Git path direct
  // the disposable probe's writes into the user's checkout or object store.
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE']) delete result[name];
  return result;
}

function optionalConfig(git, repoPath, key, pathValue = false) {
  try { return git(repoPath, ['config', ...(pathValue ? ['--path'] : []), '--get', key]); }
  catch (error) { if (error.status === 1 && !error.stdout?.trim()) return null; throw error; }
}

// The probe signs an empty, unreferenced commit in a disposable repository. It never
// changes the source checkout, index, refs, configuration, or published history.
export async function probeSigning(repo, { git, env = process.env, run } = {}) {
  requireValue(typeof git === 'function', 'Signing probe requires Git access');
  git(repo.path, ['var', 'GIT_AUTHOR_IDENT']);
  git(repo.path, ['var', 'GIT_COMMITTER_IDENT']);
  const format = optionalConfig(git, repo.path, 'gpg.format') ?? 'openpgp';
  requireValue(['openpgp', 'ssh', 'x509'].includes(format), 'Unsupported Git signing format');
  const settings = new Map();
  for (const key of SIGNING_KEYS) {
    const pathValue = ['gpg.ssh.allowedSignersFile', 'gpg.ssh.revocationFile'].includes(key);
    let value = optionalConfig(git, repo.path, key, pathValue);
    if (value === null) continue;
    if (pathValue && !path.isAbsolute(value)) value = path.resolve(repo.path, value);
    if (format === 'ssh' && key === 'user.signingkey' && !value.startsWith('key::') && !value.startsWith('ssh-')) {
      value = value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(repo.path, value);
    }
    if (/^gpg\.(?:(?:openpgp|x509|ssh)\.)?program$/.test(key) && value.includes('/') && !path.isAbsolute(value)) value = path.resolve(repo.path, value);
    settings.set(key, value);
  }
  requireValue(format !== 'ssh' || nonempty(settings.get('gpg.ssh.allowedSignersFile')), 'SSH signing needs gpg.ssh.allowedSignersFile for trusted verification');
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-signing-')));
  if (format === 'ssh' && settings.has('gpg.ssh.defaultKeyCommand')) {
    // Git parses defaultKeyCommand into argv rather than executing shell syntax.
    // A disposable wrapper changes only cwd, then preserves the original argv.
    const selector = path.join(directory, 'source-key-selector');
    fs.writeFileSync(selector, `#!/bin/sh\ncd ${shellQuote(repo.path)} || exit 1\nexec "$@"\n`, { mode: 0o700, flag: 'wx' });
    settings.set('gpg.ssh.defaultKeyCommand', `${shellQuote(selector)} ${settings.get('gpg.ssh.defaultKeyCommand')}`);
  }
  const probeEnv = commandEnvironment(env);
  const runner = run ?? createCommandRuntime(probeEnv).run;
  const configArgs = [...settings].flatMap(([key, value]) => ['-c', `${key}=${value}`]);
  const execute = async args => {
    const id = randomUUID();
    const output = path.join(directory, `${id}.out`), log = path.join(directory, `${id}.log`);
    const command = ['git', '-C', directory, ...configArgs, ...args].map(shellQuote).join(' ') + ` > ${shellQuote(output)}`;
    const result = await runner(command, directory, log, TIMEOUT_MS);
    requireValue(result.exitCode === 0 && !result.signal && result.timedOut === false, 'Signing or trusted verification failed; check the configured signer, agent and trust setup');
    return fs.readFileSync(output, 'utf8').trimEnd();
  };
  try {
    await execute(['init', '--bare', '--quiet', '--template=']);
    const tree = await execute(['hash-object', '-w', '-t', 'tree', '--stdin']);
    requireValue(shaOK(tree), 'Cannot create disposable signing probe');
    const commit = await execute(['commit-tree', '-S', tree, '-m', 'Dev Autofix signing readiness probe']);
    requireValue(shaOK(commit), 'Signing did not create a commit');
    await execute(['verify-commit', commit]);
    requireValue(await execute(['show', '-s', '--format=%G?', commit]) === 'G', 'The probe signature is not trusted by the configured verifier');
    return { format, trusted: true };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

export function createRuntime(env = process.env) {
  const execute = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, timeout: TIMEOUT_MS, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trimEnd();
  const git = (cwd, args) => execute('git', ['-C', cwd, ...args]);
  return {
    publishingHost: env.GH_HOST ?? 'github.com',
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
    signingProbe: repo => probeSigning(repo, { git, env }),
  };
}

export async function preflight(config, names = [], runtime = createRuntime()) {
  validateConfig(config);
  requireValue(Array.isArray(names) && names.every(nonempty), 'Repository filters must be names');
  for (const name of names) requireValue(config.repos.some(repo => repo.name === name), `Unknown repository ${name}`);
  const repos = names.length ? config.repos.filter(repo => names.includes(repo.name)) : config.repos;
  const checks = [], limitations = [
    'A trusted local probe does not prove GitHub will mark the signing key/account verified or accept every repository rule.',
    'Publishing checks use the gh identity. A connector may publish as a different account; do not infer that its identity or permissions match.',
  ];
  let author = null;
  const check = async (repo, name, action, success, failure) => {
    try { const result = await action(); checks.push({ repo, check: name, ok: true, message: success }); return result; }
    catch { checks.push({ repo, check: name, ok: false, message: failure }); return null; }
  };
  const hostOK = (runtime.publishingHost ?? 'github.com').toLowerCase() === 'github.com';
  checks.push({ repo: null, check: 'publishing-host', ok: hostOK, message: hostOK ? 'gh targets github.com' : 'gh must target github.com to match the configured GitHub origins' });
  if (hostOK) author = await check(null, 'identity', () => { const login = runtime.login(); requireValue(nonempty(login), 'No login'); return login; }, 'Authenticated gh publishing identity resolved', 'Cannot resolve gh publishing identity; configure authentication before running workers');
  const reviewers = config.reviewers ?? (author ? [author] : []);
  requireValue(Array.isArray(reviewers) && reviewers.every(nonempty), 'reviewers must be GitHub login strings');
  const authorIsReviewer = author !== null && reviewers.some(login => login.toLowerCase() === author.toLowerCase());
  if (author && !authorIsReviewer) limitations.push('The gh publishing author is not a configured reviewer. This is valid for run, but its review comments cannot authorize finish.');
  for (const repo of repos) {
    const origin = await check(repo.name, 'origin', () => { requireValue(githubRemote(runtime.git(repo.path, ['remote', 'get-url', 'origin'])) === repo.remote.toLowerCase(), 'Wrong origin'); return true; }, 'Origin matches configured repository', 'Origin cannot be verified against the configured repository');
    if (origin) await check(repo.name, 'remote-base', () => { const base = runtime.readBase(repo); requireValue(shaOK(base), 'Invalid remote base'); return base; }, 'Configured remote base is readable', 'Cannot read configured remote base; check Git transport access and baseBranch');
    if (author && hostOK) await check(repo.name, 'push-permission', () => { requireValue(['WRITE', 'MAINTAIN', 'ADMIN'].includes(runtime.permission(repo)), 'No push permission'); }, 'gh identity has repository write permission', 'Cannot establish repository write permission for the gh identity');
    await check(repo.name, 'signing', async () => { const result = await runtime.signingProbe(repo); requireValue(result?.trusted === true, 'Signer was not verified'); }, 'Disposable commit signed and trusted locally', 'Signing preflight failed; check signer, agent and trusted verification setup');
  }
  return { ok: checks.every(item => item.ok), author, reviewers, authorIsReviewer, checks, limitations };
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
