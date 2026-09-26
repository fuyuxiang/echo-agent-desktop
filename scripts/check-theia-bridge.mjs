import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const root = resolve(import.meta.dirname, "../vendor/theia-platform");
if (![22, 24].includes(Number(process.versions.node.split(".")[0]))) throw new Error("Theia requires Node 22 or 24");
const result = spawnSync(process.execPath, [resolve(root, "node_modules/typescript/bin/tsc"), "-b", "examples/echo-coding-bridge"], { cwd: root, stdio: "inherit" });
if (result.status !== 0) throw new Error("Theia bridge compilation failed");
