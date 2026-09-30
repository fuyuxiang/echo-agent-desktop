import assert from "node:assert/strict";
import { join } from "node:path";

export async function validateSidebarScroll(page, output) {
  const snapshot = () => page.evaluate(() => {
    const rect = (selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    };
    const scroll = (selector) => {
      const element = document.querySelector(selector);
      return { top: element.scrollTop, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    };
    return {
      content: rect(".sidebar__content"),
      taskHeader: rect(".sidebar__section-head"),
      projectHeader: rect(".sidebar__list-section--projects > .sidebar__section-label"),
      taskListRect: rect("#sidebar-task-list"),
      tasks: scroll("#sidebar-task-list"),
      projects: scroll("#sidebar-project-list"),
    };
  });

  let layouts = 0;
  await page.setViewportSize({ width: 1024, height: 720 });
  for (const variant of ["tasks", "projects", "both", "short"]) {
    await page.goto(`http://127.0.0.1:1439/__ui-review?surface=sidebar-scroll&variant=${variant}`);
    await page.locator("#sidebar-task-list").waitFor();
    const before = await snapshot();
    assert.ok(before.taskHeader.top >= before.content.top - 1, `${variant}: task heading escapes the sidebar`);
    assert.ok(before.projectHeader.bottom <= before.content.bottom + 1, `${variant}: project heading is hidden below the sidebar`);
    assert.ok(before.tasks.clientHeight > 30 && before.projects.clientHeight > 30, `${variant}: a list has no usable height`);
    if (variant === "short") {
      assert.ok(before.projectHeader.top - before.taskListRect.bottom < 20, "short lists should stay grouped together");
    }
    await page.screenshot({ path: join(output, `sidebar-scroll-${variant}.png`) });
    layouts += 1;

    if (["tasks", "both"].includes(variant)) {
      await page.locator("#sidebar-task-list").evaluate(element => { element.scrollTop = element.scrollHeight; });
      const after = await snapshot();
      assert.ok(after.tasks.top > 0, `${variant}: tasks do not scroll`);
      assert.equal(after.projects.top, before.projects.top, `${variant}: task scrolling moved projects`);
      assert.ok(Math.abs(after.taskHeader.top - before.taskHeader.top) < 1, `${variant}: task heading moved`);
      assert.ok(Math.abs(after.projectHeader.top - before.projectHeader.top) < 1, `${variant}: project heading moved`);
    }
    if (["projects", "both"].includes(variant)) {
      const previous = await snapshot();
      await page.locator("#sidebar-project-list").evaluate(element => { element.scrollTop = element.scrollHeight; });
      const after = await snapshot();
      assert.ok(after.projects.top > 0, `${variant}: projects do not scroll`);
      assert.equal(after.tasks.top, previous.tasks.top, `${variant}: project scrolling moved tasks`);
      assert.ok(Math.abs(after.taskHeader.top - previous.taskHeader.top) < 1, `${variant}: task heading moved`);
      assert.ok(Math.abs(after.projectHeader.top - previous.projectHeader.top) < 1, `${variant}: project heading moved`);
    }
    if (variant === "both") {
      const previous = await snapshot();
      await page.getByRole("button", { name: /^项目 \(/ }).click();
      const expandedTaskHeight = await page.locator("#sidebar-task-list").evaluate(element => element.clientHeight);
      assert.ok(expandedTaskHeight > previous.tasks.clientHeight + 20, "collapsing projects should give tasks more room");
      await page.getByRole("button", { name: /^项目 \(/ }).click();
      await page.locator("#sidebar-project-list").waitFor();
      const beforeTaskCollapse = await snapshot();
      await page.getByRole("button", { name: /^任务 \(/ }).click();
      const expandedProjectHeight = await page.locator("#sidebar-project-list").evaluate(element => element.clientHeight);
      assert.ok(expandedProjectHeight > beforeTaskCollapse.projects.clientHeight + 20, "collapsing tasks should give projects more room");
    }
  }

  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto("http://127.0.0.1:1439/__ui-review?surface=sidebar-scroll&variant=both");
  await page.locator("#sidebar-task-list").waitFor();
  const compact = await snapshot();
  assert.ok(compact.projectHeader.bottom <= compact.content.bottom + 1, "project heading should remain visible at compact window height");
  assert.ok(compact.tasks.clientHeight > 20 && compact.projects.clientHeight > 20, "both lists should remain usable at compact window height");

  await page.setViewportSize({ width: 1024, height: 720 });
  await page.goto("http://127.0.0.1:1439/__ui-review?surface=sidebar-scroll&variant=short");
  await page.getByRole("button", { name: "筛选任务" }).click();
  const filterVisible = await page.locator("#sidebar-task-filter-menu").evaluate((menu) => {
    const box = menu.getBoundingClientRect();
    const projectHeader = document.querySelector(".sidebar__list-section--projects > .sidebar__section-label").getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, Math.max(box.top + 12, projectHeader.top + 12));
    return element !== null && menu.contains(element);
  });
  assert.ok(filterVisible, "task filter popover should remain above the project section");
  return layouts;
}
