import { nativeReviewOutput } from './lib/native-review-output.mjs';
// Real Chrome + production React/CSS; only Tauri IPC is an explicit fixture.
import { createUiReviewServer, reviewChromium } from "./ui-review-runtime.mjs";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const output = nativeReviewOutput('meeting-recovery', 'UI_REVIEW_OUTPUT');
const server = await createUiReviewServer(0, { fixture: "/scripts/fixtures/meeting-recovery-review.tsx" });
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser;
const evidence = [];
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  const fits = async (locator, label) => {
    await locator.scrollIntoViewIfNeeded();
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, `${label}: control clips at viewport edge`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: horizontal page overflow`);
    return box;
  };
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    await page.goto(`${origin}/__ui-review?scenario=history&theme=${width === 1024 ? "dark" : "light"}`);
    const selector = page.getByRole("combobox", { name: "本次处理模型" });
    await selector.waitFor();
    await page.getByText("转写接口不可用", { exact: true }).waitFor();
    await fits(selector, `history model ${width}`);
    const retry = page.getByRole("button", { name: "重新检测", exact: true });
    await fits(retry, `connection retry ${width}`);
    await page.screenshot({ path: join(output, `meeting-history-error-${width}.png`) });
    await retry.click();
    await page.getByText("转写接口已就绪", { exact: true }).waitFor();
    await selector.selectOption("review-http/MiniMax-M3");
    await page.getByText(/录音和 API Key 将通过明文网络传输/).waitFor();
    await page.getByText("转写接口已就绪", { exact: true }).waitFor();
    const process = page.getByRole("button", { name: "开始转写并生成纪要", exact: true });
    await fits(process, `process retry ${width}`);
    await page.screenshot({ path: join(output, `meeting-model-http-${width}.png`) });
    await process.click();
    await page.locator("output").filter({ hasText: "处理失败" }).waitFor();
    await fits(process, `partial retry ${width}`);
    await page.screenshot({ path: join(output, `meeting-partial-retry-${width}.png`) });
    await process.click();
    await page.getByRole("heading", { name: "已恢复会议纪要", exact: true }).waitFor();
    const calls = await page.evaluate(() => window.__meetingReview.commands.filter(({ command }) => command === "meeting_process"));
    assert.equal(calls.length, 2);
    assert.ok(calls.every(({ args }) => args.modelId === "review-http/MiniMax-M3" && args.providerId === "review-http"), "UI model does not match invoked connection");
    await page.screenshot({ path: join(output, `meeting-recovered-${width}.png`) });
    evidence.push({ scenario: "history", width, passed: true, processCalls: calls.length, binding: calls[1].args });
  }
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto(`${origin}/__ui-review?scenario=pending-save&theme=dark`);
  const save = page.getByRole("button", { name: "重试保存", exact: true });
  await save.waitFor();
  await fits(save, "pending audio save");
  await page.screenshot({ path: join(output, "meeting-pending-save-1024.png") });
  await save.click();
  await page.locator("output").filter({ hasText: "结束录音失败" }).waitFor();
  await save.click();
  await page.locator("output").filter({ hasText: "录音已保存" }).waitFor();
  assert.equal(await page.locator(".meeting-recorder").count(), 0, "saved recording should exit pending-save state");
  const stopCalls = await page.evaluate(() => window.__meetingReview.commands.filter(({ command }) => command === "meeting_capture_stop"));
  assert.equal(stopCalls.length, 2);
  await page.screenshot({ path: join(output, "meeting-save-recovered-1024.png") });
  evidence.push({ scenario: "pending-save", width: 1024, passed: true, stopCalls: stopCalls.length });
  await page.goto(`${origin}/__ui-review?scenario=minutes&theme=dark`);
  await page.getByText(/已有转写仍可用于生成纪要/).waitFor();
  const generate = page.getByRole("button", { name: "生成会议纪要", exact: true });
  await fits(generate, "existing text minutes");
  await page.screenshot({ path: join(output, "meeting-chat-only-1024.png") });
  await generate.click();
  await page.getByRole("heading", { name: "现有转写纪要", exact: true }).waitFor();
  evidence.push({ scenario: "minutes-without-asr", width: 1024, passed: true });
  assert.deepEqual(errors, [], "meeting browser runtime errors");
  const result = { passed: true, evidenceLayer: "real Chrome + production React/CSS + in-memory native IPC fixture", layouts: evidence.length, screenshots: output, scenarios: evidence };
  writeFileSync(join(output, "meeting-recovery-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
