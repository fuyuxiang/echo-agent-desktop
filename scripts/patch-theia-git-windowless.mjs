import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Pinned upstream VSIX, unchanged in vendor/. Patch only its verified extracted
// executable, never child_process globally or interactive PTY processes.
export const GIT_WINDOWLESS_PATCH = "vscode.git-1.95.3-windowless-v1";
export const GIT_VSIX_SHA256 = "44909b81d3266860f02733c08475ab5fc66c0c1d7259b3c1b164e783559d9291";
const originalSha256 = "a71ea0092243bf1e86f47b69f3b2f8dba44dd041d801822ff9e605b67631f867";
const replacements = [
  ['h.spawn(e,["--version"])', 'h.spawn(e,["--version"],"win32"===process.platform?{windowsHide:!0}:void 0)'],
  ['h.spawn(this.path,e,t)', 'h.spawn(this.path,e,"win32"===process.platform?{...t,windowsHide:!0}:t)'],
];
const sha256 = value => createHash("sha256").update(value).digest("hex");
const markerName = "echoagent-windowless-patch.json";

export function patchGitBundle(source) {
  if (sha256(source) !== originalSha256) throw new Error("Git windowless patch: upstream executable SHA-256 changed; review the pinned extension.");
  for (const [before, after] of replacements) {
    if (source.split(before).length !== 2) throw new Error("Git windowless patch: upstream spawn contract changed.");
    source = source.replace(before, after);
  }
  return source;
}

function paths(directory) {
  return { main: join(directory, "extension/dist/main.js"), marker: join(directory, "extension", markerName) };
}

function provenance(outputSha256) {
  return {
    patch: GIT_WINDOWLESS_PATCH,
    upstream: "https://open-vsx.org/api/vscode/git/1.95.3/file/vscode.git-1.95.3.vsix",
    archiveSha256: GIT_VSIX_SHA256,
    inputSha256: originalSha256,
    outputSha256,
  };
}

// Pin the output independently: an old, self-consistent runtime tree must not
// satisfy current admission. Verify both provenance and executable before cache
// reuse or packaging.
export const GIT_PATCHED_MAIN_SHA256 = "32afd83c352e6590e25684dd4da58f0e4a7bee02b7a345ef4488e9bbe557f1cd";

export function validateGitWindowless(directory, plugin) {
  if (plugin.id !== "vscode.git") return;
  if (plugin.version !== "1.95.3") throw new Error("Git windowless patch: unsupported extension version.");
  const manifest = JSON.parse(readFileSync(join(directory, "extension/package.json"), "utf8"));
  if (manifest.publisher !== "vscode" || manifest.name !== "git"
      || manifest.version !== "1.95.3" || manifest.main !== "./dist/main") {
    throw new Error("Git windowless patch: plugin executable entry changed.");
  }
  const { main, marker } = paths(directory);
  if (sha256(readFileSync(main)) !== GIT_PATCHED_MAIN_SHA256
      || JSON.stringify(JSON.parse(readFileSync(marker, "utf8"))) !== JSON.stringify(provenance(GIT_PATCHED_MAIN_SHA256))) {
    throw new Error("Git extension is missing its verified windowless patch; rebuild the IDE runtime.");
  }
}

export function patchGitWindowless(directory, plugin, archiveSha256) {
  if (plugin.id !== "vscode.git") return;
  if (plugin.version !== "1.95.3" || archiveSha256 !== GIT_VSIX_SHA256) {
    throw new Error("Git windowless patch: unsupported VSIX version or input hash.");
  }
  const { main, marker } = paths(directory);
  const source = readFileSync(main, "utf8");
  if (sha256(source) === GIT_PATCHED_MAIN_SHA256) {
    validateGitWindowless(directory, plugin);
    return;
  }
  const patched = patchGitBundle(source);
  if (sha256(patched) !== GIT_PATCHED_MAIN_SHA256) throw new Error("Git windowless patch: output fingerprint changed.");
  writeFileSync(main, patched);
  writeFileSync(marker, `${JSON.stringify(provenance(GIT_PATCHED_MAIN_SHA256), null, 2)}\n`);
  validateGitWindowless(directory, plugin);
}
