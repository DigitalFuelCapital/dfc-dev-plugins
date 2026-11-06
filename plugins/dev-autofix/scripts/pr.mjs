import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { checkApproval, checkWorktree, recordPR, validateConfig } from './state.mjs';
import { checkVerifiedMerge, createRuntime as createMergeRuntime, installIfStale, releaseVerification, verifyMerge } from './merge.mjs';

const requireValue = (ok, message) => { if (!ok) throw new Error(message); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const shaOK = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const expand = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
const rootPath = config => fs.realpathSync(expand(config.worktreeRoot ?? '~/.claude/autofix/worktrees'));
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MARKER = '<!-- dev-autofix:review addressed=';
const DEFAULT_TOKENS = ['LGTM', '/merge'];
// Deleting a worktree with node_modules took over 120s in the live run; 30 minutes still bounds a hang.
export const WORKTREE_REMOVE_TIMEOUT_MS = 30 * 60 * 1000;

// KEY-DECISION 2026-09-27: one pattern list for run and finish gates; skills no longer carry grep blocks.
export const MALWARE_PATTERNS = [
  String.raw`global\[['"]!['"]\]`, String.raw`String\.fromCharCode\(127\)`, 'AUTH_API_KEY', 'auth-confirm-nine',
  String.raw`api\.trongrid\.io`, 'bsc-dataseed', String.raw`aptoslabs\.com`, 'createRequire',
  String.raw`(^|[^.A-Za-z_])eval\(`, String.raw`new Function\(`, String.raw`atob\(process\.env`, String.raw`config\.bat`,
];
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb'];
const SCRIPT = /\.(sh|bash|zsh|fish|command|bat|cmd|ps1|vbs)$/i;
const TOOL_CONFIG = /^(postcss\.config\..+|eslint\.config\..+|next\.config\..+|vite\.config\..+|tsconfig.*\.json|wrangler\..+|\.graphqlrc(\..+)?)$/;

export function forbiddenPath(file, repo = {}) {
  const base = path.posix.basename(file);
  const locks = [...LOCKFILES, path.posix.basename(repo.lockfile ?? 'package-lock.json')];
  if (base === '.gitignore' || base === 'package.json' || locks.includes(base)) return base;
  if (/^\.env/.test(base)) return '.env*';
  if (/(^|\/)\.(github|husky)\//.test(file)) return file.split('/').find(part => part === '.github' || part === '.husky');
  if (SCRIPT.test(base)) return 'script';
  if (TOOL_CONFIG.test(base)) return 'build/lint config';
  return null;
}

export function createRuntime(env = process.env) {
  const execute = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], timeout: 120000, ...options }).trimEnd();
  const gh = (args, options = {}) => execute('gh', args, options);
  return {
    git: (cwd, args, options = {}) => execute('git', ['-C', cwd, ...args], options),
    gh,
    ghPages: api => JSON.parse(gh(['api', '--paginate', '--slurp', api]) || '[]').flat(),
    readPR: (remote, number) => JSON.parse(gh(['pr', 'view', String(number), '-R', remote, '--json', 'number,state,isDraft,isCrossRepository,headRefName,headRefOid,baseRefName,url,mergeCommit'])),
    login: () => gh(['api', 'user', '--jq', '.login']),
    today: () => new Date().toLocaleDateString('en-CA'),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    // Long commands (install, prepare, verification) use merge.mjs's process-group runner and logs.
    merge: createMergeRuntime(env),
  };
}

function repository(config, name) {
  validateConfig(config);
  const repo = config.repos.find(item => item.name === name);
  requireValue(repo, `Unknown repository ${name}`);
  return repo;
}
const prefix = repo => repo.branchPrefix ?? 'fix/auto';

// ---------------------------------------------------------------- queue

export function queueFile(configFile, config) {
  return path.resolve(path.dirname(path.resolve(configFile)), config.queuePath ?? 'AUTOFIX_QUEUE.md');
}

function writeText(file, text) {
  const temp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temp, text, { flag: 'wx' }); fs.renameSync(temp, file); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}

