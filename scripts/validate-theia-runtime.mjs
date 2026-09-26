import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "../src-tauri/resources/theia");
const node = join(root, process.platform === "win32" ? "node/node.exe" : "node/bin/node");
const entry = join(root, "browser/lib/backend/main.js");
if (!existsSync(node) || !existsSync(entry)) throw new Error("Staged Node or Theia backend missing");
const temporary = mkdtempSync(join(tmpdir(), "echo-ide-validation-"));
const token = randomBytes(32).toString("hex");
const url = "http://127.0.0.1:31235";
const env = { ...process.env, ECHO_THEIA_EMBED_TOKEN: token, THEIA_CONFIG_DIR: join(temporary, "config") };
const backend = spawn(node, [entry, "--port=31235", "--hostname=127.0.0.1"], { cwd: join(root, "browser"), env, stdio: "inherit" });
let spawnError;
backend.once("error", error => { spawnError = error; });
const exited = new Promise(resolve => { backend.once("exit", resolve); backend.once("error", resolve); });
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (spawnError) throw spawnError;
    if (backend.exitCode !== null) throw new Error("Theia exited before readiness");
    try {
      const response = await fetch(`${url}/__echo_health?echoEmbedToken=${token}`, { signal: AbortSignal.timeout(1000) });
      if (response.status === 204 && response.headers.get("x-echo-theia-ready") === token) { ready = true; break; }
    } catch { /* Bounded startup poll. */ }
    await delay(500);
  }
  if (!ready) throw new Error("Theia did not become ready within 60 seconds");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [resolvePath("smoke-theia.mjs")], { stdio: "inherit", env: { ...env, THEIA_URL: url, THEIA_WORKSPACE: temporary, ECHO_SMOKE_EDIT: "1", ECHO_SMOKE_PREVIEW: "1" } });
    const timer = setTimeout(() => { child.kill(); reject(new Error("IDE interaction smoke exceeded 90 seconds")); }, 90_000);
    child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
  if (result !== 0) throw new Error("IDE interaction smoke failed");
  const denied = await fetch(`${url}/__echo_shutdown`, { method: "POST", headers: { "X-Echo-Shutdown-Token": "invalid" } });
  if (denied.status !== 403) throw new Error("Shutdown accepted invalid token");
  const shutdown = await fetch(`${url}/__echo_shutdown`, { method: "POST", headers: { "X-Echo-Shutdown-Token": token } });
  if (shutdown.status !== 202) throw new Error("Graceful shutdown endpoint unavailable");
  if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)]) !== true) throw new Error("Theia did not close gracefully");
} finally {
  if (backend.exitCode === null) {
    backend.kill();
    await Promise.race([exited, delay(3000)]);
    if (backend.exitCode === null) backend.kill("SIGKILL");
  }
  rmSync(temporary, { recursive: true, force: true });
}
function resolvePath(file) { return resolve(import.meta.dirname, file); }
