import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium } from "./ui-review-runtime.mjs";

const output = mkdtempSync(join(tmpdir(), "echo-permissions-ui-"));
const server = await createUiReviewServer(0);
let browser;
const evidence = [];
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const base = `http://127.0.0.1:${server.httpServer.address().port}/__ui-review?surface=workbench&state=permission`;
  for (const theme of ["light", "dark"]) for (const font of [16, 22]) for (const width of [1280, 1024, 768]) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    page.setDefaultNavigationTimeout(60000);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    const optionCase = width === 1280 ? "short" : width === 768 ? "long" : "path";
    await page.goto(`${base}&theme=${theme}&permissionCase=${width === 1024 ? "command" : "history"}&permissionOptions=${optionCase}`);
    const card = page.getByRole("region", { name: "操作授权" });
    await card.waitFor();
    await page.evaluate(font => { document.documentElement.style.fontSize = `${font}px`; }, font);
    await page.locator(".session-header__identity .session-header__status--approval").waitFor();
    await page.locator(".sidebar__approval-status").first().waitFor();
    const geometry = await card.evaluate(element => {
      const rect = element.getBoundingClientRect();
      const composer = document.querySelector(".echo-composer").getBoundingClientRect();
      return { width: rect.width, height: rect.height, left: rect.left, right: rect.right, bottom: rect.bottom,
        composerWidth: composer.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth,
        buttons: [...element.querySelectorAll("footer button")].map(button => {
          const r = button.getBoundingClientRect(); return { left: r.left, right: r.right, bottom: r.bottom, height: r.height };
        }), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
    });
    assert.equal(geometry.overflow, false, "approval must not cause page overflow");
    assert.ok(Math.abs(geometry.width - geometry.composerWidth) < 1, "approval must align with the composer");
    assert.ok(geometry.height <= (font === 16 ? 200 : 250), "default approval must stay compact");
    assert.ok(geometry.scrollWidth <= geometry.clientWidth + 1);
    assert.ok(geometry.buttons.every(button => button.left >= geometry.left && button.right <= geometry.right && button.bottom <= 800 && button.height >= 30));
    assert.equal(await page.getByRole("button", { name: "允许一次", exact: true }).count(), 1);
    const suffix = `${width}-${theme}-${font}`;
    await page.screenshot({ path: join(output, `approval-${suffix}.png`) });

    const pickerTrigger = page.getByRole("button", { name: "请求批准", exact: true });
    await pickerTrigger.click();
    const picker = page.getByRole("menu", { name: "本任务权限" });
    assert.equal(await picker.getByRole("menuitemradio").count(), 3);
    assert.equal(await picker.getByText("仅限当前任务", { exact: true }).count(), 1);
    const pickerBox = await picker.boundingBox();
    assert.ok(pickerBox.x >= 0 && pickerBox.x + pickerBox.width <= width && pickerBox.y >= 0 && pickerBox.y + pickerBox.height <= 800);
    assert.ok(pickerBox.height <= 280, "mode menu should use short descriptions");
    assert.ok(pickerBox.width <= (font === 16 ? 280 : 320), "mode menu must not reserve a fixed wide column");
    await page.screenshot({ path: join(output, `modes-${suffix}.png`) });
    await page.keyboard.press("Escape");
    await picker.waitFor({ state: "hidden" });
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "请求批准");
    assert.ok(await pickerTrigger.evaluate(element => element === document.activeElement));

    await page.getByRole("button", { name: "更多授权选项", exact: true }).click();
    const menu = page.getByRole("menu", { name: "更多授权选项" });
    const menuBox = await menu.boundingBox();
    assert.ok(menuBox.x >= 0 && menuBox.x + menuBox.width <= width && menuBox.y >= 0 && menuBox.y + menuBox.height <= 800);
    const taskAlways = menu.getByRole("menuitem", { name: /^本任务免审批/ });
    const scopedChoice = menu.getByRole("menuitem", { name: optionCase === "short" ? /^始终拒绝此类操作/ : /^始终允许此类操作/ });
    assert.ok(menuBox.width <= (optionCase === "short" ? font === 16 ? 210 : 260 : 360), "short choices should fit their content; scopes have a readable cap");
    assert.equal(await menu.locator("[title], [data-tip], [data-global-tooltip-native]").count(), 0, "raw backend labels must not create a second tooltip");
    assert.ok(!(await menu.textContent()).match(/always[ -]approve|Always allow|Yes, and/i), "permission actions must use Chinese copy");
    // Exercise real hover/focus with GlobalTooltip mounted: raw native titles
    // previously produced an untranslated bubble on top of these choices.
    for (const item of [taskAlways, scopedChoice]) {
      await item.focus();
      await item.hover();
      await page.waitForTimeout(450);
      assert.equal(await page.getByRole("tooltip").count(), 0, "focus and hover must not cover approval choices");
    }
    const rows = await menu.getByRole("menuitem").evaluateAll(items => items.map(item => {
      const rect = item.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, scrollWidth: item.scrollWidth, clientWidth: item.clientWidth };
    }));
    assert.ok(rows.every(row => row.scrollWidth <= row.clientWidth + 1), "scopes must wrap inside the menu");
    assert.ok(rows.every((row, index) => !index || row.top >= rows[index - 1].bottom), "option rows must not overlap");
    await page.screenshot({ path: join(output, `options-${suffix}.png`) });
    await menu.screenshot({ path: join(output, `menu-${optionCase}-${suffix}.png`) });
    await taskAlways.click();
    const confirmation = page.getByRole("alertdialog", { name: "确认本任务免审批" });
    await confirmation.waitFor();
    assert.equal(await page.evaluate(() => window.recoveryReview.modeChanges), 0, "opening a choice must not elevate permissions");
    await confirmation.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByRole("button", { name: "更多授权选项", exact: true }).waitFor();
    await page.getByRole("button", { name: "允许一次", exact: true }).click();
    await card.waitFor({ state: "hidden" });
    await page.waitForFunction(() => !document.querySelector(".session-header__status--approval"));
    assert.equal(await page.evaluate(() => window.recoveryReview.modeChanges), 0);
    assert.equal(await page.evaluate(() => window.recoveryReview.permissionResolutions), 1);
    assert.deepEqual(errors, []);
    evidence.push({ viewportWidth: width, theme, font, optionCase, pickerWidth: pickerBox.width, menuWidth: menuBox.width, ...geometry });
    await page.close();
  }
  const failure = await browser.newPage({ viewport: { width: 1024, height: 640 } });
  await failure.goto(`${base}&permissionCase=command&permissionFailure=1`);
  await failure.getByRole("button", { name: "允许一次", exact: true }).click();
  await failure.getByRole("alert").filter({ hasText: "连接暂不可用" }).waitFor();
  assert.ok(await failure.getByRole("button", { name: "允许一次", exact: true }).isEnabled());
  await failure.getByText("操作详情", { exact: true }).click();
  const rejectBox = await failure.getByRole("button", { name: "拒绝", exact: true }).boundingBox();
  assert.ok(rejectBox.y >= 0 && rejectBox.y + rejectBox.height <= 640, "expanded details must not hide the decision controls");
  await failure.close();
  writeFileSync(join(output, "geometry.json"), JSON.stringify(evidence, null, 2));
  console.log(`Permissions UI passed: ${evidence.length} layouts; compact cards, concise modes, task/status isolation, dropdown confirmation, single approval, failure retry and bounded details. Screenshots: ${output}`);
} finally {
  await browser?.close();
  await server.close();
}
