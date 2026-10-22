import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { patchTheiaScanoss } from "./patch-theia-scanoss.mjs";

const root = resolve(import.meta.dirname, "../vendor/theia-platform");
const require = createRequire(join(root, "package.json"));
const scanoss = dirname(require.resolve("scanoss/package.json"));

test("SCANOSS CLI and its scan/crypto subcommands load with the installed security overrides", () => {
  for (const args of [["--help"], ["scan", "--help"], ["crypto", "--help"]]) {
    const result = spawnSync(process.execPath, [join(scanoss, "build/main/cli/bin/cli-bin.js"), ...args], {
      encoding: "utf8", timeout: 15000,
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /Usage:/);
  }
});

for (const build of ["main", "module"]) {
  test(`SCANOSS ${build} build streams a real report without losing Unicode or nested results`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "echo-scanoss-report-"));
    try {
      const path = join(scanoss, "build", build, "cli/commands/scan.js");
      let source = readFileSync(path, "utf8");
      // Exercise the installed private report writer. Only expose it in this
      // isolated test module; production SCANOSS exports stay unchanged.
      if (build === "module") {
        source += "\nexport { streamAndTransformResults as writeTestReport };";
        source = require("esbuild").buildSync({
          stdin: { contents: source, resolveDir: dirname(path), sourcefile: path },
          bundle: true, packages: "external", platform: "node", format: "cjs", target: "node22", write: false,
        }).outputFiles[0].text;
      } else {
        source += "\nexports.writeTestReport = streamAndTransformResults;";
      }
      const loaded = new Module(path);
      loaded.filename = path;
      loaded.paths = Module._nodeModulePaths(dirname(path));
      loaded._compile(source, path);
      const scanner = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [
        `src/中文目录/file-${index}.ts`, [{ id: "snippet", text: "内容".repeat(30), nested: { licenses: ["MIT"] } }],
      ]));
      const input = join(directory, "scanner.json");
      const output = join(directory, "report.json");
      writeFileSync(input, JSON.stringify(scanner));
      const dependencies = [{ name: "example", version: "1.0.0" }];
      const files = [{ path: "src/中文目录/file-0.ts", algorithms: ["SHA-256"] }];
      const components = [{ name: "crypto" }];
      await loaded.exports.writeTestReport(input, dependencies, files, components, output);
      assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), {
        scanner, dependencies, cryptography: { files, components },
      });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

test("SCANOSS patch is idempotent and optional in the packaged IDE", () => {
  assert.equal(patchTheiaScanoss(root), false);
  const directory = mkdtempSync(join(tmpdir(), "echo-scanoss-empty-"));
  try { assert.equal(patchTheiaScanoss(directory), false); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test("SCANOSS patch rejects source drift before writing either published build", () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-scanoss-drift-"));
  const pkg = join(directory, "node_modules/scanoss");
  try {
    mkdirSync(pkg, { recursive: true });
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.40.2" }));
    const main = join(pkg, "build/main/cli/commands/scan.js");
    mkdirSync(dirname(main), { recursive: true });
    const original = readFileSync(join(scanoss, "build/main/cli/commands/scan.js"), "utf8")
      .replace('require("stream-json/streamers/stream-object.js")', 'require("stream-json/streamers/StreamObject")');
    writeFileSync(main, original);
    const module = join(pkg, "build/module/cli/commands/scan.js");
    mkdirSync(dirname(module), { recursive: true });
    writeFileSync(module, "upstream code changed");
    assert.throws(() => patchTheiaScanoss(directory), /no longer matches/);
    assert.equal(readFileSync(main, "utf8"), original);
    assert.equal(readFileSync(module, "utf8"), "upstream code changed");
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ version: "0.41.0" }));
    assert.throws(() => patchTheiaScanoss(directory), /Review.*0\.41\.0/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
