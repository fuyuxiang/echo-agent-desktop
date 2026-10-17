import { DEFAULT_REVIEW_MODEL_ID, seedReviewModel, redactReviewModelSecrets, captureReviewModelLogs } from './lib/native-review-model.mjs';
import { nativeReviewOutput } from './lib/native-review-output.mjs';
import { assertNativeReviewSessionUnlocked } from './lib/native-review-window.mjs';
// Genuine native extension/memory/wall-clock acceptance. Own test resources are
// prepared here; only the production application can create task/run records.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedMcpConfigSha256 } from './lib/native-managed-mcp-config.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { createCapabilitiesGitResource, capabilitiesGitProcessEnvironment } from './lib/capabilities-git-resource.mjs';

export const CAPABILITY_CHECKS = Object.freeze({
  'first-launch': ['cap-isolation', 'cap-model-session', 'cap-memory-seed', 'cap-memory-delete', 'cap-memory-recreate',
    'cap-git-add', 'cap-git-install', 'cap-git-refresh-recovery', 'cap-git-update', 'cap-git-uninstall', 'cap-git-reinstall', 'cap-git-remove',
    'cap-schedule-config', 'cap-schedule-once-due', 'cap-schedule-recurring-first', 'cap-schedule-recurring-second', 'cap-schedule-pause'],
  restart: ['cap-isolation', 'cap-memory-restored', 'cap-git-revoked-restored', 'cap-schedule-restored', 'cap-schedule-reply-restored'],
});
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const within = (root, path) => { const rel = relative(root, path); return rel !== '' && rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
const ordinary = (path, root) => {
  assert(within(root, path), 'Physical evidence escaped the owned home');
  const metadata = lstatSync(path); assert(metadata.isFile() && !metadata.isSymbolicLink(), 'Expected an ordinary evidence file');
  assert.equal(realpathSync(path), path, 'Evidence path is not canonical'); return readFileSync(path);
};
const json = (path, root) => JSON.parse(ordinary(path, root));
const jsonl = (path, root) => ordinary(path, root).toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
export const foreignReadonlySnapshot = () => {
  const root = homedir();
  return ['.claude/settings.json', '.claude/settings.local.json', '.claude/plugins/known_marketplaces.json', '.echo-agent/config.toml']
    .map((name) => {
      const path = join(root, name);
      if (!existsSync(path)) return { path, exists: false };
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        // Readonly compatibility links are valid existing user configuration;
        // retain their exact target identity/content digest without writing it.
        const target = realpathSync(path), bytes = readFileSync(path);
        return { path, exists: true, ordinary: false, symlink: true, canonicalTarget: target, sha256: sha(bytes), size: bytes.length };
      }
      if (!metadata.isFile()) return { path, exists: true, ordinary: false };
      return { path, exists: true, ordinary: true, sha256: sha(readFileSync(path)), size: metadata.size };
    });
};

function privateCompatibilitySourceRevocations() {
  // The product continues read-only compatibility discovery. This new review
  // profile explicitly revokes existing external catalogs so opening Market
  // cannot fetch unrelated remotes or activate their components. HOME and
  // foreign settings remain untouched; only the new Echo TOML is written.
  const external = join(homedir(), '.claude'), identities = new Set();
  const identity = (value) => {
    if (value.includes('://') || value.startsWith('git@')) return value.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    const expanded = value.startsWith('~/') ? join(homedir(), value.slice(2)) : resolve(value);
    return existsSync(expanded) ? realpathSync(expanded) : expanded;
  };
  for (const [name, nested] of [['settings.json', true], ['settings.local.json', true], ['plugins/known_marketplaces.json', false]]) {
    const path = join(external, name);
    if (!existsSync(path)) continue;
    const file = lstatSync(path);
    if (!file.isFile() && !file.isSymbolicLink()) continue;
    let parsed; try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    const entries = nested ? parsed.extraKnownMarketplaces : parsed;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue;
    for (const entry of Object.values(entries)) {
      const source = typeof entry?.source === 'object' ? entry.source : entry;
      let value;
      if (source?.source === 'git') value = source.url;
      else if (source?.source === 'github' && typeof source.repo === 'string') value = `https://github.com/${source.repo}.git`;
      else if (['local', 'directory'].includes(source?.source)) value = source.path;
      if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f]/.test(value)) continue;
      if (value.includes('://')) {
        const url = new URL(value);
        assert(!url.password && (url.protocol === 'ssh:' || !url.username) && !url.search && !url.hash,
          'Refusing to copy credential-bearing external catalog identities into the review profile');
      }
      identities.add(identity(value));
    }
  }
  return [...identities].sort();
}

