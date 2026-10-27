import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium } from "./ui-review-runtime.mjs";

const output = mkdtempSync(join(tmpdir(), "echo-toast-ui-"));
const server = await createUiReviewServer(0);
const evidence = [];
let browser;
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  for (const width of [1280, 768, 390, 280]) for (const theme of ["light", "dark"]) for (const font of [16, 22]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__ui-review?surface=toast&theme=${theme}`);
    await page.getByRole("button", { name: "模拟连接失败" }).waitFor();
    await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px`; }, font);
    await page.getByRole("button", { name: "模拟连接失败" }).click({ clickCount: 3 });
    assert.equal(await page.locator(".toast").count(), 1, "repeated error should not stack");
    await page.getByRole("button", { name: "归档示例" }).click({ clickCount: 2 });
    assert.equal(await page.locator(".toast").count(), 3, "different undo operations must remain independent");
    await page.locator(".toast").first().getByText("查看详情").click();
    const geometry = await page.locator(".toast").evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
        scrollWidth: element.scrollWidth, clientWidth: element.clientWidth };
    }));
    assert.ok(geometry.every(r => r.left >= 0 && r.right <= width && r.top >= 0 && r.bottom <= 800 && r.scrollWidth <= r.clientWidth + 1));
    for (let i = 1; i < geometry.length; i++) assert.ok(geometry[i].top >= geometry[i - 1].bottom + 7, "wrapped and expanded notices must not overlap");
    assert.ok(await page.locator(".toast__message").first().textContent().then(text => text.includes("请检查网络后重试")));
    await page.getByRole("button", { name: "撤销", exact: true }).first().click();
    await page.getByLabel("恢复次数").filter({ hasText: "已恢复 1 个任务" }).waitFor();
    await page.getByRole("button", { name: "关闭提示", exact: true }).last().click();
    await page.getByRole("button", { name: "模拟部分清理失败" }).click();
    assert.ok((await page.locator(".toast__message").last().textContent()).includes("部分记忆未能清理"));
    assert.equal(await page.locator(".toast").last().locator("details[open]").count(), 0, "diagnostics start collapsed");
    await page.getByRole("button", { name: "归档特殊标题", exact: true }).click();
    assert.equal(await page.locator(".toast__message").last().textContent(), "已归档“HTTP 403 问题排查”", "user-owned titles must not turn successful actions into errors");
    await page.locator(".toast").last().getByRole("button", { name: "撤销", exact: true }).click();
    await page.getByLabel("恢复次数").filter({ hasText: "已恢复 2 个任务" }).waitFor();
    await page.getByRole("button", { name: "下载特殊文件名", exact: true }).click();
    assert.equal(await page.locator(".toast__message").last().textContent(), "已下载“TypeError.log”（2 KB）", "legacy callers must also preserve successful filenames");
    await page.screenshot({ path: join(output, `${width}-${theme}-${font}.png`) });
    assert.deepEqual(errors, []);
    evidence.push({ width, theme, font, geometry });
    await page.close();
  }
  writeFileSync(join(output, "geometry.json"), JSON.stringify(evidence, null, 2));
  console.log(`Toast UI passed: ${evidence.length} layouts; deduplication, independent undo, readable diagnostics, dismissal and no overlapping notices. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
