import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

// Reconstruct the pinned production graph without building or executing any
// dependency lifecycle. This audits what staging installs, including aliases.
const root = resolve(import.meta.dirname, "..");
const lock = JSON.parse(readFileSync(join(root, "scripts/theia-runtime-package-lock.json"), "utf8"));
const temporary = mkdtempSync(join(tmpdir(), "echo-theia-audit-"));
try {
  cpSync(join(root, "vendor/theia-platform/security"), join(temporary, "security"), { recursive: true });
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (path.split("/").includes("node_modules") || pkg.link) continue;
    const target = resolve(temporary, path);
    if (target !== temporary && !target.startsWith(temporary + "/") && !target.startsWith(temporary + "\\")) throw new Error("Unsafe runtime lock path");
    mkdirSync(target, { recursive: true });
    const manifest = Object.fromEntries(Object.entries(pkg).filter(([key]) =>
      ["name", "version", "private", "workspaces", "dependencies", "optionalDependencies", "peerDependencies", "engines"].includes(key)));
    if (!path) manifest.overrides = JSON.parse(readFileSync(join(root, "vendor/theia-platform/package.json"), "utf8")).overrides;
    writeFileSync(join(target, "package.json"), JSON.stringify(manifest));
  }
  writeFileSync(join(temporary, "package-lock.json"), JSON.stringify(lock));
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["audit", "--json", "--package-lock-only", "--ignore-scripts", "--omit=dev"],
    { cwd: temporary, stdio: "inherit", shell: process.platform === "win32" });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
