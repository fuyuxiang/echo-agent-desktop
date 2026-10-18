import { cleanNativeReviewEnvironment } from "./native-review-isolation.mjs";
// Bounded Git utilities for the private native IDE acceptance journey.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';

// Keep OS HOME unchanged while disabling personal Git config and executable
// overrides. Additional repository safety settings remain per-command arguments.
export function nativeGitProcessEnvironment(extra = {}) {
  const env = { ...cleanNativeReviewEnvironment(process.env) };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) || /^(?:https?|all)_proxy$/i.test(key)
      || /^(?:CURL_CA_BUNDLE|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) delete env[key];
  }
  env.NO_PROXY = '127.0.0.1,localhost,::1';
  env.no_proxy = env.NO_PROXY;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return { ...env, ...extra };
}

export async function runNativeGitCommand(executable, args, options = {}) {
  const { cwd, env = nativeGitProcessEnvironment(), timeoutMs = 30_000 } = options;
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
  const result = await runNativeGitCommand(executable, args, options);
  assert(!result.timedOut && !result.overflow, 'Owned resource tool exceeded its bound');
  assert.equal(result.exitCode, 0, `Owned resource tool failed: ${result.stderr.slice(-2000)}`);
  return result.stdout.trim();
}

// Inspect only the owned repository config with personal/system Git config
// disabled. Never return configuration values, URLs, or command strings.
export async function auditNativeGitConfiguration(sourceUrl, cwd, fixturePaths = []) {
  const summary = { homeReplaced: false, globalConfigReplaced: true,
    inheritedGitConfigOverride: Object.keys(process.env).some((key) => /^GIT_CONFIG(?:_|$)/i.test(key)),
    inheritedTlsOverride: Object.keys(process.env).some((key) => /^(?:GIT_SSL_NO_VERIFY|GIT_SSL_CAINFO|GIT_SSL_CAPATH)$/i.test(key)),
    coreHooksPathConfigured: false, templateDirectoryConfigured: false,
    activeHooks: 0, unknownHooksDirectory: false, templateAttributesConfigured: false,
    unknownAttributesFile: false,
    packObjectsHookConfigured: false, executableFiltersConfigured: 0,
    fixturePathsChecked: 0, effectiveFixtureFilters: 0,
    matchingUrlRewrites: 0, effectiveTlsVerification: false, safe: false };
  const env = nativeGitProcessEnvironment();
  const result = await runNativeGitCommand('git', ['config', '--null', '--list'], { cwd, env });
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
    || (process.platform === 'win32' ? 'NUL' : '/dev/null');
  const expandedAttributes = expandPath(globalAttributes);
  try {
    if (!isAbsolute(expandedAttributes)) summary.unknownAttributesFile = true;
    else if (expandedAttributes !== env.GIT_CONFIG_GLOBAL && existsSync(expandedAttributes)) {
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
  const template = env.GIT_TEMPLATE_DIR || last('init.templatedir');
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
    const attributes = await runNativeGitCommand('git', ['check-attr', '-z', 'filter', '--', ...fixturePaths], { cwd, env });
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
  const ssl = await runNativeGitCommand('git', ['config', '--get-urlmatch', 'http.sslverify', sourceUrl], { cwd, env });
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
