// Read-only admission check for the specific failed, untouched native Code
// review. It never resets a task, rewrites a baseline, or launches an app.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

export const codeDeliveryPredecessorChecks = Object.freeze([
  'coding-native-existing-task-continuation', 'coding-native-task-start', 'coding-actual-ide-frame',
  'coding-unsaved-confirmation', 'coding-unsaved-cancel-keeps-buffer', 'coding-production-mutation-bridge',
  'coding-actual-file-and-checkpoint', 'coding-native-phase-verifying', 'coding-rejected-save-dialog',
  'coding-verification-rejects-save', 'coding-verification-requires-approval', 'coding-real-verification-subprocess',
]);

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => {
  const inside = relative(root, path);
  return inside !== '' && inside !== '..' && !inside.startsWith('../') && !isAbsolute(inside);
};
export function inspectCodeContinuation({ home, cwd, sessionId, history }) {
  assert(realpathSync(home) === home && realpathSync(cwd) === cwd && within(home, cwd), 'Continuation requires the retained canonical isolated workspace');
  const regular = (path) => {
    assert(within(home, path), 'Continuation artifact must stay inside the isolated home');
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() && within(home, realpathSync(path)), 'Continuation artifact is not an ordinary isolated file');
    return readFileSync(path);
  };
  const json = (path) => JSON.parse(regular(path).toString('utf8'));
  const failed = [...history].reverse().find((report) => report.phase === 'first-launch'
    && report.nativeContext?.home === home && report.sessionId === sessionId && report.workspace === cwd
    && report.passed === false && report.coding?.passed === false && report.coding?.expected?.cwd === cwd
    && report.checks?.some((check) => check.id === 'coding-native-task-start' && check.result === 'passed'));
  assert(failed && failed.errors?.length > 0, 'No actual failed task-start report may be continued');
  const expected = failed.coding.expected;
  assert(/^[A-Za-z0-9_-]+$/.test(expected.taskId) && expected.taskName === '原生代码阶段与交付验收'
    && !expected.verificationId && !expected.contentRevision, 'Failed Code expectation progressed or is foreign');
  const workspaceHash = hash(Buffer.from(cwd)).slice(0, 16);
  const projectDirectory = join(home, 'coding', workspaceHash);
  const taskDirectory = join(projectDirectory, expected.taskId);
  assert(lstatSync(projectDirectory).isDirectory() && !lstatSync(projectDirectory).isSymbolicLink(), 'Code project directory is symbolic or missing');
  assert(lstatSync(taskDirectory).isDirectory() && !lstatSync(taskDirectory).isSymbolicLink(), 'Code task directory is symbolic or missing');
  const index = json(join(projectDirectory, 'tasks.json'));
  assert(index.tasks?.length === 1 && index.tasks[0].id === expected.taskId && index.tasks[0].phase === 'discovering', 'Continuation requires exactly the original discovering task');
  const taskPath = join(taskDirectory, 'task.json');
  const setPath = join(taskDirectory, 'changeset.json');
  const task = json(taskPath);
  const set = json(setPath);
  const requirement = '把原生代码验收.ts中的验收值从1改为2，保留中文注释；真实运行文件内容验证并审阅差异。';
  assert(task.id === expected.taskId && task.name === expected.taskName && task.requirement === requirement
    && task.phase === 'discovering' && task.blocker === null && task.planRevision === null
    && task.contextPaths.length === 0 && task.planIssues.length === 0 && task.modelId === null && task.sessionId === null
    && task.acceptanceCriteria.length === 1 && task.acceptanceCriteria[0].content === requirement
    && task.acceptanceCriteria[0].satisfied === false && task.acceptanceCriteria[0].evidence.length === 0
    && task.taskNodes.length === 1 && task.taskNodes[0].planKey === 'ROOT' && task.taskNodes[0].status === 'running'
    && task.taskNodes[0].attempt === 1 && task.taskNodes[0].completedAt === null, 'Refusing to reset a changed/progressed Code task');
  assert(set.taskId === expected.taskId && set.baselineMode === 'filesystem' && set.baselineHead === null
    && set.baselineFiles.length === 0 && set.changes.length === 0 && set.reviewedFiles.length === 0
    && Object.keys(set.reviewedHashes).length === 0 && Object.keys(set.changeHashes).length === 0
    && set.verifiedRevision === null && set.verificationStartedRevision === null && set.committedHash === null
    && set.committedPaths.length === 0 && set.rollbackUnsafeFiles.length === 0, 'The original baseline has changed or gained delivery evidence');
  const ledger = regular(join(taskDirectory, 'execution-ledger.jsonl')).toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert(ledger.length === 1 && ledger[0].taskId === task.id && ledger[0].kind === 'requirement_submitted', 'Continuation must retain the one original requirement submission');
  for (const name of ['verifications.jsonl', 'reviews.json']) {
    const path = join(taskDirectory, name);
    if (!existsSync(path)) continue;
    if (name.endsWith('.jsonl')) assert.equal(regular(path).toString('utf8').trim(), '', 'A previous native verification already ran');
    else assert.equal(json(path).records.length, 0, 'A previous review already ran');
  }
  const filename = '原生代码验收.ts';
  const files = {
    [filename]: `// EchoAgent 原生代码验收\nexport const 验收值 = 1;\n// ${'x'.repeat(600)}\n`,
    'verify-native-code.cjs': `const fs = require('node:fs');\nconst assert = require('node:assert/strict');\nassert.match(fs.readFileSync(${JSON.stringify(filename)}, 'utf8'), /export const 验收值 = 2;/);\nconsole.log('native-coding-verification: 中文文件内容正确');\n`,
    '.theia/settings.json': JSON.stringify({ 'files.autoSave': 'off' }, null, 2),
  };
  const snapshots = new Map();
  for (const entry of set.baselineEntries) {
    assert(typeof entry.path === 'string' && entry.path.length > 0 && !isAbsolute(entry.path)
      && !entry.path.split('/').includes('..') && !entry.path.includes('\0') && !snapshots.has(entry.path)
      && entry.existed === true && /^[a-f0-9]{64}$/.test(entry.hash), 'Unexpected filesystem baseline entry');
    const content = regular(join(cwd, entry.path));
    assert.equal(hash(content), entry.hash, `Pre-existing workspace file changed: ${entry.path}`);
    assert.equal(hash(Buffer.from(entry.contentBase64, 'base64')), entry.hash, 'Baseline bytes no longer match their hash');
    snapshots.set(entry.path, entry.hash);
  }
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      assert(!lstatSync(path).isSymbolicLink(), 'Continuation refuses symbolic workspace entries');
      if (lstatSync(path).isDirectory()) visit(path);
      else {
        assert(lstatSync(path).isFile() && snapshots.has(relative(cwd, path).split('\\').join('/')), 'An unexpected file was added after the original baseline');
      }
    }
  };
  visit(cwd);
  for (const [name, content] of Object.entries(files)) {
    assert.equal(regular(join(cwd, name)).toString('utf8'), content, `Refusing to overwrite a changed review file: ${name}`);
  }
  return { taskId: task.id, taskDirectory, createdAt: task.createdAt, expected,
    originalSubmission: ledger[0], taskSha256: hash(regular(taskPath)), changesetSha256: hash(regular(setPath)),
    baselineSha256: hash(Buffer.from(JSON.stringify(set.baselineEntries))), unchangedBaselineFiles: snapshots.size,
    fixedFileHashes: Object.fromEntries(Object.keys(files).map((name) => [name, snapshots.get(name)])),
    evidence: 'Actual prior failed native report and persisted discovering task, unchanged workspace/baseline; read-only admission, not Code acceptance' };
}

