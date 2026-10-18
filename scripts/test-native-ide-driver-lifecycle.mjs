// Offline guard tests: no native process, activation, GUI, model, or Git command.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { collectIdeLaunchDiagnostics, ideRestartManifest, nativeIdeReviewEnvironment, requireIdeRendererReport,
  verifyIdeReportHistory, verifyIdeRestartPhysical, verifyIdeRestartReport } from './validate-native-ide-git-review.mjs';

test('IDE launch removes every foreign review mode and unsafe inherited injection option', () => {
  const env = nativeIdeReviewEnvironment({ ECHO_DESKTOP_REVIEW_CORE: '1', ECHO_DESKTOP_REVIEW_LOCAL: '1', ECHO_DESKTOP_REVIEW_EXIT: '1',
    ECHO_DESKTOP_REVIEW_BROWSER: '1', ECHO_DESKTOP_REVIEW_CODE_AGENT: '1', ECHO_DESKTOP_REVIEW_WEBDAV: '1',
    ECHO_DESKTOP_REVIEW_PHASE: 'foreign', ECHO_DESKTOP_VALIDATION: '1', ECHO_AGENT_HOME: '/foreign',
    ECHO_THEIA_NODE: '/foreign/node', NODE_OPTIONS: '--require=/foreign', NODE_PATH: '/foreign', HOME: '/unchanged', RUST_LOG: 'warn' }, '/private-fixture/legacy');
  assert.equal(env.HOME, '/unchanged'); assert.equal(env.GROK_HOME, '/private-fixture/legacy');
  assert.deepEqual(Object.keys(env).filter(key => key.startsWith('ECHO_DESKTOP_REVIEW_')).sort(), ['ECHO_DESKTOP_REVIEW_IDE', 'ECHO_DESKTOP_REVIEW_PHASE']);
  assert.equal(env.ECHO_DESKTOP_REVIEW, '1'); assert.equal(env.ECHO_DESKTOP_REVIEW_IDE, '1'); assert.equal(env.ECHO_DESKTOP_REVIEW_PHASE, 'first-launch');
  for (const key of ['ECHO_DESKTOP_VALIDATION', 'ECHO_AGENT_HOME', 'ECHO_THEIA_NODE', 'NODE_OPTIONS', 'NODE_PATH']) assert(!(key in env));
  assert(env.RUST_LOG.includes('echoagent_lib::desktop_validation=info'));
  assert.equal(nativeIdeReviewEnvironment(env, '/private-fixture/legacy', 'restart').ECHO_DESKTOP_REVIEW_PHASE, 'restart');
  assert.throws(() => nativeIdeReviewEnvironment(env, '/private-fixture/legacy', 'foreign'));
});

const sha256 = value => createHash('sha256').update(value).digest('hex');
function restartFixture() {
  const home = '/private/tmp/echo-native-review-ide-git-synthetic', cwd = join(home, 'workspaces', 'default');
  const first = { schema: 1, kind: 'ide-git-boundary', home, cwd, nonce: 'a'.repeat(32), generation: 'b'.repeat(32),
    phase: 'first-launch', expected: null, file: 'IDE边界验收.txt', initialHead: 'c'.repeat(40),
    version1: 'synthetic v1', version2: 'synthetic v2', version3: 'synthetic v3',
    baselineFiles: { '.gitignore': sha256('ignore'), 'ide-terminal-proof.cjs': sha256('terminal') } };
  const expected = { initialHead: first.initialHead, committedHead: 'd'.repeat(40), version3: first.version3, file: first.file,
    worktreeRoot: join(home, 'coding-worktrees', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'worktree'),
    originalTaskId: '11111111-2222-3333-4444-555555555555', worktreeSavedVersion: first.version1 };
  const manifest = ideRestartManifest(first, expected), pid = 654, startedAt = Date.now() - 1000;
  const report = { version: 1, kind: 'native-ide-git', passed: true, errors: [], nativeVerified: false, fakeIPC: false,
    osPickerVerified: false, home, cwd, nonce: manifest.nonce, generation: manifest.generation, phase: 'restart',
    nativeContext: { pid, ideRequested: true, evaluations: 1, home, phase: 'restart' }, expected: structuredClone(expected),
    finishedAt: new Date().toISOString(), checks: [
      { id: 'ide-private-native-isolation', result: 'passed', evidence: { pid, cwd, fixedManifest: true } },
      { id: 'ide-restart-worktree-native', result: 'passed', evidence: { workspace: { root: expected.worktreeRoot }, sameWorktree: true,
        savedWorktree: { root: expected.worktreeRoot, path: join(expected.worktreeRoot, first.file), text: first.version1, dirty: false, visible: true } } },
      { id: 'ide-restart-source-editor-native', result: 'passed', evidence: { source: {
        path: join(cwd, first.file), text: first.version3, dirty: false, visible: true }, provider: { id: 'git' }, noNewCommit: true } },
      { id: 'ide-restart-source-task-native', result: 'passed', evidence: {
        originalTaskId: expected.originalTaskId, phase: 'discovering', visibleInUi: true, modelExecuted: false } },
    ] };
  const physical = { sourceRoot: cwd, worktreeRoot: expected.worktreeRoot, sourceHead: expected.committedHead, worktreeHead: expected.committedHead,
    sourceSha256: sha256(first.version3), worktreeSha256: sha256(first.version1), sourceHistorySha256: sha256('two commits'),
    worktreeHistorySha256: sha256('two commits'), commitsSinceBaseline: '1', sourceDiffPaths: [first.file], stagedPaths: [], remotes: '',
    baselineFiles: structuredClone(first.baselineFiles), terminalSha256: sha256('terminal proof'), task: {
      id: expected.originalTaskId, name: `隔离并行夹具-${first.generation}`, phase: 'discovering', sessionId: null, sha256: sha256('task json') } };
  return { first, expected, manifest, report, physical, pid, startedAt };
}

