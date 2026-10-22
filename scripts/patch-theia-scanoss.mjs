import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Adapt SCANOSS's two published builds to the maintained stream-json API. */
export function patchTheiaScanoss(root) {
  const directory = join(root, "node_modules/scanoss");
  if (!existsSync(directory)) return false; // Optional in the packaged IDE.
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  if (manifest.version !== "0.40.2") {
    throw new Error(`Review the stream-json compatibility patch for SCANOSS ${manifest.version} before building.`);
  }
  const replacements = {
    main: [
      ['require("stream-json/streamers/StreamObject")', 'require("stream-json/streamers/stream-object.js")'],
      ["(0, stream_json_1.parser)()", "(0, stream_json_1.parserStream)()"],
      ["(0, StreamObject_1.streamObject)()", "StreamObject_1.streamObject.asStream()"],
    ],
    module: [
      ['import { parser } from "stream-json"', 'import { parserStream } from "stream-json"'],
      ['from "stream-json/streamers/StreamObject"', 'from "stream-json/streamers/stream-object.js"'],
      [".pipe(parser())", ".pipe(parserStream())"],
      [".pipe(streamObject())", ".pipe(streamObject.asStream())"],
    ],
  };
  // Validate both builds before writing either one. Unexpected upstream code
  // must stop the build instead of silently leaving a partially patched CLI.
  const updates = Object.entries(replacements).map(([build, changes]) => {
    const path = join(directory, "build", build, "cli/commands/scan.js");
    let source = readFileSync(path, "utf8");
    for (const [before, after] of changes) {
      if (source.includes(before)) source = source.replaceAll(before, after);
      else if (!source.includes(after)) throw new Error(`SCANOSS compatibility patch no longer matches ${path}: ${before}`);
    }
    return { path, source };
  });
  let changed = false;
  for (const { path, source } of updates) {
    if (readFileSync(path, "utf8") !== source) {
      writeFileSync(path, source);
      changed = true;
    }
  }
  return changed;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  patchTheiaScanoss(resolve(import.meta.dirname, "../vendor/theia-platform"));
}
