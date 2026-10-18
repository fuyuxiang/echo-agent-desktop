import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium, reviewOutput } from "./ui-review-runtime.mjs";

const output = reviewOutput(mkdtempSync(join(tmpdir(), "echo-organization-design-")));
const server = await createUiReviewServer(0);
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
const layouts = [];
let browser;
const heroGeometry = async page => page.locator(".capability-page__header").evaluate(header => {
  const rect = element => { const r=element.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}; };
  return {header:rect(header),frame:rect(header.querySelector(".capability-page__illustration")),image:rect(header.querySelector("img")),title:rect(header.querySelector(".capability-page__title")),controls:rect(header.querySelector(".capability-page__controls"))};
});
const assertSameHero = (project, organization, context) => {
  for (const part of ["header","frame","image","title","controls"]) {
    for (const axis of ["x","y","height"]) assert(Math.abs(project[part][axis]-organization[part][axis])<1, `Switching pages moves ${part}.${axis}: ${JSON.stringify({context,project,organization})}`);
    if (part !== "title") assert(Math.abs(project[part].width-organization[part].width)<1, `Switching pages resizes ${part}: ${JSON.stringify({context,project,organization})}`);
  }
};
const styles = async page => page.locator(".capability-page__header").evaluate(header => {
  const type = selector => {
    const css = getComputedStyle(header.querySelector(selector));
    return { family: css.fontFamily, size: css.fontSize, weight: css.fontWeight, lineHeight: css.lineHeight };
  };
  const css = getComputedStyle(header);
  return { title: type(".capability-page__title"), description: type(".capability-page__description"), background: css.backgroundImage, radius: css.borderRadius, padding: css.padding };
});
const geometry = async page => page.evaluate(() => {
  const rect = element => { const r = element.getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height }; };
  const header = document.querySelector(".capability-page__header");
  const workspace = document.querySelector(".org-memory__workspace");
  const page = document.querySelector(".org-memory--connected");
  const nav = workspace.querySelector(".org-memory__nav");
  const image = header.querySelector("img");
  return {
    viewport: {width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
    header: rect(header), workspace: rect(workspace), image: rect(image),
    page: rect(page), pageScrollHeight:page.scrollHeight, pageClientHeight:page.clientHeight,
    content:rect(workspace.querySelector(".org-memory__content")),
    navBackground:getComputedStyle(nav).backgroundColor,
    workspaceBackground:getComputedStyle(workspace).backgroundColor,
    activeBackground:getComputedStyle(nav.querySelector("button.active")).backgroundColor,
    imageLoaded: image.complete && image.naturalWidth > 0,
    overflow: document.documentElement.scrollWidth > innerWidth + 1 || header.scrollWidth > header.clientWidth + 1 || workspace.scrollWidth > workspace.clientWidth + 1,
    buttons: [...header.querySelectorAll("button")].map(rect),
  };
});
try {
  browser = await (await reviewChromium()).launch({ headless:true, executablePath:process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
  for (const [width,height] of [[768,720],[1024,768],[1280,800],[1440,900],[1920,1080]]) {
    for (const font of [13,18]) for (const theme of ["light","dark"]) {
      const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:font === 18 ? 1.5 : 1});
      page.setDefaultNavigationTimeout(60000);
      await page.addInitScript(font => {
        const observer = new MutationObserver(() => {
          if (document.documentElement) { document.documentElement.style.fontSize = `${16*font/13}px`; observer.disconnect(); }
        });
        observer.observe(document,{childList:true,subtree:true});
      }, font);
      const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.goto(`${base}/__ui-review?surface=projects&theme=${theme}`, {waitUntil:"networkidle"});
      await page.getByRole("heading",{name:"项目",exact:true}).waitFor();
      const projectStyles = await styles(page);
      const projectLayouts = {};
      for (const collapsed of [false,true]) {
        if (collapsed) await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();
        projectLayouts[String(collapsed)] = await heroGeometry(page);
        if (!collapsed && font===13 && theme==="light") await page.screenshot({path:join(output,`projects-${width}-${height}-${font}-${theme}.png`)});
      }
      await page.getByRole("button",{name:"展开侧边栏",exact:true}).click();
      await page.goto(`${base}/__ui-review?surface=organization-shell&theme=${theme}&orgName=${encodeURIComponent("全公司")}`, {waitUntil:"networkidle"});
      await page.getByRole("heading",{name:"全公司",level:1}).waitFor();
      assert.deepEqual(await styles(page), projectStyles, "Organization hero differs from project typography or colors");
      for (const collapsed of [false,true]) {
        if (collapsed) await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();
        const layout = await geometry(page);
        const context = JSON.stringify({width,height,font,theme,collapsed,...layout});
        assertSameHero(projectLayouts[String(collapsed)],await heroGeometry(page),{width,height,font,theme,collapsed});
        assert(layout.imageLoaded && layout.image.width > 0 && layout.image.height > 0, `Illustration is missing: ${context}`);
        assert(!layout.overflow, `Organization layout overflows: ${context}`);
        assert.equal(layout.navBackground,layout.workspaceBackground,"Organization navigation should have a neutral workspace background");
        assert.notEqual(layout.activeBackground,layout.navBackground,"Current navigation item lost its selected state");
        assert(layout.content.bottom <= layout.workspace.bottom+1,"Workspace clips its content");
        if (layout.pageScrollHeight <= layout.pageClientHeight+1) {
          assert(Math.abs(layout.page.bottom-layout.workspace.bottom-16)<2, `Workspace does not fill the page down to its bottom gutter: ${context}`);
        } else {
          assert(layout.workspace.bottom >= layout.page.bottom-17,`Scrollable workspace stops above the viewport bottom: ${context}`);
        }
        assert(Math.abs(layout.header.left-layout.workspace.left) < 2 && Math.abs(layout.header.right-layout.workspace.right) < 2, `Hero and workspace are misaligned: ${context}`);
        for (const button of layout.buttons) assert(button.left >= 0 && button.right <= width && button.top >= 0 && button.bottom <= height, `Hero action is clipped: ${context}`);
        layouts.push({width,height,font,theme,collapsed,...layout});
        if (!collapsed && ((font===13 && theme==="light") || (width===1440 && font===18 && theme==="dark"))) await page.screenshot({path:join(output,`organization-${width}-${height}-${font}-${theme}.png`)});
      }
      const nav = page.getByRole("navigation",{name:"组织功能"});
      await nav.getByRole("button",{name:/^文档/}).click();
      await page.getByRole("heading",{name:"文档",exact:true}).waitFor();
      await page.getByRole("button",{name:"上传文档",exact:true}).click();
      const dialog = page.getByRole("dialog",{name:"选择上传位置"});
      await dialog.waitFor();
      const box = await dialog.locator(".org-document-modal__confirm").boundingBox();
      assert(box.x >= 0 && box.x+box.width <= width+1 && box.y >= 0 && box.y+box.height <= height+1, "Upload dialog is clipped after hero redesign");
      await dialog.getByRole("button",{name:"取消",exact:true}).click();
      await nav.getByRole("button",{name:/^Skills/}).click();
      await page.getByRole("heading",{name:"组织 Skills",exact:true}).waitFor();
      assert.deepEqual(errors,[]);
      await page.close();
    }
    console.log(`Organization design passed at ${width}×${height}`);
  }
  writeFileSync(join(output,"geometry.json"),JSON.stringify(layouts,null,2));
  console.log(`Passed ${layouts.length} organization layouts, project typography/color parity and upload/navigation interactions; evidence: ${output}`);
} finally { await browser?.close(); await server.close(); }
