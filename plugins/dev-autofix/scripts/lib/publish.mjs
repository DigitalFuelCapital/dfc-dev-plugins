// Worker briefs and publication: gate, push, draft PR, registration, queue status.
import fs from 'node:fs';
import path from 'node:path';
import { recordPR } from '../state.mjs';
import { createRuntime, escape, prefix, requireValue, rootPath } from './common.mjs';
import { findEntry, queueFile, setStatus, writeText } from './queue.mjs';
import { gate } from './gate.mjs';

export function renderBrief({ config, repo, entry, worktree, root, date, template }) {
  const forbidden = [...(config.forbidden ?? []), ...(repo.forbidden ?? [])].map(rule => `- ${rule}`).join('\n') || '- (none configured)';
  const branch = `${prefix(repo)}-${date.replaceAll('-', '')}-${entry.slug}`;
  const prFile = path.join(root, 'pr', `${entry.slug}.md`);
  const verify = repo.verify.map(command => `\`${command}\``).join(', ');
  const protectedPaths = [...(config.protectedPaths ?? []), ...(repo.protectedPaths ?? [])].map(source => `\`${source}\``).join(', ') || 'none';
  const values = {
    repo: repo.name, worktree, repoPath: repo.path, baseBranch: repo.baseBranch, entry: entry.text, forbidden, protectedPaths,
    maxDiffLines: String(config.maxDiffLines ?? 150), branch, prFile,
    verify: repo.testCommand ? `${verify}, and \`${repo.testCommand}\` for the tests covering the files you touched` : verify,
    coAuthor: config.coAuthor ? `, ending with \`Co-Authored-By: ${config.coAuthor}\`` : '',
  };
  const brief = template.replace(/\{\{(\w+)\}\}/g, (match, key) => { requireValue(key in values, `Unknown brief placeholder ${key}`); return values[key]; });
  return { branch, prFile, brief };
}

export const DEFAULT_DEPLOY_PATTERNS = [String.raw`supabase functions deploy [\w-]+`];

export function checkPRFile(file, entryText, config = {}) {
  requireValue(fs.existsSync(file), `PR file missing: ${file}`);
  const [title, ...body] = fs.readFileSync(file, 'utf8').split('\n');
  const problems = [];
  if (!title.trim() || title.length > 70) problems.push('title must be 1-70 characters on the first line');
  if (/\bdraft\b/i.test(title + body.join('\n'))) problems.push('remove the word "draft" from the title and body');
  // KEY-DECISION 2026-09-27: deploy steps named by the plan must survive into the PR body (live run lost one).
  for (const source of config.deployPatterns ?? DEFAULT_DEPLOY_PATTERNS) {
    for (const [command] of entryText.matchAll(new RegExp(source, 'g'))) {
      if (!body.join('\n').includes(command)) problems.push(`PR body must name the deploy step: ${command}`);
    }
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
  const pr = checkPRFile(prFile, entry.text, config);
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
