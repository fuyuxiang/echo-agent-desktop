// Resume only the read-only restart phase after an already verified real hour.
// Original failures and first-launch evidence are never rewritten.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { foreignReadonlySnapshot, physicalFinal, verifyCapabilitiesNativeReport } from './validate-native-capabilities-review.mjs';
import { capabilitiesGitProcessEnvironment } from './lib/capabilities-git-resource.mjs';
import { PRIVATE_REVIEW_MODEL_ID, redactReviewModelSecrets, reviewModelId, captureReviewModelLogs } from './lib/native-review-model.mjs';
import { activateNativeReviewWindow, assertNativeReviewSessionUnlocked } from './lib/native-review-window.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function ordinary(path, directory = false) {
  const stat = lstatSync(path);
  assert(!stat.isSymbolicLink() && realpathSync(path) === path && (directory ? stat.isDirectory() : stat.isFile()), 'Resume evidence must be canonical ordinary files/directories');
  if (directory) assert.equal(stat.mode & 0o077, 0, 'Resume evidence directory must be private');
}

export function loadCapabilitiesResume(resultPath) {
  resultPath = resolve(resultPath);
  assert(/^\/private\/(?:tmp|var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/T)\/echo-native-capabilities-evidence-[A-Za-z0-9_-]+\/run-[A-Za-z0-9_-]+\/native-capabilities-result\.json$/.test(resultPath), 'Resume requires an owned temporary capabilities result');
  ordinary(dirname(resultPath), true); ordinary(resultPath);
  assert(lstatSync(resultPath).size < 2 * 1024 * 1024, 'Resume evidence exceeds bound');
  const previous = json(resultPath), { home, cwd, executable } = previous;
  assert.equal(previous.kind, 'native-capabilities-driver'); assert.equal(previous.output, dirname(resultPath));
  assert.equal(previous.version, 1); assert.equal(previous.passed, false); assert.equal(previous.nativeVerified, false); assert.equal(previous.phases?.length, 1);
  assert(previous.errors?.length && previous.errors.every(error => error === 'Native capabilities phase exceeded its genuine wall-clock acceptance deadline'), 'Only an incomplete restart timeout can be resumed');
  for (const flag of ['timeInjected', 'manualRunRequested', 'defaultHomeChanged']) assert.equal(previous[flag], false);
  assert(/^\/private\/(?:tmp|var\/folders\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/T)\/echo-native-review-capabilities-[A-Za-z0-9_-]+$/.test(home));
  ordinary(home, true); assert.equal(cwd, join(home, 'workspaces', 'default')); ordinary(cwd, true);
  ordinary(executable); assert(executable.endsWith('.app/Contents/MacOS/echoagent'));
  assert.equal(sha(readFileSync(executable)), previous.binarySha256, 'Original capabilities binary changed; refusing to mix builds');
  const manifestPath = join(cwd, 'capabilities-fixture.json'); ordinary(manifestPath);
  assert.equal(sha(readFileSync(manifestPath)), previous.manifestSha256);
  const manifest = json(manifestPath), first = previous.phases[0];
  assert.equal(manifest.home, home); assert.equal(manifest.cwd, cwd);
  assert.equal(first.phase, 'first-launch'); assert.equal(first.exitCode, 0); assert(first.physical);
  const savedFirst = join(previous.output, 'first-launch.json'); ordinary(savedFirst);
  assert.deepEqual(json(savedFirst), first.report, 'Original renderer evidence changed');
  // Historical evidence was already bounded by its original parent. This is
  // revalidation of that preserved report, never a fresh process attestation.
  const expected = verifyCapabilitiesNativeReport({ report: first.report, manifest, phase: 'first-launch', pid: first.pid, startedAt: 0 });
  const expectedPath = join(cwd, '.capabilities-restart-expected.json'); ordinary(expectedPath);
  assert.deepEqual(json(expectedPath), expected);
  assert(previous.gitHandoff && previous.actualPluginV2?.commit === expected.version2Commit);
  assert(previous.refreshFailureResource?.recovered && previous.refreshFailureResource.http503Count > 0);
  physicalFinal({ home, manifest, expected, first: first.physical });
  assert.deepEqual(foreignReadonlySnapshot(), previous.foreignBefore, 'Foreign configuration changed since original acceptance');
  return { resultPath, previous, manifest, expected };
}

