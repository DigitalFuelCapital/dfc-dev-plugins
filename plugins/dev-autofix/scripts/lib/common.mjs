// Small helpers and the runtime shared by every pr.mjs module.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateConfig } from '../state.mjs';
import { createRuntime as createMergeRuntime } from '../merge.mjs';

export const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
export const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
export const rootPath = config => fs.realpathSync(expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees'));
export const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRuntime(env = process.env) {
  const execute = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, ...options }).trimEnd();
  const gh = (args, options = {}) => execute('gh', args, options);
  let me = null; // the gh login cannot change within one run, so ask once
  return {
    git: (cwd, args, options = {}) => execute('git', ['-C', cwd, ...args], options),
    gh,
    ghPages: api => JSON.parse(gh(['api', '--paginate', '--slurp', api]) || '[]').flat(),
    readPR: (remote, number) => JSON.parse(gh(['pr', 'view', String(number), '-R', remote, '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,url,mergeCommit'])),
    login: () => (me ??= gh(['api', 'user', '--jq', '.login'])),
    today: () => new Date().toLocaleDateString('en-CA'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    // Long commands (install, prepare, verification) use merge.mjs's process-group runner and logs.
    merge: createMergeRuntime(env),
  };
}

export function repository(config, name) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === name);
  requireValue(repo, `Unknown repository ${name}`);
  return repo;
}
export const prefix = repo => repo.branchPrefix ?? 'fix/auto';
