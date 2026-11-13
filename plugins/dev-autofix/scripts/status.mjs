// Read-only summary of an autofix workspace: budget, queue, last run, locks, worktrees and
// recovery folders. Takes no locks, never calls gh and writes nothing; it runs only
// `git --version` (the runtime check) and `du` (recovery folder sizes). The budget comes
// from lib/budget.mjs, the same gate /dev-autofix:run uses.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkRuntime, inspectLock, listRecovery, validateConfig } from './state.mjs';
import { lintQueue, nextEntry, parseQueue, queueFile } from './lib/queue.mjs';
import { expand } from './lib/common.mjs';
import { readBudget } from './lib/budget.mjs';

export { budgetState } from './lib/budget.mjs';

const readJSON = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };

const STATUS_WORDS = ['ready', 'needs-human', 'blocked', 'pushed', 'pr-open', 'merged', 'fallback'];
export function queueSummary(text, config) {
  const entries = parseQueue(text);
  const repos = config.repos.map(repo => {
    const counts = Object.fromEntries([...STATUS_WORDS, 'other'].map(word => [word, 0]));
    for (const entry of entries.filter(item => item.repo === repo.name)) {
      const word = entry.status.replace(/\s*\(.*$/, '');
      counts[STATUS_WORDS.includes(word) ? word : 'other']++;
    }
    // `next` is what run would take now; ready entries can still be waiting on `after:`.
    return { repo: repo.name, ...counts, next: nextEntry(text, repo.name)?.slug ?? null };
  });
  const lint = lintQueue(text, config);
  return { entries: entries.length, repos, needsHuman: entries.filter(entry => entry.status.startsWith('needs-human')).map(entry => ({ slug: entry.slug, repo: entry.repo, decision: /\((.*)\)$/.exec(entry.status)?.[1] ?? '' })), lint: { ok: lint.ok, errors: lint.errors, warnings: lint.warnings.length } };
}

export function status(configFile, { now = Date.now(), runtimeCheck = checkRuntime, writer } = {}) {
  const file = path.resolve(configFile);
  const config = validateConfig(readJSON(file) ?? (() => { throw new Error(`Cannot read ${file}`); })());
  const root = expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees');
  const result = { config: file, worktreeRoot: root };
  try { result.runtime = { ok: true, ...runtimeCheck() }; } catch (error) { result.runtime = { ok: false, error: error.message }; }
  result.budget = readBudget(config, { now, writer });
  const queue = queueFile(file, config);
  result.queue = fs.existsSync(queue) ? { file: queue, ...queueSummary(fs.readFileSync(queue, 'utf8'), config) } : { file: queue, missing: true };
  const manifest = readJSON(path.join(root, 'last-run.json'));
  result.lastRun = manifest && Array.isArray(manifest.prs) ? { startedAt: manifest.startedAt, prs: manifest.prs } : null;
  result.locks = [];
  const locks = path.join(root, '.locks');
  for (const name of fs.existsSync(locks) ? fs.readdirSync(locks).sort() : []) {
    if (name.includes('.abandoned-')) continue;
    try {
      const { owner, createdAt } = inspectLock(path.join(locks, name));
      result.locks.push({ name, createdAt, owner: owner ? { session: owner.session, command: owner.command, host: owner.host, pid: owner.pid } : null });
    } catch (error) {
      // A lock released while we looked is simply gone; anything else is reported, not hidden.
      if (error.code !== 'ENOENT') result.locks.push({ name, error: error.message });
    }
  }
  result.worktrees = config.repos.map(repo => ({ repo: repo.name, path: path.join(root, repo.name), exists: fs.existsSync(path.join(root, repo.name)) }));
  result.recovery = fs.existsSync(root) ? listRecovery(config) : { entries: [], allocatedBytes: 0 };
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (!process.argv[2]) throw new Error('Usage: status.mjs <config-file>');
    console.log(JSON.stringify(status(process.argv[2]), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
