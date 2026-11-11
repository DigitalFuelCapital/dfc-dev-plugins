// Command-line entry point for the dev-autofix helpers. The work lives in lib/:
//   common.mjs    shared helpers and the git/gh runtime
//   queue.mjs     the queue file
//   gate.mjs      the push gate
//   publish.mjs   worker briefs and publication
//   approval.mjs  review timeline and approval evidence
//   land.mjs      prepare, land, cleanup, remove-worktree
// Everything is re-exported here, so callers and tests import from pr.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateConfig } from './state.mjs';
import { createRuntime, prefix, read, repository, requireValue, rootPath } from './lib/common.mjs';
import { addFallbackEntry, addInbox, findEntry, lintQueue, nextEntry, queueFile, queueSkeleton, setStatus, writeText } from './lib/queue.mjs';
import { gate } from './lib/gate.mjs';
import { publish, renderBrief } from './lib/publish.mjs';
import { buildApprovalInput } from './lib/approval.mjs';
import { cleanup, land, prepare, removeWorktree } from './lib/land.mjs';

export * from './lib/common.mjs';
export * from './lib/queue.mjs';
export * from './lib/gate.mjs';
export * from './lib/publish.mjs';
export * from './lib/approval.mjs';
export * from './lib/land.mjs';

const USAGE = `Usage:
  pr.mjs queue init <config>
  pr.mjs queue lint <config>
  pr.mjs queue next <config> <repo>
  pr.mjs queue set-status <config> <slug> <status>
  pr.mjs queue inbox <config> <one-line item>
  pr.mjs queue add-fallback <config> <repo> <slug> <title>
  pr.mjs brief <config> <repo> <slug>
  pr.mjs gate <config> <repo> <repoToken> run <slug>
  pr.mjs gate <config> <repo> <repoToken> finish <pr-number>
  pr.mjs publish <config> <repo> <repoToken> <runToken> <startedAt> <slug> [--max-diff <N>]
  pr.mjs prepare <config> <repo> <repoToken> [--head <branch> | --deps-only]
  pr.mjs land <config> <repo> <repoToken> <pr-number>
  pr.mjs approval-input <config> <repo> <pr-number> <out-file>
  pr.mjs cleanup <config> <repo> <repoToken> <pr-number> [verification-id]
  pr.mjs remove-worktree <config> <repo> <repoToken>`;

export async function main(argv, runtime = createRuntime()) {
  const [command, ...args] = argv;
  if (command === 'queue') {
    const [action, configFile, ...rest] = args;
    const config = validateConfig(read(configFile)), file = queueFile(configFile, config);
    if (action === 'init') {
      // Never overwrites: an existing queue is linted instead, so init is safe to repeat.
      if (fs.existsSync(file)) return { created: false, file, ...lintQueue(fs.readFileSync(file, 'utf8'), config) };
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeText(file, queueSkeleton(config));
      return { created: true, file };
    }
    const text = fs.readFileSync(file, 'utf8');
    if (action === 'lint') return { file, ...lintQueue(text, config) };
    if (action === 'next') { const entry = nextEntry(text, rest[0]); return entry ? { slug: entry.slug, kind: entry.kind, statedSize: entry.statedSize, title: entry.title } : { slug: null }; }
    if (action === 'set-status') { writeText(file, setStatus(text, rest[0], rest.slice(1).join(' '))); return { slug: rest[0], status: rest.slice(1).join(' ') }; }
    if (action === 'inbox') { writeText(file, addInbox(text, rest.join(' '))); return 'Inbox item added'; }
    if (action === 'add-fallback') { const [repoName, slug, ...title] = rest; repository(config, repoName); writeText(file, addFallbackEntry(text, repoName, slug, title.join(' '), runtime.today())); return { slug, status: 'fallback' }; }
    throw new Error(USAGE);
  }
  const [configFile, name, ...rest] = args;
  requireValue(configFile && name, USAGE);
  const config = read(configFile), repo = repository(config, name), root = rootPath(config);
  switch (command) {
    case 'brief': {
      const entry = findEntry(fs.readFileSync(queueFile(configFile, config), 'utf8'), rest[0]);
      requireValue(entry.repo === repo.name, `${entry.slug} belongs to ${entry.repo}`);
      const template = fs.readFileSync(new URL('../references/fix-brief.md', import.meta.url), 'utf8');
      const { branch, prFile, brief } = renderBrief({ config, repo, entry, worktree: path.join(root, repo.name), root, date: runtime.today(), template });
      const briefFile = path.join(root, 'briefs', `${entry.slug}.md`);
      fs.mkdirSync(path.dirname(briefFile), { recursive: true });
      fs.mkdirSync(path.dirname(prFile), { recursive: true });
      fs.writeFileSync(briefFile, brief);
      return { slug: entry.slug, branch, prFile, briefFile };
    }
    case 'gate': {
      const [token, mode, target] = rest;
      requireValue(mode === 'run' || mode === 'finish', USAGE);
      if (mode === 'run') {
        const entry = findEntry(fs.readFileSync(queueFile(configFile, config), 'utf8'), target);
        return gate({ config, repo, token, mode, statedSize: entry.statedSize }, runtime);
      }
      const pr = runtime.readPR(repo.remote, Number(target));
      requireValue(pr.headRefName.startsWith(`${prefix(repo)}-`) && !pr.isCrossRepository, 'Not a same-repository autofix PR');
      return gate({ config, repo, token, mode, headRef: pr.headRefName }, runtime);
    }
    case 'publish': {
      const [repoToken, runToken, startedAt, slug, flag, value] = rest;
      requireValue(flag === undefined || (flag === '--max-diff' && /^\d+$/.test(value ?? '')), USAGE);
      return publish({ configFile, config, repo, repoToken, runToken, startedAt, slug, maxDiff: flag ? Number(value) : null }, runtime);
    }
    case 'approval-input': {
      const [number, out] = rest;
      const result = buildApprovalInput({ config, repo, number: Number(number), root }, runtime);
      if (result.input) { fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true }); fs.writeFileSync(out, `${JSON.stringify(result.input, null, 2)}\n`); }
      const { input, ...summary } = result;
      return { ...summary, inputFile: input ? path.resolve(out) : null };
    }
    case 'cleanup': return cleanup({ configFile, config, repo, token: rest[0], number: Number(rest[1]), verificationId: rest[2] }, runtime);
    case 'prepare': {
      const [token, flag, head] = rest;
      requireValue(flag === undefined || (flag === '--head' && head) || (flag === '--deps-only' && head === undefined), USAGE);
      return prepare({ config, repo, token, head: flag === '--head' ? head : null, depsOnly: flag === '--deps-only' }, runtime);
    }
    case 'land': return land({ configFile, config, repo, token: rest[0], number: Number(rest[1]) }, runtime);
    case 'remove-worktree': return removeWorktree({ configFile, config, repo, token: rest[0] }, runtime);
    default: throw new Error(USAGE);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = await main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (result && typeof result === 'object' && (result.ok === false || result.removed === false)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
