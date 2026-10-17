import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixture = join(root, 'scripts/fixtures/theia-owner-tree.cjs');
const guard = join(root, 'src-tauri/theia-parent-guard.cjs');
const running = pid => {
  const reply = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' });
  assert([0, 1].includes(reply.status));
  return reply.status === 0 && !!reply.stdout.trim() && !reply.stdout.trim().startsWith('Z');
};
async function wait(check, label, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) { if (check()) return; await delay(30); }
  assert.fail(label);
}
for (const signal of ['SIGTERM', 'SIGKILL', 'SIGUSR2']) test(`owner lifetime ${signal} reclaims only its backend tree`, { skip: process.platform === 'win32' }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'echo-theia-owner-'));
  const spacedGuard = join(directory, '中文 guard.cjs'); copyFileSync(guard, spacedGuard);
  const owner = spawn(process.execPath, [fixture, 'owner', directory, spacedGuard], { stdio: ['ignore', 'ignore', 'pipe'] });
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  let proof, errors = '';
  owner.stderr.on('data', bytes => { errors += bytes; });
  try {
    await wait(() => existsSync(join(directory, 'owner.json')) && existsSync(join(directory, 'worker.json')), `real owned tree did not start: ${errors}`);
    proof = JSON.parse(readFileSync(join(directory, 'owner.json')));
    assert.equal(JSON.parse(readFileSync(join(directory, 'worker.json'))).inheritedOwnerFd, false, 'IPC workers must not attach the backend owner socket');
    await delay(200);
    assert(running(proof.backendPid) && running(proof.workerPid), 'Live owner unexpectedly lost its backend');
    assert(owner.kill(signal));
    await wait(() => !running(proof.backendPid) && !running(proof.workerPid), 'Backend or stubborn worker survived owner loss');
    assert(running(unrelated.pid), 'Cleanup touched an unrelated process');
    if (signal === 'SIGUSR2') assert(running(owner.pid), 'Closing the capability must not kill its owner');
    assert(!existsSync(join(directory, 'late-write')));
  } finally {
    if (proof) { try { process.kill(-proof.backendPid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
    owner.kill('SIGKILL'); unrelated.kill('SIGKILL'); rmSync(directory, { recursive: true, force: true });
  }
});
test('ordinary inherited preload without an owner descriptor is a no-op', () => {
  const reply = spawnSync(process.execPath, ['--require', guard, '-e', 'process.stdout.write("ok")'], { encoding: 'utf8', env: { ...process.env, ECHO_THEIA_PARENT_FD: undefined } });
  assert.equal(reply.status, 0); assert.equal(reply.stdout, 'ok');
});
test('refuses stdio as an owner capability', { skip: process.platform === 'win32' }, () => {
  const reply = spawnSync(process.execPath, ['--require', guard, '-e', 'process.stdout.write("unsafe")'], { encoding: 'utf8', env: { ...process.env, ECHO_THEIA_PARENT_FD: '0' } });
  assert.notEqual(reply.status, 0); assert.equal(reply.stdout, '');
});
