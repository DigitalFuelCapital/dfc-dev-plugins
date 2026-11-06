// Runs the configured install command (if any), then each verify command, in <dir>.
// Output streams through; stops at the first failure. Exit code 0 only if all pass.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
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

// One command in its own process group. When the shell exits (pass, fail or timeout) the
// group is stopped and awaited, so no background child outlives verification.
const GRACE_MS = 2000, GIVE_UP_MS = 10000;
export function runCommand(command, cwd, timeoutMs, stdio = 'inherit', env = commandEnv()) {
  return new Promise(resolve => {
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio });
    const killGroup = signal => { try { process.kill(-child.pid, signal); } catch {} };
    const groupAlive = () => { try { process.kill(-child.pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
    let timedOut = false, killTimer;
    const timer = setTimeout(() => { timedOut = true; killGroup('SIGTERM'); killTimer = setTimeout(() => killGroup('SIGKILL'), GRACE_MS); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ ok: false, error: error.message }); });
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      killGroup('SIGTERM');
      for (let waited = 0; groupAlive() && waited < GIVE_UP_MS; waited += 50) {
        if (waited === GRACE_MS) killGroup('SIGKILL');
        await sleep(50);
      }
      const leftover = groupAlive(); // could not be stopped: fail rather than report a clean pass
      resolve({ ok: code === 0 && !timedOut && !leftover, code, signal, timedOut, ...(leftover && { leftover }) });
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
