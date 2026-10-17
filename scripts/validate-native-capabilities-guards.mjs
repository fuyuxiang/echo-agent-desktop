import { nativeReviewOutput } from './lib/native-review-output.mjs';
// Synthetic admission/physical-observer regressions only. These checks do not
// launch an application or certify real UI/Runtime/scheduler acceptance.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { CAPABILITY_CHECKS, verifyCapabilitiesNativeReport, verifyCapabilitiesInstalledFixture } from './validate-native-capabilities-review.mjs';

const checks = [];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-review-capabilities-')));
const token = 'a'.repeat(64), startedAt = Date.now(), due = new Date(startedAt - 3600000).toISOString();
const manifest = { schema: 1, home, cwd: join(home, 'workspaces', 'default'), token,
  sourceUrl: 'https://127.0.0.1:4443/echo-capabilities-market-aaaaaaaaaaaa.git',
  caPath: join(home, 'capabilities-git-resource', 'ca.crt'), pluginName: 'echo-capabilities-review-aaaaaaaaaaaa',
  marketplaceName: 'echo-capabilities-market-aaaaaaaaaaaa', pluginRelativePath: 'plugins/echo-capabilities-review-aaaaaaaaaaaa',
  initialCommit: 'b'.repeat(40), memorySeed: 'owned seed\n', memorySeedSHA256: hash('owned seed\n'), memoryRestoredSeed: 'owned restoration\n' };
const task = (id, kind) => ({ id, name: `synthetic ${kind}`, prompt: `synthetic ${kind} reply`, cwds: manifest.cwd,
  status: 'PAUSED', nextRunAt: null, modelId: 'echoagent-ojlab/chat-qwen', permissionMode: 'default',
  skills: [], connectorIds: [], pushToWeChat: false, scheduleType: kind });
const once = task('synthetic-once', 'once'), recurring = task('synthetic-periodic', 'recurring');
const run = (id, task, time) => ({ id, automationId: task.id, automationName: task.name, status: 'success', error: null, sessionId: `synthetic-session-${id}`,
  cwd: manifest.cwd, modelId: task.modelId, scheduledFor: time, startedAt: time, finishedAt: new Date(Date.parse(time) + 1000).toISOString(),
  automationSnapshot: { ...task, status: 'ACTIVE' } });
const expected = { version: 1, ...manifest, sessionId: 'synthetic-warmup-session', plugins: [{}, {}, {}],
  automations: [once, recurring], records: [run('one', once, due), run('two', recurring, due), run('three', recurring, new Date(Date.parse(due) + 3600000).toISOString())],
  firstDueAt: due };
const valid = { version: 1, kind: 'capabilities', phase: 'first-launch', passed: true, errors: [],
  nativeContext: { phase: 'first-launch', home, pid: 123, capabilitiesRequested: true, evaluations: 1 },
  finishedAt: new Date().toISOString(), defaultHomeChanged: false, timeInjected: false, manualRunRequested: false, externalAccountRequested: false,
  checks: CAPABILITY_CHECKS['first-launch'].map((id) => ({ id, result: 'passed', evidence: { syntheticGuard: true } })), expected };
