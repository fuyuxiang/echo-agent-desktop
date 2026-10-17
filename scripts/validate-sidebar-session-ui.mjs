import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium } from "./ui-review-runtime.mjs";

const output = mkdtempSync(join(tmpdir(), "echo-sidebar-session-"));
const server = await createUiReviewServer(0, { freezeMotion: false });
let browser;
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  for (const theme of ["light", "dark"]) for (const width of [220, 240, 264, 360, 400]) for (const fontSize of [11, 13, 18]) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1000 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__ui-review?surface=sidebar-scroll&variant=short&sessionTimes=1&theme=${theme}`);
    await page.locator(".sidebar__conv-time").first().waitFor();
    const settleLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const resizeSidebar = async (width) => {
      await page.locator(".sidebar").evaluate((element, width) => element.style.setProperty("--app-sidebar-width", `${width}px`), width);
      await page.waitForFunction(width => Math.abs(document.querySelector(".sidebar").getBoundingClientRect().width - width) < 0.1, width);
      // Check the painted layout after any width transition has completed.
      await settleLayout();
    };
    await resizeSidebar(width);
    await page.evaluate(size => { document.documentElement.style.fontSize = `${16 * size / 13}px`; }, fontSize);
    await settleLayout();
    await page.getByRole("button", { name: "展开产品设计对话" }).click();
    await page.mouse.move(900, 0);
    const geometry = () => page.locator(".sidebar__conv").evaluateAll(rows => rows.map(row => {
      const box = element => {
        if (!element) return null;
        const r = element.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
      };
      const time = row.querySelector("time"), title = row.querySelector(".sidebar__conv-title"), heading = row.querySelector(".sidebar__conv-heading"), action = row.querySelector(".sidebar__conv-action"), status = row.querySelector(".sidebar__conv-status"), pin = row.querySelector(".sidebar__conv-pin");
      return {
        id: row.dataset.sessionId, row: box(row), time: box(time), title: box(title), heading: box(heading), action: box(action), status: box(status), pin: box(pin),
        timeVisible: time && getComputedStyle(time).visibility, timeWeight: time && getComputedStyle(time).fontWeight,
        titleWeight: getComputedStyle(title).fontWeight, titleSize: Number.parseFloat(getComputedStyle(title).fontSize),
        statusVisible: status && getComputedStyle(status).visibility, statusText: status?.textContent,
        statusColor: status && getComputedStyle(status).color, statusName: status?.getAttribute("aria-label"),
        truncated: title.scrollWidth > title.clientWidth,
      };
    }));
    const before = await geometry();
    assert.equal(before.length, 7);
    const center = box => (box.top + box.bottom) / 2;
    for (const item of before) {
      assert.ok(item.title.width >= 4 * item.titleSize, `${item.id}: title must retain room for at least three Chinese characters and an ellipsis (${item.title.width}px at ${item.titleSize}px)`);
      assert.ok(Math.abs(item.titleSize - fontSize) < 0.01, "titles must use the 13px base and respect the font preference");
      assert.equal(item.titleWeight, item.id === "sidebar-task-0" ? "500" : "400");
      assert.ok(item.row.height >= 36 && item.row.height <= 64, "rows must stay compact at all supported font sizes");
      assert.ok(item.heading.right <= item.action.left - 1, "the menu must have its own space beside the title and metadata");
      const parts = [item.title, item.pin, item.status, item.time, item.action].filter(Boolean);
      for (const part of parts) {
        assert.ok(part.left >= item.row.left && part.right <= item.row.right && part.top >= item.row.top && part.bottom <= item.row.bottom, "content must stay inside the row");
      }
      const headingParts = [item.title, item.pin, item.status].filter(Boolean);
      for (let index = 0; index < headingParts.length; index++) {
        assert.ok(Math.abs(center(headingParts[index]) - center(item.heading)) < 0.75, `${item.id}: title, pin and status must stay on the same line`);
        if (index) assert.ok(headingParts[index].left >= headingParts[index - 1].right + 1, "title, pin and status must not overlap");
      }
      assert.ok(Math.abs(center(item.action) - center(item.row)) < 0.75, "menu buttons must stay centered in the row");
      if (item.time) {
        assert.equal(item.timeVisible, "visible");
        assert.equal(item.timeWeight, "400");
        assert.ok(item.time.right <= item.action.left - 1, "timestamps must not overlap the menu");
        if (item.time.top >= item.heading.bottom) {
          assert.ok(Math.abs(item.time.left - item.title.left) < 1, "the second line must align with the title");
          assert.ok(item.time.top - item.heading.bottom <= 4, "the second line must stay close to the title");
        } else {
          assert.ok(Math.abs(center(item.time) - center(item.heading)) < 0.75 && item.time.left >= item.heading.right + 1, "single-line timestamps must sit beside the title metadata");
        }
      }
      if (item.status) {
        assert.equal(item.status.width, 6, "status must consume only the dot width");
        assert.equal(item.statusText, "", "status labels must not be rendered as text");
        assert.ok(item.statusName, "status must have an accessible name");
        assert.equal(item.statusVisible, "visible");
      }
    }
    assert.ok(before.some(item => item.truncated), "fixture must exercise truncated titles");
    assert.equal(new Set(before.filter(item => item.status).map(item => item.statusColor)).size, 4, "running, waiting, failed and paused must remain distinguishable in both themes");
    assert.equal(before.find(item => item.id === "sidebar-task-0").status, null, "completed history must stay quiet");
    assert.equal(before.find(item => item.id === "sidebar-task-4").time, null, "missing dates must not create a placeholder");
    const active = page.locator('[data-session-id="sidebar-task-0"]');
    const working = page.locator('[data-session-id="sidebar-task-2"]');
    const project = before.find(item => item.id === "sidebar-project-session");
    if (fontSize === 18 && width <= 264) assert.ok(project.time.top >= project.heading.bottom, "narrow project rows with enlarged text must move timestamps below the title");
    if (width >= 360) assert.ok(project.time.left >= project.heading.right, "roomy rows must stay on one line");
    const suffix = `${width}-${theme}-${fontSize}`;
    await page.locator(".sidebar").screenshot({ path: join(output, `sidebar-${suffix}.png`) });

    await working.locator(".sidebar__conv-status").hover();
    await page.getByRole("tooltip").filter({ hasText: /^运行中$/ }).waitFor();
    await page.mouse.move(900, 0);
    await working.locator(".sidebar__conv-select").focus();
    await page.getByRole("tooltip").filter({ hasText: "北京今天天气怎么样 · 运行中" }).waitFor();
    await page.keyboard.press("Escape");
    await page.evaluate(() => document.activeElement?.blur());

    await active.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-session-id="sidebar-task-0"] .sidebar__conv-action')).opacity === "1");
    const selectedBackground = await active.evaluate(element => getComputedStyle(element).backgroundColor);
    await page.mouse.move(900, 0);
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-session-id="sidebar-task-0"] .sidebar__conv-action')).opacity === "0");
    assert.equal(await active.evaluate(element => getComputedStyle(element).backgroundColor), selectedBackground, "selected background must stay consistent on hover");
    assert.deepEqual(await geometry(), before, "hover and focus must not move titles, dots or timestamps");
    await working.locator(".sidebar__conv-select").focus();
    await page.keyboard.press("Tab");
    assert.equal(await working.locator(".sidebar__conv-action").evaluate(element => element === document.activeElement), true, "Tab must reach the adjacent menu button");
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-session-id="sidebar-task-2"] .sidebar__conv-action')).opacity === "1");
    await page.keyboard.press("Enter");
    await page.getByRole("menu").waitFor();
    assert.equal(await working.locator("time").isVisible(), true);
    assert.equal(await working.locator(".sidebar__conv-status").isVisible(), true);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[data-session-id="sidebar-task-2"] .sidebar__conv-action') === document.activeElement);

    const pulse = working.locator(".sidebar__conv-status-dot");
    assert.notEqual(await pulse.evaluate(element => getComputedStyle(element).animationName), "none");
    await page.emulateMedia({ reducedMotion: "reduce" });
    assert.equal(await pulse.evaluate(element => getComputedStyle(element).animationName), "none", "reduced motion must disable the running pulse");
    await page.evaluate(async () => {
      const { useSessionsStore } = await import("/src/stores/sessions-store.ts");
      useSessionsStore.getState().upsert({ sessionId: "sidebar-task-2", status: "failed" });
    });
    await working.getByRole("img", { name: "失败", exact: true }).waitFor();
    assert.equal(await working.locator(".sidebar__conv-select").getAttribute("title"), "北京今天天气怎么样 · 失败");
    assert.equal((await geometry()).find(item => item.id === "sidebar-task-2").row.height, before.find(item => item.id === "sidebar-task-2").row.height, "live status updates must not grow the row");
    // Reflow an existing sidebar in both directions; no remount or reload is
    // available during a user's drag or font preference change.
    await resizeSidebar(400);
    await resizeSidebar(240);
    const resized = (await geometry()).find(item => item.id === "sidebar-project-session");
    assert.ok(resized.title.width >= 4 * resized.titleSize, "resizing must immediately preserve project title readability");
    assert.ok(resized.time.right <= resized.action.left - 1, "resizing must preserve timestamps beside the menu");
    await resizeSidebar(width);
    assert.deepEqual((await geometry()).find(item => item.id === "sidebar-project-session"), project, "resizing back must restore the original layout");
    assert.deepEqual(errors, []);
    await page.close();
  }
  console.log(`Sidebar session UI passed: readable adaptive rows, dot-only statuses, accessible tooltips, live updates, timestamps, long titles, pinned project sessions, resizing, keyboard menus and reduced motion at 220/240/264/360/400px, 11/13/18px fonts in light/dark themes. Screenshots: ${output}`);
} finally {
  // Close HTTP connections while Chromium exits; pending development requests
  // must not leave either side waiting for the other during teardown.
  await Promise.all([server.close(), browser?.close()]);
}
