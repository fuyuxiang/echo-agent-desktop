import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourceRoot = join(root, "vendor/theia-platform");
const archiveRoot = join(root, "vendor/theia-vsix");
const manifestPath = join(archiveRoot, "manifest.json");
const app = JSON.parse(readFileSync(join(sourceRoot, "examples/browser/package.json"), "utf8"));
const plugins = Object.entries(app.theiaPlugins ?? {}).map(([id, source]) => {
  const url = new URL(source);
  const match = url.pathname.match(/^\/api\/([^/]+)\/([^/]+)\/([^/]+)\/file\/([^/]+\.vsix)$/);
  const version = match?.[3];
  const filename = match?.[4];
  if (url.protocol !== "https:" || !version || !filename
      || `${match[1]}.${match[2]}`.toLowerCase() !== id.toLowerCase()
      || filename !== `${id}-${version}.vsix`) {
    throw new Error(`Invalid pinned Theia plugin URL for ${id}: ${source}`);
  }
  return { id, source, version, filename };
});

// Theia already installs this dependency for its CLI. Reuse the same VSIX
// extractor after npm ci, without adding a second ZIP implementation.
function extractor() {
  try {
    return createRequire(join(sourceRoot, "dev-packages/cli/package.json"))("decompress");
  } catch {
    throw new Error("Theia dependencies are missing. Run npm ci in vendor/theia-platform first.");
  }
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function validateExtracted(dir, { id, version }) {
  const extensionRoot = join(dir, "extension");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(extensionRoot, "package.json"), "utf8"));
  } catch {
    throw new Error(`${id}: VSIX has no extension/package.json`);
  }
  if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== id.toLowerCase()
      || manifest.version !== version
      || !manifest.contributes?.languages?.length
      || !manifest.contributes?.grammars?.length) {
    throw new Error(`${id}: VSIX identity, version, or language contributions are invalid`);
  }
  for (const grammar of manifest.contributes.grammars) {
    if (!grammar.path || !existsSync(join(extensionRoot, grammar.path))) {
      throw new Error(`${id}: missing grammar ${grammar.path}`);
    }
  }
  if (!existsSync(join(extensionRoot, "LICENSE-vscode.txt"))) {
    throw new Error(`${id}: VSIX is missing its license`);
  }
}

async function extractAndValidate(decompress, archive, plugin, target) {
  await decompress(archive, target);
  validateExtracted(target, plugin);
}

async function stage() {
  const lock = JSON.parse(readFileSync(manifestPath, "utf8"));
  const ids = plugins.map(plugin => plugin.id);
  if (JSON.stringify(Object.keys(lock.plugins ?? {}).sort()) !== JSON.stringify([...ids].sort())) {
    throw new Error("Theia VSIX manifest does not match the browser plugin list. Run pnpm ide:plugins:update.");
  }
  // Validate every archive before replacing any extracted plugin.
  for (const plugin of plugins) {
    const expected = lock.plugins[plugin.id]?.sha256;
    const path = join(archiveRoot, plugin.filename);
    if (!/^[a-f0-9]{64}$/.test(expected ?? "") || !existsSync(path) || sha256(path) !== expected) {
      throw new Error(`${plugin.id}: vendored VSIX is missing or has the wrong SHA-256: ${path}`);
    }
  }
  const decompress = extractor();
  const pluginRoot = join(sourceRoot, "plugins");
  mkdirSync(pluginRoot, { recursive: true });
  for (const plugin of plugins) {
    const target = join(pluginRoot, plugin.id);
    const temporary = mkdtempSync(join(pluginRoot, ".echoagent-vsix-"));
    try {
      await extractAndValidate(decompress, join(archiveRoot, plugin.filename), plugin, temporary);
      rmSync(target, { recursive: true, force: true });
      renameSync(temporary, target);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }
  console.log(`Staged ${plugins.length} verified Theia VSIX plugins from the repository.`);
}

async function update() {
  const decompress = extractor();
  const temporary = mkdtempSync(join(tmpdir(), "echoagent-theia-vsix-"));
  const hashes = {};
  try {
    for (const plugin of plugins) {
      const archive = join(temporary, plugin.filename);
      const curl = process.platform === "win32" ? "curl.exe" : "curl";
      const result = spawnSync(curl, [
        "--fail", "--location", "--silent", "--show-error", "--retry", "3",
        "--connect-timeout", "15", "--max-time", "120",
        "--output", archive, plugin.source,
      ], { stdio: "inherit" });
      if (result.status !== 0) throw new Error(`Failed downloading ${plugin.id} from ${plugin.source}`);
      await extractAndValidate(decompress, archive, plugin, join(temporary, plugin.id));
      hashes[plugin.id] = { sha256: sha256(archive) };
      console.log(`${plugin.id}: ${hashes[plugin.id].sha256}`);
    }
    mkdirSync(archiveRoot, { recursive: true });
    for (const plugin of plugins) {
      copyFileSync(join(temporary, plugin.filename), join(archiveRoot, plugin.filename));
    }
    writeFileSync(manifestPath, `${JSON.stringify({ plugins: hashes }, null, 2)}\n`);
    console.log(`Updated ${plugins.length} vendored VSIX archives and their SHA-256 manifest.`);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

const action = process.argv[2];
if (action === "stage") await stage();
else if (action === "update") await update();
else throw new Error("Usage: node scripts/manage-theia-vsix.mjs <stage|update>");
