#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const vendoredDependencies = [
  {
    name: "async-openai",
    root: join(projectRoot, "vendor", "async-openai"),
    revision: "95b52ebdedf42143083cf3d6f0e0be7c84e9c808",
    license: "MIT",
    requiredFiles: [
      "Cargo.toml",
      "LICENSE",
      "async-openai/Cargo.toml",
      "async-openai/src/lib.rs",
      "async-openai-macros/Cargo.toml",
      "async-openai-macros/src/lib.rs",
    ],
  },
  {
    name: "nucleo",
    root: join(projectRoot, "vendor", "nucleo"),
    revision: "5b74652e482f7c07d827f18c6d21e7540c242c69",
    license: "MPL-2.0",
    requiredFiles: [
      "Cargo.toml",
      "LICENSE",
      "src/lib.rs",
      "matcher/Cargo.toml",
      "matcher/LICENSE",
      "matcher/src/lib.rs",
    ],
  },
];

function fail(message) {
  process.stderr.write(`[ERROR] ${message}\n`);
  process.exit(1);
}

function verifyNoGitCargoSources(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "target") continue;
    const path = join(root, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`Vendored 源码不得包含符号链接：${path.slice(projectRoot.length + 1)}`);
    }
    if (entry.isDirectory()) {
      verifyNoGitCargoSources(path);
      continue;
    }
    if (entry.name !== "Cargo.toml" && entry.name !== "Cargo.lock") continue;
    const content = readFileSync(path, "utf8");
    if (/(?:^|[,{\s])git\s*=/m.test(content) || /^source\s*=\s*"git\+/m.test(content)) {
      fail(`Cargo 仍包含外部 Git 源码依赖：${path.slice(projectRoot.length + 1)}`);
    }
  }
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
if (existsSync(join(runtimeRoot, ".git"))) {
  fail("vendor/grok-build 仍包含独立 Git 元数据，不能作为主仓库普通源码管理");
}

for (const relativePath of requiredFiles) {
  if (!existsSync(join(runtimeRoot, relativePath))) {
    fail(`Vendored Runtime 源码不完整，缺少：${relativePath}`);
  }
}

for (const dependency of vendoredDependencies) {
  const sourcePath = join(dependency.root, "SOURCE.json");
  if (!existsSync(sourcePath)) {
    fail(`Vendored 依赖元数据缺失：${dependency.name}/SOURCE.json`);
  }
  let source;
  try {
    source = JSON.parse(readFileSync(sourcePath, "utf8"));
  } catch (error) {
    fail(
      `Vendored 依赖元数据无效：${dependency.name}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    source.integrationMode !== "vendored-source" ||
    source.upstreamRevision !== dependency.revision ||
    source.license !== dependency.license
  ) {
    fail(`Vendored 依赖来源与锁定版本不一致：${dependency.name}`);
  }
  if (existsSync(join(dependency.root, ".git"))) {
    fail(`Vendored 依赖不得包含独立 Git 元数据：${dependency.name}`);
  }
  for (const relativePath of dependency.requiredFiles) {
    if (!existsSync(join(dependency.root, relativePath))) {
      fail(`Vendored 依赖源码不完整：${dependency.name}/${relativePath}`);
    }
  }
}

verifyNoGitCargoSources(join(projectRoot, "src-tauri"));
verifyNoGitCargoSources(join(projectRoot, "vendor"));

process.stdout.write(
  `[OK] Vendored Runtime ${manifest.upstreamRevision.slice(0, 8)} 及 Git 源码依赖已就绪，由主仓库直接管理。\n`,
);
