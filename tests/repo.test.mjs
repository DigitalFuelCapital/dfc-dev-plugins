// Repository-level checks: the documentation, examples and manifests must agree with the code.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as autofixPR from '../plugins/dev-autofix/scripts/pr.mjs';
import * as autofixMerge from '../plugins/dev-autofix/scripts/merge.mjs';
import * as autotaskVerify from '../plugins/dev-autotask/scripts/verify.mjs';
import * as autotaskPublish from '../plugins/dev-autotask/scripts/publish-check.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const json = file => JSON.parse(read(file));
const PLUGINS = fs.readdirSync(path.join(ROOT, 'plugins')).filter(name => fs.existsSync(path.join(ROOT, 'plugins', name, '.claude-plugin', 'plugin.json')));

function walk(dir, keep, found = []) {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) walk(file, keep, found);
    else if (keep(file)) found.push(file);
  }
  return found;
}
const MARKDOWN = walk('.', file => file.endsWith('.md'));
const withoutFences = text => text.replace(/^```[\s\S]*?^```/gm, '');

// ------------------------------------------------------------------ versions

test('each plugin has the same version in its manifest, the marketplace and its changelog', () => {
  const marketplace = json('.claude-plugin/marketplace.json');
  assert.deepEqual(marketplace.plugins.map(plugin => plugin.name).sort(), [...PLUGINS].sort());
  for (const listed of marketplace.plugins) {
    const manifest = json(`plugins/${listed.name}/.claude-plugin/plugin.json`);
    assert.equal(manifest.name, listed.name);
    assert.equal(listed.source, `./plugins/${listed.name}`);
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(listed.version, manifest.version, `${listed.name}: marketplace.json and plugin.json disagree`);
    const newest = /^## (\d+\.\d+\.\d+)/m.exec(read(`plugins/${listed.name}/CHANGELOG.md`))?.[1];
    assert.equal(newest, manifest.version, `${listed.name}: the newest CHANGELOG.md entry must be the manifest version`);
  }
});

test('each plugin ships what a public reader and an installer need', () => {
  for (const file of ['README.md', 'LICENSE', 'SECURITY.md', 'CONTRIBUTING.md', 'AGENTS.md', 'CLAUDE.md']) assert.ok(fs.existsSync(path.join(ROOT, file)), file);
  assert.match(read('CLAUDE.md'), /^@AGENTS\.md$/m, 'CLAUDE.md imports AGENTS.md so both tools read the same notes');
  for (const plugin of PLUGINS) {
    // A plugin is installed on its own, so its licence and docs must be inside its folder.
    for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md']) assert.ok(fs.existsSync(path.join(ROOT, 'plugins', plugin, file)), `${plugin}/${file}`);
    assert.equal(read(`plugins/${plugin}/LICENSE`), read('LICENSE'), `${plugin}/LICENSE`);
    const manifest = json(`plugins/${plugin}/.claude-plugin/plugin.json`);
    assert.equal(manifest.license, 'MIT');
    assert.match(manifest.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
    assert.ok(manifest.homepage.endsWith(`/plugins/${plugin}`));
    assert.ok(manifest.description.length > 40 && manifest.keywords.length > 0);
  }
});

// ------------------------------------------------------------------ skills

test('every skill has matching frontmatter and must be invoked explicitly', () => {
  for (const plugin of PLUGINS) {
    const skills = fs.readdirSync(path.join(ROOT, 'plugins', plugin, 'skills'));
    assert.ok(skills.length > 0);
    for (const skill of skills) {
      const text = read(`plugins/${plugin}/skills/${skill}/SKILL.md`);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '';
      assert.equal(/^name: (.+)$/m.exec(front)?.[1], skill, `${plugin}/${skill}: name`);
      assert.ok((/^description: (.+)$/m.exec(front)?.[1] ?? '').length > 40, `${plugin}/${skill}: description`);
      assert.match(front, /^disable-model-invocation: true$/m, `${plugin}/${skill}: these skills push code, so they are never auto-invoked`);
    }
  }
});

// ------------------------------------------------------------------ links

const slug = heading => heading.trim().toLowerCase().replace(/[`*]/g, '').replace(/[^\w\- ]/g, '').replaceAll(' ', '-');
const anchors = file => new Set(withoutFences(read(file)).split('\n').filter(line => /^#+ /.test(line)).map(line => slug(line.replace(/^#+ /, ''))));

test('relative Markdown links and their anchors resolve', () => {
  const broken = [];
  for (const file of MARKDOWN) {
    for (const [, target] of withoutFences(read(file)).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [relative, anchor] = target.split('#');
      const resolved = relative ? path.posix.normalize(path.posix.join(path.posix.dirname(file), relative)) : file;
      if (!fs.existsSync(path.join(ROOT, resolved))) broken.push(`${file}: ${target} (missing file)`);
      else if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) broken.push(`${file}: ${target} (missing heading)`);
    }
  }
  assert.deepEqual(broken, []);
});

// ------------------------------------------------------------------ examples and schema

// The subset of JSON Schema that autofix.config.schema.json uses.
function validate(schema, value, at = '$', problems = []) {
  const fail = message => problems.push(`${at}: ${message}`);
  if ('const' in schema && value !== schema.const) fail(`must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) fail(`must be one of ${schema.enum.join(', ')}`);
  const type = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (schema.type && !(schema.type === type || (schema.type === 'number' && type === 'integer'))) { fail(`must be ${schema.type}`); return problems; }
  if (typeof value === 'number') {
    if ('minimum' in schema && value < schema.minimum) fail(`must be >= ${schema.minimum}`);
    if ('maximum' in schema && value > schema.maximum) fail(`must be <= ${schema.maximum}`);
    if ('exclusiveMinimum' in schema && value <= schema.exclusiveMinimum) fail(`must be > ${schema.exclusiveMinimum}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) fail(`must match ${schema.pattern}`);
  if (Array.isArray(value)) {
    if ('minItems' in schema && value.length < schema.minItems) fail(`needs at least ${schema.minItems} items`);
    if (schema.items) value.forEach((item, index) => validate(schema.items, item, `${at}[${index}]`, problems));
  }
  if (type === 'object') {
    for (const key of schema.required ?? []) if (!(key in value)) fail(`missing ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.properties?.[key]) validate(schema.properties[key], item, `${at}.${key}`, problems);
      else if (schema.additionalProperties === false) fail(`unknown key ${key}`);
    }
  }
  return problems;
}
const KNOWN_KEYWORDS = new Set(['$schema', '$id', 'title', 'description', 'type', 'required', 'additionalProperties', 'properties', 'items', 'const', 'enum', 'default', 'examples', 'minimum', 'maximum', 'exclusiveMinimum', 'minItems', 'pattern']);
function keywords(schema, found = new Set()) {
  for (const [key, value] of Object.entries(schema)) {
    found.add(key);
    if (key === 'properties') for (const item of Object.values(value)) keywords(item, found);
    if (key === 'items') keywords(value, found);
  }
  return found;
}

