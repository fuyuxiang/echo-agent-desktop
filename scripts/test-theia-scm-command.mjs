// Runs the real compiled vendored SCM implementation. RPC/command endpoints
// are unit-test doubles; native Git acceptance is recorded separately.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
const require = createRequire(resolve('vendor/theia-platform/packages/plugin-ext/package.json'));
const { ScmExtImpl } = require('./lib/plugin/scm.js');
const { URI } = require('./lib/plugin/types-impl.js');

function fixture(executeCommand) {
  const proxy = new Proxy({}, { get: () => () => undefined });
  const scm = new ScmExtImpl({ getProxy: () => proxy }, { registerArgumentProcessor() {}, executeCommand });
  const control = scm.createSourceControl({ model: { id: 'echo.scm.unit-review' } }, 'git', 'Git', URI.file('/private/tmp/echo-scm-unit-review'));
  const group = control.createResourceGroup('changes', 'Changes');
  group.resourceStates = [{ resourceUri: URI.file('/private/tmp/echo-scm-unit-review/中文文件.txt'),
    command: { command: 'review.openChange', arguments: ['owned-file'] } }];
  const snapshot = group.takeResourceStateSnapshot();
  const handle = snapshot.flatMap(value => value.rawResources).find(value => value.sourceUri.path.endsWith('/中文文件.txt'))?.handle;
  assert(Number.isInteger(handle), 'Actual SCM resource handle missing');
  return { control, group, handle };
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Actual SCM command promise did not settle')), 300);
  })]); } finally { clearTimeout(timer); }
}
test('real SCM resource command resolves after command completion and passes exact args', async () => {
  let complete;
  const called = [], { control, group, handle } = fixture((...args) => {
    called.push(args); return new Promise(resolve => { complete = resolve; });
  });
  try {
    const result = group.executeResourceCommand(handle); let resolved = false;
    result.then(() => { resolved = true; }); await Promise.resolve();
    assert.deepEqual(called, [['review.openChange', 'owned-file']]); assert.equal(resolved, false);
    complete('actual-command-value'); assert.equal(await bounded(result), undefined);
  } finally { control.dispose(); }
});
test('real SCM resource command propagates rejection to its caller', async () => {
  const failure = new Error('real endpoint failure'), escaped = [];
  const listener = error => escaped.push(error); process.on('unhandledRejection', listener);
  const { control, group, handle } = fixture(() => Promise.reject(failure));
  try {
    await assert.rejects(bounded(group.executeResourceCommand(handle)), error => error === failure);
    await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(escaped, []);
  } finally { control.dispose(); process.off('unhandledRejection', listener); }
});
test('resource without a command resolves without calling an endpoint', async () => {
  let calls = 0; const { control, group } = fixture(() => { calls++; return Promise.resolve(); });
  try { assert.equal(await bounded(group.executeResourceCommand(999)), undefined); assert.equal(calls, 0); }
  finally { control.dispose(); }
});
test('SCM supports the command registry PromiseLike contract', async () => {
  const { control, group, handle } = fixture(() => ({ then(resolve) { resolve('thenable-command-result'); } }));
  try { const result = group.executeResourceCommand(handle); assert.equal(typeof result.catch, 'function');
    assert.equal(await bounded(result), undefined); }
  finally { control.dispose(); }
});
test('synchronous command errors become observable promise rejections', async () => {
  const failure = new Error('synchronous command failure');
  const { control, group, handle } = fixture(() => { throw failure; });
  try { await assert.rejects(bounded(group.executeResourceCommand(handle)), error => error === failure); }
  finally { control.dispose(); }
});
