import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCapabilitiesResume } from './resume-native-capabilities-review.mjs';

test('resume refuses an arbitrary result path before launching anything', () => {
  assert.throws(() => loadCapabilitiesResume('/private/tmp/unrelated-result.json'), /owned temporary capabilities result/);
});
test('resume refuses shared or symlinked evidence directories', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-capabilities-evidence-')));
  const run = mkdtempSync(join(root, 'run-')), result = join(run, 'native-capabilities-result.json');
  try {
    writeFileSync(result, '{}'); chmodSync(run, 0o755);
    assert.throws(() => loadCapabilitiesResume(result), /must be private/);
    chmodSync(run, 0o700); const link = join(root, 'run-link'); symlinkSync(run, link);
    assert.throws(() => loadCapabilitiesResume(join(link, 'native-capabilities-result.json')), /canonical ordinary/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test('resume refuses a changed binary before admitting any renderer evidence', { skip: process.platform !== 'darwin' }, () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-capabilities-evidence-')));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-review-capabilities-')));
  try {
    const run = mkdtempSync(join(root, 'run-')), cwd = join(home, 'workspaces', 'default');
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const bin = join(home, 'Fixture.app', 'Contents', 'MacOS'); mkdirSync(bin, { recursive: true });
    const executable = join(bin, 'echoagent'); writeFileSync(executable, 'non-executable synthetic fixture');
    const result = join(run, 'native-capabilities-result.json');
    writeFileSync(result, JSON.stringify({ kind: 'native-capabilities-driver', version: 1, output: run,
      passed: false, nativeVerified: false, phases: [{}], errors: ['Native capabilities phase exceeded its genuine wall-clock acceptance deadline'],
      timeInjected: false, manualRunRequested: false, defaultHomeChanged: false, home, cwd, executable, binarySha256: '0'.repeat(64) }));
    assert.throws(() => loadCapabilitiesResume(result), /Original capabilities binary changed/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
