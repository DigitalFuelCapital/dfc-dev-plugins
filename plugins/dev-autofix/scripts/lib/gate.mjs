// The push gate: protected files, size, malware signatures, risky constructs, signatures.
import path from 'node:path';
import { checkWorktree } from '../state.mjs';
import { createRuntime, requireValue } from './common.mjs';

// KEY-DECISION 2026-09-27: one pattern list for run and finish gates; skills no longer carry grep blocks.
// KEY-DECISION 2026-11-11: two tiers. A malware signature is an indicator of one known campaign:
// a match stops the run and flags the machine. A risky construct is ordinary code that malware
// also uses: a match blocks that one entry for a human, and the run carries on. Either kind can
// be switched off by id with config.disabledPatterns.
export const MALWARE_SIGNATURES = {
  'global-bang': String.raw`global\[['"]!['"]\]`, 'fromcharcode-127': String.raw`String\.fromCharCode\(127\)`,
  'auth-api-key': 'AUTH_API_KEY', 'auth-confirm-nine': 'auth-confirm-nine', 'trongrid': String.raw`api\.trongrid\.io`,
  'bsc-dataseed': 'bsc-dataseed', 'aptoslabs': String.raw`aptoslabs\.com`, 'atob-env': String.raw`atob\(process\.env`,
  'config-bat': String.raw`config\.bat`,
};
export const RISKY_CONSTRUCTS = {
  'create-require': 'createRequire', 'eval': String.raw`(^|[^.A-Za-z_])eval\(`, 'new-function': String.raw`new Function\(`,
};
export const MALWARE_PATTERNS = Object.values(MALWARE_SIGNATURES);

export function gatePatterns(config = {}) {
  const disabled = config.disabledPatterns ?? [];
  const known = { ...MALWARE_SIGNATURES, ...RISKY_CONSTRUCTS };
  for (const id of disabled) requireValue(id in known, `disabledPatterns: unknown pattern id ${id}; known ids: ${Object.keys(known).join(', ')}`);
  const enabled = table => Object.entries(table).filter(([id]) => !disabled.includes(id)).map(([, source]) => new RegExp(source));
  return { malware: [...enabled(MALWARE_SIGNATURES), ...(config.blockPatterns ?? []).map(source => new RegExp(source))], risky: enabled(RISKY_CONSTRUCTS) };
}

