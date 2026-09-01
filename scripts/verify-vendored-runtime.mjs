#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = join(projectRoot, "vendor", "grok-build");
const manifestPath = join(runtimeRoot, "ECHOAGENT_VENDOR.json");
const requiredFiles = [
  "Cargo.toml",
  "LICENSE",
  "third_party/NOTICE",
  "crates/codegen/xai-acp-lib/Cargo.toml",
  "crates/codegen/xai-grok-shell/Cargo.toml",
  "crates/codegen/xai-grok-tools/Cargo.toml",
  "crates/common/xai-tool-runtime/Cargo.toml",
  "crates/common/xai-tool-protocol/Cargo.toml",
  "crates/common/xai-tool-types/Cargo.toml",
];

function fail(message) {
  process.stderr.write(`[ERROR] ${message}\n`);
  process.exit(1);
}

if (!existsSync(manifestPath)) {
  fail("Vendored Runtime 元数据缺失：vendor/grok-build/ECHOAGENT_VENDOR.json");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`Vendored Runtime 元数据无效：${error instanceof Error ? error.message : String(error)}`);
}

if (manifest.integrationMode !== "vendored-source") {
  fail("Vendored Runtime integrationMode 必须为 vendored-source");
}
if (!/^[0-9a-f]{40}$/i.test(manifest.upstreamRevision ?? "")) {
  fail("Vendored Runtime upstreamRevision 必须是完整的 40 位 Git 提交哈希");
}
if (manifest.license !== "Apache-2.0") {
  fail("Vendored Runtime 许可证元数据必须为 Apache-2.0");
}
if (manifest.namespace !== "echo.agent") {
  fail("Vendored Runtime 协议命名空间元数据必须为 echo.agent");
}
if (!Array.isArray(manifest.patches) || manifest.patches.length === 0) {
  fail("Vendored Runtime 必须记录已集成的兼容性补丁");
}
if (existsSync(join(runtimeRoot, ".git"))) {
  fail("vendor/grok-build 仍包含独立 Git 元数据，不能作为主仓库普通源码管理");
}

for (const relativePath of requiredFiles) {
  if (!existsSync(join(runtimeRoot, relativePath))) {
    fail(`Vendored Runtime 源码不完整，缺少：${relativePath}`);
  }
}

for (const patchPath of manifest.patches) {
  if (typeof patchPath !== "string" || !existsSync(join(projectRoot, patchPath))) {
    fail(`Vendored Runtime 补丁记录无效或文件缺失：${String(patchPath)}`);
  }
}

process.stdout.write(
  `[OK] Vendored Runtime ${manifest.upstreamRevision.slice(0, 8)} 已就绪，由主仓库直接管理。\n`,
);
