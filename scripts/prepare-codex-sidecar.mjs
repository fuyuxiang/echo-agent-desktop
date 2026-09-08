import { chmodSync, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const targets = {
  "darwin-x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin"],
  "darwin-arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin"],
  "linux-x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl"],
  "linux-arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl"],
  "win32-x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc"],
  "win32-arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc"],
};

const target = targets[`${process.platform}-${process.arch}`];
if (!target) {
  throw new Error(`Codex Runtime does not support ${process.platform}-${process.arch}`);
}

const [platformPackage, triple] = target;
const codexPackageJson = require.resolve("@openai/codex/package.json");
// pnpm keeps optional platform aliases inside the parent package's virtual
// store. Resolve from Codex's own package boundary just like its CLI shim does.
const codexRequire = createRequire(codexPackageJson);
const packageJson = codexRequire.resolve(`${platformPackage}/package.json`);
const executable = process.platform === "win32" ? "codex.exe" : "codex";
const source = join(dirname(packageJson), "vendor", triple, "bin", executable);
if (!existsSync(source)) {
  throw new Error(`Codex Runtime binary is missing: ${source}`);
}

const outputDir = join(projectRoot, "src-tauri", "binaries");
const destination = join(outputDir, `codex-${triple}${process.platform === "win32" ? ".exe" : ""}`);
mkdirSync(outputDir, { recursive: true });
copyFileSync(source, destination);
if (process.platform !== "win32") chmodSync(destination, 0o755);
process.stdout.write(`Prepared Codex Runtime ${triple}: ${destination}\n`);
