import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`verification interruption by ${signal} cleans up and cannot pass after a zero exit`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'autofix-interrupt-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const log = path.join(directory, 'command.log');
    const moduleUrl = new URL('../scripts/merge.mjs', import.meta.url).href;
    const source = `
      import { createRuntime } from ${JSON.stringify(moduleUrl)};
      const listenersBefore = process.listenerCount(${JSON.stringify(signal)});
      setTimeout(() => process.kill(process.pid, ${JSON.stringify(signal)}), 300);
      const result = await createRuntime().run('trap "exit 0" INT TERM; while :; do sleep 1; done', ${JSON.stringify(directory)}, ${JSON.stringify(log)}, 5000);
      process.stdout.write(JSON.stringify({ result, listenersBefore, listenersAfter: process.listenerCount(${JSON.stringify(signal)}) }));
    `;
    const output = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Interrupted verification did not finish')); }, 10000);
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', (code, sig) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`Runner exited ${code}/${sig}: ${stderr}`));
        else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
      });
    });
    assert.equal(output.result.signal, signal);
    assert.equal(output.result.exitCode, 0);
    assert.equal(output.result.timedOut, false);
    assert.equal(output.listenersAfter, output.listenersBefore);
    assert.match(fs.readFileSync(log, 'utf8'), new RegExp(`Interrupted by ${signal}`));
  });
}
