import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { TeamStatusView } from "../../src/components/TeamStatusView";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { useSubagentStore } from "../../src/stores/subagent-store";
import type { ChatMessage } from "../../src/stores/session-store";
import type { RuntimeTeamInfo } from "../../src/lib/agent-client";
import "../../src/styles/global.css";
import "../../src/styles/app.css";

document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") ?? "light";
localStorage.setItem("echoagent.theme", document.documentElement.dataset.theme);
const experts = ["业务分析师", "代码专家", "文档助手"].map((name) => ({ name, scope: "user", path: `/isolated/agents/${name}.md`, raw: "", description: `${name}的默认职责` }));
const callbacks = new Map<number, (event: unknown) => void>();
const listeners = new Set<number>();
const teams: Record<string, RuntimeTeamInfo[]> = JSON.parse(sessionStorage.getItem("team-review") ?? "{}");
let nextReadError = false, nextCreateError = false, callbackId = 0;
function changed(sessionId: string) {
  sessionStorage.setItem("team-review", JSON.stringify(teams));
  for (const id of listeners) callbacks.get(id)?.({ payload: { sessionId } });
}
Object.assign(window, { __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} }, __TAURI_INTERNALS__: {
  transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId; },
  unregisterCallback: (id: number) => callbacks.delete(id),
  invoke: async (command: string, args: any = {}) => {
    if (command === "plugin:event|listen") { listeners.add(args.handler); return args.handler; }
    if (command === "plugin:event|unlisten") { listeners.delete(args.eventId); return; }
    if (command === "agents_list") return experts;
    if (command === "team_snapshot") {
      if (nextReadError) { nextReadError = false; throw new Error("隔离验证：读取失败"); }
      return teams[args.sessionId] ?? [];
    }
    if (command === "team_create") {
      if (nextCreateError) { nextCreateError = false; throw new Error("隔离验证：保存失败，请重试"); }
      const entries = teams[args.sessionId] ??= [];
      if (entries.some((team) => team.teamId === args.input.team_id)) throw new Error("团队名称已存在");
      entries.push({ teamId: args.input.team_id, members: args.input.members.map((member: any) => member.name), roles: Object.fromEntries(args.input.members.map((member: any) => [member.name, member.role])), description: args.input.description, createdAt: Date.now() / 1000 });
      changed(args.sessionId); return;
    }
    if (command === "team_disband") { teams[args.sessionId] = (teams[args.sessionId] ?? []).filter((team) => team.teamId !== args.teamId); changed(args.sessionId); return; }
    throw new Error(`Unexpected isolated command: ${command}`);
  },
} });
const history: ChatMessage[] = [
  { id: "user", role: "user", complete: true, parts: [{ kind: "text", text: "请使用已经有的业务分析师、代码专家、文档助手创建团队123，分别分析需求并生成代码和需求文档" }] },
  { id: "assistant", role: "assistant", promptId: "old-turn", complete: true, parts: [{ kind: "tool_call", toolCall: { toolCallId: "old-spawn", kind: "spawn_subagent", title: "分析需求", status: "completed", rawInput: { subagent_type: "业务分析师", description: "分析需求" }, content: [] } }] },
];
function Review() {
  const [sessionId, setSession] = useState("a");
  const [draft, setDraft] = useState("");
  const [detail, setDetail] = useState(false);
  return <main style={{ maxWidth: 1000, margin: "24px auto", padding: 16, color: "var(--echo-text-strong)" }}>
    <p>隔离团队交互验证 · 内存服务与真实生产组件</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button onClick={() => { setSession(sessionId === "a" ? "b" : "a"); setDraft(""); }}>切换会话</button><span>当前会话：{sessionId}</span>
      <button onClick={() => { nextReadError = true; }}>模拟读取失败</button>
      <button onClick={() => { nextCreateError = true; }}>模拟创建失败</button>
      <button onClick={() => {
        const store = useSubagentStore.getState();
        for (const [index, name] of ["业务分析师", "代码专家"].entries()) store.applyEvent({ sessionId, phase: index ? "spawned" : "finished", subagentId: `${sessionId}-${index}`, subagentType: name, description: name, status: index ? "running" : "completed" });
      }}>模拟成员执行</button>
    </div>
    <TeamStatusView sessionId={sessionId} messages={sessionId === "a" ? history : []} onUseTeam={(name) => setDraft(`请使用团队“${name}”，完成以下任务：`)} onViewTasks={() => setDetail(true)} />
    <label>任务输入<textarea aria-label="任务输入" value={draft} onChange={(event) => setDraft(event.target.value)} style={{ width: "100%" }} /></label>
    {detail && <p role="note">已打开子代理任务详情</p>}
    <p>本地专家定义：{experts.length} 个</p>
  </main>;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider><Review /></ThemeProvider>);
