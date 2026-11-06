// Merges infiltrate agent outputs into findings.json and report.md for plan.
// <auditDir>/src        detached checkout of the audited commit (SHA is read from it)
// <auditDir>/agents/<agent>.json   [{id, severity, title, location, trigger, proof}]
// <auditDir>/reviews/<agent>.json  [{id, verdict, reason}] for other agents' findings
// <auditDir>/agents/<agent>.md, <auditDir>/scope.md   free-form notes, linked or included
// The agent is the file name, so a finding's discoverer and each reviewer are not self-reported.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const SEVERITIES = ['critical', 'high', 'medium', 'low'];
const VERDICTS = ['confirmed', 'rejected', 'needs-evidence'];
const FIELDS = ['id', 'severity', 'title', 'location', 'trigger', 'proof'];
const need = (ok, message) => { if (!ok) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim() !== '';

function readDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(file => {
    const items = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    need(Array.isArray(items), `${path.basename(dir)}/${file} must be a JSON array`);
    return { agent: file.slice(0, -5), items };
  });
}

// confirmed: a different agent confirmed it and nobody rejected it.
export function status(reviews) {
  const has = verdict => reviews.some(r => r.verdict === verdict);
  if (has('confirmed') && !has('rejected')) return 'confirmed';
  if (has('rejected') && !has('confirmed')) return 'rejected';
  return has('confirmed') ? 'disputed' : 'unverified';
}

export function merge(auditDir) {
  const findings = new Map();
  for (const { agent, items } of readDir(path.join(auditDir, 'agents'))) {
    for (const f of items) {
      for (const key of FIELDS) need(text(f?.[key]), `agents/${agent}.json: ${f?.id ?? 'finding'} needs ${key}`);
      need(/^[a-z0-9][a-z0-9-]*$/.test(f.id), `agents/${agent}.json: id ${f.id} must be a lowercase slug`);
      need(SEVERITIES.includes(f.severity), `${f.id}: severity must be ${SEVERITIES.join('|')}`);
      need(!findings.has(f.id), `Duplicate finding id ${f.id}`);
      findings.set(f.id, { ...Object.fromEntries(FIELDS.map(k => [k, f[k]])), agent, reviews: [] });
    }
  }
  for (const { agent, items } of readDir(path.join(auditDir, 'reviews'))) {
    for (const r of items) {
      const f = findings.get(r?.id);
      need(f, `reviews/${agent}.json: unknown finding ${r?.id}`);
      need(f.agent !== agent, `${r.id}: ${agent} cannot review its own finding`);
      need(VERDICTS.includes(r.verdict), `${r.id}: verdict must be ${VERDICTS.join('|')}`);
      need(text(r.reason), `${r.id}: review by ${agent} needs a reason`);
      f.reviews.push({ agent, verdict: r.verdict, reason: r.reason });
    }
  }
  return [...findings.values()].map(f => ({ ...f, status: status(f.reviews) }));
}

export function render({ commit, remote, findings, scope }) {
  const confirmed = findings.filter(f => f.status === 'confirmed');
  const order = f => SEVERITIES.indexOf(f.severity);
  const lines = ['# Infiltrate report', '', `Source: infiltrate`, `Repository: ${remote}`, `Audited commit: ${commit}`,
    `Confirmed: ${confirmed.length} of ${findings.length} candidates`, ''];
  if (scope) lines.push('## Scope and limits', '', scope.trim(), '');
  lines.push('## Confirmed findings', '');
  if (!confirmed.length) lines.push('None established in the reviewed scope. This does not mean the repository is secure.', '');
  for (const f of [...confirmed].sort((a, b) => order(a) - order(b))) {
    lines.push(`### ${f.id}: ${f.title}`, '', `- Severity: ${f.severity}`, `- Location: ${f.location}`, `- Found by: ${f.agent}`,
      `- Trigger: ${f.trigger}`, `- Proof: ${f.proof}`, ...f.reviews.map(r => `- Review (${r.agent}, ${r.verdict}): ${r.reason}`), '');
  }
  const rest = findings.filter(f => f.status !== 'confirmed');
  if (rest.length) {
    lines.push('## Not confirmed (do not plan these)', '');
    for (const f of rest) lines.push(`- ${f.id} (${f.status}, ${f.severity}): ${f.title} - ${f.reviews.map(r => `${r.agent}: ${r.verdict}, ${r.reason}`).join('; ') || 'no review'}`);
    lines.push('');
  }
  lines.push('Agent notes: `agents/*.md` next to this report.', '');
  return lines.join('\n');
}

export function finalize(auditDir) {
  const src = path.join(auditDir, 'src');
  const git = (...args) => execFileSync('git', ['-C', src, ...args], { encoding: 'utf8' }).trim();
  need(fs.existsSync(src), `${src} is missing; run this before removing the audit checkout`);
  const commit = git('rev-parse', 'HEAD');
  const remote = git('remote', 'get-url', 'origin').replace(/\/\/[^/@]+@/, '//'); // drop any embedded credentials
  const findings = merge(auditDir);
  const scopeFile = path.join(auditDir, 'scope.md');
  const scope = fs.existsSync(scopeFile) ? fs.readFileSync(scopeFile, 'utf8') : '';
  fs.writeFileSync(path.join(auditDir, 'findings.json'), `${JSON.stringify({ commit, remote, findings }, null, 2)}\n`);
  fs.writeFileSync(path.join(auditDir, 'report.md'), render({ commit, remote, findings, scope }));
  const count = s => findings.filter(f => f.status === s).length;
  return { report: path.join(auditDir, 'report.md'), commit, confirmed: count('confirmed'), disputed: count('disputed'), unverified: count('unverified'), rejected: count('rejected') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    need(process.argv[2], 'Usage: audit.mjs <auditDir>');
    console.log(JSON.stringify(finalize(path.resolve(process.argv[2])), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