export function verifyCapabilitiesNativeReport({ report, manifest, phase, pid, startedAt, previousExpected }) {
  assert.equal(report?.version, 1); assert.equal(report.kind, 'capabilities'); assert.equal(report.phase, phase);
  assert.equal(report.nativeContext?.phase, phase); assert.equal(report.nativeContext?.home, manifest.home);
  assert.equal(report.nativeContext?.pid, pid); assert.equal(report.nativeContext?.capabilitiesRequested, true);
  assert.equal(report.nativeContext?.evaluations, 1);
  assert(Number.isFinite(Date.parse(report.finishedAt)) && Date.parse(report.finishedAt) >= startedAt && Date.parse(report.finishedAt) <= Date.now() + 1000,
    'Capabilities report is stale or invalid');
  assert.equal(report.passed, true); assert.deepEqual(report.errors, []);
  assert.equal(report.checks?.length, CAPABILITY_CHECKS[phase].length);
  for (const id of CAPABILITY_CHECKS[phase]) {
    const matches = report.checks.filter((item) => item.id === id);
    assert.equal(matches.length, 1, `Missing/duplicate actual native check ${id}`); assert.equal(matches[0].result, 'passed');
  }
  for (const key of ['defaultHomeChanged', 'timeInjected', 'manualRunRequested', 'externalAccountRequested']) assert.equal(report[key], false);
  if (phase === 'first-launch') {
    const refresh = report.checks.find(item => item.id === 'cap-git-refresh-recovery').evidence;
    assert.equal(refresh.sourceUrl, manifest.sourceUrl);
    assert.equal(refresh.recovered, true); assert.equal(refresh.retainedInstalledVersion, '1.0.0');
    assert(refresh.failedFeedback.includes('刷新失败：') && refresh.failedFeedback.includes('503'));
    const install = report.checks.find(item => item.id === 'cap-git-install').evidence;
    assert.equal(install.toggle?.disabled?.commandPresent, false);
    assert.equal(install.toggle?.enabled?.commandPresent, true);
    for (const [id, version] of [['cap-git-install', '1.0.0'], ['cap-git-update', '2.0.0']]) {
      const use = report.checks.find(item => item.id === id).evidence.runtimeUse;
      assert.equal(use?.version, version); assert.equal(use.noTools, true);
      assert.equal(use.qualifiedName, `${manifest.pluginName}:fixture-notes`);
      assert.equal(use.source, `plugin:${manifest.pluginName}`);
      assert(['fixture-notes', use.qualifiedName].includes(use.name));
      assert(use.answer.includes(version) && !use.prompt.includes(version));
    }

  }
  const expected = report.expected;
  assert.equal(expected?.version, 1);
  for (const [key, value] of Object.entries(manifest)) assert.deepEqual(expected[key], value, `Fixed manifest ${key} changed`);
  assert(/^[a-zA-Z0-9-]{1,128}$/.test(expected.sessionId));
  assert.equal(expected.automations.length, 2); assert.equal(expected.records.length, 3); assert.equal(expected.plugins.length, 3);
  assert(expected.automations.every((item) => item.status === 'PAUSED' && !item.nextRunAt));
  const once = expected.automations.find((item) => item.scheduleType === 'once');
  const recurring = expected.automations.find((item) => item.scheduleType === 'recurring');
  assert(once && recurring && once.id !== recurring.id);
  for (const task of expected.automations) assert(task.cwds === manifest.cwd && task.modelId === (manifest.modelId ?? DEFAULT_REVIEW_MODEL_ID)
    && task.skills.length === 0 && task.connectorIds.length === 0 && !task.pushToWeChat && task.permissionMode === 'default');
  const onceRuns = expected.records.filter((item) => item.automationId === once.id);
  const recurringRuns = expected.records.filter((item) => item.automationId === recurring.id).sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  assert.equal(onceRuns.length, 1); assert.equal(recurringRuns.length, 2);
  assert.equal(Date.parse(onceRuns[0].scheduledFor), Date.parse(expected.firstDueAt));
  assert.equal(Date.parse(recurringRuns[0].scheduledFor), Date.parse(expected.firstDueAt));
  assert.equal(Date.parse(recurringRuns[1].scheduledFor) - Date.parse(recurringRuns[0].scheduledFor), 3600000);
  assert.equal(new Set(expected.records.map((item) => item.id)).size, 3);
  assert.equal(new Set(expected.records.map((item) => item.sessionId)).size, 3);
  for (const run of expected.records) {
    assert.equal(run.status, 'success'); assert(!run.error && run.sessionId && run.scheduledFor && run.finishedAt);
    assert.equal(run.cwd, manifest.cwd); assert.equal(run.modelId, manifest.modelId ?? DEFAULT_REVIEW_MODEL_ID);
    assert(Date.parse(run.startedAt) >= Date.parse(run.scheduledFor), 'Automatic occurrence started before its real due time');
    const task = expected.automations.find((item) => item.id === run.automationId);
    assert.equal(run.automationName, task.name);
    if (run.automationSnapshot != null) {
      assert.equal(run.automationSnapshot.id, task.id); assert.equal(run.automationSnapshot.prompt, task.prompt);
    }
  }
  if (phase === 'restart') assert.deepEqual(expected, previousExpected, 'Restart changed exact first-launch evidence');
  return expected;
}

