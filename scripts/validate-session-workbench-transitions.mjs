import assert from "node:assert/strict";
import { join } from "node:path";

/** Real component regressions for workflows that cross session/view states. */
export async function validateWorkbenchTransitions(page, base, output) {
  const openView = async name => {
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(name) }).click();
  };
  const sessionAction = async name => {
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
  };
  const jump = page.getByRole("button", { name: "回到最新消息并恢复自动跟随" });
  const atBottom = () => page.waitForFunction(() => {
    const e = document.querySelector(".chatview__scroll");
    return e && Math.abs(e.scrollHeight - e.clientHeight - e.scrollTop) < 2;
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  for (const action of ["rewind", "fork"]) {
    await page.goto(`${base}&state=files`);
    await sessionAction(action === "rewind" ? "回溯…" : "分叉…");
    if (action === "rewind") {
      await page.getByRole("button", { name: /回溯到此处/ }).click();
      const confirm = page.getByRole("alertdialog", { name: "确认回溯（全量）？" });
      assert.ok((await confirm.textContent()).includes("第 1 步执行前"));
      assert.ok((await confirm.textContent()).includes("撤销此步骤及后续"));
      assert.ok((await confirm.textContent()).includes("评审投影仪"));
    }
    await page.evaluate(async () => {
      const { useSessionStore } = await import("/src/stores/session-store.ts");
      useSessionStore.getState().startStreaming("review-conversation", "history-race");
    });
    await page.getByRole("button", { name: action === "rewind" ? "确认回溯" : "创建分叉", exact: true }).waitFor({ state: "hidden" });
    assert.deepEqual(await page.evaluate(() => window.workbenchCalls.filter(c => ["rewind_execute", "session_fork"].includes(c.command))), []);
    await page.evaluate(async () => {
      const { useSessionStore } = await import("/src/stores/session-store.ts");
      useSessionStore.getState().markComplete({ sessionId: "review-conversation", promptId: "history-race", stopReason: "end_turn" });
    });
    await page.getByRole("button", { name: "停止生成", exact: true }).waitFor({ state: "hidden" });
    assert.equal(await page.getByRole("button", { name: "确认回溯", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "创建分叉", exact: true }).count(), 0);
    await sessionAction(action === "rewind" ? "回溯…" : "分叉…");
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "更多操作", exact: true }).waitFor();
  }
  console.log("History confirmations invalidate when a new turn starts.");

  await page.goto(`${base}&state=empty`);
  await openView("^文件\\s*工作目录$");
  await page.getByRole("complementary", { name: "工作区面板" }).waitFor();
  await openView("网页预览");
  const address = page.getByRole("textbox", { name: "预览网址", exact: true });
  await address.waitFor();
  assert.ok((await address.boundingBox()).width >= 100, "browser address must have usable width in the default panel");
  await page.route("https://example.com/workbench-review", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Preview fixture</title><p>Isolated preview</p>" }));
  await address.fill("https://example.com/workbench-review");
  await page.getByRole("button", { name: "预览", exact: true }).click();
  await page.locator(".browser-preview__frame").waitFor();
  assert.equal(await page.locator(".browser-preview__frame").getAttribute("src"), "https://example.com/workbench-review");
  await page.getByRole("button", { name: "浏览器", exact: true }).click();
  await page.getByRole("option", { name: "文件树", exact: true }).click();
  await page.getByRole("button", { name: "收起导航", exact: true }).waitFor();
  await openView("网页预览");
  assert.equal(await page.locator(".browser-preview__frame").getAttribute("src"), "https://example.com/workbench-review", "view changes preserve the browser tab");
  await page.screenshot({ path: join(output, "empty-session-workspace.png") });
  console.log("Empty sessions retain directory and web browsing.");

  for (const following of [true, false]) {
    await page.goto(`${base}&state=files`);
    await page.evaluate(async () => {
      const { useSessionStore } = await import("/src/stores/session-store.ts");
      const messages = useSessionStore.getState().messages;
      // Keep the source tool visible beneath the runtime view, so every
      // transition below uses normal mouse clicks without forced scrolling.
      useSessionStore.getState().setMessages([messages[0], messages.at(-1), ...messages.slice(1, -1)]);
    });
    await atBottom();
    if (!following) {
      await page.locator(".chatview__scroll").evaluate(e => {
        e.scrollTop = 600;
        e.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
        e.dispatchEvent(new Event("scroll"));
      });
      await jump.waitFor();
    }
    await openView("文件变更");
    const process = page.locator(".execution-process__header").first();
    if (await process.getAttribute("aria-expanded") !== "true") await process.click();
    await page.locator(".toolcall").first().click();
    await page.getByRole("complementary", { name: "工作区面板" }).waitFor();
    assert.equal(await page.locator(".chatview__runtime-view").count(), 0);
    if (following) await atBottom();
    else await page.waitForFunction(() => Math.abs(document.querySelector(".chatview__scroll").scrollTop - 600) < 2);
    await page.getByRole("button", { name: "关闭面板", exact: true }).click();
    await page.locator(".chatview__scroll").evaluate(e => {
      e.scrollTop = 900;
      e.dispatchEvent(new WheelEvent("wheel", { deltaY: -1 }));
      e.dispatchEvent(new Event("scroll"));
    });
    await jump.waitFor();
    await openView("文件变更");
    await page.getByRole("button", { name: "关闭工作视图", exact: true }).click();
    await page.waitForFunction(() => Math.abs(document.querySelector(".chatview__scroll").scrollTop - 900) < 2);
    assert.ok(await jump.isVisible(), "old follow state must not replace the reader's new position");
  }
  await openView("任务产物");
  await page.getByRole("button", { name: /^report\.md/ }).click();
  const reportTab = page.getByRole("tab", { name: /更新任务交付说明/ });
  await reportTab.waitFor();
  await openView("网页预览");
  await reportTab.click();
  await page.getByRole("button", { name: "产物", exact: true }).waitFor();
  await page.getByRole("button", { name: "查看关联工具", exact: true }).waitFor();
  console.log("Message tool navigation preserves fresh reading snapshots.");

  for (const width of [900, 1280]) for (const theme of ["light", "dark"]) for (const mode of ["browser", "computer"]) {
    await page.setViewportSize({ width, height: 720 });
    await page.goto(`${base}&state=${mode}-paused&theme=${theme}`);
    const bar = page.locator(".task-execution-status");
    await bar.getByRole("button", { name: "继续任务", exact: true }).waitFor();
    await page.getByRole("complementary", { name: "运行中任务" }).waitFor();
    const dockClear = () => page.waitForFunction(() => {
      const tasks = document.querySelector(".tasks-panel")?.getBoundingClientRect();
      const controls = document.querySelector(".task-execution-status")?.getBoundingClientRect();
      return tasks && controls && tasks.bottom <= controls.top - 11;
    });
    await dockClear();
    await bar.getByRole("button", { name: "继续任务", exact: true }).click({ trial: true });
    if (mode === "browser") {
      await bar.locator("summary").click();
      await dockClear();
      await bar.getByRole("checkbox", { name: "允许访问本机与内网" }).click({ trial: true });
      await bar.getByRole("button", { name: "清除浏览器数据", exact: true }).click({ trial: true });
    }
    await page.screenshot({ path: join(output, `automation-dock-${mode}-${width}-${theme}.png`) });
  }
  console.log("Automation controls remain clickable in all 8 dock layouts.");

  for (const width of [900, 1536]) for (const theme of ["light", "dark"]) {
    const url = new URL(base);
    url.searchParams.set("surface", "coding");
    url.searchParams.set("codingShell", "1");
    url.searchParams.set("theme", theme);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(url.href);
    const toggle = page.getByRole("button", { name: "收起侧边栏", exact: true });
    await toggle.click();
    assert.ok(await page.locator(".app__body").evaluate(e => e.classList.contains("app__body--collapsed")));
    const expand = page.getByRole("button", { name: "展开侧边栏", exact: true });
    assert.ok(await expand.evaluate(e => e === document.activeElement));
    await page.keyboard.press("Enter");
    assert.ok(await toggle.evaluate(e => e === document.activeElement));
    assert.equal(await toggle.getAttribute("aria-expanded"), "true");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: join(output, `coding-sidebar-${width}-${theme}.png`) });
  }
  console.log("Workbench transitions passed: live history invalidation, rewind boundary, empty-session resources, fresh reading snapshots, 8 automation docks and 4 coding sidebar layouts.");
}
