import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { captureReviewModelLogs, createReviewModelSecretRedactor } from './lib/native-review-model.mjs';

const marker = '[REDACTED_MODEL_CREDENTIAL]';
for (const key of ['synthetic-private-test-credential', 'synthetic-"quoted"\\credential']) {
  test('stream redaction covers every byte boundary, JSON escaping and UTF-8: ' + (key.includes('"') ? 'escaped' : 'plain'), () => {
    const input = `中文日志 ${key}|${JSON.stringify(key)}|${key}|末尾 ${key.slice(0, 5)}`;
    const expected = `中文日志 ${marker}|"${marker}"|${marker}|末尾 ${key.slice(0, 5)}`;
    const bytes = Buffer.from(input);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const redactor = createReviewModelSecretRedactor(key);
      assert.equal(redactor.write(bytes.subarray(0, cut)) + redactor.write(bytes.subarray(cut)) + redactor.end(), expected, `byte boundary ${cut}`);
      assert.equal(redactor.end(), '');
      assert.throws(() => redactor.write(Buffer.from('late')), /completed/);
    }
    const redactor = createReviewModelSecretRedactor(key);
    assert.equal([...bytes].map(byte => redactor.write(Buffer.from([byte]))).join('') + redactor.end(), expected);
  });
}

test('unconfigured log capture preserves split UTF-8 and final short text', () => {
  const redactor = createReviewModelSecretRedactor(null), bytes = Buffer.from('中文末尾');
  assert.equal([...bytes].map(byte => redactor.write(Buffer.from([byte]))).join('') + redactor.end(), '中文末尾');
});

test('real stdout and stderr pipes redact independently and flush their final text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-review-log-')), path = join(root, 'log.txt');
  const key = 'synthetic-stdio-credential-only';
  const child = spawn(process.execPath, ['-e', `
    const key = ${JSON.stringify(key)};
    process.stdout.write('stdout ' + key.slice(0, 10));
    process.stderr.write('stderr ' + key.slice(0, 7));
    setTimeout(() => {
      process.stderr.write(key.slice(7) + ' 完成\\n');
      process.stdout.write(key.slice(10) + ' 中文日志\\nshort ' + key.slice(0, 5));
    }, 20);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const logs = captureReviewModelLogs(child, path, { apiKey: key });
    await logs.finished;
    assert.equal(child.exitCode, 0); assert.equal(logs.overflow, false);
    const content = readFileSync(path, 'utf8');
    assert(!content.includes(key)); assert.equal(content.split(marker).length - 1, 2);
    assert(content.includes('中文日志')); assert(content.includes('short ' + key.slice(0, 5)));
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o077, 0);
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('oversized process logs stop the child and still settle capture', async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-review-log-bound-'));
  const child = spawn(process.execPath, ['-e', 'process.stdout.write("x".repeat(10000)); setInterval(()=>{}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const logs = captureReviewModelLogs(child, join(root, 'log.txt'), { maxBytes: 100, apiKey: null });
    await logs.finished; assert.equal(logs.overflow, true); assert(logs.bytes > 100);
    assert.equal(child.signalCode, 'SIGTERM');
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('a descendant retaining a pipe cannot keep log capture pending forever', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'echo-review-log-close-'));
  const child = spawn(process.execPath, ['-e', `
    require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 250)'], { stdio: ['ignore', 1, 2] }).unref();
    process.stdout.write('final short text'); process.exit(0);
  `], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const logs = captureReviewModelLogs(child, join(root, 'log.txt'), { closeTimeoutMs: 20, apiKey: null });
    await logs.finished; assert.equal(logs.incomplete, true);
    assert.equal(readFileSync(join(root, 'log.txt'), 'utf8'), 'final short text');
  } finally { child.kill('SIGKILL'); rmSync(root, { recursive: true, force: true }); }
});

test('explicit private review model is scoped, seeded owner-only, and redacted', { skip: process.platform === 'win32' }, async () => {
  assert(!process.env.NATIVE_REVIEW_MODEL_CONFIG, 'Unit test must not read live model credentials');
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'echo-model-guard-')));
  chmodSync(root, 0o700);
  const privatePath = join(root, 'connection.json'), key = 'synthetic-private-test-credential';
  const value = { baseUrl: 'https://example.invalid/v1', model: 'claude-opus-5-5', protocol: 'chat_completions', apiKey: key };
  try {
    const model = await import('./lib/native-review-model.mjs');
    assert.equal(model.reviewModelId(), model.DEFAULT_REVIEW_MODEL_ID);
    process.env.NATIVE_REVIEW_MODEL_CONFIG = privatePath;
    writeFileSync(privatePath, JSON.stringify(value), { mode: 0o644 });
    assert.throws(() => model.reviewModelId(), /owner-only/);
    chmodSync(privatePath, 0o600);
    writeFileSync(privatePath, `{"apiKey":"${key}", invalid`);
    assert.throws(() => model.reviewModelId(), error => error.message.includes('valid JSON') && !error.message.includes(key));
    writeFileSync(privatePath, JSON.stringify({ ...value, baseUrl: `invalid url ${key}` }));
    assert.throws(() => model.reviewModelId(), error => error.message.includes('HTTPS') && !error.message.includes(key));
    writeFileSync(privatePath, JSON.stringify({ ...value, baseUrl: 'http://example.invalid' }));
    assert.throws(() => model.reviewModelId(), /HTTPS/);
    writeFileSync(privatePath, JSON.stringify(value));
    assert.equal(model.reviewModelId(), model.PRIVATE_REVIEW_MODEL_ID);
    writeFileSync(join(root, 'config.toml'), '[claude_compat]\nimported = true\n', { mode: 0o600 });
    assert.equal(model.seedReviewModel(root), model.PRIVATE_REVIEW_MODEL_ID);
    const config = readFileSync(join(root, 'config.toml'), 'utf8');
    assert(config.includes('model = "claude-opus-5-5"') && config.includes(key));
    assert.equal(statSync(join(root, 'config.toml')).mode & 0o077, 0);
    assert.throws(() => model.seedReviewModel(root), /overwrite/);
    assert(!model.redactReviewModelSecrets(`${key} ${key}`).includes(key));
    assert(!model.isReviewModelId('unknown/arbitrary-model'));
  } finally {
    delete process.env.NATIVE_REVIEW_MODEL_CONFIG;
    rmSync(root, { recursive: true, force: true });
  }
});