export function verifyCapabilitiesInstalledFixture({ home, manifest, installedRoot, version, metadata }) {
  assert(within(join(home, 'installed-plugins'), installedRoot), 'Actual plugin root is outside the owned install directory');
  assert.equal(realpathSync(installedRoot), installedRoot); assert(lstatSync(installedRoot).isDirectory() && !lstatSync(installedRoot).isSymbolicLink());
  const registryPath = join(home, 'installed-plugins', 'registry.json');
  const registry = json(registryPath, home);
  const repos = Object.entries(registry.repos).filter(([, repo]) => repo.marketplace?.source_url_or_path === manifest.sourceUrl
    && repo.marketplace?.plugin_subdir === manifest.pluginRelativePath);
  assert.equal(repos.length, 1, 'Owned registry source provenance is missing/ambiguous');
  const [repoKey, repo] = repos[0];
  assert(within(join(home, 'installed-plugins'), repo.path) && (installedRoot === repo.path || within(repo.path, installedRoot)));
  assert.equal(realpathSync(repo.path), repo.path); assert(!lstatSync(repo.path).isSymbolicLink());
  assert.equal(repo.plugins[manifest.pluginName]?.version, version);
  assert.equal(Object.keys(repo.plugins).length, 1);
  const pluginManifestPath = join(installedRoot, 'plugin.json'), skillPath = join(installedRoot, 'skills', 'fixture-notes', 'SKILL.md');
  const plugin = json(pluginManifestPath, home);
  assert.equal(plugin.name, manifest.pluginName); assert.equal(plugin.version, version);
  assert.equal(sha(ordinary(pluginManifestPath, home)), metadata.manifestSha256, 'Actual installed manifest differs from the Git resource');
  assert.equal(sha(ordinary(skillPath, home)), metadata.skillSha256, 'Actual installed skill differs from the Git resource');
  for (const forbidden of ['hooks', 'hooks.json', '.mcp.json', '.lsp.json', 'agents']) assert(!existsSync(join(installedRoot, forbidden)), 'Unapproved fixture executable component');
  return { repoKey, repositoryPath: repo.path, installedRoot, version, registrySha256: sha(ordinary(registryPath, home)),
    manifestSha256: sha(ordinary(pluginManifestPath, home)), skillSha256: sha(ordinary(skillPath, home)) };
}

