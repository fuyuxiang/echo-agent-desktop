import { nativeReviewOutput } from './lib/native-review-output.mjs';
// Independent standard Git/TLS preflight. This does not launch or substitute a
// native application, model, plugin installation, or Runtime acceptance.
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { request } from 'node:https';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createCapabilitiesGitResource, capabilitiesGitProcessEnvironment,
  runCapabilitiesGitCommand } from './lib/capabilities-git-resource.mjs';

const outputRoot = nativeReviewOutput('capabilities-git-resource', 'CAPABILITIES_GIT_RESOURCE_OUTPUT');
mkdirSync(outputRoot, { recursive: true });
const evidenceRoot = mkdtempSync(join(outputRoot, 'run-'));
const privateRoot = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-review-capabilities-')));
chmodSync(privateRoot, 0o700);
const token = randomBytes(32).toString('hex');
const checks = [];
const report = { version: 1, kind: 'standard-smart-https-git-resource-preflight',
  startedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch,
  node: process.version, privateRoot, evidenceRoot, nativeApplicationVerified: false,
  runtimePluginInstallationVerified: false, defaultHomeChanged: false, globalGitConfigChanged: false,
  tlsVerificationDisabled: false, checks, passed: false };
let resource;
const check = (id, details) => checks.push({ id, result: 'passed', ...details });
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = async (args, { trusted = false, cwd = privateRoot } = {}) => {
  const env = capabilitiesGitProcessEnvironment(trusted ? { GIT_SSL_CAINFO: resource.caPath } : {});
  // Resource preflight rejects unsafe ordinary config. Clone/fetch use its normal
  // hooks and TLS semantics; the only TLS addition is this instance's CA file.
  return runCapabilitiesGitCommand('git', args, { cwd, env });
};
const successful = (result) => {
  assert(!result.timedOut && !result.overflow);
  assert.equal(result.exitCode, 0, result.stderr.slice(-1000));
};
const httpsProbe = (path, method = 'GET') => new Promise((complete, reject) => {
  const url = new URL(resource.sourceUrl);
  url.pathname = path;
  const req = request(url, { method, ca: readFileSync(resource.caPath), rejectUnauthorized: true,
    agent: false, timeout: 3000 }, (response) => {
    response.resume();
    response.once('end', () => complete(response.statusCode));
  });
  req.once('error', reject);
  req.once('timeout', () => req.destroy(new Error('Scoped HTTPS probe timed out')));
  req.end();
});

