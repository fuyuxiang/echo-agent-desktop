import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium } from "./ui-review-runtime.mjs";

const output = await mkdtemp(join(tmpdir(), "echo-recovery-ui-"));
const server = await createUiReviewServer(0);
let browser;
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  const port = server.httpServer.address().port;
  for (const width of [420, 1280]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("http://127.0.0.1:" + port + "/__ui-review?surface=conversation&recovery=1&theme=" + theme);
    const input = page.locator(".echo-composer__input");
    await input.waitFor();
    assert.equal(await page.getByRole("button", { name: "继续此任务", exact: true }).count(), 0);
    assert.match(await page.locator(".yield-banner").textContent(), /操作未获批准/);
    const controlsBefore = await page.evaluate(() => ({ ...window.recoveryReview }));
    await input.fill("继续允许范围内的任务，保留此前拒绝的操作");
    const button = page.getByRole("button", { name: "发送", exact: true });
    const geometry = await button.boundingBox();
    assert(geometry && geometry.x >= 0 && geometry.x + geometry.width <= width && geometry.y + geometry.height <= 900);
    await page.screenshot({ path: join(output, "recovery-" + width + "-" + theme + ".png") });
    await button.click();
    const note = page.getByRole("note"); await note.waitFor();
    assert.equal(await note.textContent(), "继续允许范围内的任务，保留此前拒绝的操作");
    assert.deepEqual(await page.evaluate(() => window.recoveryReview), controlsBefore, "continuation must not approve rejected operations or change permission mode");
    assert.equal(await page.locator(".yield-banner").count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log("Task recovery UI: four layouts, natural-language continuation, unchanged permission decisions/mode and new-turn banner dismissal passed. Screenshots: " + output);
} finally { await browser?.close(); await server.close(); }