valid.checks.find(item => item.id === 'cap-git-refresh-recovery').evidence = {
  syntheticGuard: true, sourceUrl: manifest.sourceUrl, recovered: true, retainedInstalledVersion: '1.0.0',
  failedFeedback: '刷新失败：synthetic HTTP 503',
};
for (const [id, version] of [['cap-git-install', '1.0.0'], ['cap-git-update', '2.0.0']]) {
  valid.checks.find(item => item.id === id).evidence.runtimeUse = {
    version, name: `${manifest.pluginName}:fixture-notes`, qualifiedName: `${manifest.pluginName}:fixture-notes`, source: `plugin:${manifest.pluginName}`, noTools: true, answer: version, prompt: '/synthetic-command read installed version',
  };
}
valid.checks.find(item => item.id === 'cap-git-install').evidence.toggle = { disabled: { commandPresent: false }, enabled: { commandPresent: true } };
const verify = (report) => verifyCapabilitiesNativeReport({ report, manifest, phase: 'first-launch', pid: 123, startedAt });
assert.deepEqual(verify(valid), expected); checks.push({ id: 'strict-report-positive-synthetic', result: 'passed' });
const finalized = structuredClone(valid);
for (const record of finalized.expected.records) record.automationSnapshot = null;
assert.deepEqual(verify(finalized), finalized.expected);
checks.push({ id: 'terminal-cleared-queue-context-positive-synthetic', result: 'passed' });
for (const [id, mutate] of [
  ['foreign-plugin-command', r => { r.checks.find(item => item.id === 'cap-git-install').evidence.runtimeUse.source = 'plugin:foreign'; }],
  ['missing-gate', (r) => r.checks.pop()], ['duplicate-gate', (r) => { r.checks.at(-1).id = r.checks[0].id; }],
  ['blocked-gate', (r) => { r.checks[0].result = 'blocked'; }], ['native-errors', (r) => { r.errors.push('real failure'); }],
  ['wrong-kind', (r) => { r.kind = 'fixture'; }], ['stale-finish', (r) => { r.finishedAt = new Date(0).toISOString(); }],
  ['foreign-home', (r) => { r.nativeContext.home = '/unowned'; }], ['wrong-pid', (r) => { r.nativeContext.pid++; }],
  ['general-review', (r) => { r.nativeContext.capabilitiesRequested = false; }],
  ['repeated-evaluation', (r) => { r.nativeContext.evaluations++; }], ['clock-injection', (r) => { r.timeInjected = true; }],
  ['manual-substitution', (r) => { r.manualRunRequested = true; }], ['manifest-url-drift', (r) => { r.expected.sourceUrl += '/other'; }],
  ['missing-occurrence', (r) => { r.expected.records.pop(); }], ['duplicate-occurrence-id', (r) => { r.expected.records[2].id = r.expected.records[1].id; }],
  ['same-session-reuse', (r) => { r.expected.records[2].sessionId = r.expected.records[1].sessionId; }],
  ['manual-null-scheduled-for', (r) => { r.expected.records[2].scheduledFor = null; }],
  ['fake-minute-recurrence', (r) => { r.expected.records[2].scheduledFor = new Date(Date.parse(due) + 60000).toISOString(); }],
  ['dispatch-before-due', (r) => { r.expected.records[0].startedAt = new Date(Date.parse(due) - 1).toISOString(); }],
  ['failed-model-run', (r) => { r.expected.records[0].status = 'failed'; }], ['foreign-run-workspace', (r) => { r.expected.records[0].cwd = '/unowned'; }],
  ['snapshot-prompt-drift', (r) => { r.expected.records[0].automationSnapshot.prompt = 'another task'; }],
  ['terminal-task-name-drift', (r) => { r.expected.records[0].automationName = 'another task'; }],
  ['refresh-false-success', (r) => { r.checks.find(item => item.id === 'cap-git-refresh-recovery').evidence.failedFeedback = '已刷新'; }],
  ['refresh-not-recovered', (r) => { r.checks.find(item => item.id === 'cap-git-refresh-recovery').evidence.recovered = false; }],
  ['refresh-foreign-source', (r) => { r.checks.find(item => item.id === 'cap-git-refresh-recovery').evidence.sourceUrl = 'https://unowned.invalid'; }],
]) {
  const report = structuredClone(valid); mutate(report); assert.throws(() => verify(report), undefined, `Admission accepted ${id}`);
  checks.push({ id, result: 'passed', expected: 'rejected' });
}
const install = join(home, 'installed-plugins', 'fixture');
mkdirSync(join(install, 'skills', 'fixture-notes'), { recursive: true, mode: 0o700 });
const pluginBytes = JSON.stringify({ name: manifest.pluginName, version: '1.0.0' });
const skillBytes = '# Own static fixture\n';
writeFileSync(join(install, 'plugin.json'), pluginBytes); writeFileSync(join(install, 'skills', 'fixture-notes', 'SKILL.md'), skillBytes);
writeFileSync(join(home, 'installed-plugins', 'registry.json'), JSON.stringify({ repos: { fixture: { path: install,
  marketplace: { source_url_or_path: manifest.sourceUrl, plugin_subdir: manifest.pluginRelativePath },
  plugins: { [manifest.pluginName]: { version: '1.0.0' } } } } }));
const metadata = { manifestSha256: hash(pluginBytes), skillSha256: hash(skillBytes) };
const inspect = (options = {}) => verifyCapabilitiesInstalledFixture({ home, manifest, installedRoot: install, version: '1.0.0', metadata, ...options });
assert.equal(inspect().version, '1.0.0'); checks.push({ id: 'physical-owned-registry-and-files-positive-synthetic', result: 'passed' });
assert.throws(() => inspect({ installedRoot: home })); checks.push({ id: 'physical-root-escape', result: 'passed', expected: 'rejected' });
assert.throws(() => inspect({ metadata: { ...metadata, skillSha256: 'f'.repeat(64) } })); checks.push({ id: 'physical-content-mismatch', result: 'passed', expected: 'rejected' });
assert.throws(() => inspect({ version: '2.0.0' })); checks.push({ id: 'physical-version-mismatch', result: 'passed', expected: 'rejected' });
writeFileSync(join(install, 'hooks.json'), '{}'); assert.throws(() => inspect()); checks.push({ id: 'unknown-executable-fixture-component', result: 'passed', expected: 'rejected' });
const output = join(nativeReviewOutput('native-capabilities-guards'), 'result.json');
writeFileSync(output, JSON.stringify({ version: 1, kind: 'synthetic-native-capabilities-admission-and-observer-guards',
  actualNativeAcceptanceVerified: false, actualSchedulerDueVerified: false, home, checks, passed: true,
  driverSha256: hash(readFileSync('scripts/validate-native-capabilities-review.mjs')), factorySha256: hash(readFileSync('scripts/fixtures/native-capabilities-review.js')) }, null, 2));
console.log(JSON.stringify({ kind: 'synthetic-guards-only', checks: checks.length, passed: true, actualNativeAcceptanceVerified: false, output }));
