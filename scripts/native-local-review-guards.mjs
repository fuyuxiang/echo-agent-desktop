// Admission/negative guards only. These synthetic structures do not establish
// native UI, IPC, notification, playback, or meeting acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { REQUIRED_LOCAL_CHECKS, localMeetingFixture, verifyNativeLocalReport,
  verifyLocalReceiverAudit } from './validate-native-local-review.mjs';
const home = '/private/tmp/echo-native-review-local-unit', nonce = '0123456789abcdef0123456789abcdef';
const fixture = localMeetingFixture(home, nonce, 0), startedAt = Date.now() - 1000;
const expected = { version: 1, home, nonce, label: `本地通知恢复-${nonce}`, finalLabel: `本地通知恢复-${nonce}`,
  channelId: 'ch_1791814000000', meetingId: fixture.id, meetingTitle: fixture.title, audioPath: fixture.audioPath,
  originalMinutes: fixture.minutes, minutes: `# 本地恢复校对\n缺文件错误后可继续编辑和保存。${nonce}` };
const report = { version: 1, kind: 'local', phase: 'first-launch', passed: true, errors: [], expected,
  nativeContext: { phase: 'first-launch', home, pid: 31415, localRequested: true, evaluations: 1 },
  checks: REQUIRED_LOCAL_CHECKS['first-launch'].map((id) => ({ id, result: 'passed', evidence: 'synthetic guard structure only' })),
  finishedAt: new Date().toISOString(), modelRequested: false, osNotificationVerified: false,
  playbackSuccessVerified: false, recordingOrAsrVerified: false };
const check = (candidate, options = {}) => verifyNativeLocalReport({ report: candidate, phase: 'first-launch', home, nonce, pid: 31415, startedAt, ...options });
let passed = 0;
const guard = (name, fn) => { fn(); passed += 1; console.log(`PASS ${name}`); };
guard('complete isolated report shape accepted as structure only', () => assert.deepEqual(check(report), expected));
const negative = (name, mutate, options) => guard(name, () => {
  const candidate = structuredClone(report); mutate(candidate); assert.throws(() => check(candidate, options));
});
negative('generic report rejected', (r) => { r.kind = 'desktop'; });
negative('wrong home rejected', (r) => { r.nativeContext.home = '/private/tmp/other'; });
negative('wrong PID rejected', (r) => { r.nativeContext.pid++; });
negative('missing dedicated dispatch rejected', (r) => { r.nativeContext.localRequested = false; });
negative('duplicate evaluation rejected', (r) => { r.nativeContext.evaluations = 2; });
negative('wrong native phase rejected', (r) => { r.nativeContext.phase = 'restart'; });
negative('stale report rejected', (r) => { r.finishedAt = new Date(startedAt - 1).toISOString(); });
negative('future report rejected', (r) => { r.finishedAt = new Date(Date.now() + 10000).toISOString(); });
negative('failure report rejected', (r) => { r.passed = false; });
negative('reported error rejected', (r) => { r.errors.push('actual failure'); });
negative('missing UI gate rejected', (r) => { r.checks.pop(); });
negative('duplicate UI gate rejected', (r) => { r.checks[1] = r.checks[0]; });
negative('failed UI gate rejected', (r) => { r.checks[1].result = 'failed'; });
negative('blocked UI gate rejected', (r) => { r.checks[1].result = 'blocked'; });
for (const key of ['modelRequested', 'osNotificationVerified', 'playbackSuccessVerified', 'recordingOrAsrVerified'])
  negative(`unearned ${key} rejected`, (r) => { r[key] = true; });
negative('wrong meeting scope rejected', (r) => { r.expected.meetingId = 'another-id'; });
negative('outside-home audio rejected', (r) => { r.expected.audioPath = '/private/tmp/outside.wav'; });
negative('incorrect Chinese minutes rejected', (r) => { r.expected.minutes += 'changed'; });
negative('unrelated channel identity rejected', (r) => { r.expected.channelId = 'preset-not-ui'; });
guard('restart retains exact expectations', () => {
  const r = structuredClone(report); r.phase = r.nativeContext.phase = 'restart';
  r.checks = REQUIRED_LOCAL_CHECKS.restart.map((id) => ({ id, result: 'passed' }));
  assert.deepEqual(check(r, { phase: 'restart', previousExpected: expected }), expected);
  assert.throws(() => check(r, { phase: 'restart', previousExpected: { ...expected, channelId: 'ch_1791814000001' } }));
});
const receiverUrl = `http://127.0.0.1:41234/echo-review/${nonce}`;
const payload = { title: '测试通知', body: '来自 EchoAgent 的测试消息', level: 'info', sessionId: null, timestamp: new Date().toISOString() };
const rawBody = JSON.stringify(payload), sha256 = createHash('sha256').update(rawBody).digest('hex');
const notifications = [200, 403, 200, 200].map((status) => ({ method: 'POST', path: new URL(receiverUrl).pathname + (status === 403 ? '/fail' : ''),
  status, payload: { ...payload }, rawBody, bodySha256: sha256, contentType: 'application/json' }));
