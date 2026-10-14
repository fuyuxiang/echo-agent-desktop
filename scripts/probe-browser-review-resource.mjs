import { nativeReviewOutput } from './lib/native-review-output.mjs';
// This probes a real HTTP test resource; it is not Browser Use acceptance.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createBrowserReviewResource } from './lib/browser-review-resource.mjs';

assert.equal(process.argv.length, 2, 'This probe accepts no user path or endpoint');
const evidence = nativeReviewOutput('browser-resource', 'BROWSER_RESOURCE_REVIEW_OUTPUT');
const report = { kind: 'real-local-http-resource', nativeBrowserVerified: false,
  modelDrivenVerified: false, passed: false, checks: [], errors: [] };
let resource;
try {
  resource = await createBrowserReviewResource(randomBytes(16).toString('hex'));
  const route = (name) => resource.url + name;
  const post = (name, value, origin = resource.origin) => fetch(route(name), {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nonce: resource.nonce, value }), signal: AbortSignal.timeout(5000),
  });
  const record = (id, proof) => report.checks.push({ id, result: 'passed', proof });
  const page = await fetch(resource.url, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200); assert((await page.text()).includes('本次验收文本'));
  record('resource-real-page', { status: page.status });
  const outside = await fetch(resource.origin + '/review/unknown/', { signal: AbortSignal.timeout(5000) });
  assert.equal(outside.status, 404); record('resource-outside-scope', { status: outside.status });
  const beforeDownload = await fetch(route('download.txt'), { signal: AbortSignal.timeout(5000) });
  assert.equal(beforeDownload.status, 409); record('resource-download-needs-submit', { status: beforeDownload.status });
  const forged = await post('submit', resource.inputMarker, 'https://example.invalid');
  assert.equal(forged.status, 403); assert.equal(resource.snapshot().submitted, false);
  record('resource-cross-origin-rejected', { status: forged.status, stateUnchanged: true });
  const sent = await post('submit', resource.inputMarker);
  assert.equal(sent.status, 200); assert.equal((await sent.json()).marker, resource.submittedMarker);
  const duplicate = await post('submit', resource.inputMarker); assert.equal(duplicate.status, 409);
  record('resource-exact-submit-and-no-duplicate', { status: sent.status, duplicate: duplicate.status });
  const download = await fetch(route('download.txt'), { signal: AbortSignal.timeout(5000) });
  assert.equal(download.status, 200); const downloaded = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(downloaded, resource.bytes);
  assert.equal(createHash('sha256').update(downloaded).digest('hex'), resource.sha256);
  assert(download.headers.get('content-disposition').includes(encodeURIComponent(resource.filename)));
  record('resource-chinese-download-bytes', { status: download.status, size: downloaded.length, sha256: resource.sha256 });
  const deleted = await post('delete', 'delete-owned-fixture'); assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).marker, resource.deletedMarker);
  const duplicateDelete = await post('delete', 'delete-owned-fixture'); assert.equal(duplicateDelete.status, 409);
  record('resource-owned-delete-and-no-duplicate', { status: deleted.status, duplicate: duplicateDelete.status });
  await resource.close();
  await assert.rejects(() => fetch(resource.url, { signal: AbortSignal.timeout(2000) }));
  assert.equal(resource.snapshot().stopped, true); record('resource-stopped', { stopped: true });
  report.passed = true;
} catch (error) {
  report.errors.push(String(error?.message || error)); process.exitCode = 1;
} finally {
  if (resource) { await resource.close(); report.resource = resource.snapshot(); }
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  process.stdout.write(JSON.stringify({ evidence, passed: report.passed, checks: report.checks.length,
    errors: report.errors, nativeBrowserVerified: false, modelDrivenVerified: false }) + '\n');
}
