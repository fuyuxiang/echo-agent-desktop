import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium, reviewOutput } from "./ui-review-runtime.mjs";
import { validateWorkbenchTransitions } from "./validate-session-workbench-transitions.mjs";

const output = reviewOutput(mkdtempSync(join(tmpdir(), "echo-session-workbench-")));
console.log(`Session workbench evidence: ${output}`);
const server = await createUiReviewServer(0);
const base = `http://127.0.0.1:${server.httpServer.address().port}/__ui-review?surface=workbench`;
let browser;
const evidence = [];
try {
  browser = await (await reviewChromium()).launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60000);
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  const openView = async label => {
    await page.getByRole("button", { name: "工作区", exact: true }).click();
    await page.getByRole("menuitem", { name: new RegExp(label) }).click();
  };
  const sessionAction = async label => {
    await page.getByRole("button", { name: "更多操作", exact: true }).click();
    await page.getByRole("menuitem", { name: label, exact: true }).click();
  };
  for (const width of [1536, 1280, 900]) for (const theme of ["light", "dark"]) for (const platform of ["mac", "other"]) {
    await page.setViewportSize({width, height: 900});
    await page.goto(`${base}&theme=${theme}&platform=${platform}`);
    await page.locator(".session-header").waitFor();
    for (const collapsed of [false, true]) {
      if (collapsed) await page.getByRole("button", {name:"收起侧边栏",exact:true}).click();
      const geometry = await page.evaluate(() => {
        const rect = element => { const r = element.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; };
        const header = document.querySelector(".session-header");
        return { header: rect(header), scroll: rect(document.querySelector(".chatview__scroll")), buttons: [...header.querySelectorAll("button")].filter(e => getComputedStyle(e).display !== "none").map(e => ({label:e.getAttribute("aria-label"),...rect(e)})),
          overflow: document.documentElement.scrollWidth > innerWidth + 1, oldToolbars: document.querySelectorAll(".chatview__utility-bar").length, title: rect(document.querySelector(".main-topbar__title-area")) };
      });
      assert.equal(geometry.overflow, false, `horizontal overflow at ${width}`);
      assert.equal(geometry.oldToolbars, 0);
      assert.equal(geometry.header.height, 56);
      assert.ok(geometry.scroll.y >= geometry.header.bottom, "message history starts behind header");
      for (const button of geometry.buttons) assert.ok(button.x >= geometry.header.x && button.right <= geometry.header.right + 1, `header button clipped: ${JSON.stringify(button)}`);
      if (platform === "mac" && collapsed) assert.ok(geometry.buttons[0].x >= 84, "native traffic-light safe area");
      const before = geometry.header;
      await page.locator(".chatview__scroll").evaluate(e => { e.scrollTop = 100; e.dispatchEvent(new WheelEvent("wheel", {deltaY:-1})); });
      assert.deepEqual(await page.locator(".session-header").evaluate(e => { const r=e.getBoundingClientRect(); return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}; }), before, "scroll moved session header");
      await page.screenshot({path:join(output, `workbench-${width}-${theme}-${platform}-${collapsed ? "collapsed" : "expanded"}.png`)});
      evidence.push({width,theme,platform,collapsed,...geometry});
    }
    await page.getByRole("button", {name:"新建任务",exact:true}).click();
    assert.ok(await page.evaluate(() => window.workbenchNewTask), "collapsed new-task path");
    await page.getByRole("button", {name:"工作区",exact:true}).focus();
    await page.keyboard.press("ArrowDown");
    const menu = page.getByRole("menu", {name:"工作区视图"});
    assert.ok(await menu.getByRole("menuitem").first().evaluate(e=>e===document.activeElement));
    await page.keyboard.press("End"); await page.keyboard.press("Escape");
    assert.ok(await page.getByRole("button", {name:"工作区",exact:true}).evaluate(e=>e===document.activeElement));
  }
  await page.setViewportSize({width:1280,height:900});
  await page.goto(`${base}&theme=light&platform=mac`);
  await sessionAction("重命名会话");
  await page.getByRole("textbox", {name:"会话标题"}).fill("验收后的任务标题");
  await page.getByRole("textbox", {name:"会话标题"}).press("Enter");
  await page.getByText("验收后的任务标题",{exact:true}).first().waitFor();
  await sessionAction("取消置顶");
  await page.waitForFunction(() => window.workbenchCalls.some(c => c.command === "agent_set_session_pinned" && c.args.sessionId === "review-conversation" && c.args.pinned === false));
  await sessionAction("导出与本地分享…");
  const share = page.getByRole("dialog",{name:"分享选项"});
  await share.getByRole("button",{name:"导出 Markdown",exact:true}).click();
  await page.waitForFunction(() => window.workbenchCalls.some(c=>c.command==="export_text_file" && c.args.content.includes("评审投影仪")));
  await page.keyboard.press("ControlOrMeta+f");
  await page.getByRole("textbox",{name:"查找",exact:true}).fill("服务端");
  await page.locator(".find-hit-active").waitFor();
  await page.keyboard.press("Escape");
  await openView("网页预览");
  await page.getByRole("complementary",{name:"工作区面板"}).waitFor();
  await openView("文件变更");
  assert.equal(await page.getByRole("complementary",{name:"工作区面板"}).count(),0,"only one workspace view");
  await page.getByRole("button",{name:"关闭工作视图",exact:true}).click();
  await sessionAction("历史提问");
  await page.getByRole("searchbox",{name:"筛选历史提问"}).fill("蓝牙");
  await page.locator(".question-history__item").click();
  await page.locator(".msg-wrap--jump-target").waitFor();
  await sessionAction("回溯…");
  await page.getByRole("button",{name:"仅文件",exact:true}).click();
  await page.getByRole("button",{name:/回溯到此处/}).click();
  assert.equal(await page.evaluate(()=>window.workbenchCalls.filter(c=>c.command==="rewind_execute").length),0,"rewind must await confirmation");
  await page.getByRole("button",{name:"取消",exact:true}).click();
  await page.keyboard.press("Escape");
  for (const state of ["empty","files","plan","running","permission","collaboration","paused","failed"]) {
    await page.goto(`${base}&theme=light&platform=mac&state=${state}`);
    await page.locator(".session-header").waitFor();
    if (state === "empty") { assert.equal(await page.getByRole("button",{name:"查找当前会话"}).count(),0); assert.equal(await page.getByRole("button",{name:"工作区",exact:true}).count(),1); }
    if (state === "files") { await openView("文件变更"); await page.getByRole("region",{name:"文件变更",exact:true}).waitFor(); }
    if (state === "plan") { await openView("执行计划"); await page.getByText("验证工作台交互与交付",{exact:true}).waitFor(); }
    if (state === "collaboration") { await openView("协作详情"); await page.getByText("核对交付文档",{exact:true}).waitFor(); }
    if (state === "permission") {
      await page.getByRole("button",{name:"允许本次",exact:true}).waitFor();
      await page.getByRole("complementary",{name:"运行中任务"}).waitFor();
      await page.waitForFunction(() => {
        const tasks = document.querySelector(".tasks-panel")?.getBoundingClientRect();
        const permission = document.querySelector(".perm-inline")?.getBoundingClientRect();
        return tasks && permission && tasks.bottom <= permission.top - 11;
      });
      const allow = page.getByRole("button",{name:"允许本次",exact:true});
      await allow.click({trial:true});
      await page.getByRole("button",{name:"拒绝",exact:true}).click({trial:true});
    }
    if (state === "running") { await page.getByRole("button",{name:"停止生成",exact:true}).waitFor(); await page.getByRole("button",{name:"暂停",exact:true}).waitFor(); }
    if (state === "paused") await page.getByText("任务已暂停，发送“继续”即可续做",{exact:true}).waitFor();
    if (state === "failed") await page.getByRole("alert").filter({hasText:"本轮任务失败"}).waitFor();
    await page.screenshot({path:join(output,`state-${state}.png`)});
  }
  await validateWorkbenchTransitions(page, base, output);
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,"geometry.json"),JSON.stringify(evidence,null,2));
  console.log(`Passed ${evidence.length} header layouts, navigation, native-export bridge, find/history, rewind cancellation, mutually exclusive workspaces and 8 task states.`);
} finally { await browser?.close(); await server.close(); }
