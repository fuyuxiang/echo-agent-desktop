import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { createHash } from "node:crypto";
import { GIT_VSIX_SHA256, GIT_PATCHED_MAIN_SHA256, patchGitBundle, patchGitWindowless, validateGitWindowless } from "./patch-theia-git-windowless.mjs";
import { validateTheiaRuntimePlugin } from "./theia-plugin-validation.mjs";

const root = resolve(import.meta.dirname, "..");
const require = createRequire(join(root, "vendor/theia-platform/dev-packages/cli/package.json"));
const decompress = require("decompress");
const spec = { id: "vscode.git", version: "1.95.3" };
const archive = join(root, "vendor/theia-vsix/vscode.git-1.95.3.vsix");
const hash = value => createHash("sha256").update(value).digest("hex");
async function fixture(check) {
  const directory = mkdtempSync(join(tmpdir(), "echo-git-windowless-"));
  try { await decompress(archive, directory); await check(directory); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
function loadGit(bundle, platform, failure = false) {
  const calls = [];
  const vscode = {
    CancellationError: class extends Error {},
    Uri: { file: path => ({ scheme: "file", fsPath: path, path, authority: "" }) },
    workspace: { getConfiguration: () => ({ get: (_, fallback) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    Disposable: class { dispose() {} static from() { return new this(); } },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
    l10n: { t: value => value },
  };
  const cp = { spawn(executable, args, options) {
    calls.push({ executable, args, options });
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
    process.nextTick(() => {
      if (failure) { child.emit("error", Object.assign(new Error("spawn denied"), { code: "EACCES" })); return; }
      child.stdout.end(args[0] === "--version" ? "git version 2.47.0\n" : "/fixture");
      child.stderr.end(); child.stdout.emit("close"); child.stderr.emit("close"); child.emit("exit", 0); child.emit("close", 0);
    });
    return child;
  } };
  const context = { exports: {}, require(name) {
    if (name === "vscode") return vscode;
    if (name === "child_process") return cp;
    return require(name);
  }, process: { ...process, platform }, Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, TextDecoder };
  const bootstrap = "var __webpack_exports__=__webpack_require__(1184),";
  assert.equal(bundle.split(bootstrap).length, 2, "Pinned webpack bootstrap changed");
  // Expose only the existing module loader. All Git methods and spawn calls
  // below execute the REAL shipped module, with its external process mocked.
  runInNewContext(bundle.replace(bootstrap, `globalThis.__gitProbe=__webpack_require__;return;${bootstrap}`), context, { timeout: 3000 });
  const module = context.__gitProbe(693);
  return { module, calls, git: new module.Git({ gitPath: "git", version: "2.47.0", userAgent: "test", env: { BASE: "retained" } }) };
}

test("original VSIX is pinned; patch is idempotent and runtime admission rejects old or altered code", () => fixture(async directory => {
  assert.equal(hash(readFileSync(archive)), GIT_VSIX_SHA256);
  assert.throws(() => validateTheiaRuntimePlugin(directory, spec, ["vscode.git-base"]));
  patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
  const main = join(directory, "extension/dist/main.js"), before = readFileSync(main);
  assert.equal(hash(before), GIT_PATCHED_MAIN_SHA256);
  patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
  assert.deepEqual(readFileSync(main), before);
  validateTheiaRuntimePlugin(directory, spec, ["vscode.git-base"]);
  writeFileSync(main, `${before}\n// tampered`);
  assert.throws(() => validateGitWindowless(directory, spec));
  assert.throws(() => patchGitWindowless(directory, spec, GIT_VSIX_SHA256));
}));

test("unsupported archive, version, source and provenance fail explicitly", () => fixture(directory => {
  assert.throws(() => patchGitWindowless(directory, spec, "0".repeat(64)), /input hash/);
  assert.throws(() => patchGitWindowless(directory, { ...spec, version: "1.96.0" }, GIT_VSIX_SHA256), /version/);
  assert.throws(() => patchGitBundle("changed executable"), /SHA-256/);
  patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
  writeFileSync(join(directory, "extension/echoagent-windowless-patch.json"), "{}");
  assert.throws(() => patchGitWindowless(directory, spec, GIT_VSIX_SHA256));
}));

test("runtime cannot load another entry while keeping a patched main.js as a decoy", () => fixture(directory => {
  patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
  const path = join(directory, "extension/package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  manifest.main = "./dist/askpass-main";
  writeFileSync(path, JSON.stringify(manifest));
  assert.throws(() => validateTheiaRuntimePlugin(directory, spec, ["vscode.git-base"]), /entry changed/);
}));

for (const platform of ["win32", "darwin", "linux"]) {
  test(`real Git version and repository discovery preserve arguments and hide only on ${platform}`, () => fixture(async directory => {
    patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
    const bundle = readFileSync(join(directory, "extension/dist/main.js"), "utf8");
    const { module, git, calls } = loadGit(bundle, platform);
    const found = await module.findGit(["git"], () => true, { info() {}, warn() {} });
    assert.equal(found.path, "git");
    await git.getRepositoryRoot("/fixture");
    assert.deepEqual(Array.from(calls[0].args), ["--version"]);
    assert.deepEqual(Array.from(calls[1].args), ["rev-parse", "--show-toplevel"]);
    assert.equal(calls[1].options.cwd, "/fixture");
    const signal = new AbortController().signal, stdio = ["pipe", "pipe", "pipe"];
    git.spawn(["status", "--porcelain"], { cwd: "/fixture", env: { CUSTOM: "retained" }, stdio, signal, windowsHide: false });
    const options = calls[2].options;
    assert.equal(options.stdio, stdio); assert.equal(options.signal, signal);
    assert.equal(options.env.CUSTOM, "retained"); assert.equal(options.env.BASE, "retained");
    assert.equal(options.cwd, "/fixture"); assert.equal(options.detached, undefined);
    assert.equal(options.windowsHide, platform === "win32");
    for (const call of calls.slice(0, 2)) assert.equal(call.options?.windowsHide, platform === "win32" ? true : undefined);
  }));
}

test("real Git execution still propagates process startup errors", () => fixture(async directory => {
  patchGitWindowless(directory, spec, GIT_VSIX_SHA256);
  const { git } = loadGit(readFileSync(join(directory, "extension/dist/main.js"), "utf8"), "win32", true);
  await assert.rejects(git.getRepositoryRoot("/fixture"), /spawn denied/);
}));
