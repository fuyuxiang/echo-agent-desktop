// Admission guards only; no Native application, UI, model or Git operation.
import assert from 'node:assert/strict';
import { processHasExited, selectOwnedTheiaBackend, verifyIdeReport } from './validate-native-ide-git-review.mjs';
const now = Date.now(), home = '/private/tmp/echo-native-review-ide-synthetic';
const manifest = { home, cwd: home + '/workspaces/default', nonce: 'a'.repeat(32), generation: 'b'.repeat(32),
  phase: 'first-launch', file: 'IDE边界验收.txt', initialHead: 'c'.repeat(40), version1: 'synthetic version1', version2: 'synthetic version2', version3: 'synthetic version3' };
const ids = ['ide-private-native-isolation', 'ide-git-provider-native', 'ide-chinese-editor-native', 'ide-search-native',
  'ide-terminal-native', 'ide-git-diff-native', 'ide-git-stage-physical', 'ide-git-commit-physical',
  'ide-own-preview-native', 'ide-unsaved-cancel-native', 'ide-unsaved-save-native',
  'ide-disconnect-dirty-cancel-native', 'ide-disconnect-confirm-recovery-native', 'ide-parallel-worktree-native',
  'ide-project-switch-dirty-cancel-native', 'ide-project-switch-save-native', 'ide-project-switch-return-native'];
const base = { version: 1, kind: 'native-ide-git', passed: true, errors: [], nativeVerified: false,
  fakeIPC: false, osPickerVerified: false, ...manifest, nativeContext: { pid: 321, ideRequested: true, evaluations: 1, home },
  finishedAt: new Date().toISOString(), checks: ids.map(id => ({ id, result: 'passed', evidence: id === 'ide-git-provider-native'
    ? { provider: { id: 'git' }, root: manifest.cwd } : { syntheticGuard: true } })),
  expected: { initialHead: manifest.initialHead, committedHead: 'd'.repeat(40), version3: manifest.version3, file: manifest.file } };
base.checks.find(check => check.id === 'ide-disconnect-dirty-cancel-native').evidence = {
  stopped: { ownedParentPid: 321, processStopped: true }, sameFrame: true, dirty: true, text: manifest.version1, physicalVersion: 3 };
base.checks.find(check => check.id === 'ide-disconnect-confirm-recovery-native').evidence = {
  newFrame: true, dirty: false, text: manifest.version3, provider: { id: 'git' } };
const worktreeRoot = `${home}/coding-worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/worktree`;
Object.assign(base.expected, { worktreeRoot, originalTaskId: 'synthetic-task', worktreeSavedVersion: manifest.version1 });
base.checks.find(check => check.id === 'ide-parallel-worktree-native').evidence = {
  isolation: { root: worktreeRoot, sourceRoot: manifest.cwd, baseHead: base.expected.committedHead }, actualUiNewTask: true,
  committedFile: { text: manifest.version2 }, persistedSyntheticTask: { id: 'synthetic-task', phase: 'discovering', sessionId: null } };
base.checks.find(check => check.id === 'ide-project-switch-dirty-cancel-native').evidence = {
  root: worktreeRoot, dirty: true, text: manifest.version1, sameFrame: true };
base.checks.find(check => check.id === 'ide-project-switch-return-native').evidence = {
  root: worktreeRoot, dirty: false, text: manifest.version1 };
assert.deepEqual(verifyIdeReport(base, manifest, 321, now), base.expected);
let count = 1;
for (const [name, mutate] of [
  ['missing-check', value => value.checks.pop()], ['duplicate-check', value => value.checks.at(-1).id = value.checks[0].id],
  ['failed-check', value => value.checks[0].result = 'failed'], ['renderer-native-claim', value => value.nativeVerified = true],
  ['fake-ipc', value => value.fakeIPC = true], ['wrong-pid', value => value.nativeContext.pid++],
  ['foreign-root', value => value.nativeContext.home = '/outside'], ['another-review', value => value.nativeContext.ideRequested = false],
  ['two-evaluations', value => value.nativeContext.evaluations++], ['stale-report', value => value.finishedAt = new Date(0).toISOString()],
  ['no-git-provider', value => value.checks.find(check => check.id === 'ide-git-provider-native').evidence.provider.id = 'scm'],
  ['no-real-commit', value => value.expected.committedHead = value.expected.initialHead],
  ['errors', value => value.errors.push('actual operation failed')],
  ['foreign-worktree', value => value.expected.worktreeRoot = '/foreign/worktree'],
  ['copied-uncommitted-source', value => value.checks.find(check => check.id === 'ide-parallel-worktree-native').evidence.committedFile.text = manifest.version3],
  ['cancel-lost-worktree-buffer', value => value.checks.find(check => check.id === 'ide-project-switch-dirty-cancel-native').evidence.dirty = false],
  ['wrong-returned-version', value => value.checks.find(check => check.id === 'ide-project-switch-return-native').evidence.text = manifest.version2],
]) {
  const candidate = structuredClone(base); mutate(candidate);
  assert.throws(() => verifyIdeReport(candidate, manifest, 321, now), undefined, `Accepted ${name}`); count++;
}
console.log(JSON.stringify({ passed: true, syntheticGuards: count, nativeVerified: false }));
const node = '/private/tmp/frozen/EchoAgent.app/Contents/Resources/theia/node/bin/node';
const main = '/private/tmp/frozen/EchoAgent.app/Contents/Resources/theia/browser/lib/backend/main.js';
const owned = `  444 321 ${node} ${main} --port=12345 --hostname=127.0.0.1 --plugins=local-dir:plugins`;
assert.equal(selectOwnedTheiaBackend(owned, 321, node, main), 444);
for (const table of [owned.replace('444 321', '444 999'), owned.replace('444 321', '1 321'),
  owned.replace(' --hostname=127.0.0.1', ' --hostname=0.0.0.0'), owned + '\n' + owned.replace('444 321', '445 321'),
  owned.replace(`${node} ${main}`, `${node} /foreign/main.js`), owned + ' --foreign']) {
  assert.throws(() => selectOwnedTheiaBackend(table, 321, node, main));
}
console.log(JSON.stringify({ passed: true, processOwnershipGuards: 7, nativeVerified: false }));
assert.equal(processHasExited(0, 'Z'), true);
assert.equal(processHasExited(0, 'Z+'), true);
assert.equal(processHasExited(1, ''), true);
assert.equal(processHasExited(0, 'S+'), false);
assert.equal(processHasExited(0, 'R'), false);
assert.equal(processHasExited(0, ''), false);
assert.equal(processHasExited(0, '?E'), false);
assert.throws(() => processHasExited(2, ''));
assert.throws(() => processHasExited(null, ''));
console.log(JSON.stringify({ passed: true, kernelExitStateGuards: 9, nativeVerified: false }));
