import assert from "node:assert/strict";
import { join } from "node:path";

export async function validateSidebarScroll(page, output) {
  const validateHeadings = async () => {
    await page.mouse.move(page.viewportSize().width - 1, 0);
    const headings = await page.locator(".sidebar__list-section").evaluateAll(sections => sections.map(section => {
      const label = section.querySelector(".sidebar__section-label");
      const style = getComputedStyle(label);
      const box = label.getBoundingClientRect();
      const textBox = label.querySelector("span").getBoundingClientRect();
      const chevronBox = label.querySelector("svg").getBoundingClientRect();
      return {
        name: label.textContent.replace(/\s*\(.*\)/, ""),
        left: box.left,
        top: box.top,
        chevronAfterText: chevronBox.left >= textBox.right,
        borderTopWidth: getComputedStyle(section).borderTopWidth,
        typography: [style.fontFamily, style.fontSize, style.fontWeight, style.color, style.padding, box.height],
      };
    }));
    assert.deepEqual(headings.map(heading => heading.name), ["任务", "项目", "群聊"], "sidebar lists should appear in task, project, chat order");
    for (const heading of headings) {
      assert.deepEqual(heading.typography, headings[0].typography, `${heading.name}: list heading style should match tasks`);
      assert.equal(heading.left, headings[0].left, `${heading.name}: list headings should align`);
      assert.equal(heading.borderTopWidth, "0px", `${heading.name}: list sections should have no separator`);
      assert.ok(heading.chevronAfterText, `${heading.name}: collapse arrow should follow the label`);
    }
    assert.ok(headings[0].top < headings[1].top && headings[1].top < headings[2].top, "list headings should follow their document order visually");
    const contentBottom = await page.locator(".sidebar__content").evaluate(element => element.getBoundingClientRect().bottom);
    assert.ok(headings[2].top + headings[2].typography.at(-1) <= contentBottom + 1, "chat heading should remain visible inside the sidebar");
  };
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
      taskHeader: rect(".sidebar__list-section--tasks > .sidebar__section-head"),
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

  for (const height of [600, 720]) {
    await page.setViewportSize({width:1024,height});
    await page.goto("http://127.0.0.1:1439/__ui-review?surface=sidebar-scroll&variant=both&groups=12");
    const groupList = page.getByRole("region",{name:"最近群聊"});
    await groupList.waitFor();
    await validateHeadings();
    const before = await snapshot();
    assert.ok(before.tasks.clientHeight >= 36 && before.projects.clientHeight >= 36, `12 groups must leave a full ordinary row visible at height ${height}: ${JSON.stringify(before)}`);
    assert.ok(before.projectHeader.bottom <= before.content.bottom + 1, "groups must not push projects outside the sidebar");
    const groupSizes = await groupList.evaluate(element => ({height:element.clientHeight,scrollHeight:element.scrollHeight}));
    assert.ok(groupSizes.height >= 30 && groupSizes.scrollHeight > groupSizes.height, `groups must show a full compact row and scroll at height ${height}: ${JSON.stringify(groupSizes)}`);
    await groupList.evaluate(element => {element.scrollTop=element.scrollHeight;});
    const after = await snapshot();
    assert.equal(after.tasks.top,before.tasks.top,"scrolling groups must not move tasks");
    assert.equal(after.projects.top,before.projects.top,"scrolling groups must not move projects");
    await page.screenshot({path:join(output,`sidebar-three-lists-${height}.png`)});
    await page.getByRole("button",{name:/^群聊 \(/}).click();
    assert.equal(await groupList.count(),0);
    const collapsed = await snapshot();
    assert.ok(collapsed.tasks.clientHeight > before.tasks.clientHeight,"collapsing groups must free room for tasks");
    await page.getByRole("button",{name:"查看全部群聊"}).waitFor();
    layouts++;
  }

  for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width: 1024, height: 720 });
    await page.goto(`http://127.0.0.1:1439/__ui-review?surface=sidebar-scroll&variant=short&groups=1&theme=${theme}`);
    await page.getByRole("region", { name: "最近群聊" }).waitFor();
    await validateHeadings();
    await page.locator(".sidebar").screenshot({ path: join(output, `sidebar-short-chats-${theme}.png`) });
    layouts++;
  }

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
