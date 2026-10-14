// Synthetic fail-closed regression checks; no native app or real IDE is run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectCodeContinuation } from './native-coding-continuation-state.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-review-continuation-guards-')));
const cwd = join(home, 'workspace');
mkdirSync(join(cwd, '.theia'), { recursive: true });
const taskId = 'synthetic-task';
const taskName = '原生代码阶段与交付验收';
const requirement = '把原生代码验收.ts中的验收值从1改为2，保留中文注释；真实运行文件内容验证并审阅差异。';
const sessionId = 'synthetic-retained-session';
const filename = '原生代码验收.ts';
const files = {
  [filename]: `// EchoAgent 原生代码验收\nexport const 验收值 = 1;\n// ${'x'.repeat(600)}\n`,
  'verify-native-code.cjs': `const fs = require('node:fs');\nconst assert = require('node:assert/strict');\nassert.match(fs.readFileSync(${JSON.stringify(filename)}, 'utf8'), /export const 验收值 = 2;/);\nconsole.log('native-coding-verification: 中文文件内容正确');\n`,
  '.theia/settings.json': JSON.stringify({ 'files.autoSave': 'off' }, null, 2),
};
for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
const project = join(home, 'coding', hash(Buffer.from(cwd)).slice(0, 16));
const directory = join(project, taskId);
mkdirSync(directory, { recursive: true });
const task = { id: taskId, name: taskName, requirement, phase: 'discovering', blocker: null, planRevision: null,
  contextPaths: [], planIssues: [], modelId: null, sessionId: null, createdAt: 'synthetic-original-time',
  acceptanceCriteria: [{ content: requirement, satisfied: false, evidence: [] }],
  taskNodes: [{ planKey: 'ROOT', status: 'running', attempt: 1, completedAt: null }] };
const set = { taskId, baselineMode: 'filesystem', baselineHead: null, baselineFiles: [], changes: [], reviewedFiles: [],
  reviewedHashes: {}, changeHashes: {}, verifiedRevision: null, verificationStartedRevision: null, committedHash: null,
  committedPaths: [], rollbackUnsafeFiles: [], baselineEntries: Object.entries(files).map(([path, content]) => ({
    path, existed: true, hash: hash(Buffer.from(content)), contentBase64: Buffer.from(content).toString('base64'),
  })) };
const original = { id: 'synthetic-original-submission', taskId, kind: 'requirement_submitted' };
const index = { tasks: [{ id: taskId, phase: 'discovering' }] };
const history = [{ phase: 'first-launch', nativeContext: { home }, sessionId, workspace: cwd, passed: false,
  checks: [{ id: 'coding-native-task-start', result: 'passed' }], errors: ['synthetic service resolver failure'],
  coding: { passed: false, expected: { cwd, taskId, taskName } } }];
const json = (path, value) => writeFileSync(path, JSON.stringify(value));
const reset = () => {
  json(join(project, 'tasks.json'), index);
  json(join(directory, 'task.json'), task);
  json(join(directory, 'changeset.json'), set);
  writeFileSync(join(directory, 'execution-ledger.jsonl'), `${JSON.stringify(original)}\n`);
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
};
const inspect = (override = {}) => inspectCodeContinuation({ home, cwd, sessionId, history, ...override });
reset();
assert.equal(inspect().taskId, taskId);
assert.equal(inspect().unchangedBaselineFiles, 3);
json(join(directory, 'task.json'), { ...task, phase: 'verifying' });
assert.throws(inspect, /changed\/progressed/);
reset();
writeFileSync(join(cwd, filename), files[filename].replace('= 1;', '= 2;'));
assert.throws(inspect, /workspace file changed/);
reset();
writeFileSync(join(cwd, 'foreign-added.txt'), 'unrelated content');
assert.throws(inspect, /unexpected file/);
unlinkSync(join(cwd, 'foreign-added.txt'));
const changedSet = JSON.parse(JSON.stringify(set));
changedSet.baselineEntries[0].contentBase64 = Buffer.from('replacement').toString('base64');
json(join(directory, 'changeset.json'), changedSet);
assert.throws(inspect, /Baseline bytes/);
reset();
json(join(project, 'tasks.json'), { tasks: [...index.tasks, { id: 'foreign-task', phase: 'discovering' }] });
assert.throws(inspect, /exactly the original/);
reset();
writeFileSync(join(directory, 'verifications.jsonl'), '{"id":"already-ran"}\n');
assert.throws(inspect, /verification already ran/);
unlinkSync(join(directory, 'verifications.jsonl'));
assert.throws(() => inspect({ history: [{ ...history[0], passed: true }] }), /No actual failed/);
assert.equal(readFileSync(join(cwd, filename), 'utf8'), files[filename]);
console.log('Synthetic continuation guards passed: 8 cases. Temporary fixture retained at ' + home
  + '. No native application, real Theia service, or Rust host was exercised.');