test('restart manifest retains exact first-launch identity and refuses foreign expected resources', () => {
  const { first, expected, manifest } = restartFixture();
  assert.deepEqual(manifest, { ...first, phase: 'restart', expected });
  assert.notEqual(manifest.expected, expected);
  for (const mutate of [value => value.initialHead = 'e'.repeat(40), value => value.committedHead = first.initialHead,
    value => value.worktreeRoot = '/outside/worktree', value => value.originalTaskId = '../foreign',
    value => value.file = 'foreign.txt', value => value.version3 = first.version2, value => value.worktreeSavedVersion = first.version2]) {
    const candidate = structuredClone(expected); mutate(candidate); assert.throws(() => ideRestartManifest(first, candidate));
  }
  assert.throws(() => ideRestartManifest({ ...first, phase: 'restart' }, expected));
});

test('restart requires all four exact native checks from the new process and restored editors/task', () => {
  const { report, manifest, pid, startedAt } = restartFixture();
  assert.deepEqual(verifyIdeRestartReport(report, manifest, pid, startedAt), manifest.expected);
  const check = (value, id) => value.checks.find(item => item.id === id).evidence;
  for (const mutate of [value => value.checks.pop(), value => value.checks.push(value.checks[0]),
    value => value.checks[1].id = value.checks[0].id, value => value.checks[2].result = 'failed',
    value => value.passed = false, value => value.nativeVerified = true, value => value.fakeIPC = true,
    value => value.nativeContext.pid--, value => value.nativeContext.evaluations++,
    value => value.nativeContext.phase = 'first-launch', value => value.home = '/foreign',
    value => value.nonce = 'c'.repeat(32), value => value.generation = 'd'.repeat(32),
    value => value.phase = 'first-launch', value => value.finishedAt = new Date(0).toISOString(),
    value => value.expected.originalTaskId = '11111111-2222-3333-4444-666666666666',
    value => check(value, 'ide-restart-worktree-native').workspace.root = manifest.cwd,
    value => check(value, 'ide-restart-worktree-native').savedWorktree.text = manifest.version2,
    value => check(value, 'ide-restart-worktree-native').savedWorktree.dirty = true,
    value => check(value, 'ide-restart-source-editor-native').source.path = '/foreign/file',
    value => check(value, 'ide-restart-source-editor-native').source.text = manifest.version1,
    value => check(value, 'ide-restart-source-editor-native').source.visible = false,
    value => check(value, 'ide-restart-source-editor-native').provider.id = 'scm',
    value => check(value, 'ide-restart-source-task-native').visibleInUi = false,
    value => check(value, 'ide-restart-source-task-native').modelExecuted = true]) {
    const candidate = structuredClone(report); mutate(candidate);
    assert.throws(() => verifyIdeRestartReport(candidate, manifest, pid, startedAt));
  }
});

