// The queue file: parsing, selection, status updates, the skeleton and lint.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { escape, requireValue } from './common.mjs';

export function queueFile(configFile, config) {
  return path.resolve(path.dirname(path.resolve(configFile)), config.queuePath ?? 'AUTOFIX_QUEUE.md');
}

export function writeText(file, text) {
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

// A security entry is never auto-executed; compare loosely so `Security` cannot slip through.
const isSecurity = entry => entry.kind.trim().toLowerCase() === 'security';

export function nextEntry(text, repoName) {
  const entries = parseQueue(text);
  const merged = new Set(entries.filter(entry => entry.status.startsWith('merged')).map(entry => entry.slug));
  return entries.find(entry => entry.repo === repoName && entry.status === 'ready' && !isSecurity(entry) && (entry.after === 'none' || merged.has(entry.after))) ?? null;
}

const SUMMARY_HEAD = '| slug | status | after | title |\n|---|---|---|---|\n';
// The layout every queue helper relies on. `queue init` writes it; `queue lint` checks it.
export function queueSkeleton(config) {
  const tables = config.repos.map(repo => `## Summary - ${repo.name}\n\n${SUMMARY_HEAD}`).join('\n');
  return `# Autofix queue\n\nPre-verified fix plans consumed by \`/dev-autofix:run\`. Written by \`/dev-autofix:plan\`.\n\n${tables}\n## Inbox\n\n## Entries\n\n## Dropped\n`;
}

export const QUEUE_KINDS = ['mechanical', 'bugfix', 'refactor', 'security'];
const STATUS_FORMS = [/^ready$/, /^needs-human \(.+\)$/, /^blocked \(.+\)$/, /^pushed \(.+\)$/, /^pr-open \(PR #\d+, .+\)$/, /^merged \(PR #\d+, .+\)$/, /^fallback \(.+\)$/];

/**
 * Check a queue file against what the helpers parse. `errors` are things that make a helper
 * fail or an entry run when it should not; `warnings` are drift a human should tidy up.
 */
export function lintQueue(text, config) {
  const errors = [], warnings = [];
  const repoNames = new Set(config.repos.map(repo => repo.name));
  for (const heading of ['## Inbox', '## Entries']) {
    if (!new RegExp(`^${heading}[ \\t]*$`, 'm').test(text)) errors.push({ problem: `missing the \`${heading}\` heading` });
  }
  const entriesAt = text.search(/^## Entries[ \t]*$/m);
  const firstEntry = text.search(/^### /m);
  if (entriesAt >= 0 && firstEntry >= 0 && firstEntry < entriesAt) errors.push({ problem: 'entries (`### ` headings) appear before the `## Entries` heading' });
  const entries = parseQueue(text);
  const seen = new Set();
  for (const entry of entries) {
    const at = { slug: entry.slug };
    if (!/^[a-z0-9][a-z0-9-]*$/.test(entry.slug)) errors.push({ ...at, problem: 'slug must be lowercase letters, digits and hyphens' });
    if (seen.has(entry.slug)) errors.push({ ...at, problem: 'duplicate slug' });
    seen.add(entry.slug);
    if (!entry.repo || !entry.title) errors.push({ ...at, problem: 'heading must be `### <slug> · <repo> · <title>`' });
    else if (!repoNames.has(entry.repo)) errors.push({ ...at, problem: `repo \`${entry.repo}\` is not in the config` });
    if (!QUEUE_KINDS.includes(entry.kind)) errors.push({ ...at, problem: `kind must be one of ${QUEUE_KINDS.join(', ')} (got \`${entry.kind || 'none'}\`)` });
    if (!STATUS_FORMS.some(form => form.test(entry.status))) warnings.push({ ...at, problem: `status \`${entry.status || 'none'}\` is not a form the helpers know; the entry will never run` });
    if (!entry.after) warnings.push({ ...at, problem: 'no `after:` line; the entry will never run' });
    else if (entry.after !== 'none' && !entries.some(other => other.slug === entry.after)) warnings.push({ ...at, problem: `after: \`${entry.after}\` names no entry; the entry will never run` });
    if (entry.statedSize === null && !entry.status.startsWith('fallback')) warnings.push({ ...at, problem: 'no `size: ~N` on the risk line; the default size cap applies' });
    if (entry.repo && repoNames.has(entry.repo)) {
      const table = new RegExp(`^## Summary - ${escape(entry.repo)}[ \\t]*$`, 'm').test(text);
      const row = new RegExp(`^\\| ${escape(entry.slug)} \\| ([^|]*)\\|`, 'm').exec(text);
      if (!table) warnings.push({ ...at, problem: `no \`## Summary - ${entry.repo}\` table` });
      else if (!row) warnings.push({ ...at, problem: 'no row in the summary table' });
      else if (row[1].trim() !== entry.status.replace(/\s*\(.*$/, '')) warnings.push({ ...at, problem: `summary table says \`${row[1].trim()}\`, entry says \`${entry.status}\`` });
    }
  }
  return { ok: errors.length === 0, entries: entries.length, errors, warnings };
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

export function findEntry(text, slug) {
  const entry = parseQueue(text).find(item => item.slug === slug);
  requireValue(entry, `Queue entry ${slug} not found`);
  return entry;
}
