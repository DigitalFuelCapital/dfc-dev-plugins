// Runs the configured install command (if any), then each verify command, in <dir>.
// Output streams through; stops at the first failure. Exit code 0 only if all pass.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './state.mjs';

// KEY-DECISION 2026-11-06: commands get a minimal environment, not process.env, so repo
// scripts (and security regression tests) never see the caller's tokens or credentials.
// Install tools still find their config and caches through HOME and these variables.
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'LC_ALL', 'TZ',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'NVM_DIR', 'VOLTA_HOME',
  'PNPM_HOME', 'COREPACK_HOME', 'YARN_CACHE_FOLDER'];
// repo.env names extra variables to pass through (e.g. DATABASE_URL); values never live in config.
export const commandEnv = (source = process.env, extra = []) =>
  ({ ...Object.fromEntries([...PASS, ...extra].filter(k => source[k] !== undefined).map(k => [k, source[k]])), CI: '1' });

// One command in its own process group, so a timeout or exit also stops its children.
export function runCommand(command, cwd, timeoutMs, stdio = 'inherit', env = commandEnv()) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio });
    const killGroup = signal => { try { process.kill(-child.pid, signal); } catch {} };
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); setTimeout(() => killGroup('SIGKILL'), 5000).unref(); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      killGroup('SIGTERM');
      resolve({ ok: code === 0 && !timedOut, code, signal, timedOut });
    });
  });
}

export async function verify(config, dir, { stdio = 'inherit', log = console.error } = {}) {
  const commands = [config.repo.install, ...config.repo.verify].filter(Boolean);
  const results = [];
  for (const command of commands) {
    log(`[dev-autotask] $ ${command}`);
    const result = { command, ...await runCommand(command, dir, config.repo.commandTimeoutSeconds * 1000, stdio, commandEnv(process.env, config.repo.env)) };
    results.push(result);
    if (!result.ok) {
      log(`[dev-autotask] FAILED${result.timedOut ? ' (timed out)' : ''}: ${command}`);
      return { passed: false, results };
    }
  }
  log('[dev-autotask] all checks passed');
  return { passed: true, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, configFile] = process.argv.slice(2);
  try {
    if (!dir) throw new Error('Usage: verify.mjs <dir> [config-file]');
    const { passed } = await verify(configFile ? loadConfig(configFile) : loadConfig(), path.resolve(dir));
    process.exitCode = passed ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
