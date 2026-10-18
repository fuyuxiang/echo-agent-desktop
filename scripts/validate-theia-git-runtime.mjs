import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { validateGitWindowless, GIT_WINDOWLESS_PATCH, GIT_PATCHED_MAIN_SHA256 } from "./patch-theia-git-windowless.mjs";

// Accept a staged browser directory OR the browser directory inside an actual
// installation. No build-tree fallback: verify exactly the supplied resources.
export function validateGitRuntime(runtime) {
  const directory = join(runtime, "plugins/vscode.git");
  const manifest = JSON.parse(readFileSync(join(directory, "extension/package.json"), "utf8"));
  assert.equal(`${manifest.publisher}.${manifest.name}`, "vscode.git");
  validateGitWindowless(directory, { id: "vscode.git", version: manifest.version });
  const hash = createHash("sha256").update(readFileSync(join(directory, "extension/dist/main.js"))).digest("hex");
  assert.equal(hash, GIT_PATCHED_MAIN_SHA256);
  return { runtime: resolve(runtime), plugin: "vscode.git", version: manifest.version, patch: GIT_WINDOWLESS_PATCH, mainSha256: hash, verified: true };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(JSON.stringify(validateGitRuntime(resolve(process.argv[2] ?? "src-tauri/resources/theia/browser")), null, 2));
}
