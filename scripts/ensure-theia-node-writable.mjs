import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

// Tauri copies the bundled Node.js binary over an existing copy on rebuilds.
// A read-only binary works once, but blocks the next build.
export function ensureTheiaNodeWritable(projectRoot, stagedNode, platform = process.platform) {
  const nodeResource = platform === "win32"
    ? ["theia", "node", "node.exe"]
    : ["theia", "node", "bin", "node"];
  const targetRoots = new Set([join(projectRoot, "src-tauri", "target")]);
  if (process.env.CARGO_TARGET_DIR) {
    targetRoots.add(resolve(projectRoot, process.env.CARGO_TARGET_DIR));
    targetRoots.add(resolve(projectRoot, "src-tauri", process.env.CARGO_TARGET_DIR));
  }
  const candidates = new Set([stagedNode]);

  for (const targetRoot of targetRoots) {
    const outputRoots = [targetRoot];
    if (existsSync(targetRoot)) {
      for (const entry of readdirSync(targetRoot, { withFileTypes: true })) {
        if (entry.isDirectory() && ["debug", "release"].some((profile) =>
          existsSync(join(targetRoot, entry.name, profile)))) {
          outputRoots.push(join(targetRoot, entry.name));
        }
      }
    }
    for (const outputRoot of outputRoots) {
      for (const profile of ["debug", "release"]) {
        candidates.add(join(outputRoot, profile, ...nodeResource));
      }
    }
  }

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const stats = lstatSync(path);
    if (!stats.isFile()) throw new Error(`Bundled Node.js must be a regular file: ${path}`);
    if ((stats.mode & 0o200) === 0) chmodSync(path, (stats.mode & 0o777) | 0o200);
  }
}
