import { chromium } from "../vendor/theia-platform/node_modules/playwright/index.mjs";
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const backend = process.env.THEIA_URL ?? "http://127.0.0.1:31235/";
const embedToken = process.env.ECHO_THEIA_EMBED_TOKEN;
const workspace = process.env.THEIA_WORKSPACE ?? "/private/tmp/echo-theia-workspace";
const testFile = join(workspace, "echo-bridge-smoke.ts");
const priorFile = existsSync(testFile) ? readFileSync(testFile, "utf8") : null;
if (process.env.ECHO_SMOKE_EDIT === "1") writeFileSync(testFile, "export const smoke = 1;\n");
if (!embedToken) throw new Error("Set ECHO_THEIA_EMBED_TOKEN for the running Theia backend.");

const hostOrigin = "http://127.0.0.1:43121";
const iframeUrl = new URL(backend);
iframeUrl.searchParams.set("echoEmbedToken", embedToken);
iframeUrl.searchParams.set("echoBridgeToken", "smoke-bridge-token");
iframeUrl.searchParams.set("echoParentOrigin", hostOrigin);
iframeUrl.hash = encodeURI(workspace);

const hostHtml = `<html><body><iframe id="ide" src="${iframeUrl.toString()}" style="width:1200px;height:800px"></iframe><script>
  window.echoReady = false;
  window.echoActiveFile = null;
  window.echoWorkspace = null;
  window.echoAgentBounds = null;
  window.echoBeforeCount = 0;
  window.echoAfterCount = 0;
  window.echoMutationPaths = [];
  window.addEventListener('message', event => {
    if (event.origin !== ${JSON.stringify(new URL(backend).origin)}
        || event.data?.token !== 'smoke-bridge-token') return;
    if (event.data.type === 'echo/ready') window.echoReady = true;
    if (event.data.type === 'echo/active-file') window.echoActiveFile = event.data.path;
    if (event.data.type === 'echo/workspace') window.echoWorkspace = event.data.path;
    if (event.data.type === 'echo/agent-bounds') window.echoAgentBounds = event.data.bounds;
    if (event.data.type === 'echo/before-mutation') {
      window.echoBeforeCount++;
      window.echoMutationPaths.push(event.data.paths);
      event.source.postMessage({ type: 'echo/response', token: 'smoke-bridge-token',
        id: event.data.id, ok: true, value: { taskId: 'smoke', closeRound: false } }, event.origin);
    }
    if (event.data.type === 'echo/after-mutation') {
      window.echoAfterCount++;
      event.source.postMessage({ type: 'echo/response', token: 'smoke-bridge-token',
        id: event.data.id, ok: true }, event.origin);
    }
  });
</script></body></html>`;
const hostServer = createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(request.url === "/preview" ? "<h1>Echo preview smoke</h1>" : hostHtml);
});
await new Promise(resolve => hostServer.listen(43121, "127.0.0.1", resolve));

