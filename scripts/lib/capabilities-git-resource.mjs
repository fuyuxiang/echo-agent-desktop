// A real, read-only smart-HTTPS Git remote for isolated native acceptance.
// No user HOME, Git configuration, certificate store, or application data is changed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:https';
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const within = (root, path) => {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel);
};
const digest = (value) => createHash('sha256').update(value).digest('hex');

function ownDirectory(path, parent) {
  assert(within(parent, path), 'Git resource escaped its owned temporary directory');
  assert(!existsSync(path), 'Git resource requires a fresh, non-existing directory');
  mkdirSync(path, { mode: 0o700 });
  assert(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink());
  assert.equal(realpathSync(path), path, 'Git resource directory must be canonical');
}

function ownFile(path, bytes, parent) {
  assert(within(parent, path));
  if (existsSync(path)) {
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    assert.equal(realpathSync(path), path);
  }
  writeFileSync(path, bytes, { mode: 0o600, flag: existsSync(path) ? 'w' : 'wx' });
  assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
  assert.equal(realpathSync(path), path);
  chmodSync(path, 0o600);
}

// Remove inherited Git/TLS overrides and proxies, without replacing HOME or
// GIT_CONFIG_GLOBAL. Git safety settings below are per-command arguments.
export function capabilitiesGitProcessEnvironment(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || /^(?:https?|all)_proxy$/i.test(key)
      || /^(?:CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  env.GIT_TERMINAL_PROMPT = '0';
  return { ...env, ...extra };
}

export async function runCapabilitiesGitCommand(executable, args, options = {}) {
  const { cwd, env = capabilitiesGitProcessEnvironment(), timeoutMs = 30_000 } = options;
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let overflow = false;
  const append = (previous, bytes) => {
    if (Buffer.byteLength(previous) + bytes.length > 256 * 1024) {
      overflow = true;
      child.kill('SIGKILL');
      return previous;
    }
    return previous + bytes.toString('utf8');
  };
  child.stdout.on('data', (bytes) => { stdout = append(stdout, bytes); });
  child.stderr.on('data', (bytes) => { stderr = append(stderr, bytes); });
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const result = await new Promise((complete, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => complete({ exitCode, signal }));
    });
    return { ...result, stdout, stderr, timedOut, overflow };
  } finally { clearTimeout(timer); }
}

