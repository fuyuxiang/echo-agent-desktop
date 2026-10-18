import { cleanNativeReviewEnvironment } from "./lib/native-review-isolation.mjs";
// Full host tests with isolated state. macOS preparation adds only local test
// signatures; it never changes operating-system checks or release identities.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareMacosTestSignatures } from './prepare-macos-test-signatures.mjs';
assert.equal(process.argv.length, 2, 'This entry runs all host tests; arbitrary filters are not accepted');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-host-tests-')));
const legacy = join(home, 'empty-legacy'); mkdirSync(legacy, { mode: 0o700 });
const env = { ...cleanNativeReviewEnvironment(process.env), ECHO_AGENT_HOME: home, GROK_HOME: legacy };
console.log(`Isolated host test data: ${home}`);
const preparation = prepareMacosTestSignatures(env);
if (process.platform === 'darwin') {
  // A second Cargo build can relink a harness and discard its signature. Run
  // exactly the complete --lib --tests artifact set Cargo just compiled, with
  // Cargo's manifest-directory cwd and the same unfiltered test arguments.
  console.log(`Compiled host test programs: ${preparation.signed.length}`);
  for (const executable of preparation.signed) {
    console.log(`Running compiled host tests: ${executable}`);
    const result = spawnSync(executable, ['--test-threads=2'],
      { cwd: realpathSync('src-tauri'), env, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} else {
  const result = spawnSync('cargo', ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml',
    '--lib', '--tests', '-j', '2', '--', '--test-threads=2'], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}
