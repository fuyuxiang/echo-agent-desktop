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
    const button = page.getByRole("button", { name: "继续此任务", exact: true });
    await button.waitFor();
    assert.match(await page.locator(".yield-banner").textContent(), /操作未获批准/);
    const geometry = await button.boundingBox();
    assert(geometry && geometry.x >= 0 && geometry.x + geometry.width <= width && geometry.y + geometry.height <= 900);
    await page.screenshot({ path: join(output, "recovery-" + width + "-" + theme + ".png") });
    await button.click();
    const note = page.getByRole("note"); await note.waitFor();
    assert.match(await note.textContent(), /刚才被拒绝或取消的操作仍然禁止/);
    assert.equal(await page.locator(".yield-banner").count(), 0);
  }
  assert.deepEqual(errors, []);
  console.log("Task recovery UI: four layouts, original restrictions, actual continue action and banner dismissal passed. Screenshots: " + output);
} finally { await browser?.close(); await server.close(); }