async function checked(executable, args, options) {
  const result = await runCapabilitiesGitCommand(executable, args, options);
  assert(!result.timedOut && !result.overflow, 'Owned resource tool exceeded its bound');
  assert.equal(result.exitCode, 0, `Owned resource tool failed: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}

// Read the effective ordinary system/global config, but never return its values,
// URLs, paths, or executable command strings. An unknown executable setting is a
// resource prerequisite failure, rather than something this harness overrides.
export async function auditCapabilitiesGitConfiguration(sourceUrl, cwd, fixturePaths = []) {
  const summary = { homeReplaced: false, globalConfigReplaced: false,
    inheritedGitConfigOverride: Object.keys(process.env).some((key) => /^GIT_CONFIG(?:_|$)/i.test(key)),
    inheritedTlsOverride: Object.keys(process.env).some((key) => /^(?:GIT_SSL_NO_VERIFY|GIT_SSL_CAINFO|GIT_SSL_CAPATH)$/i.test(key)),
    coreHooksPathConfigured: false, templateDirectoryConfigured: false,
    activeHooks: 0, unknownHooksDirectory: false, templateAttributesConfigured: false,
    unknownAttributesFile: false,
    packObjectsHookConfigured: false, executableFiltersConfigured: 0,
    fixturePathsChecked: 0, effectiveFixtureFilters: 0,
    matchingUrlRewrites: 0, effectiveTlsVerification: false, safe: false };
  const env = { ...process.env };
  const result = await runCapabilitiesGitCommand('git', ['config', '--null', '--list'], { cwd, env });
  assert.equal(result.exitCode, 0, 'Cannot read the effective Git configuration safely');
  assert(!result.timedOut && !result.overflow, 'Git configuration inspection exceeded its limit');
  const entries = result.stdout.split('\0').filter(Boolean).map((entry) => {
    const separator = entry.indexOf('\n');
    return { key: (separator < 0 ? entry : entry.slice(0, separator)).toLowerCase(),
      value: separator < 0 ? '' : entry.slice(separator + 1) };
  });
  const last = (key) => entries.filter((entry) => entry.key === key).at(-1)?.value;
  const expandPath = (path) => path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
  const inspectHooks = (directory) => {
    const expanded = expandPath(directory);
    // A relative externally configured hooks location has repository-dependent
    // semantics; it cannot be approved by inspecting a different working dir.
    if (!isAbsolute(expanded)) { summary.unknownHooksDirectory = true; return; }
    try {
      if (!existsSync(expanded)) return;
      if (!lstatSync(expanded).isDirectory() || lstatSync(expanded).isSymbolicLink()) {
        summary.unknownHooksDirectory = true;
        return;
      }
      for (const name of readdirSync(expanded)) {
        if (name.endsWith('.sample')) continue;
        const item = lstatSync(join(expanded, name));
        if (item.isSymbolicLink()) summary.unknownHooksDirectory = true;
        else if (item.isFile() && (item.mode & 0o111) !== 0) summary.activeHooks += 1;
      }
    } catch { summary.unknownHooksDirectory = true; }
  };
  const hooks = last('core.hookspath');
  if (hooks !== undefined) { summary.coreHooksPathConfigured = true; inspectHooks(hooks); }
  const globalAttributes = last('core.attributesfile')
    || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'git', 'attributes');
  const expandedAttributes = expandPath(globalAttributes);
  try {
    if (!isAbsolute(expandedAttributes)) summary.unknownAttributesFile = true;
    else if (existsSync(expandedAttributes)) {
      summary.unknownAttributesFile = !lstatSync(expandedAttributes).isFile()
        || lstatSync(expandedAttributes).isSymbolicLink()
        || realpathSync(expandedAttributes) !== expandedAttributes;
    }
  } catch { summary.unknownAttributesFile = true; }
  const inspectTemplate = (directory) => {
    const expanded = expandPath(directory);
    if (!isAbsolute(expanded)) { summary.unknownHooksDirectory = true; return; }
    inspectHooks(join(expanded, 'hooks'));
    const attributes = join(expanded, 'info', 'attributes');
    try {
      if (!existsSync(attributes)) return;
      const item = lstatSync(attributes);
      summary.templateAttributesConfigured = item.isSymbolicLink() || !item.isFile() || item.size !== 0;
    } catch { summary.templateAttributesConfigured = true; }
  };
  const template = process.env.GIT_TEMPLATE_DIR || last('init.templatedir');
  if (template !== undefined) {
    summary.templateDirectoryConfigured = true;
    inspectTemplate(template);
  } else {
    const execPath = await checked('git', ['--exec-path'], { cwd, env });
    inspectTemplate(join(dirname(dirname(execPath)), 'share', 'git-core', 'templates'));
  }
  summary.packObjectsHookConfigured = entries.some((entry) => entry.key === 'uploadpack.packobjectshook' && entry.value !== '');
  summary.executableFiltersConfigured = entries.filter((entry) => /^filter\..+\.(?:clean|smudge|process)$/.test(entry.key)
    && entry.value !== '').length;
  if (fixturePaths.length !== 0) {
    assert.equal(fixturePaths.length, 3, 'Filter applicability proof requires all three fixed fixture files');
    for (const path of fixturePaths) {
      assert(!isAbsolute(path) && !path.split('/').includes('..'));
      const file = join(cwd, path);
      assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink());
      assert.equal(realpathSync(file), file);
    }
    const attributes = await runCapabilitiesGitCommand('git', ['check-attr', '-z', 'filter', '--', ...fixturePaths], { cwd, env });
    assert.equal(attributes.exitCode, 0, 'Cannot establish fixed fixture filter applicability');
    assert(!attributes.timedOut && !attributes.overflow);
    const fields = attributes.stdout.split('\0');
    assert.equal(fields.pop(), '');
    assert.equal(fields.length, fixturePaths.length * 3);
    for (let index = 0; index < fixturePaths.length; index += 1) {
      assert.equal(fields[index * 3], fixturePaths[index]);
      assert.equal(fields[index * 3 + 1], 'filter');
      summary.fixturePathsChecked += 1;
      if (!['unspecified', 'unset'].includes(fields[index * 3 + 2])) summary.effectiveFixtureFilters += 1;
    }
  }
  summary.matchingUrlRewrites = entries.filter((entry) => /^url\..+\.insteadof$/.test(entry.key)
    && sourceUrl.startsWith(entry.value)).length;
  const ssl = await runCapabilitiesGitCommand('git', ['config', '--get-urlmatch', 'http.sslverify', sourceUrl], { cwd, env });
  assert(!ssl.timedOut && !ssl.overflow && [0, 1].includes(ssl.exitCode), 'Cannot establish effective Git TLS verification');
  summary.effectiveTlsVerification = ssl.exitCode === 1 || /^(?:true|yes|on|1)$/i.test(ssl.stdout.trim());
  summary.safe = !summary.inheritedGitConfigOverride && !summary.inheritedTlsOverride
    && summary.activeHooks === 0 && !summary.unknownHooksDirectory
    && !summary.templateAttributesConfigured && !summary.unknownAttributesFile
    && !summary.packObjectsHookConfigured
    && (summary.executableFiltersConfigured === 0 || (summary.fixturePathsChecked === 3 && summary.effectiveFixtureFilters === 0))
    && summary.matchingUrlRewrites === 0 && summary.effectiveTlsVerification;
  return summary;
}

/**
 * privateRoot must be a canonical, ordinary 0700 echo-native-review-capabilities-*
 * directory directly below the system temporary directory. token is an instance
 * nonce; only its first 12 hex characters form unique, legal plugin identifiers.
 */
export async function createCapabilitiesGitResource(privateRoot, token) {
  assert.equal(typeof privateRoot, 'string');
  assert.equal(resolve(privateRoot), privateRoot);
  assert.equal(realpathSync(privateRoot), privateRoot, 'Private Git scope must be canonical');
  assert(lstatSync(privateRoot).isDirectory() && !lstatSync(privateRoot).isSymbolicLink());
  assert.equal(lstatSync(privateRoot).mode & 0o777, 0o700, 'Private Git scope requires mode 0700');
  assert.equal(resolve(privateRoot, '..'), realpathSync(tmpdir()), 'Private Git scope must be a direct temporary child');
  assert(/^echo-native-review-capabilities-[a-zA-Z0-9]+$/.test(basename(privateRoot)));
  assert(typeof token === 'string' && /^(?:[a-f0-9]{32}|[a-f0-9]{64})$/.test(token), 'Invalid resource instance nonce');

  const resourceRoot = join(privateRoot, 'capabilities-git-resource');
  ownDirectory(resourceRoot, privateRoot);
  const pluginName = `echo-capabilities-review-${token.slice(0, 12)}`;
  const marketplaceName = `echo-capabilities-market-${token.slice(0, 12)}`;
  const repositoryName = `${marketplaceName}.git`;
  const repositoryPrefix = `/${repositoryName}`;
  const repository = join(resourceRoot, repositoryName);
  const emptyHooks = join(resourceRoot, 'empty-hooks');
  const emptyTemplate = join(resourceRoot, 'empty-template');
  ownDirectory(emptyHooks, resourceRoot);
  ownDirectory(emptyTemplate, resourceRoot);
  const pluginRelativePath = `plugins/${pluginName}`;
  const gitArgs = ['-c', `core.hooksPath=${emptyHooks}`, '-c', 'commit.gpgsign=false',
    '-c', 'user.name=EchoAgent Local Review', '-c', 'user.email=review@example.invalid'];
  const git = (args, cwd = resourceRoot) => checked('git', [...gitArgs, ...args], { cwd });
  await git(['init', '--initial-branch=main', `--template=${emptyTemplate}`, repository]);
  await git(['config', '--local', 'http.receivepack', 'false'], repository);
  await git(['config', '--local', 'http.uploadpack', 'true'], repository);
  ownDirectory(join(repository, '.echo-agent-plugin'), resourceRoot);
  ownDirectory(join(repository, 'plugins'), resourceRoot);
  ownDirectory(join(repository, pluginRelativePath), resourceRoot);
  ownDirectory(join(repository, pluginRelativePath, 'skills'), resourceRoot);
  ownDirectory(join(repository, pluginRelativePath, 'skills', 'fixture-notes'), resourceRoot);
  const marketplaceIndex = join(repository, '.echo-agent-plugin', 'marketplace.json');
  const pluginManifest = join(repository, pluginRelativePath, 'plugin.json');
  const skill = join(repository, pluginRelativePath, 'skills', 'fixture-notes', 'SKILL.md');
  const fixturePaths = ['.echo-agent-plugin/marketplace.json', `${pluginRelativePath}/plugin.json`,
    `${pluginRelativePath}/skills/fixture-notes/SKILL.md`];
  let version = '1.0.0';
  let version2Commit = null;
  let version2Advance;
  const writeVersion = (next) => {
    ownFile(marketplaceIndex, JSON.stringify({ name: marketplaceName,
      description: '受控本机 HTTPS Git 插件验收资源', owner: { name: 'EchoAgent Local Review' },
      plugins: [{ name: pluginName, version: next, description: '仅静态说明，无工具或运行钩子',
        category: 'productivity', source: { type: 'local', path: `./${pluginRelativePath}` },
        tags: ['local-acceptance'] }] }, null, 2) + '\n', resourceRoot);
    ownFile(pluginManifest, JSON.stringify({ name: pluginName, version: next,
      description: '本机功能验收静态技能', author: { name: 'EchoAgent Local Review' },
      skills: 'skills' }, null, 2) + '\n', resourceRoot);
    ownFile(skill, `---\nname: fixture-notes\ndescription: 受控本机插件验收的静态说明\n---\n\n# 本机插件验收\n\n版本：${next}\n\n此技能仅提供静态说明，不运行工具，不访问网络，不修改用户文件。\n`, resourceRoot);
    version = next;
  };
  const commitVersion = async (next) => {
    writeVersion(next);
    // Check attributes before git add can execute any globally configured clean
    // filter. The server repeats this audit with its actual URL before exposure.
    const beforeAdd = await auditCapabilitiesGitConfiguration(`https://127.0.0.1:1${repositoryPrefix}`, repository, fixturePaths);
    assert(beforeAdd.safe, `Ordinary Git configuration is unsafe for this fixture: ${JSON.stringify(beforeAdd)}`);
    await git(['add', '--', ...fixturePaths], repository);
    await git(['commit', '--no-verify', '-m', `Controlled local marketplace ${next}`], repository);
    const tracked = await checked('git', [...gitArgs, 'ls-files', '-z'], { cwd: repository });
    assert.deepEqual(tracked.split('\0').filter(Boolean).sort(), [...fixturePaths].sort(),
      'The controlled repository must contain only the three approved metadata files');
    const commit = await git(['rev-parse', 'HEAD'], repository);
    assert(/^[a-f0-9]{40}$/.test(commit));
    return commit;
  };
  const initialCommit = await commitVersion(version);
  const execPath = await git(['--exec-path']);
  assert(isAbsolute(execPath));
  const backendPath = join(execPath, 'git-http-backend');
  assert(lstatSync(backendPath).isFile(), 'Real git-http-backend is required');

  const caPath = join(resourceRoot, 'ca.crt');
  const caKey = join(resourceRoot, 'ca.key');
  const serverKey = join(resourceRoot, 'server.key');
  const serverCertificate = join(resourceRoot, 'server.crt');
  const serverRequest = join(resourceRoot, 'server.csr');
  const caConfig = join(resourceRoot, 'ca-openssl.cnf');
  const serverConfig = join(resourceRoot, 'server-openssl.cnf');
  ownFile(caConfig, '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca_ext\n[dn]\nCN=EchoAgent Controlled Local Review CA\n[ca_ext]\nbasicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n', resourceRoot);
  ownFile(serverConfig, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=server_ext\n[dn]\nCN=127.0.0.1\n[server_ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n', resourceRoot);
  await checked('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-config', caConfig, '-keyout', caKey, '-out', caPath], { cwd: resourceRoot });
  await checked('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-config', serverConfig,
    '-keyout', serverKey, '-out', serverRequest], { cwd: resourceRoot });
  await checked('openssl', ['x509', '-req', '-in', serverRequest, '-CA', caPath, '-CAkey', caKey,
    '-CAcreateserial', '-CAserial', join(resourceRoot, 'ca.srl'), '-days', '2',
    '-extensions', 'server_ext', '-extfile', serverConfig, '-out', serverCertificate], { cwd: resourceRoot });
  for (const path of [caPath, caKey, serverKey, serverCertificate, serverRequest, join(resourceRoot, 'ca.srl')]) {
    assert(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink());
    assert.equal(realpathSync(path), path);
    chmodSync(path, 0o600);
  }

  const ledgerPath = join(resourceRoot, 'requests.redacted.jsonl');
  ownFile(ledgerPath, '', resourceRoot);
  const requests = [];
  const activeBackends = new Map();
  const sockets = new Set();
  let closing = false;
  let temporarilyUnavailable = false;
  let tlsHandshakeRejections = 0;
  let backendFailures = 0;
  let closePromise;
  const server = createServer({ key: readFileSync(serverKey), cert: readFileSync(serverCertificate),
    minVersion: 'TLSv1.2' }, (req, res) => {
    let audited = false;
    const auditPath = [`${repositoryPrefix}/info/refs`, `${repositoryPrefix}/git-upload-pack`,
      `${repositoryPrefix}/git-receive-pack`].includes(req.url?.split('?')[0])
      ? req.url.split('?')[0] : '<rejected>';
    const method = ['GET', 'POST', 'HEAD', 'PUT', 'DELETE', 'OPTIONS'].includes(req.method) ? req.method : 'OTHER';
    const audit = (status) => {
      if (audited) return;
      audited = true;
      const entry = { method, path: auditPath, status };
      requests.push(entry);
      appendFileSync(ledgerPath, JSON.stringify(entry) + '\n');
    };
    res.once('finish', () => audit(res.statusCode));
    res.once('close', () => audit(res.writableFinished ? res.statusCode : 499));
    const reject = (status, message) => {
      req.resume();
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(message);
    };
    if (closing) return reject(503, 'Owned resource is closing.');
    const discovery = req.method === 'GET' && req.url === `${repositoryPrefix}/info/refs?service=git-upload-pack`;
    const upload = req.method === 'POST' && req.url === `${repositoryPrefix}/git-upload-pack`;
    if (!discovery && !upload) {
      return reject(auditPath === `${repositoryPrefix}/git-receive-pack`
        || req.url === `${repositoryPrefix}/info/refs?service=git-receive-pack` ? 403 : 404,
      'Only read-only smart Git upload-pack is available.');
    }
    if (temporarilyUnavailable) return reject(503, 'Owned Git test resource temporarily unavailable.');
    if (upload && req.headers['content-type'] !== 'application/x-git-upload-pack-request') {
      return reject(415, 'Expected a Git upload-pack request.');
    }
    const contentLength = req.headers['content-length'];
    if (contentLength != null && (!/^\d+$/.test(contentLength) || Number(contentLength) > 1024 * 1024)) {
      return reject(413, 'Owned resource request exceeded its limit.');
    }
    const protocol = req.headers['git-protocol'];
    if (protocol != null && (typeof protocol !== 'string' || !/^version=[12]$/.test(protocol))) {
      return reject(400, 'Unsupported Git protocol declaration.');
    }
    const env = capabilitiesGitProcessEnvironment({ GIT_PROJECT_ROOT: resourceRoot,
      GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method,
      PATH_INFO: discovery ? `${repositoryPrefix}/info/refs` : `${repositoryPrefix}/git-upload-pack`,
      QUERY_STRING: discovery ? 'service=git-upload-pack' : '',
      CONTENT_TYPE: upload ? 'application/x-git-upload-pack-request' : '',
      ...(contentLength != null ? { CONTENT_LENGTH: contentLength } : {}),
      ...(protocol ? { HTTP_GIT_PROTOCOL: protocol } : {}) });
    const child = spawn(backendPath, [], { cwd: resourceRoot, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const exited = new Promise((complete) => child.once('close', complete));
    activeBackends.set(child, exited);
    let headers = Buffer.alloc(0);
    let parsed = false;
    let requestBytes = 0;
    const timer = setTimeout(() => { child.kill('SIGKILL'); res.destroy(); }, 30_000);
    child.stdin.on('error', () => {});
    child.stderr.resume();
    req.on('data', (bytes) => {
      requestBytes += bytes.length;
      if (requestBytes > 1024 * 1024) { child.kill('SIGKILL'); res.destroy(); }
    });
    req.once('aborted', () => child.kill('SIGKILL'));
    res.once('close', () => { if (!res.writableFinished) child.kill('SIGKILL'); });
    child.once('error', () => {
      backendFailures += 1;
      if (!res.headersSent) reject(500, 'Owned Git backend failed to start.');
      else res.destroy();
    });
    child.stdout.on('data', (bytes) => {
      if (parsed) { res.write(bytes); return; }
      headers = Buffer.concat([headers, bytes]);
      let boundary = headers.indexOf('\r\n\r\n');
      let width = 4;
      if (boundary < 0) { boundary = headers.indexOf('\n\n'); width = 2; }
      if (boundary < 0) {
        if (headers.length > 32 * 1024) { child.kill('SIGKILL'); reject(502, 'Invalid Git backend headers.'); }
        return;
      }
      const responseHeaders = {};
      let status = 200;
      for (const line of headers.subarray(0, boundary).toString('ascii').split(/\r?\n/)) {
        const separator = line.indexOf(':');
        if (separator < 0) continue;
        const key = line.slice(0, separator).toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (key === 'status' && /^[1-5]\d\d(?:\s|$)/.test(value)) status = Number(value.slice(0, 3));
        else if (['content-type', 'cache-control', 'pragma', 'expires'].includes(key)) responseHeaders[key] = value;
      }
      parsed = true;
      res.writeHead(status, responseHeaders);
      res.write(headers.subarray(boundary + width));
      headers = Buffer.alloc(0);
    });
    child.stdout.once('end', () => { if (parsed) res.end(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      activeBackends.delete(child);
      if (code !== 0 && !closing) backendFailures += 1;
      if (!parsed && !res.headersSent) reject(502, 'Owned Git backend returned no response.');
    });
    req.pipe(child.stdin);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('tlsClientError', () => { tlsHandshakeRejections += 1; });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  await new Promise((complete, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', complete);
  });
  const address = server.address();
  assert(address && typeof address !== 'string' && address.address === '127.0.0.1');
  const sourceUrl = `https://127.0.0.1:${address.port}${repositoryPrefix}`;

  const close = () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closing = true;
      const stopped = new Promise((complete) => server.close(complete));
      for (const child of activeBackends.keys()) child.kill('SIGTERM');
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      const pending = [...activeBackends.entries()];
      await Promise.race([Promise.all(pending.map(([, exited]) => exited)), delay(1500)]);
      for (const [child] of pending) if (activeBackends.has(child)) child.kill('SIGKILL');
      await Promise.race([Promise.all(pending.map(([, exited]) => exited)), delay(1500)]);
      await stopped;
      assert.equal(activeBackends.size, 0, 'Owned Git backend did not exit');
    })();
    return closePromise;
  };
  let globalGitAudit;
  try {
    globalGitAudit = await auditCapabilitiesGitConfiguration(sourceUrl, repository, fixturePaths);
    assert(globalGitAudit.safe,
      `Ordinary Git configuration is unsafe for this acceptance scope: ${JSON.stringify(globalGitAudit)}`);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    sourceUrl, caPath, pluginName, marketplaceName, pluginRelativePath, initialCommit, globalGitAudit,
    get version2Commit() { return version2Commit; },
    setTemporarilyUnavailable(value) {
      assert(typeof value === 'boolean' && !closing, 'Invalid owned Git resource availability');
      temporarilyUnavailable = value;
    },
    async advanceVersion2() {
      assert(!closing, 'Cannot update a closed Git resource');
      if (version2Commit) return version2Commit;
      if (!version2Advance) version2Advance = commitVersion('2.0.0').then((commit) => {
        version2Commit = commit;
        assert.notEqual(version2Commit, initialCommit);
        return version2Commit;
      });
      return version2Advance;
    },
    close,
    requestsSummary() {
      return { count: requests.length, requests: requests.map((entry) => ({ ...entry })),
        tlsHandshakeRejections, backendFailures, activeBackends: activeBackends.size,
        listening: server.listening, closed: closing && !server.listening && activeBackends.size === 0 };
    },
    readFixtureMetadata() {
      return { version, marketplace: JSON.parse(readFileSync(marketplaceIndex, 'utf8')),
        manifest: JSON.parse(readFileSync(pluginManifest, 'utf8')),
        indexSha256: digest(readFileSync(marketplaceIndex)), manifestSha256: digest(readFileSync(pluginManifest)),
        skillSha256: digest(readFileSync(skill)) };
    },
    ownResourcePaths: Object.freeze({ resourceRoot, repository, marketplaceIndex, pluginManifest, skill,
      emptyHooks, ledgerPath }),
  };
}
