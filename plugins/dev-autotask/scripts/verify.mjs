// Runs the selected repo's install, prepare and verify commands, in order, in <dir>.
// Output streams through; stops at the first failure. Exit code 0 only if all pass.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './state.mjs';

export const DEFAULT_INSTALL = 'npm ci --ignore-scripts --no-audit --no-fund'; // autofix's default

// KEY-DECISION 2026-11-06: commands get a minimal environment, not process.env, so repo
// scripts (and security regression tests) never see the caller's tokens or credentials.
// Install tools still find their config and caches through HOME and these variables.
const PASS = ['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG', 'LC_ALL', 'TZ',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'npm_config_cache', 'NPM_CONFIG_CACHE', 'NVM_DIR', 'VOLTA_HOME',
  'PNPM_HOME', 'COREPACK_HOME', 'YARN_CACHE_FOLDER'];
// repo.env (an optional autofix.config.json repo field) names extra variables to pass through (e.g. DATABASE_URL); values never live in config.
export const commandEnv = (source = process.env, extra = []) =>
  ({ ...Object.fromEntries([...PASS, ...extra].filter(k => source[k] !== undefined).map(k => [k, source[k]])), CI: '1' });

// One command in its own process group. When the shell exits (pass, fail or timeout) the
// group is stopped and awaited, so no background child outlives verification.
const GRACE_MS = 2000, GIVE_UP_MS = 10000;
const killGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch {} };
const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
// SIGTERM the group, SIGKILL after the grace period; true if it is gone within GIVE_UP_MS.
async function stopGroup(pid) {
  killGroup(pid, 'SIGTERM');
  for (let waited = 0; groupAlive(pid) && waited < GIVE_UP_MS; waited += 50) {
    if (waited === GRACE_MS) killGroup(pid, 'SIGKILL');
    await sleep(50);
  }
  return !groupAlive(pid);
}
const active = new Set(); // running command groups, for the CLI's signal handler
let cancelled = false; // set by the CLI's signal handler; no command starts after it

export function runCommand(command, cwd, timeoutMs, stdio = 'inherit', env = commandEnv()) {
  return new Promise(resolve => {
    if (cancelled) return resolve({ ok: false, cancelled });
    const child = spawn('/bin/sh', ['-c', command], { cwd, env, detached: true, stdio });
    if (child.pid) active.add(child.pid);
    let timedOut = false, killTimer;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid, 'SIGTERM'); killTimer = setTimeout(() => killGroup(child.pid, 'SIGKILL'), GRACE_MS); }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); active.delete(child.pid); resolve({ ok: false, error: error.message }); });
    child.on('exit', async (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      const leftover = !await stopGroup(child.pid); // could not be stopped: fail rather than report a clean pass
      active.delete(child.pid);
      resolve({ ok: code === 0 && !timedOut && !leftover, code, signal, timedOut, ...(leftover && { leftover }) });
    });
  });
}

export async function verify(config, dir, { stdio = 'inherit', log = console.error } = {}) {
  // Same rule as dev-autofix's installIfStale: no install configured means the default
  // npm install only when the checkout has a package.json, otherwise none.
  const install = config.repo.install ?? (fs.existsSync(path.join(dir, 'package.json')) ? DEFAULT_INSTALL : null);
  const commands = [install, ...config.repo.prepare, ...config.repo.verify].filter(Boolean);
  const results = [];
  for (const command of commands) {
    if (cancelled) break;
    log(`[dev-autotask] $ ${command}`);
    const result = { command, ...await runCommand(command, dir, config.repo.commandTimeoutSeconds * 1000, stdio, commandEnv(process.env, config.repo.env)) };
    results.push(result);
    if (cancelled) break;
    if (!result.ok) {
      log(`[dev-autotask] FAILED${result.timedOut ? ' (timed out)' : ''}: ${command}`);
      return { passed: false, results };
    }
  }
  if (cancelled) {
    log('[dev-autotask] FAILED: cancelled');
    return { passed: false, cancelled, results };
  }
  log('[dev-autotask] all checks passed');
  return { passed: true, results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [dir, configFile, repo] = process.argv.slice(2);
  // Cancelling the helper stops the running command's group before exiting, and fails.
  // Signal listeners do not keep Node alive, so normal completion is unaffected.
  for (const name of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(name, async () => {
      if (cancelled) return;
      cancelled = true; // first, synchronously: verify() and runCommand() start nothing new
      console.error(`[dev-autotask] ${name}: stopping checks`);
      // Drain until empty; each group is taken once, so an unkillable one cannot spin this forever.
      while (active.size) {
        const pids = [...active];
        pids.forEach(pid => active.delete(pid));
        await Promise.all(pids.map(stopGroup));
      }
      process.exit(1);
    });
  }
  try {
    // Both explicit: the task's recorded config and repo name, never rediscovered from <dir>.
    if (!dir || !configFile || !repo) throw new Error('Usage: verify.mjs <dir> <config-file> <repo-name>');
    const { passed } = await verify(loadConfig(configFile, { repo }), path.resolve(dir));
    process.exitCode = passed ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