const SCHEMA = json('plugins/dev-autofix/schema/autofix.config.schema.json');
const EXAMPLE_CONFIGS = walk('plugins/dev-autofix/examples', file => file.endsWith('.json'));

test('the test validator understands every keyword the config schema uses', () => {
  assert.deepEqual([...keywords(SCHEMA)].filter(key => !KNOWN_KEYWORDS.has(key)), []);
});

test('example configs satisfy the schema, and the schema rejects what it should', () => {
  assert.ok(EXAMPLE_CONFIGS.length > 0);
  for (const file of EXAMPLE_CONFIGS) assert.deepEqual(validate(SCHEMA, json(file)), [], file);
  const example = json('plugins/dev-autofix/examples/autofix.config.json');
  const broken = variant => validate(SCHEMA, variant).join('\n');
  assert.match(broken({ ...example, version: 2 }), /version: must be 1/);
  assert.match(broken({ ...example, surprise: true }), /unknown key surprise/);
  assert.match(broken({ ...example, repos: [{ ...example.repos[0], verify: [] }] }), /verify: needs at least 1 items/);
  assert.match(broken({ ...example, repos: [{ ...example.repos[0], env: ['A=b'] }] }), /env\[0\]: must match/);
});

test('the example queue is a queue the helpers accept, for a repo in the example config', () => {
  const config = json('plugins/dev-autofix/examples/autofix.config.json');
  const text = read('plugins/dev-autofix/examples/AUTOFIX_QUEUE.md');
  assert.deepEqual(autofixPR.lintQueue(text, config), { ok: true, entries: autofixPR.parseQueue(text).length, errors: [], warnings: [] });
  assert.ok(autofixPR.parseQueue(text).length >= 2);
  const repo = autofixPR.parseQueue(text)[0].repo;
  assert.ok(autofixPR.nextEntry(text, repo));
  assert.ok(autofixPR.addFallbackEntry(text, repo, 'example-fallback', 'An unplanned fix', '2026-01-01'));
  assert.ok(autofixPR.addInbox(text, 'one more thing'));
});

test('every config key in the schema is documented in the dev-autofix README', () => {
  const readme = read('plugins/dev-autofix/README.md');
  const keys = [...Object.keys(SCHEMA.properties), ...Object.keys(SCHEMA.properties.repos.items.properties)].filter(key => !['$schema', 'version', 'repos'].includes(key));
  assert.deepEqual(keys.filter(key => !readme.includes(`\`${key}\``)), []);
});

