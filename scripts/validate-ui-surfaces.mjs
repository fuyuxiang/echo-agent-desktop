// Run with the same Node/Playwright installation as scripts/smoke-theia.mjs.
// Screenshots and geometry checks use production components and CSS, with
// native IPC replaced only in the development fixture.
import { chromium } from "../vendor/theia-platform/node_modules/playwright/index.mjs";
import { createServer } from "vite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const output = mkdtempSync(join(tmpdir(), "echo-ui-surfaces-"));
console.log(`UI screenshots: ${output}`);
const server = await createServer({
  server: { host: "127.0.0.1", port: 1439, strictPort: true },
  plugins: [{ name: "isolated-ui-review", configureServer(server) {
    server.middlewares.use((request, response, next) => {
      if (!request.url?.startsWith("/__ui-review")) return next();
      const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}html,body,#root{width:100%;height:100%;margin:0}body{overflow:hidden;background:var(--echo-bg-secondary);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}</style></head><body><div id="root"></div><script type="module" src="/scripts/fixtures/ui-surfaces.tsx"></script></body></html>`;
      void server.transformIndexHtml(request.url, html).then(result => { response.setHeader("Content-Type", "text/html"); response.end(result); });
    });
  } }],
});
let browser;
try {
  await server.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  const page = await browser.newPage();
  const errors = [];
  let layouts = 0;
  page.on("pageerror", error => errors.push(error.message));
  const surfaces = ["memory", "security", "cloud-storage", "notify-channels", "capabilities", "coding"];
  for (const [width, height, theme] of [[1440, 900, "light"], [1024, 768, "dark"], [768, 720, "light"]]) {
    await page.setViewportSize({ width, height });
    for (const surface of surfaces) {
      await page.goto(`http://127.0.0.1:1439/__ui-review?surface=${surface}&theme=${theme}`);
      await page.addStyleTag({ content: "*,*::before,*::after{animation:none!important;transition:none!important}" });
      if (surface === "capabilities") await page.getByRole("heading", { name: "我的专家" }).waitFor();
      else if (surface === "coding") await page.getByRole("button", { name: "切换项目" }).waitFor();
      else await page.getByRole("dialog", { name: "设置" }).waitFor();
      await page.waitForFunction(() => !document.querySelector("select.form-control:disabled"));
      const controls = await page.locator("select.form-control").evaluateAll(elements => elements.map(element => ({ appearance: getComputedStyle(element).appearance, height: element.getBoundingClientRect().height })));
      for (const control of controls) { assert.equal(control.appearance, "none"); assert.ok(control.height >= 36, `${surface}: short select (${control.height}px)`); }
      if (surface === "memory") {
        assert.ok(await page.locator(".settings-row--retrieval").evaluate(element => element.getBoundingClientRect().bottom <= element.nextElementSibling.getBoundingClientRect().top + 1), "memory hints overlap");
      }
      if (surface === "security") {
        await page.locator(".permission-rule-builder").scrollIntoViewIfNeeded();
        const fields = await page.locator(".permission-rule-builder .form-control").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().height));
        assert.ok(Math.max(...fields) - Math.min(...fields) < 1, "permission controls have inconsistent heights");
      }
      if (surface === "capabilities") {
        assert.equal(await page.getByRole("navigation", { name: "能力管理" }).count(), 1);
        assert.equal(await page.getByRole("tablist", { name: "专家·技能·连接器" }).count(), 0);
        const template = await page.getByText("推荐模板", { exact: true }).boundingBox();
        assert.ok(template && template.y < height - 100, "templates pushed below first screen");
        assert.equal(await page.locator(".colleagues-panel-shell").evaluate(element => getComputedStyle(element).overflowY), "visible");
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${surface}: horizontal page overflow`);
      await page.screenshot({ path: join(output, `${surface}-${width}-${theme}.png`) });
      layouts += 1;
      if (surface === "cloud-storage") {
        await page.getByRole("button", { name: "添加存储源" }).click();
        const fields = await page.locator(".storage-panel__field .form-control").evaluateAll(elements => elements.map(element => {
          const rect = element.getBoundingClientRect();
          return { left: rect.left, right: rect.right, height: rect.height };
        }));
        assert.equal(fields.length, 4);
        assert.ok(fields.every(field => field.left >= 0 && field.right <= width && field.height >= 36), "storage form clips fields");
        await page.screenshot({ path: join(output, `cloud-storage-form-${width}-${theme}.png`) });
        layouts += 1;
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:1439/__ui-review?surface=memory");
  await page.getByRole("combobox", { name: "记忆检索方式" }).selectOption("configured");
  await page.getByText("记忆配置已保存，重启 Agent 后对新会话生效。").waitFor();

  await page.goto("http://127.0.0.1:1439/__ui-review?surface=notify-channels");
  await page.getByRole("textbox", { name: "通知渠道显示名" }).fill("测试渠道");
  await page.getByRole("textbox", { name: "Webhook URL" }).fill("https://example.com/webhook");
  await page.getByRole("button", { name: "+ 添加", exact: true }).click();
  await page.locator(".notify-panel__row-label", { hasText: "测试渠道" }).waitFor();

  await page.goto("http://127.0.0.1:1439/__ui-review?surface=cloud-storage");
  await page.getByRole("button", { name: "添加存储源" }).click();
  await page.getByRole("textbox", { name: "存储源显示名" }).fill("测试网盘");
  await page.getByRole("textbox", { name: "WebDAV 地址" }).fill("https://example.com/dav");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("combobox", { name: "选择云存储源" }).selectOption({ label: "测试网盘" });
  await page.getByText("空目录", { exact: true }).waitFor();

  await page.goto("http://127.0.0.1:1439/__ui-review?surface=capabilities");
  await page.getByRole("button", { name: "创建专家" }).click();
  await page.getByRole("dialog", { name: "创建专家" }).waitFor();
  await page.getByRole("textbox", { name: "专家名称" }).fill("评审专家");
  await page.getByRole("textbox", { name: "专家描述" }).fill("检查产品与实现的一致性");
  await page.getByRole("textbox", { name: "专家 System Prompt" }).fill("仔细检查需求和代码，给出可验证的结论。");
  await page.getByRole("dialog", { name: "创建专家" }).getByRole("button", { name: "创建", exact: true }).click();
  await page.getByRole("button", { name: "查看专家 评审专家 详情" }).waitFor();
  for (const label of ["技能", "连接器", "插件", "浏览市场", "专家"]) {
    await page.getByRole("navigation", { name: "能力管理" }).getByRole("button", { name: label, exact: true }).click();
    await page.waitForFunction(() => !document.querySelector(".placeholder-page[role='status']"));
  }
  await page.getByRole("heading", { name: "我的专家" }).waitFor();

  await page.goto("http://127.0.0.1:1439/__ui-review?surface=coding");
  await page.getByRole("button", { name: "切换项目" }).focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menu", { name: "项目列表" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("menu", { name: "项目列表" }).count(), 0);
  assert.deepEqual(errors, [], "browser runtime errors");
  console.log(JSON.stringify({ passed: true, screenshots: output, layouts, interactions: ["memory", "notification", "storage", "expert creation", "capability navigation", "project keyboard navigation"] }, null, 2));
} finally {
  await browser?.close();
  await server.close();
}