export function parseQueue(text) {
  const blocks = text.split(/^(?=### )/m).filter(block => block.startsWith('### '));
  return blocks.map(block => {
    const [head, ...rest] = block.replace(/\n## [\s\S]*$/, '').trimEnd().split('\n');
    const [slug, repo, ...title] = head.slice(4).split(' · ');
    const field = key => rest.find(line => line.startsWith(`- ${key}:`))?.slice(key.length + 3).trim() ?? '';
    const size = /size:\s*~?(\d+)/.exec(field('risk'));
    return { slug: slug.trim(), repo: repo?.trim(), title: title.join(' · '), status: field('status'), kind: field('kind'), after: field('after'), statedSize: size ? Number(size[1]) : null, text: [head, ...rest].join('\n') };
  });
}

export function nextEntry(text, repoName) {
  const entries = parseQueue(text);
  const merged = new Set(entries.filter(entry => entry.status.startsWith('merged')).map(entry => entry.slug));
  return entries.find(entry => entry.repo === repoName && entry.status === 'ready' && entry.kind !== 'security' && (entry.after === 'none' || merged.has(entry.after))) ?? null;
}

export function setStatus(text, slug, status) {
  requireValue(/^[a-z0-9][a-z0-9-]*$/.test(slug) && !/\n/.test(status), 'Invalid slug or status');
  const entry = new RegExp(`(^### ${escape(slug)} ·[^\\n]*\\n- status: )[^\\n]*`, 'm');
  requireValue(entry.test(text), `Queue entry ${slug} not found`);
  const short = status.replace(/\s*\(.*$/, '');
  return text.replace(entry, `$1${status}`).replace(new RegExp(`^(\\| ${escape(slug)} \\| )[^|]*`, 'm'), `$1${short} `);
}

export function addInbox(text, line) {
  const item = line.trim().replace(/^- /, '');
  const header = /^## Inbox[ \t]*$/m.exec(text);
  requireValue(header && item && !/\n/.test(item), 'Queue needs an ## Inbox section and a one-line item');
  const start = header.index + header[0].length;
  const next = text.indexOf('\n## ', start);
  const end = next < 0 ? text.length : next;
  const body = [text.slice(start, end).trim(), `- ${item}`].filter(Boolean).join('\n');
  return `${text.slice(0, start)}\n\n${body}\n${next < 0 ? '' : text.slice(end)}`;
}

// Fallback-search fixes have no planned entry; publish needs one to track status.
export function addFallbackEntry(text, repoName, slug, title, date) {
  requireValue(/^[a-z0-9][a-z0-9-]*$/.test(slug) && title.trim() && !/[\n|]/.test(title), 'Invalid slug or title');
  requireValue(!parseQueue(text).some(entry => entry.slug === slug), `Queue entry ${slug} already exists`);
  const header = /^## Entries[ \t]*$/m.exec(text);
  requireValue(header, 'Queue needs an ## Entries section');
  const entry = `### ${slug} · ${repoName} · ${title.trim()}\n- status: fallback (unplanned, ${date})\n- kind: mechanical\n- risk: low · size: unknown · deps-change: no\n- after: none\n- problem: found by fallbackSearch; see the PR body\n`;
  const at = header.index + header[0].length;
  let out = `${text.slice(0, at)}\n\n${entry}${text.slice(at).replace(/^\n+/, '\n')}`;
  const table = new RegExp(`(^## Summary - ${escape(repoName)}[ \\t]*\\n\\n\\| slug \\|[^\\n]*\\n\\|[-| ]+\\|\\n)`, 'm');
  out = out.replace(table, `$1| ${slug} | fallback | none | ${title.trim()} |\n`);
  return out;
}

function findEntry(text, slug) {
  const entry = parseQueue(text).find(item => item.slug === slug);
  requireValue(entry, `Queue entry ${slug} not found`);
  return entry;
}

// ---------------------------------------------------------------- brief

export function renderBrief({ config, repo, entry, worktree, root, date, template }) {
  const forbidden = [...(config.forbidden ?? []), ...(repo.forbidden ?? [])].map(rule => `- ${rule}`).join('\n') || '- (none configured)';
  const branch = `${prefix(repo)}-${date.replaceAll('-', '')}-${entry.slug}`;
  const prFile = path.join(root, 'pr', `${entry.slug}.md`);
  const verify = repo.verify.map(command => `\`${command}\``).join(', ');
  const values = {
    repo: repo.name, worktree, repoPath: repo.path, baseBranch: repo.baseBranch, entry: entry.text, forbidden,
    maxDiffLines: String(config.maxDiffLines ?? 150), branch, prFile,
    verify: repo.testCommand ? `${verify}, and \`${repo.testCommand}\` for the tests covering the files you touched` : verify,
    coAuthor: config.coAuthor ? `, ending with \`Co-Authored-By: ${config.coAuthor}\`` : '',
  };
  const brief = template.replace(/\{\{(\w+)\}\}/g, (match, key) => { requireValue(key in values, `Unknown brief placeholder ${key}`); return values[key]; });
  return { branch, prFile, brief };
}

// ---------------------------------------------------------------- gate

export function sizeLimit(config, statedSize) {
  const cap = config.maxDiffLines ?? 150;
  return Number.isSafeInteger(statedSize) ? Math.max(cap, Math.ceil(statedSize * 1.5)) : cap;
}

const addedLines = patch => patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++ '));

function scan(lines, patterns) {
  const hits = [];
  for (const line of lines) for (const pattern of patterns) if (pattern.test(line.slice(1))) hits.push({ pattern: pattern.source, line: line.slice(1, 200) });
  return hits;
}

// NUL-delimited output keeps non-ASCII paths literal; quoted paths would dodge basename checks.
export function parseRawZ(output) {
  const parts = output.split('\0'), rows = [];
  for (let i = 0; i < parts.length; i++) {
    if (!parts[i].startsWith(':')) continue;
    const meta = parts[i].slice(1).split(' ');
    const paths = /^[RC]/.test(meta[4] ?? '') ? [parts[i + 1], parts[i + 2]] : [parts[i + 1]];
    i += paths.length;
    for (const file of paths) if (file) rows.push({ newMode: meta[1], file });
  }
  return rows;
}

// KEY-DECISION 2026-09-28: moved code counts once, not twice (#559 was a 160-line dedupe refused at 150).
// A move is a contiguous run of added lines equal to a contiguous run of deleted lines (both within
// one hunk), with at least minRun non-blank lines. Matching across hunk boundaries is not a move.
export function diffSize(patch, minRun = 3) {
  const addedBlocks = [], deletedBlocks = [];
  let current = null, sign = null, raw = 0;
  const flush = () => { if (current?.length) (sign === '+' ? addedBlocks : deletedBlocks).push(current); current = null; sign = null; };
  for (const line of patch.split('\n')) {
    const isChange = (line.startsWith('+') && !line.startsWith('+++ ')) || (line.startsWith('-') && !line.startsWith('--- '));
    if (!isChange) { flush(); continue; } // headers, @@, context and '\ No newline' all end a block
    raw++;
    if (line[0] !== sign) { flush(); sign = line[0]; current = []; }
    current.push(line.slice(1).trim());
  }
  flush();
  const used = deletedBlocks.map(block => block.map(() => false));
  const nonBlank = lines => lines.filter(Boolean).length;
  let moved = 0;
  for (const added of addedBlocks) {
    let i = 0;
    while (i < added.length) {
      let best = { length: 0 };
      deletedBlocks.forEach((deleted, d) => {
        for (let j = 0; j < deleted.length; j++) {
          let k = 0;
          while (i + k < added.length && j + k < deleted.length && !used[d][j + k] && added[i + k] === deleted[j + k]) k++;
          if (k > best.length) best = { length: k, d, j };
        }
      });
      if (best.length && nonBlank(added.slice(i, i + best.length)) >= minRun) {
        for (let k = 0; k < best.length; k++) used[best.d][best.j + k] = true;
        moved += best.length;
        i += best.length;
      } else i++;
    }
  }
  return { raw, moved, effective: raw - moved };
}

export function sizeVerdict({ raw, moved, effective }, limit, config, maxDiff = null) {
  let cap = limit, ceiling = Math.max(limit, Math.ceil((config.maxDiffLines ?? 150) * 1.5));
  if (Number.isSafeInteger(maxDiff) && maxDiff > 0) { cap = Math.max(cap, maxDiff); ceiling = Math.max(ceiling, maxDiff); }
  const autoPassed = raw > cap && effective <= cap && raw <= ceiling;
  return { raw, moved, effective, limit: cap, ceiling, override: cap > limit ? cap : null, autoPassed, ok: raw <= cap || autoPassed };
}

/**
 * Push gate. mode 'run' checks base..HEAD of a fresh fix branch; mode 'finish' checks only
 * commits added on top of the PR's remote head. Read-only: never pushes or edits anything.
 */
export function gate({ config, repo, token, mode, statedSize = null, headRef = null, expectBranch = null, maxDiff = null }, runtime = createRuntime()) {
  const { git } = runtime;
  const failures = [], fail = (check, detail) => failures.push({ check, detail });
  const patterns = [...MALWARE_PATTERNS, ...(config.blockPatterns ?? [])].map(source => new RegExp(source));
  let wt;
  // KEY-DECISION 2026-09-27: finish workers commit on detached HEAD; the gate inspects without requiring a retaining ref.
  try { wt = checkWorktree(config, repo.name, token, git, { requireRetained: false }); }
  catch (error) { return { ok: false, malware: false, failures: [{ check: 'clean', detail: error.message }] }; }
  requireValue(wt.exists, 'Managed worktree is missing');
  const cwd = wt.path, base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  const branch = git(cwd, ['branch', '--show-current']);
  let commits, merges = [], limit, size;
  const ancestor = (a, b) => { try { git(cwd, ['merge-base', '--is-ancestor', a, b]); return true; } catch { return false; } };
  if (mode === 'run') {
    if (expectBranch && branch !== expectBranch) fail('shape', `on branch '${branch}', expected '${expectBranch}'`);
    if (!ancestor(base, 'HEAD')) fail('shape', `not based on origin/${repo.baseBranch}`);
    commits = git(cwd, ['rev-list', '--reverse', `${base}..HEAD`]).split('\n').filter(Boolean);
    if (!commits.length) fail('shape', 'no commits to publish');
    const found = git(cwd, ['rev-list', '--merges', `${base}..HEAD`]).split('\n').filter(Boolean);
    if (found.length) fail('shape', `merge commits: ${found.join(' ')}`);
    limit = sizeLimit(config, statedSize);
    size = diffSize(git(cwd, ['diff', '-U0', '--no-color', `${base}...HEAD`]));
  } else {
    requireValue(headRef, 'finish gate needs the PR head branch');
    const head = `refs/remotes/origin/${headRef}`;
    git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${headRef}:${head}`]);
    if (!ancestor(head, 'HEAD')) fail('shape', `not a fast-forward of origin/${headRef}`);
    commits = git(cwd, ['rev-list', '--reverse', `${head}..HEAD`, `^${base}`]).split('\n').filter(Boolean);
    merges = git(cwd, ['rev-list', '--merges', `${head}..HEAD`, `^${base}`]).split('\n').filter(Boolean);
    for (const merge of merges) {
      for (const parent of git(cwd, ['rev-list', '--parents', '-n1', merge]).split(' ').slice(2)) {
        if (!ancestor(parent, base)) fail('shape', `merge ${merge} pulls in ${parent}, not on origin/${repo.baseBranch}`);
      }
      for (const file of git(cwd, ['show', '--remerge-diff', '--format=', '--name-only', '-z', merge]).split('\0').filter(Boolean)) {
        const why = forbiddenPath(file, repo);
        if (why) fail('files', `${merge.slice(0, 8)} conflict resolution touches ${file} (${why})`);
      }
      for (const hit of scan(addedLines(git(cwd, ['show', '--remerge-diff', '--format=', merge])), patterns)) fail('malware', `${merge.slice(0, 8)}: /${hit.pattern}/ in "${hit.line}"`);
    }
    limit = Math.ceil((config.maxDiffLines ?? 150) * 1.5);
    size = diffSize(git(cwd, ['diff', '-U0', '--no-color', base, 'HEAD']));
  }
  for (const commit of commits) {
    try { git(cwd, ['verify-commit', commit]); } catch { fail('signed', `signature invalid ${commit}`); }
    if (merges.includes(commit)) continue;
    for (const { newMode, file } of parseRawZ(git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '-z', commit]))) {
      const why = forbiddenPath(file, repo);
      if (why) fail('files', `${commit.slice(0, 8)} touches ${file} (${why})`);
      if (newMode === '100755') fail('files', `${commit.slice(0, 8)} makes ${file} executable`);
    }
    for (const hit of scan(addedLines(git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '-p', '-U0', commit])), patterns)) fail('malware', `${commit.slice(0, 8)}: /${hit.pattern}/ in "${hit.line}"`);
  }
  const verdict = sizeVerdict(size, limit, config, maxDiff);
  if (!verdict.ok) fail('size', `${verdict.raw} changed lines (${verdict.moved} moved, ${verdict.effective} effective) exceeds limit ${verdict.limit}; auto-pass needs effective <= ${verdict.limit} and raw <= ${verdict.ceiling}`);
  const dirty = git(cwd, ['status', '--porcelain']);
  if (dirty) fail('clean', dirty.split('\n').slice(0, 10).join('; '));
  return { ok: failures.length === 0, malware: failures.some(item => item.check === 'malware'), failures, path: cwd, branch, head: git(cwd, ['rev-parse', 'HEAD']), commits, size: verdict };
}

// ---------------------------------------------------------------- publish

export function checkPRFile(file, entryText) {
  requireValue(fs.existsSync(file), `PR file missing: ${file}`);
  const [title, ...body] = fs.readFileSync(file, 'utf8').split('\n');
  const problems = [];
  if (!title.trim() || title.length > 70) problems.push('title must be 1-70 characters on the first line');
  if (/\bdraft\b/i.test(title + body.join('\n'))) problems.push('remove the word "draft" from the title and body');
  // KEY-DECISION 2026-09-27: deploy steps named by the plan must survive into the PR body (live run lost one).
  for (const [command] of entryText.matchAll(/supabase functions deploy [\w-]+/g)) {
    if (!body.join('\n').includes(command)) problems.push(`PR body must name the deploy step: ${command}`);
  }
  return { title: title.trim(), body: body.join('\n').trim(), problems: [...new Set(problems)] };
}

// Size exceptions are stated on the PR itself, so the reviewer sees why the cap did not apply.
export function sizeNote(size) {
  if (size.override) return `Size override: ${size.override} lines, approved by the user (${size.raw} changed, ${size.moved} moved).`;
  if (size.autoPassed) return `Size: ${size.raw} changed lines (${size.moved} moved), ${size.effective} effective; auto-passed the ${size.limit}-line cap.`;
  return '';
}

export function publish({ configFile, config, repo, repoToken, runToken, startedAt, slug, maxDiff = null }, runtime = createRuntime()) {
  const { git, gh } = runtime;
  const qfile = queueFile(configFile, config), root = rootPath(config), today = runtime.today();
  const entry = findEntry(fs.readFileSync(qfile, 'utf8'), slug);
  requireValue(entry.repo === repo.name, `${slug} belongs to ${entry.repo}`);
  const update = status => writeText(qfile, setStatus(fs.readFileSync(qfile, 'utf8'), slug, status));
  // The gate runs the full worktree guard; a dirty tree must surface as a gate failure, not a throw.
  const branch = git(path.join(root, repo.name), ['branch', '--show-current']);
  requireValue(new RegExp(`^${escape(prefix(repo))}-\\d{8}-${escape(slug)}$`).test(branch), `Worktree branch '${branch}' is not the fix branch for ${slug}`);
  const gated = gate({ config, repo, token: repoToken, mode: 'run', statedSize: entry.statedSize, expectBranch: branch, maxDiff }, runtime);
  if (!gated.ok) {
    if (!gated.malware) update(`blocked (push gate: ${[...new Set(gated.failures.map(item => item.check))].join(', ')})`);
    return { ok: false, stage: 'gate', stopRun: gated.malware, failures: gated.failures };
  }
  const prFile = path.join(root, 'pr', `${slug}.md`);
  const pr = checkPRFile(prFile, entry.text);
  if (pr.problems.length) return { ok: false, stage: 'pr-file', prFile, problems: pr.problems };

  const remoteTip = git(repo.path, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
  if (!remoteTip) git(gated.path, ['push', '-u', 'origin', branch]);
  else requireValue(remoteTip === gated.head, `Remote ${branch} is at ${remoteTip}, not the gated head; not overwriting`);
  update(`pushed (${branch}, ${today})`);

  const discover = () => JSON.parse(gh(['pr', 'list', '-R', repo.remote, '--head', branch, '--state', 'all', '--json', 'number,url'])) [0] ?? null;
  let found = discover();
  if (!found) {
    const bodyFile = path.join(root, 'pr', `${slug}.body.md`);
    fs.writeFileSync(bodyFile, [pr.body, sizeNote(gated.size)].filter(Boolean).join('\n\n'));
    try { gh(['pr', 'create', '-R', repo.remote, '--draft', '--base', repo.baseBranch, '--head', branch, '--title', pr.title, '--body-file', bodyFile]); }
    catch (error) { found = discover(); if (!found) return { ok: false, stage: 'create', status: 'pushed', error: error.message }; }
    found ??= discover();
  }
  if (!found) return { ok: false, stage: 'discover', status: 'pushed', error: 'PR creation returned but no PR is visible for the branch' };
  const view = runtime.readPR(repo.remote, found.number);
  if (view.state !== 'OPEN' || view.headRefName !== branch || view.baseRefName !== repo.baseBranch || view.isCrossRepository || view.headRefOid !== gated.head) {
    return { ok: false, stage: 'identity', status: 'pushed', error: `PR #${found.number} (${view.state}) is not an open PR for ${branch} -> ${repo.baseBranch} at ${gated.head}` };
  }
  try { recordPR(root, startedAt, { repo: repo.name, number: view.number, branch, url: view.url }, runToken); }
  catch (error) { return { ok: false, stage: 'register', status: 'pushed', number: view.number, error: error.message }; }
  update(`pr-open (PR #${view.number}, ${today})`);
  return { ok: true, number: view.number, url: view.url, branch, size: gated.size, sizeAutoPassed: gated.size.autoPassed, sizeOverride: gated.size.override };
}

// ---------------------------------------------------------------- approval input

export function buildApprovalInput({ config, repo, number, root }, runtime = createRuntime()) {
  const remote = repo.remote;
  const pr = runtime.readPR(remote, number);
  const skip = reason => ({ number, classification: 'skipped', reason });
  if (pr.state !== 'OPEN') return skip(`PR is ${pr.state}`);
  if (pr.baseRefName !== repo.baseBranch) return skip(`base is ${pr.baseRefName}, not ${repo.baseBranch}`);
  if (pr.isCrossRepository || !pr.headRefName.startsWith(`${prefix(repo)}-`)) return skip('not a same-repository autofix branch');
  const reviewers = config.reviewers ?? [runtime.login()];
  const approveTokens = config.approveTokens ?? DEFAULT_TOKENS;
  const isReviewer = login => reviewers.some(item => item.toLowerCase() === login?.toLowerCase());
  const api = `repos/${remote}`;
  const timeline = [
    ...runtime.ghPages(`${api}/issues/${number}/comments`).map(c => ({ id: c.id, kind: 'issue', url: c.html_url, author: c.user?.login, body: c.body ?? '', createdAt: c.created_at, updatedAt: c.updated_at, at: c.created_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/reviews`).filter(r => r.body?.trim()).map(r => ({ id: r.id, kind: 'review', url: r.html_url, author: r.user?.login, body: r.body, state: r.state, commitSha: r.commit_id, at: r.submitted_at })),
    ...runtime.ghPages(`${api}/pulls/${number}/comments`).map(c => ({ id: c.id, kind: 'inline', url: c.html_url, author: c.user?.login, body: c.body ?? '', path: c.path, line: c.line, createdAt: c.created_at, at: c.created_at })),
  ].filter(item => isReviewer(item.author));
  const markers = timeline.filter(item => item.body.includes(MARKER)).map(item => Date.parse(item.at));
  const since = markers.length ? Math.max(...markers) : -Infinity;
  const pending = timeline.filter(item => !item.body.includes(MARKER) && Date.parse(item.at) > since).sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).map(({ at, ...item }) => item);
  const base = { number, headRef: pr.headRefName, headSha: pr.headRefOid, isDraft: pr.isDraft, pending };
  if (!pending.length) return { ...base, classification: 'awaiting review' };
  const only = pending[0];
  const candidate = pending.length === 1 && only.kind !== 'inline' && approveTokens.some(token => token.toLowerCase() === only.body.trim().toLowerCase());
  if (!candidate) return { ...base, classification: 'address' };

  const input = { remote, number, headRef: pr.headRefName, headSha: pr.headRefOid, pending, reviewers, approveTokens };
  let evidence = only.kind === 'review' ? 'review' : null;
  if (only.kind === 'issue') {
    // KEY-DECISION 2026-09-27: review's immutable record is always preferred; push history is only the fallback.
    const recordFile = path.join(root, 'review', 'records', `${repo.name}-pr${number}-comment${only.id}.approval.json`);
    if (fs.existsSync(recordFile)) { input.record = read(recordFile); evidence = 'record'; }
    else {
      const ref = `refs/heads/${pr.headRefName}`;
      const activities = runtime.ghPages(`${api}/activity?ref=${encodeURIComponent(ref)}&direction=desc&per_page=100`)
        .map(({ timestamp, before, after, ref: activityRef, activity_type }) => ({ timestamp, before, after, ref: activityRef, activity_type }));
      const observedHead = runtime.readPR(remote, number).headRefOid;
      if (observedHead !== pr.headRefOid) return { ...base, classification: 'evidence-unavailable', reason: 'head moved while collecting push history' };
      input.history = { remote, ref, complete: true, observedHead, activities };
      evidence = 'push-history';
    }
  }
  try {
    const approvedHead = checkApproval(input);
    return { ...base, classification: 'approve', evidence, approvedHead, input };
  } catch (error) {
    const stale = (input.record && input.record.headSha !== pr.headRefOid) || (only.kind === 'review' && shaOK(only.commitSha) && only.commitSha !== pr.headRefOid) || /different head/.test(error.message);
    return { ...base, classification: stale ? 'stale' : 'evidence-unavailable', evidence, reason: error.message };
  }
}

// ---------------------------------------------------------------- cleanup

export function cleanup({ configFile, config, repo, token, number, verificationId }, runtime = createRuntime()) {
  const { git } = runtime;
  const pr = runtime.readPR(repo.remote, number);
  if (pr.state !== 'MERGED') return { ok: false, reason: `PR is ${pr.state}; merge queued or not merged, entry stays pr-open` };
  const mergeCommit = pr.mergeCommit?.oid;
  if (!shaOK(mergeCommit)) return { ok: false, reason: `GitHub reports no valid merge commit for PR #${number} (${mergeCommit ?? 'missing'}); entry stays pr-open` };
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  try { git(repo.path, ['merge-base', '--is-ancestor', mergeCommit, base]); }
  catch { return { ok: false, reason: `merge commit ${mergeCommit} is not on the fetched ${repo.baseBranch} yet` }; }
  const result = { ok: true, number };
  const qfile = queueFile(configFile, config);
  const text = fs.readFileSync(qfile, 'utf8');
  const entry = parseQueue(text).find(item => item.repo === repo.name && new RegExp(`PR #${number}\\b`).test(item.status));
  if (entry) { writeText(qfile, setStatus(text, entry.slug, `merged (PR #${number}, ${runtime.today()})`)); result.queue = `${entry.slug} -> merged`; }
  else result.queue = 'no queue entry references this PR';

  const wt = checkWorktree(config, repo.name, token, git);
  if (wt.exists) { git(wt.path, ['checkout', '--detach', base, '--quiet']); checkWorktree(config, repo.name, token, git); }
  if (verificationId) result.released = releaseVerification(config, repo.name, token, verificationId, { git }).released;

  const head = pr.headRefOid, branch = pr.headRefName;
  const local = (() => { try { return git(repo.path, ['rev-parse', '-q', '--verify', `refs/heads/${branch}`]); } catch { return ''; } })();
  if (!local) result.local = 'absent';
  else if (local !== head) result.local = `kept: tip ${local} advanced past merged ${head}`;
  else {
    try { git(repo.path, ['branch', '-D', branch]); result.local = 'deleted'; }
    catch (error) { result.local = `kept: ${error.stderr?.trim() || error.message}`; }
  }
  // KEY-DECISION 2026-09-27: repos with delete_branch_on_merge remove the head first; absence is success.
  const remoteTip = git(repo.path, ['ls-remote', 'origin', `refs/heads/${branch}`]).split('\t')[0];
  if (!remoteTip) result.remote = 'already deleted';
  else if (remoteTip !== head) result.remote = `kept: remote tip ${remoteTip} advanced past merged ${head}`;
  else {
    try { git(repo.path, ['push', `--force-with-lease=refs/heads/${branch}:${head}`, 'origin', `:refs/heads/${branch}`]); result.remote = 'deleted'; }
    catch (error) { result.remote = `kept: lease rejected (${error.stderr?.trim() || error.message})`; }
  }
  return result;
}

export function removeWorktree({ configFile, config, repo, token }, runtime = createRuntime()) {
  const { git, gh } = runtime;
  const keep = reason => ({ removed: false, reason });
  const text = fs.readFileSync(queueFile(configFile, config), 'utf8');
  const unpublished = parseQueue(text).filter(entry => entry.repo === repo.name && /^(pr-open|pushed)\b/.test(entry.status));
  if (unpublished.length) return keep(`queue has ${unpublished.map(entry => `${entry.slug} (${entry.status})`).join(', ')}`);
  const open = JSON.parse(gh(['pr', 'list', '-R', repo.remote, '--state', 'open', '--json', 'number,headRefName', '--limit', '200'])).filter(item => item.headRefName.startsWith(`${prefix(repo)}-`));
  if (open.length) return keep(`open autofix PRs: ${open.map(item => `#${item.number}`).join(', ')}`);
  const wt = checkWorktree(config, repo.name, token, git);
  if (!wt.exists) return keep('managed worktree does not exist');
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  try { git(wt.path, ['merge-base', '--is-ancestor', 'HEAD', base]); }
  catch { return keep('worktree HEAD is not on the fetched base'); }
  checkWorktree(config, repo.name, token, git);
  git(repo.path, ['worktree', 'remove', wt.path], { timeout: WORKTREE_REMOVE_TIMEOUT_MS });
  for (const file of [path.join(rootPath(config), `${repo.name}.lock.sha`), prepareMarker(rootPath(config), repo)]) if (fs.existsSync(file)) fs.unlinkSync(file);
  return { removed: true, path: wt.path };
}

// ---------------------------------------------------------------- prepare

/**
 * Create or reuse the managed worktree at the base (or a PR head), then refresh dependencies.
 * Never prunes, resets or cleans: a stale registration is reported for the skill's prune rules.
 */
export async function prepare({ config, repo, token, head = null, depsOnly = false }, runtime = createRuntime()) {
  const { git } = runtime;
  const root = rootPath(config);
  // --deps-only refreshes dependencies in place after finish syncs the base: HEAD is an unretained
  // local merge that must not be checked out or switched away from.
  if (depsOnly) {
    const wt = checkWorktree(config, repo.name, token, git, { requireRetained: false });
    requireValue(wt.exists, 'Managed worktree is missing; run prepare without --deps-only');
    return refreshDependencies({ config, repo, token, root, wtPath: wt.path, created: false }, runtime);
  }
  let wt = checkWorktree(config, repo.name, token, git);
  const base = `refs/remotes/origin/${repo.baseBranch}`;
  git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${repo.baseBranch}:${base}`]);
  let target = base;
  if (head) {
    git(repo.path, ['check-ref-format', `refs/heads/${head}`]);
    target = `refs/remotes/origin/${head}`;
    git(repo.path, ['fetch', '--no-tags', 'origin', `+refs/heads/${head}:${target}`]);
  }
  let created = false;
  if (!wt.exists) {
    if (wt.registered) {
      // git prints prune --dry-run to stderr; the porcelain listing carries the same reason.
      const listing = git(repo.path, ['worktree', 'list', '--porcelain']).split('\n\n').find(item => item.startsWith(`worktree ${wt.path}\n`)) ?? '';
      return { ok: false, stage: 'prune-needed', path: wt.path, registration: listing };
    }
    git(repo.path, ['worktree', 'add', '--detach', wt.path, target]);
    created = true;
  } else {
    git(wt.path, ['checkout', '--detach', target, '--quiet']);
  }
  wt = checkWorktree(config, repo.name, token, git);
  return refreshDependencies({ config, repo, token, root, wtPath: wt.path, created }, runtime);
}

// Prepare commands succeed once per managed tree; the marker makes a failed attempt re-run on retry.
const prepareMarker = (root, repo) => path.join(root, `${repo.name}.prepared`);
const prepareFingerprint = repo => createHash('sha256').update(JSON.stringify(repo.prepare ?? [])).digest('hex');

async function refreshDependencies({ config, repo, token, root, wtPath, created }, runtime) {
  const { git } = runtime;
  const marker = prepareMarker(root, repo);
  if (created && fs.existsSync(marker)) fs.unlinkSync(marker);
  const logs = path.join(root, 'review', 'scratch', `prepare-${randomUUID()}`);
  const timeoutMs = (repo.commandTimeoutSeconds ?? 600) * 1000;
  const steps = [];
  const exec = async (phase, command) => {
    fs.mkdirSync(logs, { recursive: true });
    const log = path.join(logs, `${steps.length}.log`);
    const result = await runtime.merge.run(command, wtPath, log, timeoutMs);
    steps.push({ phase, command, log, ...result });
    return result.exitCode === 0 && !result.signal && !result.timedOut;
  };
  const installed = await installIfStale(root, repo, wtPath, exec);
  if (installed === false) return { ok: false, stage: 'install', path: wtPath, steps };
  let prepared = false;
  const fingerprint = prepareFingerprint(repo);
  const done = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === fingerprint;
  if (!done && (repo.prepare ?? []).length) {
    for (const command of repo.prepare) if (!await exec('prepare', command)) return { ok: false, stage: 'prepare', path: wtPath, steps };
    prepared = true;
  }
  if (!done) fs.writeFileSync(marker, `${fingerprint}\n`);
  try { checkWorktree(config, repo.name, token, git, { requireRetained: false }); }
  catch (error) { return { ok: false, stage: 'dirty', path: wtPath, error: error.message, steps }; }
  return { ok: true, path: wtPath, created, installed: Boolean(installed), prepared, head: git(wtPath, ['rev-parse', 'HEAD']), logs: steps.map(step => step.log) };
}

// ---------------------------------------------------------------- land

const LONG_GH_MS = 60 * 60 * 1000;

async function waitForChecks({ repo, number }, runtime, retries = 4, pauseMs = 15000) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      runtime.gh(['pr', 'checks', String(number), '-R', repo.remote, '--watch', '--fail-fast', '--interval', '15'], { timeout: LONG_GH_MS });
      return { ok: true };
    } catch (error) {
      const output = `${error.stdout ?? ''}\n${error.stderr ?? ''}\n${error.message}`;
      // Checks can take a few seconds to register after a ready event.
      if (!/no checks reported/i.test(output)) return { ok: false, error: output.trim().split('\n').slice(-5).join('\n') };
      if (attempt < retries) await runtime.sleep(pauseMs);
    }
  }
  return { ok: true, noChecks: true };
}

/**
 * Land one approved PR: verify the integration, wait for CI, re-check approval and base, merge
 * the exact approved head, confirm, and clean up. Never posts comments or bypasses branch rules.
 */
export async function land({ configFile, config, repo, token, number }, runtime = createRuntime()) {
  const root = rootPath(config);
  const approval = () => buildApprovalInput({ config, repo, number, root }, runtime);
  const first = approval();
  if (first.classification !== 'approve') return { ok: false, number, stage: first.classification, reason: first.reason ?? null, pending: first.pending ?? [] };
  let input = first.input, verification, checked, ci = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    verification = await verifyMerge(config, repo.name, token, input, runtime.merge);
    if (verification.status !== 'passed') return { ok: false, number, stage: verification.status === 'conflict' ? 'conflict' : 'verify', error: verification.error, verificationId: verification.id };
    if (!ci) {
      if (first.isDraft) runtime.gh(['pr', 'ready', String(number), '-R', repo.remote]);
      ci = await waitForChecks({ repo, number }, runtime);
      if (!ci.ok) return { ok: false, number, stage: 'ci', error: ci.error, verificationId: verification.id };
    }
    const fresh = approval();
    if (fresh.classification !== 'approve') return { ok: false, number, stage: fresh.classification, reason: fresh.reason ?? null, verificationId: verification.id };
    try {
      checked = await checkVerifiedMerge(config, repo.name, token, fresh.input, verification.id, runtime.merge);
      break;
    } catch (error) {
      // Only a moved base is retried; the unchanged head keeps its approval.
      if (!/changed since verification/.test(error.message) || fresh.headSha !== first.headSha || attempt === 3) return { ok: false, number, stage: 'check', error: error.message, verificationId: verification.id, attempts: attempt };
      releaseVerification(config, repo.name, token, verification.id, runtime.merge);
      input = fresh.input;
    }
  }
  runtime.gh(['pr', 'merge', String(number), '-R', repo.remote, `--${config.mergeMethod ?? 'squash'}`, '--match-head-commit', checked.approvedHead], { timeout: 10 * 60 * 1000 });
  let state = null;
  for (let poll = 0; poll < 6; poll++) {
    state = runtime.readPR(repo.remote, number).state;
    if (state === 'MERGED') break;
    await runtime.sleep(5000);
  }
  if (state !== 'MERGED') return { ok: false, number, stage: 'queued', state, verificationId: verification.id };
  const cleaned = cleanup({ configFile, config, repo, token, number, verificationId: verification.id }, runtime);
  return { ok: cleaned.ok, number, evidence: first.evidence, approvedHead: checked.approvedHead, verificationId: verification.id, noChecks: ci?.noChecks ?? false, cleanup: cleaned };
}

// ---------------------------------------------------------------- CLI

const USAGE = `Usage:
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
    const text = fs.readFileSync(file, 'utf8');
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