try {
  resource = await createCapabilitiesGitResource(privateRoot, token);
  assert.equal(resource.globalGitAudit.safe, true);
  check('ordinary-git-configuration-readonly-preflight', resource.globalGitAudit);
  const repositoryPrefix = `/${resource.marketplaceName}.git`;
  assert.equal(new URL(resource.sourceUrl).pathname, repositoryPrefix);
  report.resource = { sourceUrl: resource.sourceUrl, caPath: resource.caPath,
    pluginName: resource.pluginName, marketplaceName: resource.marketplaceName,
    pluginRelativePath: resource.pluginRelativePath, initialCommit: resource.initialCommit,
    caSha256: sha(readFileSync(resource.caPath)) };
  const rejectedClone = join(privateRoot, 'untrusted-clone');
  const untrusted = await git(['clone', '--depth', '1', '--', resource.sourceUrl, rejectedClone]);
  assert(!untrusted.timedOut && !untrusted.overflow && untrusted.exitCode !== 0);
  assert(/(?:certificate|issuer|SSL|TLS|trust)/i.test(untrusted.stderr), 'Expected actual TLS certificate rejection');
  assert(!existsSync(join(rejectedClone, '.git')), 'Untrusted clone unexpectedly created a usable repository');
  check('untrusted-ca-rejected', { exitCode: untrusted.exitCode, rejectedByTls: true,
    diagnostic: untrusted.stderr.trim().slice(-1000) });
  const clone = join(privateRoot, 'trusted-clone');
  const cloneResult = await git(['clone', '--depth', '1', '--', resource.sourceUrl, clone], { trusted: true });
  successful(cloneResult);
  const firstHead = await git(['rev-parse', 'HEAD'], { trusted: true, cwd: clone });
  successful(firstHead);
  assert.equal(firstHead.stdout.trim(), resource.initialCommit);
  const manifestPath = join(clone, resource.pluginRelativePath, 'plugin.json');
  const readManifest = () => JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.equal(readManifest().name, resource.pluginName);
  assert.equal(readManifest().version, '1.0.0');
  const index = JSON.parse(readFileSync(join(clone, '.echo-agent-plugin/marketplace.json'), 'utf8'));
  assert.equal(index.name, resource.marketplaceName);
  assert.equal(index.plugins.length, 1);
  assert.equal(index.plugins[0].source.path, `./${resource.pluginRelativePath}`);
  const fixturePaths = ['.echo-agent-plugin/marketplace.json', `${resource.pluginRelativePath}/plugin.json`,
    `${resource.pluginRelativePath}/skills/fixture-notes/SKILL.md`];
  const tracked = await git(['ls-files', '-z'], { cwd: clone });
  successful(tracked);
  assert.deepEqual(tracked.stdout.split('\0').filter(Boolean).sort(), [...fixturePaths].sort());
  const attributes = await git(['check-attr', '-z', 'filter', '--', ...fixturePaths], { cwd: clone });
  successful(attributes);
  const fields = attributes.stdout.split('\0');
  assert.equal(fields.pop(), '');
  assert.equal(fields.length, 9);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(fields[i * 3], fixturePaths[i]);
    assert.equal(fields[i * 3 + 1], 'filter');
    assert(['unspecified', 'unset'].includes(fields[i * 3 + 2]));
  }
  check('trusted-ca-clone-v1', { actualHead: firstHead.stdout.trim(), version: readManifest().version,
    manifestSha256: sha(readFileSync(manifestPath)), smartHttpsGit: true,
    trackedFiles: 3, effectiveCheckoutFilters: 0 });
  const rejectedWrite = await httpsProbe(`${repositoryPrefix}/git-receive-pack`, 'POST');
  assert.equal(rejectedWrite, 403);
  const rejectedPath = await httpsProbe('/unowned-repository.git/info/refs');
  assert.equal(rejectedPath, 404);
  check('read-only-and-path-scope', { receivePackStatus: rejectedWrite, unownedPathStatus: rejectedPath });
  resource.setTemporarilyUnavailable(true);
  const beforeFailureHead = firstHead.stdout.trim();
  const failedFetch = await git(['fetch', '--depth', '1', '--', 'origin', 'main'], { trusted: true, cwd: clone });
  assert.notEqual(failedFetch.exitCode, 0);
  assert(failedFetch.stderr.includes('503'));
  const unchangedHead = await git(['rev-parse', 'HEAD'], { trusted: true, cwd: clone });
  successful(unchangedHead); assert.equal(unchangedHead.stdout.trim(), beforeFailureHead);
  assert(resource.requestsSummary().requests.some(entry => entry.status === 503));
  resource.setTemporarilyUnavailable(false);
  check('owned-http-503-and-safe-recovery', { failedFetchExitCode: failedFetch.exitCode, unchangedHead: beforeFailureHead,
    actualHttp503: true, tlsVerificationDisabled: false });
  const nextCommit = await resource.advanceVersion2();
  assert.equal(await resource.advanceVersion2(), nextCommit, 'Version advance must be idempotent');
  assert.equal(resource.version2Commit, nextCommit);
  assert.notEqual(nextCommit, resource.initialCommit);
  const fetch = await git(['fetch', '--depth', '1', '--', 'origin', 'main'], { trusted: true, cwd: clone });
  successful(fetch);
  const reset = await git(['reset', '--hard', 'FETCH_HEAD'], { trusted: true, cwd: clone });
  successful(reset);
  const secondHead = await git(['rev-parse', 'HEAD'], { trusted: true, cwd: clone });
  successful(secondHead);
  assert.equal(secondHead.stdout.trim(), nextCommit);
  assert.equal(readManifest().version, '2.0.0');
  assert(readFileSync(join(clone, resource.pluginRelativePath, 'skills/fixture-notes/SKILL.md'), 'utf8')
    .includes('版本：2.0.0'));
  check('real-version-two-fetch', { actualHead: nextCommit, previousHead: resource.initialCommit,
    version: readManifest().version, manifestSha256: sha(readFileSync(manifestPath)) });
  const beforeClose = resource.requestsSummary();
  assert.equal(beforeClose.backendFailures, 0);
  assert(beforeClose.requests.some((entry) => entry.method === 'GET'
    && entry.path === `${repositoryPrefix}/info/refs` && entry.status === 200));
  assert(beforeClose.requests.some((entry) => entry.method === 'POST'
    && entry.path === `${repositoryPrefix}/git-upload-pack` && entry.status === 200));
  for (const entry of beforeClose.requests) assert.deepEqual(Object.keys(entry).sort(), ['method', 'path', 'status']);
  await resource.close();
  await resource.close();
  let refusedAfterClose = false;
  try { await httpsProbe(`${repositoryPrefix}/info/refs`); }
  catch (error) { refusedAfterClose = error.code === 'ECONNREFUSED'; }
  assert(refusedAfterClose, 'HTTPS listener is still reachable after close');
  const summary = resource.requestsSummary();
  assert.equal(summary.closed, true);
  assert.equal(summary.activeBackends, 0);
  assert.equal(summary.listening, false);
  check('owned-server-and-backends-closed', { actualConnectionRefused: true, activeBackends: 0 });
  report.requests = summary;
  report.fixture = resource.readFixtureMetadata();
  report.resource.version2Commit = resource.version2Commit;
  report.passed = true;
} catch (error) {
  report.error = { name: error.name, message: error.message.replaceAll(token, '[redacted]') };
  process.exitCode = 1;
} finally {
  if (resource) {
    try { await resource.close(); }
    catch (error) { report.cleanupError = error.message.replaceAll(token, '[redacted]'); report.passed = false; process.exitCode = 1; }
    report.requests = resource.requestsSummary();
  }
  report.finishedAt = new Date().toISOString();
  const serialized = JSON.stringify(report, null, 2) + '\n';
  assert(!serialized.includes(token), 'Refusing to persist the full resource nonce');
  assert(!/-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----/.test(serialized));
  const reportPath = join(evidenceRoot, 'preflight.json');
  writeFileSync(reportPath, serialized, { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, checks: checks.length, reportPath,
    nativeApplicationVerified: false }));
}
