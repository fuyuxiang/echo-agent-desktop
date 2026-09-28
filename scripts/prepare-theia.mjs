import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
import { latestTheiaSourceMtime } from "./theia-source-mtime.mjs";
import { ensureTheiaNodeWritable } from "./ensure-theia-node-writable.mjs";

const root = resolve(import.meta.dirname, "..");
const resources = join(root, "src-tauri/resources/theia");
const runtime = join(resources, "browser/lib/backend/main.js");
const app = JSON.parse(readFileSync(join(root, "vendor/theia-platform/examples/browser/package.json"), "utf8"));
const languagePluginIds = [...Object.keys(app.theiaPlugins ?? {}), "echoagent.toml-basics"];
const languagePluginsReady = languagePluginIds.every(id => {
  try {
    const manifestPath = id === "echoagent.toml-basics" ? "package.json" : "extension/package.json";
    const manifest = JSON.parse(readFileSync(join(resources, "browser/plugins", id, manifestPath), "utf8"));
    return `${manifest.publisher}.${manifest.name}`.toLowerCase() === id.toLowerCase();
  } catch { return false; }
});
const node = process.platform === "win32"
  ? join(resources, "node/node.exe")
  : join(resources, "node/bin/node");
let platform;
try {
  platform = JSON.parse(readFileSync(join(resources, "runtime-platform.json"), "utf8"));
} catch {
  platform = null;
}

if (existsSync(runtime) && existsSync(node) && languagePluginsReady
    && platform?.platform === process.platform && platform?.arch === process.arch
    && platform?.sourceMtimeMs >= latestTheiaSourceMtime(join(root, "vendor/theia-platform"))) {
  ensureTheiaNodeWritable(root, node);
  console.log("Echo Code IDE runtime is already staged.");
  process.exit(0);
}

const major = Number(process.versions.node.split(".")[0]);
if (major !== 22 && major !== 24) {
  throw new Error("Echo Code IDE is validated with Node.js 22 or 24. Select one of those versions and retry.");
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
for (const script of ["ide:build", "ide:stage"]) {
  const result = spawnSync(pnpm, [script], { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed`);
}
