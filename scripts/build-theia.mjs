import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22 || major === 23) {
  throw new Error("Eclipse Theia requires Node.js 22 or 24+. Run this command with a supported Node.js on PATH.");
}

const sourceRoot = resolve(import.meta.dirname, "../vendor/theia-platform");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const env = { ...process.env, PUPPETEER_SKIP_DOWNLOAD: "1" };

function run(args) {
  const result = spawnSync(npm, args, { cwd: sourceRoot, env, stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`Theia build failed: npm ${args.join(" ")}`);
  }
}

if (!existsSync(join(sourceRoot, "node_modules"))) run(["ci"]);
run(["run", "compile"]);
run(["run", "build:production", "--workspace", "@echoagent/theia-browser"]);

if (!existsSync(join(sourceRoot, "examples/browser/lib/backend/main.js"))) {
  throw new Error("Theia backend entry point was not produced by the build.");
}
console.log("Echo Code IDE built from vendored Theia source.");
