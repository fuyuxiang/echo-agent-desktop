// Standalone Node guard; use the existing test-*.mjs convention so Vitest does
// not mistake this native artifact test for a frontend test suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pinnedTheiaPlugins, validateTheiaPlugin, theiaPluginTreeFingerprint } from "./theia-plugin-validation.mjs";

const source = resolve(import.meta.dirname, "../vendor/theia-platform");
const app = JSON.parse(readFileSync(join(source, "examples/browser/package.json")));
const specs = pinnedTheiaPlugins(app), ids = specs.map(plugin => plugin.id);
const git = specs.find(plugin => plugin.id === "vscode.git");

function fixture(change, check) {
  const root = mkdtempSync(join(tmpdir(), "echo-theia-plugin-guard-"));
  try {
    cpSync(join(source, "plugins/vscode.git"), join(root, "vscode.git"), { recursive: true });
    const directory = join(root, "vscode.git"), path = join(directory, "extension/package.json");
    const manifest = JSON.parse(readFileSync(path));
    change?.({ directory, manifest, path });
    check({ directory, manifest, root });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("official pinned executable Git and Git Base validate without language contributions", () => {
  for (const id of ["vscode.git", "vscode.git-base"]) {
    const spec = specs.find(plugin => plugin.id === id);
    assert.equal(validateTheiaPlugin(join(source, "plugins", id), spec, ids).version, "1.95.3");
  }
});
test("Git is rejected when Git Base is absent from the bundled set", () => {
  assert.throws(() => validateTheiaPlugin(join(source, "plugins/vscode.git"), git, ["vscode.git"]), /dependency/);
});
test("a corrupted Git version is not accepted as an already staged plugin", () => {
  fixture(({ manifest, path }) => { manifest.version = "1.95.2"; writeFileSync(path, JSON.stringify(manifest)); },
    ({ directory }) => assert.throws(() => validateTheiaPlugin(directory, git, ids), /version/));
});
test("missing executable Git entry is rejected", () => {
  fixture(({ directory }) => unlinkSync(join(directory, "extension/dist/main.js")),
    ({ directory }) => assert.throws(() => validateTheiaPlugin(directory, git, ids), /artifact/));
});
test("missing staged Git command rejects the provider contract", () => {
  fixture(({ manifest, path }) => {
    manifest.contributes.commands = manifest.contributes.commands.filter(command => command.command !== "git.stage");
    writeFileSync(path, JSON.stringify(manifest));
  }, ({ directory }) => assert.throws(() => validateTheiaPlugin(directory, git, ids), /commands/));
});
test("a main entry cannot traverse outside its plugin directory", () => {
  fixture(({ manifest, path }) => { manifest.main = "../../unowned.js"; writeFileSync(path, JSON.stringify(manifest)); },
    ({ directory }) => assert.throws(() => validateTheiaPlugin(directory, git, ids), /artifact path/));
});
test("non-Git plugins retain the language and grammar validation", () => {
  fixture(({ manifest, path }) => { manifest.name = "javascript"; writeFileSync(path, JSON.stringify(manifest)); },
    ({ directory }) => assert.throws(() => validateTheiaPlugin(directory, { ...git, id: "vscode.javascript" }, ids), /language/));
});
test("an altered executable changes the prepare-cache fingerprint", () => {
  fixture(null, ({ directory, root }) => {
    const before = theiaPluginTreeFingerprint(root, ["vscode.git"]);
    writeFileSync(join(directory, "extension/dist/main.js"), "// guard deliberately changed owned copy\n");
    assert.notEqual(theiaPluginTreeFingerprint(root, ["vscode.git"]), before);
  });
});
test("plugin registry sources must remain the pinned primary OpenVSX host", () => {
  assert.throws(() => pinnedTheiaPlugins({ theiaPlugins: { "vscode.git": "https://example.com/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix" } }), /pinned/);
});