// Admit only the real verification-completed attempt. The retained report and
// its original admission are evidence, never commands to reset or replay work.
export function inspectCodeDeliveryContinuation({ home, cwd, sessionId, history, evidenceRoot }) {
  assert(realpathSync(home) === home && realpathSync(cwd) === cwd && within(home, cwd), 'Delivery continuation requires the canonical isolated workspace');
  const regular = (root, path) => {
    assert(within(root, path), 'Delivery continuation artifact escapes its evidence root');
    const info = lstatSync(path);
    assert(info.isFile() && !info.isSymbolicLink() && realpathSync(path) === path, 'Delivery continuation requires ordinary canonical files');
    return readFileSync(path);
  };
  const bytes = (path) => regular(home, path);
  const json = (path) => JSON.parse(bytes(path).toString('utf8'));
  // Exactly one known read-only projection failure may follow the original
  // twelve-check attempt. Never search past arbitrary later failures/successes.
  const latest = history.at(-1);
  const recoveringProjection = latest?.checks?.[0]?.id === 'coding-native-delivery-continuation';
  const failed = history.at(recoveringProjection ? -2 : -1);
  assert(failed?.phase === 'first-launch' && failed.nativeContext?.phase === 'first-launch'
    && failed.nativeContext.home === home && Number.isSafeInteger(failed.nativeContext.pid) && failed.nativeContext.pid > 0
    && failed.nativeContext.evaluations === 1 && failed.sessionId === sessionId && failed.workspace === cwd
    && failed.passed === false && failed.coding?.passed === false && failed.coding.phase === 'first-launch'
    && failed.coding.environment === 'native WKWebView + production Echo Code/Theia bridge + real Rust subprocesses'
    && failed.coding.activeStep === 'Native IPC: coding_orchestrator_report_verification', 'Original actual native report is not the completed-verification continuation point');
  assert.deepEqual(failed.errors, ['只有验证阶段可以报告验证完成'], 'Unexpected predecessor failure');
  assert.deepEqual(failed.coding.errors, failed.errors, 'Predecessor failure differs between native and Code reports');
  assert(Number.isFinite(Date.parse(failed.finishedAt)), 'Predecessor native report has no finish time');
  for (const flag of ['mediaRequested', 'extendedRequested', 'webdavRequested', 'codeAgentRequested']) {
    assert.equal(failed.nativeContext[flag], false, 'Predecessor mixed unrelated review modes');
  }
  assert.equal(failed.checks.length, codeDeliveryPredecessorChecks.length, 'Predecessor does not contain exactly the actual twelve checks');
  assert.deepEqual(failed.coding.checks, failed.checks, 'Predecessor native and Code checks differ');
  for (const id of codeDeliveryPredecessorChecks) {
    const checks = failed.checks.filter((entry) => entry.id === id);
    assert(checks.length === 1 && checks[0].result === 'passed', `Missing or duplicate actual predecessor check: ${id}`);
  }
  const oldExpected = failed.coding.expected;
  assert(oldExpected?.cwd === cwd && /^[A-Za-z0-9_-]+$/.test(oldExpected.taskId)
    && oldExpected.taskName === '原生代码阶段与交付验收' && !oldExpected.verificationId && !oldExpected.contentRevision,
  'Predecessor Code expectation is foreign or already reviewed');
  const root = realpathSync(evidenceRoot);
  assert(root === evidenceRoot && lstatSync(root).isDirectory(), 'Pass the canonical native evidence root');
  const candidates = [];
  for (const name of readdirSync(root)) {
    if (!/^run-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = join(root, name);
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) continue;
    const path = join(directory, 'first-launch.json');
    if (!existsSync(path)) continue;
    const reportBytes = regular(root, path);
    if (JSON.stringify(JSON.parse(reportBytes.toString('utf8'))) === JSON.stringify(failed)) candidates.push({ directory, path, reportBytes });
  }
  assert.equal(candidates.length, 1, 'Predecessor must match exactly one retained actual run');
  const prior = candidates[0];
  const admissionBytes = regular(root, join(prior.directory, 'continuation-before.json'));
  const admission = JSON.parse(admissionBytes.toString('utf8'));
  const result = JSON.parse(regular(root, join(prior.directory, 'native-code-result.json')).toString('utf8'));
  assert(result.environment === 'actual macOS native Code review' && result.home === home
    && result.retainedSessionId === sessionId && result.retainedWorkspace === cwd && result.output === prior.directory
    && result.passed === false && result.errors.length === 1 && /^[a-f0-9]{64}$/.test(result.binarySha256)
    && result.phases.length === 1 && result.phases[0].phase === 'first-launch' && result.phases[0].exitCode === 0,
  'Predecessor was not one actual normally exited native attempt');
  assert.deepEqual(result.phases[0].report, failed);
  assert.deepEqual(result.continuation, admission, 'Original admission evidence was replaced');
  const taskDirectory = join(home, 'coding', hash(Buffer.from(cwd)).slice(0, 16), oldExpected.taskId);
  assert(realpathSync(taskDirectory) === taskDirectory && lstatSync(taskDirectory).isDirectory(), 'Original task directory is not canonical');
  assert(admission.taskId === oldExpected.taskId && admission.taskDirectory === taskDirectory
    && admission.unchangedBaselineFiles === 10 && /^[a-f0-9]{64}$/.test(admission.baselineSha256), 'Original baseline admission is missing');
  const task = json(join(taskDirectory, 'task.json'));
  const set = json(join(taskDirectory, 'changeset.json'));
  const index = json(join(home, 'coding', hash(Buffer.from(cwd)).slice(0, 16), 'tasks.json'));
  const requirement = '把原生代码验收.ts中的验收值从1改为2，保留中文注释；真实运行文件内容验证并审阅差异。';
  assert(index.tasks?.length === 1 && index.tasks[0].id === task.id && index.tasks[0].phase === 'delivered', 'Original delivered task index changed');
  assert(task.id === admission.taskId && task.createdAt === admission.createdAt && task.name === oldExpected.taskName
    && task.requirement === requirement && task.phase === 'delivered' && task.blocker === null && task.planRevision === null
    && task.modelId === null && task.sessionId === null && task.contextPaths.length === 0 && task.planIssues.length === 0
    && task.acceptanceCriteria.length === 1 && task.acceptanceCriteria[0].content === requirement
    && task.acceptanceCriteria[0].satisfied === false && task.acceptanceCriteria[0].evidence.length === 0
    && task.taskNodes.length === 1 && task.taskNodes[0].planKey === 'ROOT' && task.taskNodes[0].status === 'success'
    && task.taskNodes[0].attempt === 1 && task.taskNodes[0].completedAt, 'Original completed task was replaced or already reviewed');
  const filename = '原生代码验收.ts';
  assert(!existsSync(join(cwd, '.git')), 'Delivery continuation must not gain a Git repository');
  const original = `// EchoAgent 原生代码验收\nexport const 验收值 = 1;\n// ${'x'.repeat(600)}\n`;
  const modified = original.replace('验收值 = 1;', '验收值 = 2;');
  const content = bytes(join(cwd, filename));
  assert.equal(content.toString('utf8'), modified, 'Retained code is not the actual verified V2');
  assert(set.taskId === task.id && set.baselineMode === 'filesystem' && set.baselineHead === null && set.baselineFiles.length === 0
    && set.baselineEntries.length === 10 && hash(Buffer.from(JSON.stringify(set.baselineEntries))) === admission.baselineSha256
    && set.changes.length === 1 && set.changes[0].path === filename && set.changes[0].kind === 'modified'
    && set.changes[0].baselineContent === original && set.changes[0].preExisting === false
    && set.reviewedFiles.length === 0 && Object.keys(set.reviewedHashes).length === 0
    && Object.keys(set.changeHashes).length === 1 && set.changeHashes[filename] === hash(content)
    && set.verificationStartedRevision === null && set.committedHash === null && set.committedPaths.length === 0
    && set.rollbackUnsafeFiles.length === 0, 'Retained changeset/baseline gained foreign or review/Git evidence');
  const snapshots = new Map();
  for (const entry of set.baselineEntries) {
    assert(typeof entry.path === 'string' && entry.path.length > 0 && !isAbsolute(entry.path)
      && !entry.path.split('/').includes('..') && !entry.path.includes('\0') && !snapshots.has(entry.path)
      && entry.existed === true && /^[a-f0-9]{64}$/.test(entry.hash), 'Invalid retained baseline entry');
    const snapshot = Buffer.from(entry.contentBase64, 'base64');
    assert.equal(hash(snapshot), entry.hash, 'Original baseline snapshot bytes changed');
    const current = bytes(join(cwd, entry.path));
    assert.equal(hash(current), entry.path === filename ? hash(content) : entry.hash, `Unrelated original file changed: ${entry.path}`);
    if (entry.path === filename) assert.equal(snapshot.toString('utf8'), original);
    snapshots.set(entry.path, entry.hash);
  }
  for (const [name, digest] of Object.entries(admission.fixedFileHashes)) assert.equal(snapshots.get(name), digest, 'Original fixed-file baseline changed');
  const visit = (directory) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name); const info = lstatSync(path);
      assert(!info.isSymbolicLink() && realpathSync(path) === path, 'Retained workspace gained a symbolic entry');
      if (info.isDirectory()) visit(path);
      else assert(info.isFile() && snapshots.has(relative(cwd, path).split('\\').join('/')), 'Retained workspace gained a file outside the ten original entries');
    }
  };
  visit(cwd);
  const verificationBytes = bytes(join(taskDirectory, 'verifications.jsonl'));
  const records = verificationBytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(records.length, 1, 'Delivery continuation must preserve exactly one real verification');
  const verification = records[0];
  const actualVerification = failed.checks.find((entry) => entry.id === 'coding-real-verification-subprocess').evidence.verification;
  assert.deepEqual(verification, actualVerification, 'Retained verification differs from the actual predecessor subprocess');
  assert(verification.taskId === task.id && /^[A-Za-z0-9_-]+$/.test(verification.id)
    && verification.kind === 'test' && verification.command === 'node verify-native-code.cjs'
    && verification.status === 'passed' && verification.exitCode === 0 && verification.stdout === 'native-coding-verification: 中文文件内容正确\n'
    && verification.stderr === '' && verification.durationMs > 0 && Date.parse(verification.finishedAt) >= Date.parse(verification.startedAt)
    && /^[a-f0-9]{64}$/.test(verification.contentRevision), 'Retained verification is not the actual successful subprocess');
  const revision = hash(Buffer.concat([Buffer.from(filename), Buffer.from([0]), Buffer.from(hash(content)), Buffer.from([0])]));
  assert.equal(verification.contentRevision, revision, 'Retained verification no longer matches actual code bytes');
  assert.equal(set.verifiedRevision, revision);
  if (existsSync(join(taskDirectory, 'reviews.json'))) assert.deepEqual(json(join(taskDirectory, 'reviews.json')).records, [], 'Review already ran');
  const ledgerBytes = bytes(join(taskDirectory, 'execution-ledger.jsonl'));
  const ledger = ledgerBytes.toString('utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(ledger[0], admission.originalSubmission, 'Original requirement submission changed');
  assert.deepEqual(ledger.map((entry) => entry.kind), ['requirement_submitted', 'implementation_finished', 'verification_started', 'verification_started', 'verification_finished'], 'Original execution ledger progressed or was reset');
  assert(ledger.every((entry) => entry.taskId === task.id) && new Set(ledger.map((entry) => entry.id)).size === ledger.length, 'Original ledger contains a foreign/duplicate entry');
  const continued = failed.checks.find((entry) => entry.id === 'coding-native-existing-task-continuation').evidence;
  assert(continued.taskId === task.id && continued.originalSubmissionId === admission.originalSubmission.id, 'Predecessor did not continue the original submission');
  const admitted = { taskId: task.id, taskDirectory, createdAt: task.createdAt,
    expected: { ...oldExpected, verificationId: verification.id, contentRevision: revision },
    originalSubmission: admission.originalSubmission, originalLedger: ledger, ledgerSha256: hash(ledgerBytes),
    baselineSha256: admission.baselineSha256, unchangedBaselineFiles: 9, baselineFiles: 10,
    fixedFileHashes: admission.fixedFileHashes, verifiedFileSha256: hash(content),
    verification, verificationSha256: hash(verificationBytes),
    predecessor: { path: prior.path, sha256: hash(prior.reportBytes), pid: failed.nativeContext.pid,
      phase: failed.phase, finishedAt: failed.finishedAt, binarySha256: result.binarySha256,
      admissionPath: join(prior.directory, 'continuation-before.json'), admissionSha256: hash(admissionBytes),
      checks: failed.checks.map((entry) => ({ id: entry.id, result: entry.result })) },
    evidence: 'Read-only admission of original actual twelve-check native attempt and one retained verification; current Diff/reviews/delivery remain unaccepted' };
  if (recoveringProjection) {
    assert(latest.phase === 'first-launch' && latest.nativeContext?.phase === 'first-launch'
      && latest.nativeContext.home === home && Number.isSafeInteger(latest.nativeContext.pid) && latest.nativeContext.pid > 0
      && latest.nativeContext.pid !== failed.nativeContext.pid && latest.nativeContext.evaluations === 1
      && latest.sessionId === sessionId && latest.workspace === cwd && latest.passed === false
      && latest.coding?.passed === false && latest.coding.phase === 'first-launch'
      && latest.coding.environment === failed.coding.environment
      && latest.coding.activeStep === 'Native IPC: coding_task_execution_ledger'
      && Number.isFinite(Date.parse(latest.finishedAt)) && Date.parse(latest.finishedAt) > Date.parse(failed.finishedAt),
    'Recovery suffix is not the same-session actual read-only projection failure');
    assert.deepEqual(latest.errors, ['Error: Native Echo Code acceptance failed: coding-retained-verification'], 'Recovery suffix has an unrelated error');
    assert.deepEqual(latest.coding.errors, latest.errors);
    assert.deepEqual(latest.coding.expected, oldExpected, 'Recovery suffix switched the original Code expectation');
    assert.deepEqual(latest.coding.checks, latest.checks);
    assert.equal(latest.checks.length, 2, 'Recovery suffix advanced beyond the two read-only checks');
    for (const flag of ['mediaRequested', 'extendedRequested', 'webdavRequested', 'codeAgentRequested']) assert.equal(latest.nativeContext[flag], false);
    const [continued, retainedVerification] = latest.checks;
    assert(continued.id === 'coding-native-delivery-continuation' && continued.result === 'passed'
      && continued.evidence.taskId === task.id && continued.evidence.phase === 'delivered'
      && continued.evidence.originalSubmissionId === admission.originalSubmission.id && continued.evidence.noTaskReset === true,
    'Recovery suffix reset or switched the original task');
    assert(retainedVerification.id === 'coding-retained-verification' && retainedVerification.result === 'failed'
      && retainedVerification.evidence.noRerunOrEvidenceClearing === true, 'Recovery suffix did not stop at the projection guard');
    assert.deepEqual(retainedVerification.evidence.verification, verification, 'Recovery suffix did not retain the original verification');
    const attempts = [];
    for (const name of readdirSync(root)) {
      if (!/^run-[A-Za-z0-9]+$/.test(name)) continue;
      const directory = join(root, name);
      if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink() || realpathSync(directory) !== directory) continue;
      const path = join(directory, 'first-launch.json');
      if (!existsSync(path)) continue;
      const reportBytes = regular(root, path);
      if (JSON.stringify(JSON.parse(reportBytes.toString('utf8'))) === JSON.stringify(latest)) attempts.push({ directory, path, reportBytes });
    }
    assert.equal(attempts.length, 1, 'Read-only recovery must match exactly one retained native run');
    const attempt = attempts[0];
    const recoveryAdmissionPath = join(attempt.directory, 'delivery-continuation-before.json');
    const recoveryAdmissionBytes = regular(root, recoveryAdmissionPath);
    const recoveryAdmission = JSON.parse(recoveryAdmissionBytes.toString('utf8'));
    // The prior read-only admission pins the original report bytes/PID and
    // original baseline/ledger/record. Any rewrites break this exact linkage.
    assert.deepEqual(recoveryAdmission, admitted, 'Read-only recovery admission no longer anchors the original native source and unchanged state');
    const recoveryResult = JSON.parse(regular(root, join(attempt.directory, 'native-code-result.json')).toString('utf8'));
    assert(recoveryResult.environment === result.environment && recoveryResult.home === home
      && recoveryResult.retainedSessionId === sessionId && recoveryResult.retainedWorkspace === cwd
      && recoveryResult.output === attempt.directory && recoveryResult.passed === false && recoveryResult.errors.length === 1
      && /^[a-f0-9]{64}$/.test(recoveryResult.binarySha256) && recoveryResult.phases.length === 1
      && recoveryResult.phases[0].phase === 'first-launch' && recoveryResult.phases[0].exitCode === 0,
    'Read-only projection suffix did not come from one normally exited actual native attempt');
    assert.deepEqual(recoveryResult.phases[0].report, latest);
    assert.deepEqual(recoveryResult.deliveryContinuation, recoveryAdmission);
    admitted.recoveryAttempts = [{ path: attempt.path, sha256: hash(attempt.reportBytes), pid: latest.nativeContext.pid,
      phase: latest.phase, finishedAt: latest.finishedAt, binarySha256: recoveryResult.binarySha256,
      admissionPath: recoveryAdmissionPath, admissionSha256: hash(recoveryAdmissionBytes),
      evidence: 'Retained failed read-only public-projection check; no current Diff, acceptance, review or verification was executed' }];
  }
  return admitted;
}
