import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { createTheiaRuntimeManifest } from "./theia-runtime-manifest.mjs";
import { assertSupportedNodeVersion, assertSupportedNpmVersion } from "./node-runtime-version.mjs";

const require = createRequire(import.meta.url);
const braces = require(resolve("vendor/theia-platform/security/braces"));
const { sprintf } = require(resolve("vendor/theia-platform/security/sprintf-js"));

test("normal brace globs keep expansion and compilation behavior", () => {
  assert.deepEqual(braces.expand("src/{main,test}.{ts,tsx}"), ["src/main.ts", "src/main.tsx", "src/test.ts", "src/test.tsx"]);
  assert.equal(braces.compile("src/{main,test}.ts"), "src/(main|test).ts");
});

test("deep brace patterns fail through a controlled depth guard before recursive walking", () => {
  for (const [open, close] of [["{", "}"], ["(", ")"], ["({", "})"]]) {
    const input = open.repeat(2000) + "a,b" + close.repeat(2000);
    for (const operation of [braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => operation(input), { name: "SyntaxError", message: /nesting exceeds/ });
    }
  }
});

test("caller-created brace ASTs cannot bypass the depth guard", () => {
  let ast = { type: "text", value: "x" };
  for (let index = 0; index < 1000; index++) ast = { type: "brace", nodes: [ast] };
  for (const operation of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => operation(ast), { name: "SyntaxError", message: /nesting exceeds/ });
  }
  const cycle = { type: "brace", nodes: [] };
  cycle.nodes.push(cycle);
  assert.throws(() => braces.stringify(cycle), /nesting exceeds/);
});

test("normal CLI number, name and padding formats remain intact", () => {
  assert.equal(sprintf("%.2f %04d %s", 1.234, 7, "ready"), "1.23 0007 ready");
  assert.equal(sprintf("%.0f", 1.234), "1");
  assert.equal(sprintf("%(name)s", { name: "中文" }), "中文");
});

test("bundled Node versions must meet the security toolchain minimum", () => {
  for (const version of ["22.23.4", "22.24.0", "24.22.1"]) assert.doesNotThrow(() => assertSupportedNodeVersion(version));
  for (const version of ["20.19.0", "22.14.0", "22.23.3", "24.17.0", "24.22.0", "25.0.0"]) assert.throws(() => assertSupportedNodeVersion(version), /requires Node.js/);
});

test("npm must support reproducible workspace installs with overrides", () => {
  assert.throws(() => assertSupportedNpmVersion("10.9.2"), /requires npm/);
  assert.throws(() => assertSupportedNpmVersion("11.21.0"), /requires npm/);
  assert.doesNotThrow(() => assertSupportedNpmVersion("11.21.1"));
});

test("untrusted precision cannot trigger a native number-format RangeError", () => {
  for (const conversion of ["e", "f", "g"]) {
    for (const precision of ["0", "101", "9999999999999999999999999999999999999999"]) {
      const result = sprintf(`%.${precision}${conversion}`, 1.234);
      assert.ok(result.length <= 110);
    }
  }
  assert.ok(sprintf("%999999999999999999999s", "x").length <= 1000000);
});

test("source overrides reach the packaged runtime without build scripts or dev dependencies", () => {
  const manifest = createTheiaRuntimeManifest({ dependencies: { core: "1" }, scripts: { postinstall: "build" }, devDependencies: { test: "1" } }, { overrides: { dompurify: "^3.4.16" } });
  assert.deepEqual(manifest.overrides, { dompurify: "^3.4.16" });
  assert.deepEqual(manifest.dependencies, { core: "1" });
  assert.deepEqual(manifest.scripts, {});
  assert.deepEqual(manifest.devDependencies, {});
});

test("packaged runtime retains both allowed and denied dependency installation policies", () => {
  const source = { allowScripts: { "node-pty": true, drivelist: true, "@google/genai": false } };
  const manifest = createTheiaRuntimeManifest({ allowScripts: { drivelist: false } }, source);
  assert.deepEqual(manifest.allowScripts, { "node-pty": true, drivelist: false, "@google/genai": false });
  assert.equal(source.allowScripts.drivelist, true);
});

test("npm ci runs approved native setup and blocks explicitly denied scripts in the staged manifest", { timeout: 60000 }, () => {
  const directory = mkdtempSync(join(tmpdir(), "echo-runtime-install-policy-"));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (args, cwd) => {
    const result = spawnSync(npm, args, {
      cwd, encoding: "utf8", timeout: 20000, shell: process.platform === "win32",
      env: { ...process.env, npm_config_cache: join(directory, "cache"), ECHO_INSTALL_POLICY_FIXTURE: directory },
    });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    return result.stdout;
  };
  try {
    assertSupportedNpmVersion(run(["--version"], directory));
    for (const name of ["echo-policy-allowed", "echo-policy-denied"]) {
      const pkg = join(directory, name);
      mkdirSync(pkg);
      writeFileSync(join(pkg, "package.json"), JSON.stringify({ name, version: "1.0.0", scripts: { install: "node install.cjs" } }));
      writeFileSync(join(pkg, "install.cjs"), `require('node:fs').writeFileSync(require('node:path').join(process.env.ECHO_INSTALL_POLICY_FIXTURE, ${JSON.stringify(name + ".ran")}), 'installed');`);
      run(["pack", "--ignore-scripts", "--json", "--pack-destination", ".."], pkg);
    }
    const runtime = join(directory, "runtime");
    mkdirSync(runtime);
    // npm identifies file dependencies by their saved source spec, rather
    // than trusting the name inside a tarball's package.json.
    writeFileSync(join(runtime, "package.json"), JSON.stringify(createTheiaRuntimeManifest({ dependencies: {
      "echo-policy-allowed": "file:../echo-policy-allowed-1.0.0.tgz",
      "echo-policy-denied": "file:../echo-policy-denied-1.0.0.tgz",
    } }, { allowScripts: { "file:../echo-policy-allowed-1.0.0.tgz": true, "file:../echo-policy-denied-1.0.0.tgz": false } })));
    run(["install", "--package-lock-only", "--ignore-scripts", "--offline", "--no-audit", "--no-fund"], runtime);
    run(["ci", "--omit=dev", "--offline", "--no-audit", "--no-fund"], runtime);
    assert.equal(existsSync(join(directory, "echo-policy-allowed.ran")), true, "approved setup did not run");
    assert.equal(existsSync(join(directory, "echo-policy-denied.ran")), false, "denied setup ran");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