// Files a fix must never touch: they decide what code gets installed, built or run.
const LOCKFILES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'deno.lock',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'Cargo.lock', 'go.sum', 'Gemfile.lock', 'composer.lock', 'mix.lock', 'pubspec.lock', 'flake.lock'];
const MANIFESTS = ['pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'go.mod', 'Cargo.toml', 'Gemfile', 'composer.json', 'pom.xml',
  'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'deno.json', 'deno.jsonc', 'mix.exs', 'pubspec.yaml'];
const PACKAGE_MANAGER_CONFIG = ['.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pip.conf', '.pypirc'];
const BUILD_FILE = /^(makefile|gnumakefile|justfile|taskfile\.ya?ml|dockerfile(\.(?!md$).+)?|.+\.dockerfile|(docker-)?compose(\..+)?\.ya?ml)$/i;
const CI_CONFIG = /(^|\/)(\.github|\.husky|\.circleci)\/|(^|\/)(\.gitlab-ci\.yml|\.pre-commit-config\.yaml)$/;
const SCRIPT = /\.(sh|bash|zsh|fish|command|bat|cmd|ps1|vbs)$/i;
const TOOL_CONFIG = /^(postcss\.config\..+|eslint\.config\..+|next\.config\..+|vite\.config\..+|tsconfig.*\.json|wrangler\..+|\.graphqlrc(\..+)?)$/;

export function forbiddenPath(file, repo = {}, config = {}) {
  const base = path.posix.basename(file);
  const locks = [...LOCKFILES, path.posix.basename(repo.lockfile ?? 'package-lock.json')];
  if (base === '.gitignore' || base === 'package.json' || locks.includes(base)) return base;
  if (/^\.env/.test(base)) return '.env*';
  if (MANIFESTS.includes(base) || /^requirements.*\.txt$/.test(base)) return 'dependency manifest';
  if (PACKAGE_MANAGER_CONFIG.includes(base)) return 'package manager config';
  const ci = CI_CONFIG.exec(file);
  if (ci) return ci[2] ?? ci[4];
  if (SCRIPT.test(base)) return 'script';
  if (TOOL_CONFIG.test(base)) return 'build/lint config';
  if (BUILD_FILE.test(base)) return 'build file';
  for (const source of [...(config.protectedPaths ?? []), ...(repo.protectedPaths ?? [])]) if (new RegExp(source).test(file)) return `protectedPaths /${source}/`;
  return null;
}

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

// KEY-DECISION 2026-09-28: moved code counts once, not twice (a 160-line dedupe was refused at a 150-line cap).
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
  const patterns = gatePatterns(config);
  // One pass per patch: a signature is `malware`, a risky construct only `risky`.
  const scanPatch = (label, patch) => {
    const added = addedLines(patch);
    for (const hit of scan(added, patterns.malware)) fail('malware', `${label}: /${hit.pattern}/ in "${hit.line}"`);
    for (const hit of scan(added, patterns.risky)) fail('risky', `${label}: /${hit.pattern}/ in "${hit.line}" - a construct malware also uses; a human must make this change`);
  };
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
      const parents = git(cwd, ['rev-list', '--parents', '-n1', merge]).split(' ').slice(1);
      // Git skips --remerge-diff for octopus merges, so their content could not be inspected.
      if (parents.length !== 2) { fail('shape', `merge ${merge} has ${parents.length} parents; only a two-parent merge of origin/${repo.baseBranch} can be checked`); continue; }
      if (!ancestor(parents[1], base)) fail('shape', `merge ${merge} pulls in ${parents[1]}, not on origin/${repo.baseBranch}`);
      // --no-renames lists both sides of a rename, so neither path escapes forbiddenPath.
      for (const file of git(cwd, ['show', '--remerge-diff', '--no-renames', '--format=', '--name-only', '-z', merge]).split('\0').filter(Boolean)) {
        const why = forbiddenPath(file, repo, config);
        if (why) fail('files', `${merge.slice(0, 8)} conflict resolution touches ${file} (${why})`);
      }
      scanPatch(merge.slice(0, 8), git(cwd, ['show', '--remerge-diff', '--no-renames', '--format=', merge]));
    }
    limit = Math.ceil((config.maxDiffLines ?? 150) * 1.5);
    size = diffSize(git(cwd, ['diff', '-U0', '--no-color', base, 'HEAD']));
  }
  for (const commit of commits) {
    try { git(cwd, ['verify-commit', commit]); } catch { fail('signed', `signature invalid ${commit}`); }
    if (merges.includes(commit)) continue;
    for (const { newMode, file } of parseRawZ(git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '-z', commit]))) {
      const why = forbiddenPath(file, repo, config);
      if (why) fail('files', `${commit.slice(0, 8)} touches ${file} (${why})`);
      if (newMode === '100755') fail('files', `${commit.slice(0, 8)} makes ${file} executable`);
    }
    scanPatch(commit.slice(0, 8), git(cwd, ['diff-tree', '--no-commit-id', '--root', '-r', '-p', '-U0', commit]));
  }
  const verdict = sizeVerdict(size, limit, config, maxDiff);
  if (!verdict.ok) fail('size', `${verdict.raw} changed lines (${verdict.moved} moved, ${verdict.effective} effective) exceeds limit ${verdict.limit}; auto-pass needs effective <= ${verdict.limit} and raw <= ${verdict.ceiling}`);
  const dirty = git(cwd, ['status', '--porcelain']);
  if (dirty) fail('clean', dirty.split('\n').slice(0, 10).join('; '));
  return { ok: failures.length === 0, malware: failures.some(item => item.check === 'malware'), failures, path: cwd, branch, head: git(cwd, ['rev-parse', 'HEAD']), commits, size: verdict };
}
