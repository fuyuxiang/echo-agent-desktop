// Synthetic admission guards for the fixed delivery-review branch only.
// No application, GUI, real IPC, retained profile, or filesystem mutation is exercised.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const scriptPath = new URL('./fixtures/native-coding-review.js', import.meta.url);
const script = readFileSync(scriptPath, 'utf8');
// An optional historical control is evaluated only inside the synthetic VM.
// Its provenance must be recorded separately; it is never called a captured native run.
const beforeScript = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : null;
const beforeProvenance = process.argv[3] ? JSON.parse(readFileSync(process.argv[3], 'utf8')) : null;
const home = '/private/tmp/echo-synthetic-coding-delivery-guards';
const cwd = `${home}/workspace`;
const taskName = '原生代码阶段与交付验收';
const requirement = '把原生代码验收.ts中的验收值从1改为2，保留中文注释；真实运行文件内容验证并审阅差异。';
const revision = 'a'.repeat(64);
const forbidden = /(?:create|submit|begin|report_implementation|report_verification|approve|(?:^|_)run(?:_|$)|write|clear)/;
const allowedReads = new Set([
  'desktop_review_context', 'coding_task_get', 'coding_changeset_get',
  'coding_verification_list', 'coding_task_execution_ledger', 'coding_delivery_report',
]);

function syntheticState() {
  const state = {
    expected: { cwd, taskId: 'synthetic-delivered-task', taskName },
    task: { id: 'synthetic-delivered-task', phase: 'delivered', name: taskName,
      requirement, modelId: null, sessionId: null, taskNodes: [{ status: 'success' }] },
    // These are exactly ChangeSetView/FileChangeView's serialized public fields.
    // No persisted ChangeSet revision/hash/baseline byte fields are injected.
    set: { taskId: 'synthetic-delivered-task', baselineMode: 'filesystem',
      changes: [{ path: '原生代码验收.ts', kind: 'modified', added: 1, removed: 1, preExisting: true }],
      createdAt: '2026-10-12T00:00:00Z', reviewedFiles: [], rollbackUnsafeFiles: [],
      committedHash: null, committedPaths: [] },
    records: [{ id: 'synthetic-sole-verification', status: 'passed', exitCode: 0,
      taskId: 'synthetic-delivered-task', kind: 'custom', stderr: '', durationMs: 1,
      startedAt: '2026-10-12T00:00:00Z', finishedAt: '2026-10-12T00:00:01Z',
      testSummary: null, structured: false,
      command: 'node verify-native-code.cjs', stdout: 'native-coding-verification: 中文文件内容正确\n',
      contentRevision: revision }],
    ledger: [{ id: 'synthetic-original-submission', kind: 'requirement_submitted' }],
  };
  state.delivery = { task: structuredClone(state.task),
    gates: ['build', 'test', 'lint', 'type_check', 'verification_freshness', 'diff_review',
      'acceptance', 'requirements_review', 'code_quality_review', 'test_first'].map((id) => ({
      id, title: id === 'verification_freshness' ? '验证对应当前代码' : `合成 ${id}`,
      status: id === 'verification_freshness' ? 'satisfied'
        : ['diff_review', 'acceptance', 'requirements_review', 'code_quality_review'].includes(id) ? 'not_satisfied' : 'not_applicable',
      summary: id === 'verification_freshness' ? '最近一次验证与当前文件内容一致' : '合成的待审阅或不适用门禁',
      evidence: [],
    })),
    changes: structuredClone(state.set.changes), totalAdded: 1, totalRemoved: 1,
    verifications: structuredClone(state.records), problems: [], repairRounds: [], evidence: [],
    blockers: ['合成的待人工审阅门禁'], deliverable: false };
  return state;
}