// ------------------------------------------------------------------ skills name real helper commands

// Code spans and fenced blocks only: prose can mention a script without calling it.
const codeOf = text => [...text.matchAll(/```[\s\S]*?```|`[^`\n]+`/g)].map(match => match[0]).join('\n');
const usageOf = (file, pattern) => new Set([...read(file).matchAll(pattern)].map(match => match[1]));
function called(text, pattern) {
  const found = new Set();
  for (const [, first, second] of codeOf(text).matchAll(pattern)) found.add(first === 'queue' && second ? `queue ${second}` : first);
  return found;
}

test('every helper command the dev-autofix docs name exists in the scripts', () => {
  const docs = MARKDOWN.filter(file => file.startsWith('plugins/dev-autofix/') && !file.endsWith('CHANGELOG.md')).map(read).join('\n');
  const known = {
    pr: usageOf('plugins/dev-autofix/scripts/pr.mjs', /^ {2}pr\.mjs (queue [a-z-]+|[a-z-]+)/gm),
    state: new Set(/Usage: state\.mjs ([a-z|-]+) /.exec(read('plugins/dev-autofix/scripts/state.mjs'))[1].split('|')),
    merge: new Set(['verify', 'check', 'release']),
    review: new Set(['verify']),
  };
  assert.ok(known.pr.has('queue lint') && known.pr.size >= 12 && known.state.size >= 12);
  const used = {
    pr: called(docs, /(?:<pr>|\bpr\.mjs)\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g),
    state: called(docs, /\bstate\.mjs\s+([a-z][a-z-]*)/g),
    merge: called(docs, /\bmerge\.mjs\s+([a-z][a-z-]*)/g),
    review: called(docs, /\breview\.mjs\s+([a-z][a-z-]*)/g),
  };
  for (const script of Object.keys(known)) {
    assert.ok(used[script].size > 0, `${script}.mjs is never named in the docs`);
    assert.deepEqual([...used[script]].filter(command => !known[script].has(command)), [], `${script}.mjs`);
  }
});

test('every state.mjs command the dev-autotask docs name exists in the script', () => {
  const docs = MARKDOWN.filter(file => file.startsWith('plugins/dev-autotask/') && !file.endsWith('CHANGELOG.md')).map(read).join('\n');
  const known = new Set(/Usage: state\.mjs (?:\[[^\]]*\] )?(.+)'/.exec(read('plugins/dev-autotask/scripts/state.mjs'))[1].split(' | ').map(part => part.split(' ')[0]));
  assert.ok(known.has('show') && known.has('create'));
  const used = called(docs.replace(/--(?:repo|remote) \S+/g, ''), /(?:<state>|\bstate\.mjs)\s+([a-z][a-z-]*)/g);
  assert.ok(used.size >= 4);
  assert.deepEqual([...used].filter(command => !known.has(command)), []);
});

test('every helper message quoted in the troubleshooting page still exists in the code', () => {
  const page = read('plugins/dev-autofix/docs/troubleshooting.md');
  // Helper messages come from the scripts; the worker's report phrases come from the fix brief.
  const source = [...walk('plugins/dev-autofix/scripts', file => file.endsWith('.mjs')), 'plugins/dev-autofix/references/fix-brief.md'].map(read).join('\n');
  // First cell of each table row; only quoted text of three words or more is a helper message.
  const quoted = [...page.matchAll(/^\| (.+?) \|/gm)].flatMap(([, cell]) => [...cell.matchAll(/`([^`]+)`/g)].map(match => match[1])).filter(text => text.split(' ').length >= 3);
  assert.ok(quoted.length >= 20, `only ${quoted.length} messages found`);
  assert.deepEqual(quoted.filter(text => !source.includes(text)), []);
});

// ------------------------------------------------------------------ the two plugins stay in step

test('both plugins run repo commands with the same defaults', () => {
  assert.equal(autofixMerge.DEFAULT_INSTALL, autotaskVerify.DEFAULT_INSTALL);
  assert.deepEqual(autofixMerge.COMMAND_ENV_PASS, autotaskVerify.COMMAND_ENV_PASS);
  const source = { PATH: '/bin', HOME: '/h', SECRET: 'x', EXTRA: 'y' };
  assert.deepEqual(autofixMerge.commandEnv(source, ['EXTRA']), autotaskVerify.commandEnv(source, ['EXTRA']));
});

test('both plugins look for the same malware signatures', () => {
  assert.deepEqual(autotaskPublish.MALWARE_SIGNATURES, autofixPR.MALWARE_SIGNATURES);
});