const browser = await chromium.launch({
  executablePath: process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage();
  if (process.env.ECHO_SMOKE_PREVIOUS_LOCALE) {
    await page.addInitScript(({ port, locale }) => {
      if (location.port !== port) return;
      if (sessionStorage.getItem("echo-smoke-locale-seeded")) return;
      localStorage.setItem("localeId", locale);
      localStorage.removeItem("echo-code-default-locale-v1");
      sessionStorage.setItem("echo-smoke-locale-seeded", "1");
    }, { port: new URL(backend).port, locale: process.env.ECHO_SMOKE_PREVIOUS_LOCALE });
  }
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("requestfailed", request => errors.push(`${request.url()}: ${request.failure()?.errorText}`));
  await page.goto(`${hostOrigin}/`);
  try {
  await page.waitForFunction(() => window.echoReady, undefined, { timeout: 30_000 });
  await page.waitForFunction(path => window.echoWorkspace === path, workspace, { timeout: 15_000 });
  } catch (error) {
    await page.screenshot({ path: "/private/tmp/echo-theia-smoke.png", fullPage: true });
    console.error("Frames:", page.frames().map(frame => frame.url()));
    console.error("Frame body:", await page.frames()[1]?.locator("body").innerText().catch(() => "unavailable"));
    console.error("Errors:", errors.slice(0, 20));
    throw error;
  }
  const ide = page.frameLocator("#ide");
  await ide.locator("#theia-app-shell").waitFor({ timeout: 30_000 });
  await ide.locator("#files").waitFor({ state: "attached", timeout: 30_000 });
  await ide.locator(".echo-code-start h1").getByText("打开文件开始编辑").waitFor({ timeout: 15_000 });
  await ide.getByText("资源管理器", { exact: true }).first().waitFor({ state: "attached", timeout: 15_000 });
  await ide.locator(".theia-compact-menu").waitFor({ state: "attached", timeout: 15_000 });
  await ide.locator("#echo-agent-dock").waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => window.echoAgentBounds?.width > 300, undefined, { timeout: 15_000 });
  if (process.env.ECHO_SMOKE_PREVIOUS_LOCALE === "en") {
    const locale = await ide.locator("body").evaluate(() => localStorage.getItem("localeId"));
    if (locale !== "zh-cn") throw new Error(`Legacy English locale was not migrated: ${locale}`);
  }
  await page.screenshot({ path: "/private/tmp/echo-theia-welcome.png", fullPage: true });
  console.log("Chinese explorer, compact IDE menu, and Echo start page are visible.");
  for (const theme of ["dark", "light"]) {
    await page.evaluate(({ theme, origin }) => {
      document.querySelector("#ide").contentWindow.postMessage({
        type: "echo/set-theme", token: "smoke-bridge-token", theme,
      }, origin);
    }, { theme, origin: new URL(backend).origin });
    await ide.locator(`body.theia-${theme}`).waitFor({ timeout: 15_000 });
  }
  console.log("Theia follows the Echo host theme.");
  if (process.env.ECHO_SMOKE_EDIT === "1") {
    await page.evaluate(({ path, origin }) => {
      document.querySelector("#ide").contentWindow.postMessage({
        type: "echo/open-file", token: "smoke-bridge-token", path, line: 1,
      }, origin);
    }, { path: testFile, origin: new URL(backend).origin });
    await page.waitForFunction(path => window.echoActiveFile === path, testFile, { timeout: 15_000 });
    const editor = ide.locator(".monaco-editor").first();
    await editor.waitFor({ timeout: 15_000 });
    await editor.click();
    const baseline = await page.evaluate(() => window.echoAfterCount);
    await page.keyboard.press("ControlOrMeta+End");
    await page.keyboard.type("\nexport const savedByBridge = true;");
    await page.keyboard.press("ControlOrMeta+s");
    await page.waitForFunction(count => window.echoAfterCount > count, baseline, { timeout: 15_000 });
    if (!readFileSync(testFile, "utf8").includes("savedByBridge")) {
      const diagnostics = await page.evaluate(() => ({
        active: window.echoActiveFile, before: window.echoBeforeCount,
        after: window.echoAfterCount, paths: window.echoMutationPaths,
      }));
      throw new Error(`Theia editor did not save the smoke file: ${JSON.stringify({
        contents: readFileSync(testFile, "utf8"), diagnostics,
      })}`);
    }
    console.log("Editor save passed through Echo preflight and postflight messages.");
  }
  if (process.env.ECHO_SMOKE_PREVIEW === "1") {
    await page.evaluate(({ url, origin }) => {
      document.querySelector("#ide").contentWindow.postMessage({
        type: "echo/open-preview", token: "smoke-bridge-token", url,
      }, origin);
    }, { url: `${hostOrigin}/preview`, origin: new URL(backend).origin });
    await ide.locator('[id^="mini-browser:"]').waitFor({ timeout: 15_000 });
    console.log("Theia preview panel opened from the Echo host command.");
  }
  await page.screenshot({ path: "/private/tmp/echo-theia-success.png", fullPage: true });
  console.log("Theia iframe loaded, IDE shell mounted, and Echo bridge sent ready.");
  if (errors.length) console.warn("Page errors:", errors.join(" | "));
} finally {
  await browser.close();
  hostServer.close();
  if (process.env.ECHO_SMOKE_EDIT === "1") {
    if (priorFile === null) unlinkSync(testFile);
    else writeFileSync(testFile, priorFile);
  }
}