export async function resumeCapabilitiesRestart({ resultPath, validateOnly = false }) {
  const scope = loadCapabilitiesResume(resultPath), { previous, manifest, expected } = scope;
  if (validateOnly) return { resumeReady: true, nativeVerified: false, firstChecks: 17, actualRecords: expected.records.length, sameBinary: true };
  assertNativeReviewSessionUnlocked();
  if (manifest.modelId === PRIVATE_REVIEW_MODEL_ID) assert.equal(reviewModelId(), PRIVATE_REVIEW_MODEL_ID, 'Set the original private model config for redaction');
  const { home, cwd, executable } = previous, output = mkdtempSync(join(previous.output, 'restart-retry-'));
  const reportPath = join(home, 'native-review.json'), historyPath = join(home, 'native-review-history.jsonl');
  ordinary(historyPath);
  if (existsSync(reportPath)) { writeFileSync(join(output, 'previous-renderer.json'), redactReviewModelSecrets(readFileSync(reportPath)), { mode: 0o600 }); unlinkSync(reportPath); }
  const oldHistory = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(oldHistory.filter(report => JSON.stringify(report) === JSON.stringify(previous.phases[0].report)).length, 1);
  const env = capabilitiesGitProcessEnvironment({ GROK_HOME: join(home, 'empty-legacy'), GIT_SSL_CAINFO: manifest.caPath });
  for (const key of Object.keys(env)) if (key.startsWith('ECHO_DESKTOP_REVIEW') || ['ECHO_AGENT_HOME', 'ECHO_DESKTOP_VALIDATION', 'ECHO_THEIA_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) delete env[key];
  Object.assign(env, { ECHO_DESKTOP_REVIEW: '1', ECHO_DESKTOP_REVIEW_CAPABILITIES: '1', ECHO_DESKTOP_REVIEW_EXTENDED: '0', ECHO_DESKTOP_REVIEW_MEDIA: '0', ECHO_DESKTOP_REVIEW_PHASE: 'restart' });
  const result = { kind: 'native-capabilities-restart-retry', passed: false, nativeVerified: false, combinedNativeVerified: false,
    originalResult: scope.resultPath, originalResultSha256: sha(readFileSync(scope.resultPath)), binarySha256: previous.binarySha256, home, output, errors: [], windowActivation: [] };
  const startedAt = Date.now(), child = spawn(executable, ['--data-home', home], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let ended = false, spawnError, nextActivation = 0;
  child.once('exit', () => { ended = true; }); child.once('error', error => { ended = true; spawnError = error; });
  const logs = captureReviewModelLogs(child, join(output, 'restart.log'));
  const stop = () => child.kill('SIGTERM'); process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    while (!ended && Date.now() - startedAt < 180000) {
      if (Date.now() >= nextActivation) { nextActivation = Date.now() + 15000; result.windowActivation.push({ pid: child.pid, activated: activateNativeReviewWindow(child.pid) }); }
      await delay(250);
    }
    assert(ended, 'Restart retry exceeded original 180s bound'); assert(!spawnError); await logs.finished; assert(!logs.overflow, 'Restart log exceeded limit'); assert(!logs.incomplete, 'Native log pipes did not close after process exit');
    assert.equal(child.exitCode, 0); assert.equal(child.signalCode, null);
    const report = json(reportPath); writeFileSync(join(output, 'restart.json'), redactReviewModelSecrets(JSON.stringify(report, null, 2)), { mode: 0o600 });
    verifyCapabilitiesNativeReport({ report, manifest, phase: 'restart', pid: child.pid, startedAt, previousExpected: expected });
    const history = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
    assert.equal(history.length, oldHistory.length + 1); assert.deepEqual(history.slice(0, -1), oldHistory); assert.deepEqual(history.at(-1), report);
    result.physical = physicalFinal({ home, manifest, expected, first: previous.phases[0].physical });
    assert.deepEqual(foreignReadonlySnapshot(), previous.foreignBefore);
    result.passed = result.nativeVerified = result.combinedNativeVerified = true; result.checks = report.checks.length;
  } catch (error) { result.errors.push(String(error?.message || error)); }
  finally {
    if (!ended) { child.kill('SIGTERM'); for (let i = 0; i < 20 && !ended; i++) await delay(250); if (!ended) child.kill('SIGKILL'); }
    await logs.finished;
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    writeFileSync(join(output, 'restart-retry-result.json'), redactReviewModelSecrets(JSON.stringify(result, null, 2)), { mode: 0o600 });
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), validateOnly = args[0] === '--validate-only';
  assert(args.length === (validateOnly ? 2 : 1), 'Usage: node scripts/resume-native-capabilities-review.mjs [--validate-only] <original-result.json>');
  const result = await resumeCapabilitiesRestart({ resultPath: args.at(-1), validateOnly });
  console.log(redactReviewModelSecrets(JSON.stringify(result))); if (!validateOnly && !result.passed) process.exitCode = 1;
}