guard('exact production payload request sequence accepted as structure only', () => assert.equal(verifyLocalReceiverAudit({ notifications, receiverUrl }).requests, 4));
for (const [name, mutate] of [
  ['duplicate HTTP rejection rejected', (n) => n.push(n[1])],
  ['missing manual retry rejected', (n) => n.splice(2, 1)],
  ['wrong receiver path rejected', (n) => { n[2].path += '/outside'; }],
  ['wrong real status rejected', (n) => { n[1].status = 200; }],
  ['nonproduction title rejected', (n) => { n[0].payload.title = 'fake'; }],
  ['corrupt body SHA rejected', (n) => { n[0].bodySha256 = '0'.repeat(64); }],
  ['non-JSON send rejected', (n) => { n[0].contentType = 'text/plain'; }],
  ['received body and decoded payload mismatch rejected', (n) => { n[0].payload.body += 'changed'; }],
]) guard(name, () => { const n = structuredClone(notifications); mutate(n); assert.throws(() => verifyLocalReceiverAudit({ notifications: n, receiverUrl })); });
guard('external audit scope rejected', () => assert.throws(() => verifyLocalReceiverAudit({ notifications,
  receiverUrl: `https://example.test/echo-review/${nonce}` })));
const source = readFileSync(new URL('./fixtures/native-local-review.js', import.meta.url), 'utf8');
const readinessSource = source.match(/const notificationPanelReady = \(\) => \{[\s\S]*?\n  \};/)?.[0];
assert(readinessSource, 'Guard must evaluate the actual fixed helper readiness function');
const readyControl = { disabled: false, shown: true };
const readyPanel = { shown: true, querySelector: (selector) => selector === '.panel-inline-error' ? null : readyControl,
  addButton: { disabled: true } };
const readiness = (candidate) => vm.runInNewContext(readinessSource + '\nnotificationPanelReady();',
  { panel: () => candidate, visible: (element) => Boolean(element?.shown) });
guard('loaded empty form accepted while correctly-disabled Add remains disabled', () => {
  assert.equal(readiness(readyPanel), readyPanel);
  assert.equal(readyPanel.addButton.disabled, true);
});
guard('loading disabled controls rejected', () => assert.equal(readiness({ shown: true, querySelector: (s) => s === '.panel-inline-error' ? null : { disabled: true, shown: true } }), null));
guard('real load error rejected', () => assert.equal(readiness({ shown: true, querySelector: () => ({ shown: true }) }), null));
guard('missing required field rejected', () => assert.equal(readiness({ shown: true, querySelector: () => null }), null));
guard('detached panel rejected', () => assert.equal(readiness({ ...readyPanel, shown: false }), null));
guard('fixed factory has no arbitrary caller script or IPC replacement', () => {
  assert(!/\beval\s*\(|new\s+Function\s*\(|__TAURI_INTERNALS__\.invoke\s*=/.test(source));
  assert(source.includes("element.querySelector('.iam-item__label')?.textContent === '会议录音与纪要'"));
});
const fakeInvoke = async () => { throw new Error('Synthetic guard must not invoke production commands'); };
const browser = { window: { __TAURI_INTERNALS__: { invoke: fakeInvoke } }, URL, Date, setTimeout, clearTimeout, Promise, Set };
vm.runInNewContext(source, browser);
for (const [name, scope, context] of [
  ['external loopback scope rejected before DOM', { schema: 1, home, nonce, receiverUrl: 'https://example.test/echo-review/' + nonce }, { phase: 'first-launch', home, evaluations: 1, localRequested: true }],
  ['default home rejected before DOM', { schema: 1, home: '/Users/synthetic/.echo-agent', nonce, receiverUrl }, { phase: 'first-launch', home: '/Users/synthetic/.echo-agent', evaluations: 1, localRequested: true }],
  ['missing dedicated context rejected before DOM', { schema: 1, home, nonce, receiverUrl }, { phase: 'first-launch', home, evaluations: 1, localRequested: false }],
]) {
  const result = await browser.window.__echoNativeLocalReview({ invoke: fakeInvoke, context, scope });
  guard(name, () => { assert.equal(result.passed, false); assert.equal(result.checks[0].id, 'native-local-isolation'); assert.equal(result.checks[0].result, 'failed'); });
}
console.log(JSON.stringify({ passed, nativeVerified: false, layer: 'synthetic strict-admission and safety guards only' }));