test('restart independently preserves source v3/worktree v1, both Git histories, task bytes and terminal proof', () => {
  const { physical, manifest } = restartFixture();
  assert.equal(verifyIdeRestartPhysical(physical, structuredClone(physical), manifest).passed, true);
  for (const mutate of [value => value.sourceRoot = '/foreign', value => value.sourceHead = manifest.initialHead,
    value => value.worktreeHead = manifest.initialHead, value => value.sourceSha256 = sha256(manifest.version2),
    value => value.worktreeSha256 = sha256(manifest.version2), value => value.sourceHistorySha256 = sha256('new history'),
    value => value.worktreeHistorySha256 = sha256('new history'), value => delete value.sourceHistorySha256,
    value => value.commitsSinceBaseline = '2', value => value.sourceDiffPaths = [], value => value.stagedPaths = [manifest.file],
    value => value.remotes = 'origin', value => value.baselineFiles['.gitignore'] = sha256('changed'),
    value => value.task.sha256 = sha256('changed task'), value => value.task.sessionId = 'unapproved-model',
    value => value.terminalSha256 = sha256('reran terminal')]) {
    const candidate = structuredClone(physical); mutate(candidate);
    assert.throws(() => verifyIdeRestartPhysical(physical, candidate, manifest));
  }
});

test('restart appends exactly one new report and preserves first-launch history bytes', () => {
  const { report } = restartFixture(), first = { phase: 'first-launch', checks: 17 };
  const before = JSON.stringify(first) + '\n', after = before + JSON.stringify(report) + '\n';
  assert.equal(verifyIdeReportHistory(before, [first]).entries, 1);
  assert.equal(verifyIdeReportHistory(after, [first, report], before).entries, 2);
  for (const invalid of [before, after + JSON.stringify(report) + '\n', after.trimEnd(),
    JSON.stringify({ ...first, changed: true }) + '\n' + JSON.stringify(report) + '\n',
    before + JSON.stringify({ ...report, nonce: 'foreign' }) + '\n']) {
    assert.throws(() => verifyIdeReportHistory(invalid, [first, report], before));
  }
});

test('exit zero without a report is diagnosed as unverified, with original lifecycle and stage facts', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-ide-driver-guard-'))), cwd = join(home, 'workspaces', 'default');
  try {
    mkdirSync(cwd, { recursive: true }); mkdirSync(join(home, 'theia'));
    writeFileSync(join(home, 'theia', 'theia.log'), "ready\nroot ERROR bridge rejection\n");
    const diagnostics = collectIdeLaunchDiagnostics({ home, cwd, pid: 321, executable: '/owned/app', startedAt: 100, now: 600, ended: true, exitCode: 0, signal: null });
    assert.equal(diagnostics.elapsedMs, 500); assert.equal(diagnostics.nativeReportExists, false);
    assert.equal(diagnostics.nativeHistoryExists, false); assert.equal(diagnostics.terminalProofExists, false);
    assert.deepEqual(diagnostics.barriers.stage, { ready: false, proof: false });
    assert.match(diagnostics.theiaLogTail, /bridge rejection/);
    assert.throws(() => requireIdeRendererReport(diagnostics), /exited without a renderer report.*exit 0/);
    assert.throws(() => requireIdeRendererReport({ ...diagnostics, ended: false }), /exceeded its bound/);
    assert.throws(() => requireIdeRendererReport({ ...diagnostics, exitCode: 2 }), /process failed/);
    assert.throws(() => requireIdeRendererReport({ ...diagnostics, signal: 'SIGTERM' }), /signalled/);
    writeFileSync(join(home, 'native-review.json'), '{}');
    writeFileSync(join(cwd, '.native-ide-stage-ready.json'), '{}');
    const reported = collectIdeLaunchDiagnostics({ home, cwd, pid: 321, executable: '/owned/app', startedAt: 100, now: 600, ended: true, exitCode: 0, signal: null });
    assert.equal(reported.barriers.stage.ready, true); requireIdeRendererReport(reported);
    // Report existence only admits the pre-existing strict verifyIdeReport checks;
    // this guard does not mark a renderer report or journey as passed.
  } finally { rmSync(home, { recursive: true, force: true }); }
});
