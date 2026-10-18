import { cleanNativeReviewEnvironment } from "./lib/native-review-isolation.mjs";
import { nativeReviewOutput } from './lib/native-review-output.mjs';
// Actual native Code acceptance, continuing only an existing isolated review
// home. Run after all prior apps, Cargo, and staging have finished.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync,
  mkdtempSync, realpathSync, lstatSync, statSync, openSync, closeSync, unlinkSync, copyFileSync } from 'node:fs';
import { resolve, join, relative, isAbsolute, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { inspectCodeContinuation, inspectCodeDeliveryContinuation } from './native-coding-continuation-state.mjs';

assert.equal(process.platform, 'darwin', 'This driver requires the actual macOS WKWebView installer');
const executableArgument = process.argv[2];
const homeArgument = process.argv[3];
const continueExistingTask = process.argv[4] === '--continue-existing-task';
const continueDeliveryReview = process.argv[4] === '--continue-delivery-review';
assert(process.argv.length <= 5 && (!process.argv[4] || continueExistingTask || continueDeliveryReview), 'Unsupported or mutually exclusive native Code review arguments');
assert(executableArgument && homeArgument, 'Usage: node scripts/validate-native-coding-review.mjs <built-executable> <existing-isolated-native-home> [--continue-existing-task | --continue-delivery-review]');
const executable = realpathSync(resolve(executableArgument));
const home = realpathSync(resolve(homeArgument));
const within = (root, path) => {
  const inside = relative(root, path);
  return inside !== '' && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside);
};
assert(lstatSync(home).isDirectory() && !lstatSync(resolve(homeArgument)).isSymbolicLink(), 'Review home must be an ordinary canonical directory');
assert(home === resolve(homeArgument), 'Pass the canonical review home, not an alias');
assert(basename(home).startsWith('echo-native-review-'), 'Refusing a non-review data home');
assert(within(realpathSync(tmpdir()), home) || within(realpathSync('/private/tmp'), home), 'Refusing a non-temporary data home');
assert.equal(statSync(home).mode & 0o077, 0, 'Review data directory must remain private');
assert(lstatSync(executable).isFile(), 'Pass an ordinary built executable');
const regularInside = (path) => {
  assert(within(home, path), `Expected an acceptance artifact inside the isolated home: ${path}`);
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), `Expected an ordinary acceptance artifact: ${path}`);
  assert(within(home, realpathSync(path)), `Acceptance artifact escapes the isolated home: ${path}`);
  return readFileSync(path);
};
const parseFile = (path) => JSON.parse(regularInside(path).toString('utf8'));
const historyPath = join(home, 'native-review-history.jsonl');
const history = regularInside(historyPath).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const retained = [...history].reverse().find((report) => report.nativeContext?.home === home
  && typeof report.sessionId === 'string' && typeof report.workspace === 'string'
  && !report.coding && within(home, report.workspace));
assert(retained, 'The existing review has no actual retained main session/workspace');
assert(/^[A-Za-z0-9_-]+$/.test(retained.sessionId), 'Retained session identifier is invalid');
assert.equal(realpathSync(retained.workspace), retained.workspace, 'Retained workspace must be canonical');
const outputRoot = nativeReviewOutput('native-code', 'NATIVE_CODE_REVIEW_OUTPUT');
const deliveryContinuation = continueDeliveryReview ? inspectCodeDeliveryContinuation({ home, cwd: retained.workspace,
  sessionId: retained.sessionId, history, evidenceRoot: realpathSync(outputRoot) }) : null;
const continuation = continueExistingTask ? inspectCodeContinuation({ home, cwd: retained.workspace,
  sessionId: retained.sessionId, history }) : null;

mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(join(outputRoot, 'run-'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const executableHash = createHash('sha256');
for await (const chunk of createReadStream(executable)) executableHash.update(chunk);
const result = { environment: 'actual macOS native Code review', executable,
  binarySha256: executableHash.digest('hex'), home, output,
  retainedSessionId: retained.sessionId, retainedWorkspace: retained.workspace, phases: [], errors: [] };
if (continuation) {
  result.continuation = continuation;
  writeFileSync(join(output, 'continuation-before.json'), JSON.stringify(continuation, null, 2));
}
if (deliveryContinuation) {
  result.deliveryContinuation = deliveryContinuation;
  writeFileSync(join(output, 'delivery-continuation-before.json'), JSON.stringify(deliveryContinuation, null, 2));
  writeFileSync(join(output, 'predecessor-actual-checks.json'), JSON.stringify({
    evidence: 'These twelve actual checks belong to the prior failed run; they were not repeated by this delivery-only run',
    source: deliveryContinuation.predecessor,
  }, null, 2));
}
const originalReport = join(home, 'native-review.json');
if (existsSync(originalReport)) copyFileSync(originalReport, join(output, 'prior-native-review.json'));
writeFileSync(join(output, 'prior-native-history-sha256.json'), JSON.stringify({ path: historyPath,
  sha256: hash(regularInside(historyPath)), entries: history.length }, null, 2));
const lockPath = join(home, '.native-code-review.lock');
const legacy = join(home, 'empty-legacy');
assert(lstatSync(legacy).isDirectory() && !lstatSync(legacy).isSymbolicLink(), 'Expected the original isolated empty legacy directory');
const lock = openSync(lockPath, 'wx', 0o600);
writeFileSync(lock, `${process.pid}\n`);
const launchEnv = { ...cleanNativeReviewEnvironment(process.env), GROK_HOME: legacy, ECHO_DESKTOP_REVIEW: '1', ECHO_DESKTOP_REVIEW_CODE: '1',
  ECHO_DESKTOP_REVIEW_CODE_CONTINUE: continueExistingTask ? '1' : '0',
  ECHO_DESKTOP_REVIEW_CODE_DELIVERY_CONTINUE: continueDeliveryReview ? '1' : '0',
  ECHO_DESKTOP_REVIEW_MEDIA: '0', ECHO_DESKTOP_REVIEW_EXTENDED: '0' };
for (const name of ['ECHO_AGENT_HOME', 'ECHO_DESKTOP_VALIDATION', 'ECHO_THEIA_NODE']) delete launchEnv[name];
let active;
let interrupted = false;
const stop = () => { interrupted = true; active?.kill('SIGTERM'); };
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
let firstFilesystem;
const required = {
  'first-launch': continueDeliveryReview
    ? ['coding-native-delivery-continuation', 'coding-retained-verification', 'coding-actual-diff-ui', 'coding-native-delivery-gates']
    : ['coding-native-task-start', 'coding-actual-ide-frame', 'coding-unsaved-confirmation', 'coding-unsaved-cancel-keeps-buffer',
    'coding-production-mutation-bridge', 'coding-actual-file-and-checkpoint', 'coding-native-phase-verifying',
    'coding-rejected-save-dialog', 'coding-verification-rejects-save', 'coding-verification-requires-approval',
    'coding-real-verification-subprocess', 'coding-native-completed-evidence', 'coding-actual-diff-ui', 'coding-native-delivery-gates'],
  restart: ['coding-restart-native-state', 'coding-actual-ide-frame', 'coding-restart-actual-editor', 'coding-restart-delivery-ui'],
};
const verifyFilesystem = (report) => {
  const expected = report.coding?.expected;
  assert(expected && expected.cwd === retained.workspace && /^[A-Za-z0-9_-]+$/.test(expected.taskId), 'Actual Code task expectation missing or belongs to a different workspace');
  assert(/^[a-f0-9]{64}$/.test(expected.contentRevision), 'The native verification lacks a real content revision');
  const workspaceHash = hash(Buffer.from(realpathSync(expected.cwd))).slice(0, 16);
  const taskDirectory = join(home, 'coding', workspaceHash, expected.taskId);
  assert(lstatSync(taskDirectory).isDirectory() && !lstatSync(taskDirectory).isSymbolicLink(), 'Persisted Code task directory is missing or symbolic');
  const task = parseFile(join(taskDirectory, 'task.json'));
  const set = parseFile(join(taskDirectory, 'changeset.json'));
  const records = regularInside(join(taskDirectory, 'verifications.jsonl')).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const reviews = parseFile(join(taskDirectory, 'reviews.json')).records;
  const file = join(expected.cwd, '原生代码验收.ts');
  const content = regularInside(file);
  const expectedContent = `// EchoAgent 原生代码验收\nexport const 验收值 = 2;\n// ${'x'.repeat(600)}\n`;
  assert.equal(content.toString('utf8'), expectedContent, 'Actual code file differs from the reviewed version');
  assert.equal(task.id, expected.taskId);
  const admitted = deliveryContinuation || continuation;
  if (admitted) {
    assert.equal(task.id, admitted.taskId, 'Continuation recreated or switched the original Code task');
    assert.equal(task.createdAt, admitted.createdAt, 'Continuation replaced the original task creation evidence');
    assert.equal(hash(Buffer.from(JSON.stringify(set.baselineEntries))), admitted.baselineSha256, 'Continuation recaptured or rewrote the original baseline');
    const ledger = regularInside(join(taskDirectory, 'execution-ledger.jsonl')).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    assert.deepEqual(ledger[0], admitted.originalSubmission, 'The original requirement submission was replaced');
    assert.equal(ledger.filter((entry) => entry.kind === 'requirement_submitted').length, 1, 'Continuation submitted the same requirement twice');
    if (deliveryContinuation) {
      assert.deepEqual(ledger, deliveryContinuation.originalLedger, 'Delivery review reset/replayed the original execution ledger');
      assert.equal(hash(regularInside(join(taskDirectory, 'execution-ledger.jsonl'))), deliveryContinuation.ledgerSha256, 'Delivery review rewrote original execution ledger bytes');
      const sourceChain = [deliveryContinuation.predecessor, ...(deliveryContinuation.recoveryAttempts || [])]
        .flatMap((entry) => [[entry.path, entry.sha256], [entry.admissionPath, entry.admissionSha256]]);
      for (const [path, digest] of sourceChain) {
        assert(realpathSync(path) === path && lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'Delivery predecessor evidence became symbolic or missing');
        assert.equal(hash(readFileSync(path)), digest, 'Delivery predecessor source evidence was overwritten');
      }
      assert.equal(expected.verificationId, deliveryContinuation.verification.id, 'Delivery review selected a different verification');
      assert.equal(expected.contentRevision, deliveryContinuation.expected.contentRevision, 'Delivery review changed the verified content revision');
      assert.equal(hash(regularInside(join(taskDirectory, 'verifications.jsonl'))), deliveryContinuation.verificationSha256, 'Delivery review reran or rewrote the retained verification record');
      assert.deepEqual(records, [deliveryContinuation.verification], 'Delivery review replaced the actual predecessor subprocess result');
      assert.equal(set.baselineEntries.length, 10);
      assert(!existsSync(join(expected.cwd, '.git')), 'Delivery review must not create a Git repository');
      const baselinePaths = new Set();
      for (const entry of set.baselineEntries) {
        assert(typeof entry.path === 'string' && !isAbsolute(entry.path) && !entry.path.split('/').includes('..')
          && !entry.path.includes('\0') && !baselinePaths.has(entry.path) && entry.existed === true, 'Delivery review baseline is unsafe or duplicated');
        baselinePaths.add(entry.path);
        assert.equal(hash(Buffer.from(entry.contentBase64, 'base64')), entry.hash, 'Delivery review changed original snapshot bytes');
        assert.equal(hash(regularInside(join(expected.cwd, entry.path))), entry.path === '原生代码验收.ts'
          ? deliveryContinuation.verifiedFileSha256 : entry.hash, 'Delivery review modified an original unrelated file');
      }
      const visit = (directory) => {
        for (const name of readdirSync(directory)) {
          const path = join(directory, name); const info = lstatSync(path);
          assert(!info.isSymbolicLink() && realpathSync(path) === path, 'Delivery review gained a symbolic workspace entry');
          if (info.isDirectory()) visit(path);
          else assert(info.isFile() && baselinePaths.has(relative(expected.cwd, path).split('\\').join('/')), 'Delivery review added a file outside the original baseline');
        }
      };
      visit(expected.cwd);
    }
  }
  assert.equal(task.phase, 'delivered');
  assert(task.acceptanceCriteria.length > 0 && task.acceptanceCriteria.every((entry) => entry.satisfied && entry.evidence.length > 0), 'Persisted acceptance lacks actual confirmation evidence');
  assert.equal(set.taskId, expected.taskId);
  assert.equal(set.changes.length, 1);
  assert.equal(set.changes[0].path, '原生代码验收.ts');
  assert.equal(set.changeHashes['原生代码验收.ts'], hash(content));
  assert.equal(set.reviewedHashes['原生代码验收.ts'], hash(content));
  const revision = createHash('sha256');
  for (const [path, digest] of Object.entries(set.changeHashes).sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    revision.update(path); revision.update(Buffer.from([0])); revision.update(digest); revision.update(Buffer.from([0]));
  }
  assert.equal(revision.digest('hex'), expected.contentRevision, 'Actual saved content revision differs from the native verification');
  assert.equal(set.verifiedRevision, expected.contentRevision);
  assert.equal(set.committedHash, null, 'This acceptance must not commit files');
  assert.equal(records.length, 1, 'Duplicate native verification runs occurred');
  const verification = records[0];
  assert.equal(verification.id, expected.verificationId);
  assert.equal(verification.taskId, expected.taskId);
  assert.equal(verification.command, 'node verify-native-code.cjs');
  assert.equal(verification.kind, 'test');
  assert.equal(verification.status, 'passed');
  assert.equal(verification.exitCode, 0);
  assert(verification.stdout.includes('中文文件内容正确'));
  assert.equal(verification.contentRevision, expected.contentRevision);
  assert.equal(reviews.length, 2);
  assert.deepEqual(reviews.map((entry) => entry.kind).sort(), ['code_quality', 'requirements']);
  assert(reviews.every((entry) => entry.contentRevision === expected.contentRevision));
  const theiaLog = regularInside(join(home, 'theia', 'theia.log')).toString('utf8');
  assert(theiaLog.includes('Frontend application startup sequence completed'), 'Actual isolated Theia frontend did not initialize');
  assert(lstatSync(join(home, 'theia', 'theia-config')).isDirectory(), 'Theia config was not isolated inside the review home');
  return { file, fileSha256: hash(content), taskDirectory,
    taskSha256: hash(regularInside(join(taskDirectory, 'task.json'))),
    changesetSha256: hash(regularInside(join(taskDirectory, 'changeset.json'))),
    verificationSha256: hash(regularInside(join(taskDirectory, 'verifications.jsonl'))),
    reviewsSha256: hash(regularInside(join(taskDirectory, 'reviews.json'))),
    contentRevision: expected.contentRevision, verificationId: verification.id,
    ...(deliveryContinuation ? { predecessorReportPath: deliveryContinuation.predecessor.path,
      predecessorReportSha256: deliveryContinuation.predecessor.sha256, retainedVerificationNotRerun: true,
      originalSubmissionId: deliveryContinuation.originalSubmission.id, originalBaselineSha256: deliveryContinuation.baselineSha256 } : {}),
    theiaLogPath: join(home, 'theia', 'theia.log'), isolatedTheiaConfig: join(home, 'theia', 'theia-config') };
};
try {
  for (const phase of ['first-launch', 'restart']) {
    if (interrupted) throw new Error('Native Code acceptance interrupted');
    if (existsSync(originalReport)) unlinkSync(originalReport);
    const start = Date.now();
    const historyCount = regularInside(historyPath).toString('utf8').trim().split('\n').filter(Boolean).length;
    const child = spawn(executable, ['--data-home', home], { env: { ...launchEnv, ECHO_DESKTOP_REVIEW_PHASE: phase }, stdio: 'inherit' });
    active = child;
    let launchError;
    let ended = false;
    const exited = new Promise((accept) => {
      child.once('exit', () => { ended = true; accept(true); });
      child.once('error', (error) => { launchError = error; ended = true; accept(true); });
    });
    try {
      const timeout = phase === 'first-launch' ? 600000 : 240000;
      const finished = await Promise.race([exited, delay(timeout, false, { ref: false })]);
      if (launchError) throw launchError;
      if (!finished) throw new Error(`${phase}: Native Code did not finish within ${timeout / 1000} seconds`);
      assert.equal(child.exitCode, 0, `${phase}: native process did not exit normally`);
      const report = parseFile(originalReport);
      copyFileSync(originalReport, join(output, `${phase}.json`));
      result.phases.push({ phase, report, exitCode: child.exitCode });
      console.log(JSON.stringify({ phase, exitCode: child.exitCode, report }));
      assert.equal(report.phase, phase);
      assert.equal(report.nativeContext?.home, home);
      assert.equal(report.nativeContext.pid, child.pid, 'Native report belongs to a different process');
      assert.equal(report.nativeContext.evaluations, 1, 'Native report evaluated more than once');
      assert.equal(report.sessionId, retained.sessionId);
      assert.equal(report.workspace, retained.workspace);
      const finishedAt = Date.parse(report.finishedAt);
      assert(Number.isFinite(finishedAt) && finishedAt >= start && finishedAt <= Date.now() + 1000, 'Stale or invalid native report');
      assert(Array.isArray(report.errors) && report.errors.length === 0);
      assert(Array.isArray(report.checks) && report.checks.every((check) => check.result === 'passed'));
      for (const id of required[phase]) assert.equal(report.checks.filter((check) => check.id === id).length, 1, `Missing or duplicate actual check: ${id}`);
      assert.equal(new Set(report.checks.map((check) => check.id)).size, report.checks.length, 'Duplicate native checks');
      if (deliveryContinuation && phase === 'first-launch') {
        const currentIds = new Set([...required[phase], 'coding-actual-ide-frame']);
        assert(report.checks.every((check) => currentIds.has(check.id)), 'Delivery-only run claimed to repeat predecessor checks');
        const continued = report.checks.find((check) => check.id === 'coding-native-delivery-continuation').evidence;
        assert.equal(continued.taskId, deliveryContinuation.taskId);
        assert.equal(continued.originalSubmissionId, deliveryContinuation.originalSubmission.id);
        assert.equal(continued.noTaskReset, true);
        const retainedVerification = report.checks.find((check) => check.id === 'coding-retained-verification').evidence;
        assert.deepEqual(retainedVerification.verification, deliveryContinuation.verification);
        assert.equal(retainedVerification.noRerunOrEvidenceClearing, true);
      }
      if (continuation && phase === 'first-launch') {
        const continued = report.checks.filter((check) => check.id === 'coding-native-existing-task-continuation');
        assert.equal(continued.length, 1, 'Continuation has no unique actual native state check');
        assert.equal(continued[0].evidence.taskId, continuation.taskId);
        assert.equal(continued[0].evidence.originalSubmissionId, continuation.originalSubmission.id);
        assert.equal(report.checks.find((check) => check.id === 'coding-native-task-start').evidence.continuedExistingTask, true);
      }
      assert.equal(report.passed, true);
      assert.equal(report.coding?.passed, true);
      assert.equal(report.coding.phase, phase);
      assert(Array.isArray(report.coding.errors) && report.coding.errors.length === 0);
      const updatedHistory = regularInside(historyPath).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      assert.equal(updatedHistory.length, historyCount + 1, 'A duplicate renderer evaluation overwrote native evidence');
      assert.deepEqual(updatedHistory.at(-1), report);
      const filesystem = verifyFilesystem(report);
      if (phase === 'first-launch') firstFilesystem = filesystem;
      else {
        assert(firstFilesystem, 'First launch did not establish valid Code filesystem evidence');
        for (const key of ['fileSha256', 'taskSha256', 'changesetSha256', 'verificationSha256', 'reviewsSha256', 'contentRevision', 'verificationId']) {
          assert.equal(filesystem[key], firstFilesystem[key], `Restart changed persisted Code evidence: ${key}`);
        }
      }
      writeFileSync(join(output, `${phase}-filesystem.json`), JSON.stringify(filesystem, null, 2));
    } catch (error) {
      result.errors.push(`${phase}: ${String(error)}`);
      console.error(`${phase}: ${String(error)}`);
      break; // A failed first launch cannot establish a restart acceptance.
    } finally {
      if (!ended) {
        child.kill('SIGTERM');
        await Promise.race([exited, delay(3000, undefined, { ref: false })]);
        if (!ended) child.kill('SIGKILL');
      }
      active = undefined;
    }
  }
} catch (error) { result.errors.push(String(error)); }
finally {
  process.removeListener('SIGINT', stop);
  process.removeListener('SIGTERM', stop);
  closeSync(lock);
  unlinkSync(lockPath);
  result.passed = result.errors.length === 0 && result.phases.length === 2;
  writeFileSync(join(output, 'native-code-result.json'), JSON.stringify(result, null, 2));
}
console.log(`Native Code evidence retained: ${output}; ${home}`);
if (!result.passed) process.exitCode = 1;
