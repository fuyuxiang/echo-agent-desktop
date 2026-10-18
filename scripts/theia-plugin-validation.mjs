import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { validateGitWindowless } from "./patch-theia-git-windowless.mjs";

export const GIT_PLUGIN_IDS = Object.freeze(["vscode.git", "vscode.git-base"]);

export function pinnedTheiaPlugins(app) {
  return Object.entries(app.theiaPlugins ?? {}).map(([id, source]) => {
    const url = new URL(source);
    const match = url.pathname.match(/^\/api\/([^/]+)\/([^/]+)\/([^/]+)\/file\/([^/]+\.vsix)$/);
    if (url.protocol !== "https:" || url.hostname !== "open-vsx.org" || url.search || url.hash
      || !match || `${match[1]}.${match[2]}`.toLowerCase() !== id.toLowerCase()
      || match[4] !== `${id}-${match[3]}.vsix`) throw new Error(`Invalid pinned Theia plugin URL: ${id}`);
    return { id, source, version: match[3], filename: match[4], manifestDir: "extension" };
  });
}

function artifact(root, name) {
  if (typeof name !== "string" || !name || isAbsolute(name) || name.includes("\\")
    || name.includes("\0") || name.split("/").includes("..")) throw new Error("Invalid plugin artifact path");
  const path = join(root, name);
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
    || !relative(realpathSync(root), realpathSync(path)) || relative(realpathSync(root), realpathSync(path)).startsWith("..")) {
    throw new Error(`Plugin artifact is missing or escapes its root: ${name}`);
  }
  return path;
}

export function validateTheiaPlugin(directory, plugin, availableIds) {
  const root = join(directory, plugin.manifestDir ?? "extension");
  const manifest = JSON.parse(readFileSync(artifact(root, "package.json"), "utf8"));
  if (`${manifest.publisher}.${manifest.name}`.toLowerCase() !== plugin.id.toLowerCase()
    || manifest.version !== plugin.version) throw new Error(`${plugin.id}: plugin identity or version mismatch`);
  if (availableIds && (manifest.extensionDependencies ?? []).some(id => !availableIds.includes(id))) {
    throw new Error(`${plugin.id}: required extension dependency is not bundled`);
  }
  if (GIT_PLUGIN_IDS.includes(plugin.id)) {
    // Only these fixed official built-ins can take the executable-provider path.
    // Basic syntax plugins must still supply actual languages and grammars.
    if (plugin.version !== "1.95.3" || !["^1.5.0", "0.10.0"].includes(manifest.engines?.vscode)
      || !manifest.activationEvents?.includes("*")) throw new Error(`${plugin.id}: unsupported Git builtin contract`);
    const main = manifest.main;
    artifact(root, existsSync(join(root, main ?? "")) ? main : `${main}.js`);
    const required = plugin.id === "vscode.git" ? ["git.openChange", "git.stage", "git.commitStaged", "git.refresh"]
      : ["git-base.api.getRemoteSources"];
    if (!required.every(id => manifest.contributes?.commands?.some(command => command.command === id))
      || (plugin.id === "vscode.git" && JSON.stringify(manifest.extensionDependencies) !== '["vscode.git-base"]')) {
      throw new Error(`${plugin.id}: required Git commands or Git Base dependency are missing`);
    }
  } else {
    if (!manifest.contributes?.languages?.length || !manifest.contributes?.grammars?.length) {
      throw new Error(`${plugin.id}: language contributions are missing`);
    }
    for (const grammar of manifest.contributes.grammars) artifact(root, grammar.path);
  }
  if (plugin.id !== "echoagent.toml-basics") artifact(root, "LICENSE-vscode.txt");
  return manifest;
}

export function theiaPluginTreeFingerprint(root, ids) {
  const hash = createHash("sha256");
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Theia plugin runtime contains a symbolic artifact");
      if (metadata.isDirectory()) visit(path);
      else if (metadata.isFile()) {
        hash.update(relative(root, path).replaceAll("\\", "/")); hash.update("\0");
        hash.update(readFileSync(path)); hash.update("\0");
      } else throw new Error("Theia plugin runtime contains a non-file artifact");
    }
  };
  for (const id of [...ids].sort()) visit(join(root, id));
  return hash.digest("hex");
}

/** Runtime admission is stricter than validation of an original upstream VSIX. */
export function validateTheiaRuntimePlugin(directory, plugin, availableIds) {
  const manifest = validateTheiaPlugin(directory, plugin, availableIds);
  validateGitWindowless(directory, plugin);
  return manifest;
}
