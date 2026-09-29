import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// node-pty's ConPTY cleanup forks a Node helper when a terminal is closed.
// The Theia backend has no console, so an unhidden helper opens a separate
// Windows console even though the backend itself was started without one.
const expectedVersion = "1.2.0-beta.12";
const originalCall = "child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()])";
const hiddenCall = "child_process_1.fork(path.join(__dirname, 'conpty_console_list_agent'), [_this._innerPid.toString()], { windowsHide: true })";

function paths(browserRoot) {
  const packageRoot = join(browserRoot, "node_modules/node-pty");
  return {
    manifest: join(packageRoot, "package.json"),
    agent: join(packageRoot, "lib/windowsPtyAgent.js"),
  };
}

function occurrences(source, value) {
  return source.split(value).length - 1;
}

export function isNodePtyConsoleHelperHidden(browserRoot) {
  try {
    const { manifest, agent } = paths(browserRoot);
    if (JSON.parse(readFileSync(manifest, "utf8")).version !== expectedVersion) return false;
    const source = readFileSync(agent, "utf8");
    return occurrences(source, hiddenCall) === 1 && occurrences(source, originalCall) === 0;
  } catch {
    return false;
  }
}

export function patchNodePtyConsoleHelper(browserRoot) {
  const { manifest, agent } = paths(browserRoot);
  const version = JSON.parse(readFileSync(manifest, "utf8")).version;
  if (version !== expectedVersion) {
    throw new Error(`Unsupported node-pty version ${version}; review the Windows console helper patch.`);
  }
  const source = readFileSync(agent, "utf8");
  if (occurrences(source, hiddenCall) === 1 && occurrences(source, originalCall) === 0) return;
  if (occurrences(source, originalCall) !== 1 || occurrences(source, hiddenCall) !== 0) {
    throw new Error("node-pty ConPTY helper changed; review its fork call before staging.");
  }
  writeFileSync(agent, source.replace(originalCall, hiddenCall));
  if (!isNodePtyConsoleHelperHidden(browserRoot)) {
    throw new Error("node-pty ConPTY helper patch verification failed.");
  }
}