export function physicalFinal({ home, manifest, expected, first }) {
  const memoryPath = join(home, 'memory', 'MEMORY.md'), memoryBytes = ordinary(memoryPath, home);
  // The UI creates a note through production memory_append, whose documented
  // normalization trims the submitted note. Actual bytes remain unmodified.
  assert.equal(memoryBytes.toString('utf8'), manifest.memoryRestoredSeed.trim());
  const tasksPath = join(home, 'echoagent-automations.json'), recordsPath = join(home, 'echoagent-automation-records.json');
  const tasks = json(tasksPath, home).automations, records = json(recordsPath, home).records;
  assert.deepEqual([...tasks].sort((a, b) => a.id.localeCompare(b.id)), [...expected.automations].sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual([...records].sort((a, b) => a.id.localeCompare(b.id)), [...expected.records].sort((a, b) => a.id.localeCompare(b.id)));
  const registryPath = join(home, 'installed-plugins', 'registry.json'), registry = json(registryPath, home);
  assert(!Object.values(registry.repos).some((repo) => repo.marketplace?.source_url_or_path === manifest.sourceUrl), 'Source removal left an owned install record');
  for (const plugin of expected.plugins) assert(!existsSync(plugin.root), 'Source removal left its managed plugin files');
  const configPath = join(home, 'config.toml'), config = ordinary(configPath, home).toString('utf8');
  const normalized = manifest.sourceUrl.replace(/\.git$/, '');
  assert(/disabled_sources\s*=/.test(config) && config.includes(JSON.stringify(normalized)), 'Source revocation tombstone did not persist');
  assert(!new RegExp(`git\\s*=\\s*${JSON.stringify(manifest.sourceUrl).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(config), 'Owned native source entry remains configured');
  const extensionRoots = readdirSync(join(home, 'sessions'), { withFileTypes: true }).filter(entry => entry.isDirectory())
    .map(entry => join(home, 'sessions', entry.name, expected.sessionId)).filter(path => existsSync(join(path, 'updates.jsonl')));
  assert.equal(extensionRoots.length, 1, 'Installed skill source session is missing/ambiguous');
  const extensionJournal = ordinary(join(extensionRoots[0], 'updates.jsonl'), home);
  const extensionUpdates = extensionJournal.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    .map(envelope => envelope.params?.update ?? envelope.params);
  const extensionAnswers = extensionUpdates.filter(update => update?.sessionUpdate === 'agent_message_chunk')
    .map(update => update.content?.text ?? '').join('');
  for (const version of ['1.0.0', '2.0.0']) assert(extensionAnswers.includes(version), 'Actual installed skill response/version missing on disk');
  assert(!extensionUpdates.some(update => ['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)), 'Static extension session called a tool');
  const sessions = expected.records.map((run) => {
    const roots = readdirSync(join(home, 'sessions'), { withFileTypes: true }).filter((entry) => entry.isDirectory())
      .map((entry) => join(home, 'sessions', entry.name, run.sessionId)).filter((path) => existsSync(join(path, 'summary.json')));
    assert.equal(roots.length, 1, 'Actual scheduled session directory is ambiguous/missing');
    const root = roots[0], summary = json(join(root, 'summary.json'), home), updates = jsonl(join(root, 'updates.jsonl'), home);
    assert([expected.modelId ?? DEFAULT_REVIEW_MODEL_ID, (expected.modelId ?? DEFAULT_REVIEW_MODEL_ID).split('/').at(-1)].includes(summary.current_model_id));
    const tools = updates.filter((envelope) => ['tool_call', 'tool_call_update'].includes((envelope.params?.update ?? envelope.params)?.sessionUpdate));
    assert.equal(tools.length, 0, 'Actual no-tool scheduled journal contains a tool invocation');
    const journalText = JSON.stringify(updates), task = expected.automations.find((item) => item.id === run.automationId);
    assert(journalText.includes(task.prompt), 'Canonical journal lost the scheduler prompt');
    const reply = task.scheduleType === 'once' ? expected.onceReply : expected.recurringReply;
    assert(journalText.includes(reply), 'Canonical journal lost the actual model reply');
    const { updated_at: resumedAt, ...durableSummary } = summary;
    assert(Number.isFinite(Date.parse(resumedAt)), 'Session summary has no valid real update time');
    return { sessionId: run.sessionId, summarySha256: sha(ordinary(join(root, 'summary.json'), home)),
      summaryUpdatedAt: resumedAt, durableSummary,
      updatesSha256: sha(ordinary(join(root, 'updates.jsonl'), home)), tools: 0, prompt: task.prompt, reply };
  });
  const result = { memoryPath, memorySha256: sha(memoryBytes), memorySize: memoryBytes.length,
    tasksSha256: sha(ordinary(tasksPath, home)), recordsSha256: sha(ordinary(recordsPath, home)),
    registrySha256: sha(ordinary(registryPath, home)), configSha256: sha(Buffer.from(config)),
    extensionJournalSha256: sha(extensionJournal), installedSkillVersionsReplied: ['1.0.0', '2.0.0'],
    configSemanticSha256: managedMcpConfigSha256(configPath), taskCount: tasks.length, recordCount: records.length, sessions };
  if (first) {
    // Production load legitimately persists CurrentModel and updates this one
    // timestamp. Keep raw byte hashes as evidence, compare all other fields.
    const durable = ({ configSha256: _raw, ...value }) => ({ ...value, sessions: value.sessions.map(({ summarySha256: _hash,
      summaryUpdatedAt: _timestamp, ...session }) => session) });
    assert.deepEqual(durable(result), durable(first), 'Restart changed physical memory/config/install/task/run/journal evidence');
    for (const session of result.sessions) {
      const previous = first.sessions.find((item) => item.sessionId === session.sessionId);
      assert(previous && Date.parse(session.summaryUpdatedAt) >= Date.parse(previous.summaryUpdatedAt), 'Restored session update time moved backwards');
    }
  }
  return result;
}

const managed = (child) => {
  const state = { child, ended: false, error: null };
  state.exited = new Promise((accept) => {
    child.once('exit', () => { state.ended = true; accept(); });
    child.once('error', (error) => { state.ended = true; state.error = error; accept(); });
  }); return state;
};
async function terminate(state) {
  if (!state || state.ended) return;
  state.child.kill('SIGTERM'); await Promise.race([state.exited, delay(5000, undefined, { ref: false })]);
  if (!state.ended) { state.child.kill('SIGKILL'); await Promise.race([state.exited, delay(3000, undefined, { ref: false })]); }
}

export async function runNativeCapabilitiesReview({ executable } = {}) {
  assertNativeReviewSessionUnlocked();
  assert.equal(process.platform, 'darwin', 'This review requires an actual macOS native WebView');
  assert(executable, 'Pass the newly built application containing the fixed capabilities factory');
  executable = realpathSync(resolve(executable)); assert(lstatSync(executable).isFile());
  const outputRoot = nativeReviewOutput('native-capabilities', 'NATIVE_CAPABILITIES_REVIEW_OUTPUT');
  mkdirSync(outputRoot, { recursive: true }); const output = mkdtempSync(join(outputRoot, 'run-'));
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'echo-native-review-capabilities-'))); chmodSync(home, 0o700);
  assert.equal(lstatSync(home).mode & 0o777, 0o700); assert(/^echo-native-review-capabilities-[a-zA-Z0-9]+$/.test(basename(home)));
  const cwd = join(home, 'workspaces', 'default'), legacy = join(home, 'empty-legacy');
  mkdirSync(cwd, { recursive: true, mode: 0o700 }); mkdirSync(legacy, { mode: 0o700 }); mkdirSync(join(home, 'memory'), { mode: 0o700 });
  mkdirSync(join(home, 'installed-plugins'), { mode: 0o700 }); mkdirSync(join(home, 'marketplace-cache'), { mode: 0o700 });
  const token = randomBytes(32).toString('hex'), suffix = token.slice(0, 12);
  const memorySeed = `# 隔离全局记忆\n\n仅供本机验收删除的种子 ${suffix}。\n`;
  const memoryRestoredSeed = `# 隔离全局记忆恢复\n\n由真实追加记忆入口重建 ${suffix}。\n`;
  const memoryPath = join(home, 'memory', 'MEMORY.md'); writeFileSync(memoryPath, memorySeed, { flag: 'wx', mode: 0o600 });
  const configPath = join(home, 'config.toml');
  // This is an ordinary explicit application configuration in the new scope:
  // no automatic official network install; legacy credential/hook imports off.
  const revokedCompatSources = privateCompatibilitySourceRevocations();
  writeFileSync(configPath, `[marketplace]\nofficial_marketplace_auto_installed = true\ndisabled_sources = [${revokedCompatSources.map((value) => JSON.stringify(value)).join(', ')}]\n[claude_compat]\nimported = true\n`, { flag: 'wx', mode: 0o600 });
  const modelId = seedReviewModel(home);
  const beforeForeign = foreignReadonlySnapshot();
  const result = { version: 1, kind: 'native-capabilities-driver', passed: false, nativeVerified: false, executable,
    binarySha256: sha(readFileSync(executable)), home, cwd, output, phases: [], errors: [], gitHandoff: null,
    timeInjected: false, manualRunRequested: false, defaultHomeChanged: false, foreignBefore: beforeForeign,
    actualPluginV2: null, compatibilityCatalogRevocations: { count: revokedCompatSources.length,
      identitySha256: revokedCompatSources.map((value) => sha(Buffer.from(value))), scope: 'new private Echo profile only', foreignFilesWritten: false } };
  let resource, active, interrupted = false, expected, firstFilesystem;
  const interrupt = () => { interrupted = true; active?.child.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    resource = await createCapabilitiesGitResource(home, token);
    const initialMetadata = resource.readFixtureMetadata();
    assert.equal(initialMetadata.version, '1.0.0');
    const manifest = { schema: 1, modelId, home, cwd, token, sourceUrl: resource.sourceUrl, caPath: resource.caPath,
      pluginName: resource.pluginName, marketplaceName: resource.marketplaceName, pluginRelativePath: resource.pluginRelativePath,
      initialCommit: resource.initialCommit, memorySeed, memorySeedSHA256: sha(Buffer.from(memorySeed)), memoryRestoredSeed };
    const manifestPath = join(cwd, 'capabilities-fixture.json'); writeFileSync(manifestPath, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    result.manifestSha256 = sha(ordinary(manifestPath, home)); result.resource = { sourceUrl: resource.sourceUrl,
      caPath: resource.caPath, caSha256: sha(ordinary(resource.caPath, home)), initialCommit: resource.initialCommit,
      tlsVerificationDisabled: false, remoteType: 'standard git-http-backend smart HTTPS upload-pack only', fixtureHasExecutableHooks: false,
      globalGitAudit: resource.globalGitAudit };
    const launchEnv = capabilitiesGitProcessEnvironment({ GROK_HOME: legacy, GIT_SSL_CAINFO: resource.caPath,
      ECHO_DESKTOP_REVIEW: '1', ECHO_DESKTOP_REVIEW_CAPABILITIES: '1', ECHO_DESKTOP_REVIEW_EXTENDED: '0', ECHO_DESKTOP_REVIEW_MEDIA: '0' });
    for (const name of Object.keys(launchEnv)) if ((name.startsWith('ECHO_DESKTOP_REVIEW_') && !['ECHO_DESKTOP_REVIEW_CAPABILITIES', 'ECHO_DESKTOP_REVIEW_EXTENDED', 'ECHO_DESKTOP_REVIEW_MEDIA'].includes(name))
      || ['ECHO_AGENT_HOME', 'ECHO_DESKTOP_VALIDATION', 'ECHO_THEIA_NODE', 'NODE_OPTIONS', 'NODE_PATH'].includes(name)) delete launchEnv[name];
    assert.equal(launchEnv.HOME, process.env.HOME, 'HOME must remain the real inherited environment');
    assert(!Object.hasOwn(launchEnv, 'GIT_CONFIG_GLOBAL'), 'Do not replace global Git configuration to manufacture isolation');
    const reportPath = join(home, 'native-review.json'), historyPath = join(home, 'native-review-history.jsonl');
    for (const phase of ['first-launch', 'restart']) {
      assert(!interrupted, 'Owned capabilities review interrupted');
      if (phase === 'restart') writeFileSync(join(cwd, '.capabilities-restart-expected.json'), JSON.stringify(expected), { flag: 'wx', mode: 0o600 });
      if (existsSync(reportPath)) unlinkSync(reportPath);
      const oldHistory = existsSync(historyPath) ? jsonl(historyPath, home) : [], startedAt = Date.now();
      active = managed(spawn(executable, ['--data-home', home], { env: { ...launchEnv, ECHO_DESKTOP_REVIEW_PHASE: phase }, stdio: ['ignore', 'pipe', 'pipe'] }));
      const logs = captureReviewModelLogs(active.child, join(output, `${phase}.log`));
      let lastProgress = 0, handoffHandled = phase === 'restart', v2Observed = phase === 'restart';
      const availabilityHandled = new Set();
      try {
        while (!active.ended && Date.now() - startedAt < (phase === 'first-launch' ? 80 * 60 * 1000 : 180000)) {
          if (phase === 'first-launch') for (const mode of ['fail', 'recover']) {
            const path = join(cwd, `.capabilities-git-${mode}.json`);
            if (availabilityHandled.has(mode) || !existsSync(path)) continue;
            const request = json(path, home);
            assert.deepEqual(request, { schema: 1, token, sourceUrl: manifest.sourceUrl, mode });
            if (mode === 'recover') {
              assert(availabilityHandled.has('fail'));
              assert(resource.requestsSummary().requests.some(item => item.status === 503), 'No actual failed Git request observed');
            }
            resource.setTemporarilyUnavailable(mode === 'fail');
            writeFileSync(join(cwd, `.capabilities-git-${mode}-ack.json`), JSON.stringify(request), { flag: 'wx', mode: 0o600 });
            availabilityHandled.add(mode);
            result.refreshFailureResource = { unavailableRequested: availabilityHandled.has('fail'), recovered: availabilityHandled.has('recover'),
              http503Count: resource.requestsSummary().requests.filter(item => item.status === 503).length };
          }
          if (!handoffHandled && existsSync(join(cwd, '.capabilities-git-update.json'))) {
            const handoff = json(join(cwd, '.capabilities-git-update.json'), home);
            assert.deepEqual(Object.keys(handoff).sort(), ['schema', 'token', 'sourceUrl', 'pluginName', 'initialCommit', 'installedRoot'].sort());
            assert.equal(handoff.schema, 1); assert.equal(handoff.token, token); assert.equal(handoff.sourceUrl, manifest.sourceUrl);
            assert.equal(handoff.pluginName, manifest.pluginName); assert.equal(handoff.initialCommit, manifest.initialCommit);
            const actualV1 = verifyCapabilitiesInstalledFixture({ home, manifest, installedRoot: handoff.installedRoot, version: '1.0.0', metadata: initialMetadata });
            const commit = await resource.advanceVersion2(); const metadataV2 = resource.readFixtureMetadata();
            assert.equal(metadataV2.version, '2.0.0');
            const ackPath = join(cwd, '.capabilities-git-update-ack.json');
            writeFileSync(ackPath, JSON.stringify({ schema: 1, token, sourceUrl: manifest.sourceUrl, commit }), { mode: 0o600, flag: 'wx' });
            result.gitHandoff = { observedAt: new Date().toISOString(), actualV1, commit, metadataV2, acknowledgementType: 'test HTTPS resource version advance only; never a production install ACK' };
            writeFileSync(join(output, 'actual-plugin-v1-before-resource-update.json'), JSON.stringify(result.gitHandoff, null, 2)); handoffHandled = true;
          }
          if (!v2Observed && existsSync(join(cwd, '.capabilities-git-v2.json'))) {
            assert(result.gitHandoff && resource.version2Commit, 'V2 observation preceded the real resource advance');
            const handoff = json(join(cwd, '.capabilities-git-v2.json'), home);
            assert.deepEqual(Object.keys(handoff).sort(), ['schema', 'token', 'sourceUrl', 'installedRoot', 'commit'].sort());
            assert.equal(handoff.schema, 1); assert.equal(handoff.token, token); assert.equal(handoff.sourceUrl, manifest.sourceUrl);
            assert.equal(handoff.commit, resource.version2Commit);
            const actualV2 = verifyCapabilitiesInstalledFixture({ home, manifest, installedRoot: handoff.installedRoot,
              version: '2.0.0', metadata: result.gitHandoff.metadataV2 });
            result.actualPluginV2 = { ...actualV2, commit: handoff.commit, observedAt: new Date().toISOString() };
            writeFileSync(join(output, 'actual-plugin-v2-before-uninstall.json'), JSON.stringify(result.actualPluginV2, null, 2));
            writeFileSync(join(cwd, '.capabilities-git-v2-ack.json'), JSON.stringify({ schema: 1, token, installedRoot: handoff.installedRoot,
              commit: handoff.commit, manifestSha256: actualV2.manifestSha256, skillSha256: actualV2.skillSha256 }), { mode: 0o600, flag: 'wx' });
            v2Observed = true;
          }
          if (Date.now() - lastProgress > 30000) {
            lastProgress = Date.now();
            const snapshotPath = join(home, 'echoagent-automation-records.json');
            const records = existsSync(snapshotPath) ? json(snapshotPath, home).records.map((item) => ({ id: item.id, status: item.status,
              scheduledFor: item.scheduledFor, startedAt: item.startedAt, finishedAt: item.finishedAt })) : [];
            const progress = { at: new Date().toISOString(), phase, pid: active.child.pid, elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000),
              appExited: active.ended, actualAutomaticRecords: records, gitResourceAdvanced: Boolean(resource.version2Commit), acceptancePassed: false };
            writeFileSync(join(output, 'progress.json'), JSON.stringify(progress, null, 2)); console.log(JSON.stringify(progress));
          }
          await Promise.race([active.exited, delay(500)]);
        }
        assert(active.ended, 'Native capabilities phase exceeded its genuine wall-clock acceptance deadline');
        if (active.error) throw active.error;
        await logs.finished; assert(!logs.overflow, 'Native capabilities log exceeded limit'); assert(!logs.incomplete, 'Native log pipes did not close after process exit');
        assert.equal(active.child.exitCode, 0, 'Native application did not exit normally');
        assert.equal(active.child.signalCode, null);
        const report = json(reportPath, home); writeFileSync(join(output, `${phase}.json`), redactReviewModelSecrets(readFileSync(reportPath)), { mode: 0o600 });
        result.phases.push({ phase, pid: active.child.pid, exitCode: active.child.exitCode, report });
        const current = verifyCapabilitiesNativeReport({ report, manifest, phase, pid: active.child.pid, startedAt, previousExpected: expected });
        const history = jsonl(historyPath, home); assert.equal(history.length, oldHistory.length + 1); assert.deepEqual(history.slice(0, -1), oldHistory); assert.deepEqual(history.at(-1), report);
        const physical = physicalFinal({ home, manifest, expected: current, first: firstFilesystem });
        writeFileSync(join(output, `${phase}-filesystem.json`), JSON.stringify(physical, null, 2)); result.phases.at(-1).physical = physical;
        assert(result.gitHandoff && result.actualPluginV2 && resource.version2Commit === current.version2Commit,
          'The application did not install/update the physical plugin from the actual v1/v2 Git remote');
        assert(result.refreshFailureResource?.recovered && result.refreshFailureResource.http503Count > 0,
          'Actual Git refresh failure/recovery was not observed by the independent resource');
        assert.deepEqual(foreignReadonlySnapshot(), beforeForeign, 'Native acceptance changed external Claude/default Echo data');
        if (phase === 'first-launch') { expected = current; firstFilesystem = physical; }
      } finally { await terminate(active); await logs.finished; active = undefined; }
    }
    result.nativeVerified = true; result.passed = result.phases.length === 2;
  } catch (error) { result.errors.push(String(error?.message || error).slice(0, 2000)); result.passed = false; }
  finally {
    await terminate(active); process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    if (resource) { await resource.close(); result.requests = resource.requestsSummary(); }
    result.foreignAfter = foreignReadonlySnapshot(); result.defaultHomeChanged = JSON.stringify(result.foreignAfter) !== JSON.stringify(beforeForeign);
    if (result.defaultHomeChanged) { result.errors.push('External application/default Echo files changed'); result.passed = false; }
    writeFileSync(join(output, 'native-capabilities-result.json'), redactReviewModelSecrets(JSON.stringify(result, null, 2)));
  }
  console.log(redactReviewModelSecrets(JSON.stringify({ passed: result.passed, nativeVerified: result.nativeVerified, phases: result.phases.length,
    errors: result.errors, output, home, automaticDueVerified: result.passed, simulatedTime: false, manualRuns: 0 })));
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); assert(args.length === 1 && !args[0].startsWith('--'), 'Usage: node scripts/validate-native-capabilities-review.mjs <new-packaged-executable>');
  const result = await runNativeCapabilitiesReview({ executable: args[0] }); if (!result.passed) process.exitCode = 1;
}
