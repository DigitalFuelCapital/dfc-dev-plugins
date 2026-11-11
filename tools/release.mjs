// Release helpers for this repository (not part of either plugin).
//
//   node tools/release.mjs check <base-ref>   fail when a plugin changed since <base-ref> without a version bump
//   node tools/release.mjs pending            one "<plugin> <version> <tag>" line per version that has no tag yet
//   node tools/release.mjs notes <plugin>     the CHANGELOG.md section for the plugin's current version
//
// Claude Code and Codex cache plugins by version, so a behaviour change that ships without a
// bump never reaches installed copies. `check` turns that rule into a CI failure.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultGit = root => (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();

// Changes to these never alter what an installed plugin does.
const NO_BUMP = [/^tests\//, /^examples\//, /^README\.md$/, /^CHANGELOG\.md$/, /^LICENSE$/];

export const pluginNames = root => fs.readdirSync(path.join(root, 'plugins')).filter(name => fs.existsSync(path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'))).sort();
export const pluginVersion = (root, name) => JSON.parse(fs.readFileSync(path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const parts = version => { const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? ''); if (!match) throw new Error(`Not a version: ${version}`); return match.slice(1).map(Number); };
export const newer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

export function checkVersions(root, base, git = defaultGit(root)) {
  const problems = [], checked = [];
  for (const name of pluginNames(root)) {
    const dir = `plugins/${name}`;
    const changed = git('diff', '--name-only', `${base}...HEAD`, '--', dir).split('\n').filter(Boolean).map(file => file.slice(dir.length + 1)).filter(file => !NO_BUMP.some(pattern => pattern.test(file)));
    let before = null;
    try { before = JSON.parse(git('show', `${base}:${dir}/.claude-plugin/plugin.json`)).version; } catch { /* the plugin is new on this branch */ }
    const now = pluginVersion(root, name);
    checked.push({ plugin: name, before, now, changed: changed.length });
    if (!changed.length || before === null) continue;
    if (!newer(now, before)) problems.push(`${name}: ${changed.length} file(s) changed since ${base} (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}) but the version is still ${before}. Bump it in plugins/${name}/.claude-plugin/plugin.json and .claude-plugin/marketplace.json, and add a CHANGELOG.md entry.`);
  }
  return { ok: problems.length === 0, checked, problems };
}

export function releaseNotes(root, name) {
  const version = pluginVersion(root, name);
  const text = fs.readFileSync(path.join(root, 'plugins', name, 'CHANGELOG.md'), 'utf8');
  const start = text.search(new RegExp(`^## ${version.replaceAll('.', '\\.')}\\s*$`, 'm'));
  if (start < 0) throw new Error(`plugins/${name}/CHANGELOG.md has no "## ${version}" section`);
  const body = text.slice(start).split('\n').slice(1).join('\n');
  const end = body.search(/^## /m);
  return (end < 0 ? body : body.slice(0, end)).trim();
}

export const tagFor = (name, version) => `${name}-v${version}`;
export function pendingReleases(root, git = defaultGit(root)) {
  const tags = new Set(git('tag', '--list').split('\n').filter(Boolean));
  return pluginNames(root).map(name => ({ plugin: name, version: pluginVersion(root, name), tag: tagFor(name, pluginVersion(root, name)) })).filter(item => !tags.has(item.tag));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [command, argument] = process.argv.slice(2);
    if (command === 'check' && argument) {
      const result = checkVersions(ROOT, argument);
      for (const item of result.checked) console.log(`${item.plugin}: ${item.before ?? 'new'} -> ${item.now} (${item.changed} behaviour file(s) changed)`);
      for (const problem of result.problems) console.error(`error: ${problem}`);
      if (!result.ok) process.exitCode = 1;
    } else if (command === 'pending') {
      for (const item of pendingReleases(ROOT)) console.log(`${item.plugin} ${item.version} ${item.tag}`);
    } else if (command === 'notes' && argument) {
      console.log(releaseNotes(ROOT, argument));
    } else throw new Error('Usage: release.mjs check <base-ref> | pending | notes <plugin>');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
