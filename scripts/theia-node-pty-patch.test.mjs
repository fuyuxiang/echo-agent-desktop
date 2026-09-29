import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { isNodePtyConsoleHelperHidden, patchNodePtyConsoleHelper } from "./patch-theia-node-pty.mjs";

const temporaryDirectories = [];
const originalCall = "child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])";

function fixture(version = "1.2.0-beta.12", call = originalCall) {
  const browserRoot = mkdtempSync(join(tmpdir(), "echo-node-pty-patch-"));
  temporaryDirectories.push(browserRoot);
  const packageRoot = join(browserRoot, "node_modules/node-pty");
  mkdirSync(join(packageRoot, "lib"), { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ version }));
  writeFileSync(join(packageRoot, "lib/windowsPtyAgent.js"), `var agent = ${call};\n`);
  return browserRoot;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("hides the node-pty console helper and preserves the IPC fork call", () => {
  const browserRoot = fixture();
  expect(isNodePtyConsoleHelperHidden(browserRoot)).toBe(false);
  patchNodePtyConsoleHelper(browserRoot);
  const agent = readFileSync(join(browserRoot, "node_modules/node-pty/lib/windowsPtyAgent.js"), "utf8");
  expect(agent).toContain("[_this._innerPid.toString()], { windowsHide: true })");
  expect(isNodePtyConsoleHelperHidden(browserRoot)).toBe(true);
  patchNodePtyConsoleHelper(browserRoot);
  expect(readFileSync(join(browserRoot, "node_modules/node-pty/lib/windowsPtyAgent.js"), "utf8")).toBe(agent);
});

it("fails staging when the installed node-pty version or helper changes", () => {
  expect(() => patchNodePtyConsoleHelper(fixture("1.2.0"))).toThrow(/Unsupported node-pty version/);
  expect(() => patchNodePtyConsoleHelper(fixture("1.2.0-beta.12", "someOtherFork()"))).toThrow(/helper changed/);
});
