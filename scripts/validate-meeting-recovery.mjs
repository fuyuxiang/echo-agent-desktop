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
  const toolbarFits = async (label) => {
    const fits = await page.locator(".meeting-content-toolbar").evaluate(toolbar => {
      const box = toolbar.closest(".meeting-tab-content").getBoundingClientRect();
      return [...toolbar.querySelectorAll("button")].every(button => {
        const rect = button.getBoundingClientRect();
        return rect.left >= box.left && rect.right <= box.right;
      });
    });
    assert.ok(fits, `${label}: toolbar controls clip within the content panel`);
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
  for (const width of [1024, 768]) {
    await page.setViewportSize({ width, height: 768 });
    const theme = width === 1024 ? "dark" : "light";
    await page.goto(`${origin}/__ui-review?scenario=draft-recovery&theme=${theme}`);
    await page.getByText("转写接口已就绪", { exact: true }).waitFor();
    await page.getByRole("button", { name: /完整转写/ }).click();
    const first = page.getByRole("textbox", { name: "第 1 段转写", exact: true });
    await first.fill("保留人工校对的段落");
    assert.ok(await page.getByRole("button", { name: "TXT", exact: true }).isDisabled(), "dirty transcript export must explain that saving is required");
    await page.getByRole("button", { name: "保存校对", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "TXT")?.disabled);
    await first.fill("在已保存校对上继续修订");
    await page.getByRole("button", { name: "开始转写并生成纪要", exact: true }).click();
    await page.getByRole("heading", { name: "重试后会议纪要", exact: true }).waitFor();
    assert.ok(await page.getByRole("button", { name: "编辑纪要", exact: true }).isDisabled(), "minutes editing must wait for transcript corrections to be saved");
    assert.ok(await page.getByRole("button", { name: "导出 Word", exact: true }).isDisabled(), "minutes export must use saved corrections");
    await page.getByRole("button", { name: /完整转写/ }).click();
    assert.equal(await first.inputValue(), "重试恢复的新段落");
    assert.equal(await page.getByRole("textbox", { name: "第 2 段转写", exact: true }).inputValue(), "在已保存校对上继续修订");
    await toolbarFits(`transcript toolbar ${width}`);
    await fits(page.getByRole("button", { name: "保存校对", exact: true }), `merged draft save ${width}`);
    await page.screenshot({ path: join(output, `meeting-draft-merged-${width}.png`) });
    await page.getByRole("button", { name: "保存校对", exact: true }).click();
    await page.getByRole("button", { name: "TXT", exact: true }).waitFor({ state: "visible" });
    await page.waitForFunction(() => ![...document.querySelectorAll("button")].find(button => button.textContent === "TXT")?.disabled);
    const saves = await page.evaluate(() => window.__meetingReview.commands.filter(({ command }) => command === "meeting_update"));
    assert.equal(saves.length, 2);
    assert.deepEqual(saves[1].args.transcript.map(segment => segment.text), ["重试恢复的新段落", "在已保存校对上继续修订"]);
    assert.equal(saves[1].args.expectedContent.transcript.length, 2, "save must compare against the recovered transcript");
    evidence.push({ scenario: "merged-transcript-draft", width, passed: true });

    await page.goto(`${origin}/__ui-review?scenario=draft-conflict&theme=${theme}`);
    const editorButton = page.getByRole("button", { name: "编辑纪要", exact: true });
    await editorButton.waitFor();
    await editorButton.click();
    const editor = page.getByRole("textbox", { name: "编辑会议纪要", exact: true });
    await editor.fill("# 人工校对草稿\n\n必须保留的人工修订。");
    await page.getByRole("button", { name: "返回预览（保留草稿）", exact: true }).click();
    await page.getByRole("button", { name: "重新生成", exact: true }).click();
    await page.getByRole("heading", { name: "现有转写纪要", exact: true }).waitFor();
    const notice = page.getByRole("alert").filter({ hasText: "原纪要草稿已保留" });
    await notice.waitFor();
    assert.ok(await editorButton.isDisabled(), "old minutes require an explicit resolution before reopening");
    assert.ok(await page.getByRole("button", { name: "导出 Word", exact: true }).isDisabled(), "conflicted draft must not export an unexpected version");
    await toolbarFits(`minutes toolbar ${width}`);
    for (const name of ["复制原纪要草稿", "保留原草稿并编辑", "舍弃草稿，使用最新纪要"]) {
      await fits(notice.getByRole("button", { name, exact: true }), `minutes conflict ${width} ${name}`);
    }
    await page.screenshot({ path: join(output, `meeting-draft-conflict-${width}.png`) });
    await notice.getByRole("button", { name: "保留原草稿并编辑", exact: true }).click();
    assert.equal(await editor.inputValue(), "# 人工校对草稿\n\n必须保留的人工修订。");
    await fits(page.getByRole("button", { name: "保存纪要", exact: true }), `resolved minutes save ${width}`);
    await page.getByRole("button", { name: "保存纪要", exact: true }).click();
    await page.getByRole("heading", { name: "人工校对草稿", exact: true }).waitFor();
    assert.equal(await notice.count(), 0);
    evidence.push({ scenario: "explicit-minutes-draft-choice", width, passed: true });
  }
  assert.deepEqual(errors, [], "meeting browser runtime errors");
  const result = { passed: true, evidenceLayer: "real Chrome + production React/CSS + in-memory native IPC fixture", layouts: evidence.length, screenshots: output, scenarios: evidence };
  writeFileSync(join(output, "meeting-recovery-results.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
