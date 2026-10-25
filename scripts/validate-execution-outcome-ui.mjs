import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiReviewServer, reviewChromium, reviewOutput } from "./ui-review-runtime.mjs";

const output = reviewOutput(mkdtempSync(join(tmpdir(),"echo-execution-outcome-")));
console.log(`Execution outcome evidence: ${output}`);
const server = await createUiReviewServer(0);
const base = `http://127.0.0.1:${server.httpServer.address().port}/__ui-review?surface=workbench&state=empty&platform=mac`;
let browser;
const evidence = [];
try {
  browser = await (await reviewChromium()).launch({headless:true,executablePath:process.env.CHROME_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
  const page = await browser.newPage();
  page.setDefaultTimeout(15_000); page.setDefaultNavigationTimeout(60_000);
  const errors = []; page.on("pageerror",error => errors.push(error.message));
  const setup = async scenario => page.evaluate(async scenario => {
    const { useSessionStore } = await import("/src/stores/session-store.ts");
    const store = useSessionStore.getState();
    const sid = "review-conversation";
    store.clearReplaySuppression(sid);
    store.pushUser("上一轮问题"); store.pushAssistant("上一轮已回复。");
    store.pushUser("查询资料并生成报告");
    if (scenario !== "history") store.startStreaming(sid,"outcome-review");
    const timestamp = Date.now()-5_000;
    const emit = (sessionUpdate,fields,time,name) => store.applyUpdate({sessionUpdate,...fields,__sessionId:sid,
      _meta:{isReplay:scenario === "history",agentTimestampMs:timestamp+time,"echo.agent/tool":{version:1,name},streamStartMs:time<2_000 ? "generation-1" : "generation-2"}});
    const firstFails = ["recovered","failed","all-failed"].includes(scenario);
    emit("tool_call",{toolCallId:"query-1",kind:"web_fetch",title:"查询资料",rawInput:{city:"北京",source:"weather"},status:"in_progress",content:[]},0,"weather-query");
    emit("tool_call_update",{toolCallId:"query-1",status:firstFails ? "failed" : "completed",content:[{type:"text",text:firstFails ? "首次连接超时" : "资料查询成功"}]},1_000,"weather-query");
    const retry = scenario === "recovered" || scenario === "failed" || scenario === "history";
    emit("tool_call",{toolCallId:"query-2",kind:retry ? "web_fetch" : "write_file",title:retry ? "查询资料" : "生成报告",rawInput:retry ? {source:"weather",city:"北京"} : {path:"/review/report.md",content:"报告"},status:"in_progress",content:[]},2_000,retry ? "weather-query" : "write-report");
    if (scenario !== "unfinished") emit("tool_call_update",{toolCallId:"query-2",status:retry ? "completed" : "failed",content:[{type:"text",text:retry ? "重试查询成功" : "报告目录无写入权限"}]},3_000,retry ? "weather-query" : "write-report");
    emit("agent_message_chunk",{content:{type:"text",text:scenario === "all-failed" ? "正文即使声称全部成功，也不能覆盖工具失败。" : "这里保留已生成的结果，执行状态以实际记录为准。"}},4_000);
  },scenario);
  const settle = async scenario => page.evaluate(async scenario => {
    const { useSessionStore } = await import("/src/stores/session-store.ts");
    if (scenario === "history") { useSessionStore.getState().finalizeIncompleteReplay("review-conversation"); return; }
    useSessionStore.getState().markComplete({sessionId:"review-conversation",promptId:"outcome-review",stopReason:scenario === "failed" ? "error" : "end_turn",
      ...(scenario === "failed" ? {agentResult:"连接中断，最终检查未完成"} : {})});
  },scenario);

  for (const [width,height,theme] of [[1440,900,"light"],[1280,800,"dark"],[1024,768,"light"],[390,844,"dark"]]) {
    for (const scenario of ["recovered","partial","failed"]) {
      await page.setViewportSize({width,height});
      await page.goto(`${base}&theme=${theme}`);
      await page.locator(".session-header").waitFor();
      if (width < 720) await page.getByRole("button",{name:"收起侧边栏",exact:true}).click();
      await setup(scenario);
      const process = page.locator(".execution-process");
      await process.locator(".execution-process__title").filter({hasText:"正在生成回复"}).waitFor();
      assert(await process.evaluate(element => element.classList.contains("execution-process--running")),"answer text must not turn a running task green");
      await settle(scenario);
      const state = scenario === "recovered" ? "complete" : scenario;
      await page.locator(`.execution-process--${state}`).waitFor();
      const header = process.locator(".execution-process__header");
      assert.equal(await header.getAttribute("aria-expanded"),"false");
      assert.equal(await process.locator(".toolcall").count(),0,"details should stay collapsed initially");
      const title = await process.locator(".execution-process__title").textContent();
      assert.equal(title,scenario === "recovered" ? "执行过程" : scenario === "partial" ? "部分操作未完成" : "执行未正常完成");
      const detail = process.locator(".execution-process__outcome-detail");
      assert.equal(await detail.count(),scenario === "recovered" ? 0 : 1);
      if (scenario === "partial") assert((await detail.textContent()).includes("1 项失败操作尚未确认恢复"));
      const geometry = await process.evaluate(element => {
        const box = element.getBoundingClientRect();
        const marker = getComputedStyle(element.querySelector(".execution-process__status"));
        const tokenColor = token => {
          const probe = document.createElement("span"); probe.style.color = `var(${token})`; document.body.append(probe);
          const color = getComputedStyle(probe).color; probe.remove(); return color;
        };
        return {x:box.x,right:box.right,overflow:document.documentElement.scrollWidth>innerWidth+1,
          clipped:element.scrollWidth>element.clientWidth+1,color:marker.backgroundColor,
          error:tokenColor("--echo-status-error"),warning:tokenColor("--echo-color-text-warning-default"),neutral:tokenColor("--echo-text-medium")};
      });
      assert.equal(geometry.overflow,false); assert.equal(geometry.clipped,false);
      assert(geometry.x >= 0 && geometry.right <= width+1);
      assert.equal(geometry.color,scenario === "recovered" ? geometry.neutral : scenario === "partial" ? geometry.warning : geometry.error);
      await page.screenshot({path:join(output,`${scenario}-${width}-${theme}.png`)});
      if (scenario === "recovered") assert.equal(await page.locator(".session-header__status").count(),0);
      else assert.equal(await page.locator(".session-header__status").textContent(),scenario === "partial" ? "部分完成" : "任务出错");
      if (width >= 1280) {
        await page.locator(".conversation-nav__mark").last().hover();
        await page.locator(".conversation-nav__preview").filter({hasText:title}).waitFor();
        await header.hover();
      }
      await header.click();
      assert.equal(await process.locator(".toolcall").count(),2,"both the failed attempt and later work must remain available");
      if (scenario === "recovered") await process.getByText("该次失败已通过后续重试恢复",{exact:true}).waitFor();
      await process.locator(".toolcall--err").first().click();
      await page.getByText(scenario === "partial" ? "报告目录无写入权限" : "首次连接超时",{exact:true}).waitFor();
      await page.getByRole("button",{name:"关闭面板",exact:true}).click();
      if (width === 1440) {
        await page.locator('.sidebar__conv[data-session-id="review-other"] .sidebar__conv-select').click();
        await page.locator('.sidebar__conv[data-session-id="review-conversation"] .sidebar__conv-select').click();
        await page.locator(`.execution-process--${state}`).waitFor();
      }
      evidence.push({scenario,width,height,theme,title,geometry});
    }
  }
  for (const scenario of ["all-failed","unfinished","history"]) {
    await page.setViewportSize({width:1280,height:800}); await page.goto(`${base}&theme=light`);
    await page.locator(".session-header").waitFor(); await setup(scenario); await settle(scenario);
    await page.locator(scenario === "all-failed" ? ".execution-process--failed" : scenario === "history" ? ".execution-process--attention" : ".execution-process--partial").waitFor();
    assert.equal(await page.locator(".execution-process--complete").count(),0);
  }
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,"evidence.json"),JSON.stringify({layouts:evidence,errors},null,2));
  console.log(JSON.stringify({ok:true,output,layouts:evidence.length,checks:["verified recovery","partial result","runtime failure after output","all tools failed","unfinished operation","unconfirmed replay","retained tool details","consistent navigation","session restoration"],errors},null,2));
} finally { await browser?.close(); await server.close(); }
