import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium, reviewOutput } from "./ui-review-runtime.mjs";

const output = reviewOutput(mkdtempSync(join(tmpdir(), "echo-coding-composer-ui-")));
const server = await createUiReviewServer(0, { fixture: "/scripts/fixtures/coding-composer-review.tsx" });
const base = `http://127.0.0.1:${server.httpServer.address().port}/__ui-review`;
const layouts = [];
let browser;
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  for (const width of [300, 360, 410, 520]) for (const font of [13, 18]) for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errors = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${base}?width=${width}&font=${font}&theme=${theme}&mode=always`);
    const input = page.getByRole("textbox", { name: "任务描述" });
    await input.waitFor();
    await page.waitForFunction((size) => Math.abs(parseFloat(getComputedStyle(document.documentElement).fontSize) - 16 * size / 13) < 0.01, font);
    await input.fill("检查输入框和工具栏的对齐");
    const geometry = await page.locator(".echo-theia-agent__composer").evaluate((element) => {
      const toolbar = element.querySelector(".echo-theia-agent__composer-tools");
      const controls = [...toolbar.children].map((child) => {
        const rect = child.getBoundingClientRect();
        return { left: rect.left, right: rect.right, center: rect.top + rect.height / 2, width: rect.width };
      });
      const input = element.querySelector("textarea");
      return { width: element.clientWidth, scrollWidth: element.scrollWidth, controls,
        toolbarWidth: toolbar.clientWidth, toolbarScrollWidth: toolbar.scrollWidth,
        outline: getComputedStyle(input).outlineStyle, inputHeight: input.clientHeight };
    });
    assert(geometry.scrollWidth <= geometry.width + 1, "Composer overflows");
    assert(geometry.toolbarScrollWidth <= geometry.toolbarWidth + 1, "Toolbar overflows");
    assert(Math.max(...geometry.controls.map((control) => control.center)) - Math.min(...geometry.controls.map((control) => control.center)) < 2, "Controls wrap or lose vertical alignment");
    assert(geometry.controls[0].right <= geometry.controls[1].left && geometry.controls[1].right <= geometry.controls[2].left, "Controls overlap");
    assert(geometry.controls[1].width >= 50 && geometry.controls[2].width === 32, "Model or send control is squeezed away");
    assert.equal(geometry.outline, "none", "Textarea duplicates the enclosing focus border");
    layouts.push({ width, font, theme, ...geometry });
    const model = page.getByRole("button", { name: /^开发任务模型：/ });
    assert.match(await model.getAttribute("title"), /MiniMax-M3.1-Flash-企业研发长名称模型/);
    await model.click();
    const menu = page.getByRole("listbox", { name: "开发任务模型" });
    const bounds = await menu.boundingBox();
    assert(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 1281 && bounds.y + bounds.height <= 801, "Model menu clipped");
    await page.getByRole("option", { name: /另一个模型/ }).click();
    await page.getByRole("button", { name: "开发任务模型：另一个模型" }).waitFor();
    await page.getByRole("button", { name: /本任务始终允许/ }).click();
    await page.getByRole("menuitemradio", { name: /自动模式/ }).click();
    await page.getByRole("button", { name: /自动模式/ }).waitFor();
    const shortHeight = await input.evaluate((element) => element.clientHeight);
    await input.fill("长草稿检查\n".repeat(30));
    const tall = await input.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
    assert(tall.height > shortHeight && tall.scrollHeight > tall.height, "Long draft must grow then scroll internally");
    await input.fill("短草稿");
    assert.equal(await input.evaluate((element) => element.clientHeight), shortHeight, "Deleting text does not shrink the input");
    if (font === 13 && [300, 410].includes(width)) await page.screenshot({ path: join(output, `composer-${width}-${theme}.png`) });
    assert.deepEqual(errors, []);
    await page.close();
  }
  const typography = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await typography.goto(`${base}?width=410&font=13&state=followup`);
  const draft = typography.getByRole("textbox", { name: "补充开发要求" });
  const text = "自动高度检查内容。".repeat(20);
  await draft.fill(text);
  await draft.evaluate((element) => element.setSelectionRange(12, 24));
  const originalHeight = await draft.evaluate((element) => element.clientHeight);
  const setFontSize = (size) => typography.evaluate(async (value) => {
    const { saveFontSize } = await import("/src/lib/font-size.ts");
    saveFontSize(value);
  }, size);
  await setFontSize(18);
  await typography.waitForFunction((height) => document.querySelector("textarea").clientHeight > height, originalHeight);
  const largeDraft = await draft.evaluate((element) => ({ height: element.clientHeight, scrollHeight: element.scrollHeight }));
  assert(largeDraft.height <= 190 && largeDraft.scrollHeight > largeDraft.height, "Larger text must grow to the input limit then scroll internally");
  await setFontSize(13);
  await typography.waitForFunction((height) => document.querySelector("textarea").clientHeight === height, originalHeight);
  assert.equal(await draft.inputValue(), text, "Changing font size must preserve the draft");
  assert.deepEqual(await draft.evaluate((element) => ({ start: element.selectionStart, end: element.selectionEnd, focused: document.activeElement === element })),
    { start: 12, end: 24, focused: true }, "Changing font size must preserve selection and focus");
  await typography.close();
  for (const theme of ["light", "dark"]) {
    const preview = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await preview.goto(`${base}?width=410&theme=${theme}`);
    await preview.getByRole("textbox", { name: "任务描述" }).fill("优化订单导出流程，并补充边界条件验证。");
    await preview.locator(".echo-theia-agent__composer").screenshot({ path: join(output, `coding-composer-${theme}.png`) });
    await preview.close();
  }
  const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
  await page.goto(`${base}?width=300&state=followup`);
  const input = page.getByRole("textbox", { name: "补充开发要求" });
  await input.fill("第一条开发要求");
  await input.press("Shift+Enter");
  assert.match(await input.inputValue(), /\n/);
  assert.match(await page.getByLabel("提交记录").textContent(), /^0 次/);
  await input.press("Enter");
  await page.waitForFunction(() => document.querySelector('[aria-label="提交记录"]').textContent.startsWith("1 次"));
  await page.waitForFunction(() => document.querySelector("textarea").value === "");
  await input.fill("通过按钮发送");
  await page.getByRole("button", { name: "发送给 Agent" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="提交记录"]').textContent.startsWith("2 次"));
  for (const state of ["streaming", "verifying", "unconfigured", "error", "context"]) {
    await page.goto(`${base}?width=300&state=${state}`);
    const editor = page.getByRole("textbox");
    await editor.fill("保留这条草稿\n".repeat(25));
    const send = page.getByRole("button", { name: state === "streaming" || state === "verifying" ? "加入待发送队列" : "开始 Agent 任务" });
    await send.scrollIntoViewIfNeeded();
    if (state === "unconfigured") assert(await send.isDisabled());
    if (["streaming", "verifying"].includes(state)) {
      assert(await send.isEnabled());
      await editor.press("Enter");
      await page.waitForFunction(() => document.querySelector('[aria-label="排队记录"]').textContent.startsWith("1 条"));
      assert.match(await page.getByLabel("提交记录").textContent(), /^0 次/);
    }
    if (state === "error") await page.getByRole("alert").waitFor();
    if (state === "context") {
      const remove = page.getByRole("button", { name: /移除上下文/ }).first();
      await remove.click();
      assert.equal(await page.getByRole("button", { name: /移除上下文/ }).count(), 1);
    }
    const rect = await send.boundingBox();
    assert(rect && rect.y >= 0 && rect.y + rect.height <= 640, "Send action is hidden in a long draft");
  }
  await page.close();
  writeFileSync(join(output, "layouts.json"), JSON.stringify(layouts, null, 2));
  console.log(`Passed ${layouts.length} single-row layouts, menus, growing drafts, live font-size changes, keyboard/button submission and blocked states. Evidence: ${output}`);
} finally { await browser?.close(); await server.close(); }