async function runGuard(change, evaluatedScript = script) {
  const state = syntheticState();
  change?.(state);
  assert.deepEqual(Object.keys(state.set).sort(), ['taskId', 'baselineMode', 'changes', 'createdAt',
    'reviewedFiles', 'rollbackUnsafeFiles', 'committedHash', 'committedPaths'].sort());
  for (const change of state.set.changes) {
    assert.deepEqual(Object.keys(change).sort(), ['path', 'kind', 'added', 'removed', 'preExisting'].sort());
  }
  assert.deepEqual(Object.keys(state.delivery).sort(), ['task', 'gates', 'changes', 'totalAdded',
    'totalRemoved', 'verifications', 'problems', 'repairRounds', 'evidence', 'blockers', 'deliverable'].sort());
  const before = JSON.stringify(state);
  const calls = [];
  const mutationCalls = [];
  const queries = [];
  const listeners = new Map();
  let virtualClock = 0;
  class GuardDate extends Date {
    constructor(...args) { super(...(args.length ? args : [virtualClock])); }
    static now() { return virtualClock; }
  }
  const window = {
    addEventListener(type, handler) { listeners.set(type, handler); },
    removeEventListener(type, handler) { assert.equal(listeners.get(type), handler); listeners.delete(type); },
  };
  // Intentionally no navigation, iframe, editor, diff, delivery panel or ACK.
  const document = {
    querySelector(selector) { queries.push(selector); return null; },
    querySelectorAll(selector) { queries.push(selector); return []; },
  };
  const context = vm.createContext({ window, document, Date: GuardDate, URL,
    CSS: { escape: (value) => String(value) }, getComputedStyle: () => ({ visibility: 'visible' }),
    setTimeout(callback, milliseconds) {
      return setTimeout(() => {
        if (milliseconds <= 100) virtualClock += milliseconds;
        callback();
      }, milliseconds <= 100 ? 0 : 1000);
    }, clearTimeout,
  });
  vm.runInContext(evaluatedScript, context, { filename: 'native-coding-review-under-synthetic-guard.js', timeout: 1000 });
  const invoke = async (name, args) => {
    calls.push(name);
    if (forbidden.test(name)) {
      mutationCalls.push(name);
      throw new Error(`Synthetic delivery guard forbids mutation: ${name}`);
    }
    assert(allowedReads.has(name), `Unexpected synthetic read: ${name}`);
    if (name === 'desktop_review_context') return { home, phase: 'first-launch' };
    assert.equal(args.root, cwd);
    assert.equal(args.taskId, state.expected.taskId);
    const data = {
      coding_task_get: state.task,
      coding_changeset_get: state.set,
      coding_verification_list: state.records,
      coding_task_execution_ledger: state.ledger,
      coding_delivery_report: state.delivery,
    };
    return structuredClone(data[name]);
  };
  let timer;
  const started = performance.now();
  let report;
  try {
    report = await Promise.race([
      window.__echoNativeCodingReview({ invoke, home, cwd,
        nonce: 'synthetic-delivery-guard-nonce-0123456789', sessionId: null,
        phase: 'first-launch', expected: structuredClone(state.expected), continueDeliveryReview: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Synthetic guard deadline exceeded')), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
  assert.equal(JSON.stringify(state), before, 'The synthetic persisted state must remain untouched');
  assert.deepEqual(mutationCalls, [], 'A delivery-only continuation must not create, start, report, approve, run, write or clear');
  assert.equal(listeners.size, 0, 'The production helper must remove its listener on failure');
  assert.equal(report.passed, false, 'Missing actual DOM cannot satisfy native acceptance');
  assert.equal(report.errors.length, 1);
  return { report, calls, queries, virtualClock, durationMs: Math.round(performance.now() - started) };
}

const results = [];
const summarize = (id, result) => ({ id, syntheticGuardPassed: true,
  helperReportedPassed: result.report.passed, checks: Array.from(result.report.checks, ({ id, result }) => ({ id, result })),
  nativeMutationCalls: 0, readCalls: result.calls, durationMs: result.durationMs });
const stateReads = ['desktop_review_context', 'coding_task_get', 'coding_changeset_get',
  'coding_verification_list', 'coding_task_execution_ledger', 'coding_delivery_report'];

let beforePublicProjection = null;
if (beforeScript) {
  assert(beforeScript.includes('set.verifiedRevision === verification.contentRevision'),
    'Historical control must contain the original invalid public DTO predicate');
  const before = await runGuard(undefined, beforeScript);
  assert.match(before.report.errors[0], /coding-retained-verification/);
  assert.deepEqual(Array.from(before.report.checks, ({ result }) => result), ['passed', 'failed']);
  assert.deepEqual(before.calls, stateReads.slice(0, -1));
  const beforeSourceSha256 = createHash('sha256').update(beforeScript).digest('hex');
  if (beforeProvenance) assert.equal(beforeSourceSha256, beforeProvenance.sha256, 'Control source does not match its provenance');
  beforePublicProjection = { ...summarize('old-predicate-rejects-valid-public-projection', before),
    controlSourceSha256: beforeSourceSha256,
    rawBeforeCaptured: beforeProvenance?.rawBeforeCaptured === true,
    controlProvenance: beforeProvenance?.rawBeforeCaptured === true
      ? 'captured original source bytes; SHA verified against capture metadata'
      : 'historical/reconstructed control; no raw capture claimed',
    publicProjectionInjectedInternalFields: false };
}

const invalidScope = await runGuard((state) => { state.expected.taskId = '../outside-retained-scope'; });
assert.match(invalidScope.report.errors[0], /Invalid retained delivery review scope/);
assert.equal(invalidScope.report.checks.length, 0);
assert.deepEqual(invalidScope.calls, ['desktop_review_context']);
results.push(summarize('invalid-scope-rejected-before-task-reads', invalidScope));

const stopped = await runGuard((state) => { state.task.phase = 'stopped'; state.delivery.task.phase = 'stopped'; });
assert.deepEqual(stopped.calls, stateReads);
assert.match(stopped.report.errors[0], /coding-native-delivery-continuation/);
assert.equal(stopped.report.checks.length, 1);
assert.equal(stopped.report.checks[0].result, 'failed');
results.push(summarize('stopped-task-rejected', stopped));

const duplicateRecords = await runGuard((state) => {
  state.records.push({ ...state.records[0], id: 'synthetic-second-verification' });
  state.delivery.verifications.push(structuredClone(state.records[1]));
});
assert.deepEqual(duplicateRecords.calls, stateReads);
assert.match(duplicateRecords.report.errors[0], /coding-retained-verification/);
assert.deepEqual(Array.from(duplicateRecords.report.checks, ({ result }) => result), ['passed', 'failed']);
results.push(summarize('two-verification-records-rejected', duplicateRecords));

const wrongRevision = await runGuard((state) => { state.delivery.gates.find((gate) => gate.id === 'verification_freshness').status = 'not_satisfied'; });
assert.deepEqual(wrongRevision.calls, stateReads);
assert.match(wrongRevision.report.errors[0], /coding-retained-verification/);
assert.deepEqual(Array.from(wrongRevision.report.checks, ({ result }) => result), ['passed', 'failed']);
results.push(summarize('stale-verification-freshness-gate-rejected', wrongRevision));

const missingGate = await runGuard((state) => { state.delivery.gates = state.delivery.gates.filter((gate) => gate.id !== 'verification_freshness'); });
assert.deepEqual(missingGate.calls, stateReads);
assert.match(missingGate.report.errors[0], /coding-retained-verification/);
assert.deepEqual(Array.from(missingGate.report.checks, ({ result }) => result), ['passed', 'failed']);
results.push(summarize('missing-verification-freshness-gate-rejected', missingGate));

const wrongDeliveryId = await runGuard((state) => { state.delivery.verifications[0].id = 'synthetic-different-verification'; });
assert.deepEqual(wrongDeliveryId.calls, stateReads);
assert.match(wrongDeliveryId.report.errors[0], /coding-retained-verification/);
assert.deepEqual(Array.from(wrongDeliveryId.report.checks, ({ result }) => result), ['passed', 'failed']);
results.push(summarize('wrong-delivery-verification-id-rejected', wrongDeliveryId));

const admitted = await runGuard();
assert.deepEqual(admitted.calls, stateReads);
assert.deepEqual(Array.from(admitted.report.checks, ({ id, result }) => `${id}:${result}`),
  ['coding-native-delivery-continuation:passed', 'coding-retained-verification:passed']);
assert.equal(admitted.report.expected.verificationId, 'synthetic-sole-verification');
assert.equal(admitted.report.expected.contentRevision, revision);
assert.match(admitted.report.errors[0], /Timed out waiting for actual Echo Code step:.*nav\('代码开发'\)/);
assert(admitted.queries.includes('.sidebar__nav'));
assert(admitted.virtualClock >= 20_000);
assert.equal(admitted.report.failureContext.iframePresent, false);
results.push({ ...summarize('valid-persisted-state-stops-at-missing-real-ui', admitted),
  admittedPersistedChecks: 2, actualUiVerified: false, virtualDomTimeoutMs: admitted.virtualClock });

console.log(JSON.stringify({ environment: 'synthetic VM delivery-branch admission guards only',
  source: 'scripts/fixtures/native-coding-review.js', sourceSha256: createHash('sha256').update(script).digest('hex'),
  syntheticGuardsPassed: results.length, nativeAcceptanceExecuted: false,
  realIpcExecuted: false, retainedProfileAccessed: false, mutationsExecuted: 0,
  publicProjectionInjectedInternalFields: false, beforePublicProjection, results }, null, 2));
