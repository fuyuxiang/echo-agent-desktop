// Development-only visual fixture. Native calls use isolated in-memory data;
// this module is never imported by the production entry point.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "../../src/components/ThemeProvider";
import { SettingsPanel, type SettingsSectionId } from "../../src/components/SettingsPanel";
import { PlaceholderPage } from "../../src/components/PlaceholderPage";
import { ProjectDetailView } from "../../src/components/ProjectDetailView";
import { WorkbenchIdentity } from "../../src/features/coding/shell/WorkbenchIdentity";
import { ProjectSwitcher } from "../../src/features/coding/shell/ProjectSwitcher";
import { TaskSwitcher } from "../../src/features/coding/shell/TaskSwitcher";
import { OrganizationMemoryPanel } from "../../src/components/OrganizationMemoryPanel";
import { ChatView } from "../../src/components/ChatView";
import { SecondarySidebar } from "../../src/components/SecondarySidebar";
import { Sidebar } from "../../src/components/Sidebar";
import { AutomationEditPage } from "../../src/components/automation/AutomationEditPage";
import { AutomationPanel } from "../../src/components/AutomationPanel";
import type { Automation } from "../../src/lib/types";
import { buildDraft, draftFromAutomation } from "../../src/components/automation/schedule-utils";
import { useAutomationEditorStore } from "../../src/stores/automation-editor-store";
import { createAutomationTemplates } from "../../src/components/automation/template-config";
import { WorkspacePicker } from "../../src/components/WorkspacePicker";
import { GlobalTooltip } from "../../src/components/GlobalTooltip";
import { TasksPanel } from "../../src/components/TasksPanel";
import { MeetingMinutesPanel } from "../../src/components/MeetingMinutesPanel";
import { PermissionPicker } from "../../src/components/PermissionPicker";
import { HomePage } from "../../src/components/HomePage";
import ModalReview from "./modal-review";
import ResultReviewFixture from "./result-review";
import DetailReview from "./detail-review";
import TrustReview, { trustReviewPending, trustReviewError } from "./trust-review";
import ExecutionReviewFixture, { executionReviewTeamSnapshot, executionReviewFinalMarkdown } from "./execution-review";
import { useSessionStore } from "../../src/stores/session-store";
import { useSessionsStore } from "../../src/stores/sessions-store";
import { useProjectsStore } from "../../src/stores/projects-store";
import { useGroupStore } from "../../src/features/groups/group-store";
import { useMessageQueueStore } from "../../src/stores/message-queue-store";
import "../../src/styles/global.css";
import "../../src/styles/app.css";
import "../../src/styles/automation-echo.css";
import "../../src/styles/visual-polish.css";
import "../../src/styles/form-controls.css";
import "../../src/styles/coding-workbench.css";

const query = new URLSearchParams(location.search);
if (query.get("surface") === "runtime") query.set("executionView", "runtime");
localStorage.setItem("echoagent.theme", query.get("theme") ?? "light");
let memory = { enabled: true, initialInjectionEnabled: true, saveOnEnd: true, watcherEnabled: true,
  autoFlushEnabled: true, dreamEnabled: true, retrievalMode: "local", revision: "1",
  retrievalSummary: "仅在本机进行全文检索；摘要和整理仍使用会话模型" };
let providers: unknown[] = [];
let channels: unknown[] = [];
let automationFlowTask: Automation = { ...buildDraft(undefined, "/review/EchoAgent"), id: "review-automation", name: "保留草稿与通知导航验收任务", prompt: "整理交付报告", status: "PAUSED", createdAt: "2026-10-17T00:00:00Z" };
let automationFlowRemoved = query.get("state") === "removed";
if (query.get("surface") === "automation-flow" && automationFlowRemoved) {
  useAutomationEditorStore.getState().begin(draftFromAutomation(automationFlowTask), automationFlowTask);
}
let agents: unknown[] = [];
const extensionState = query.get("extensionState");
const extensionCount = extensionState === "long" ? 48 : ["populated", "error"].includes(extensionState ?? "") ? 3 : 0;
const extensionNames = ["需求评审", "文档整理", "数据分析"];
const extensionName = (index: number) => `${extensionNames[index % extensionNames.length]} ${String(index + 1).padStart(2, "0")}`;
if (extensionCount) agents = Array.from({ length: extensionCount }, (_, index) => ({
  name: extensionName(index), description: "检查工作目标与交付结果，整理可以继续使用的建议。", scope: "user",
  path: `/review/agents/expert-${index}.md`, raw: "检查工作目标与交付结果。", modelTags: ["default"], avatar: index % 20 + 1,
}));
let extensionSkills = Array.from({ length: extensionCount }, (_, index) => ({
  name: `review-skill-${index}`, displayName: extensionName(index), description: "梳理需求、检查实现并生成可验证的交付报告。",
  scope: index % 2 ? "plugin" : "user", enabled: true, path: `/review/skills/skill-${index}/SKILL.md`,
}));
let extensionPlugins = Array.from({ length: extensionCount }, (_, index) => ({
  id: `user/review-${index}`, name: extensionName(index), description: "提供任务所需的技能、专家与工具。",
  root: `/review/plugins/plugin-${index}`, scope: "user", enabled: true, trusted: true,
  version: "1.0.0", skillCount: 2, agentCount: 1, mcpServerCount: 1,
}));
let extensionConnectors = Array.from({ length: extensionCount }, (_, index) => ({
  name: `review-mcp-${index}`, displayName: extensionName(index), transport: "stdio", target: `review-tool-${index}`,
  enabled: true, source: "user", status: "ready", live: true, editable: true, setupValues: {}, args: [], env: {},
  tools: [{ name: "review", displayName: "检查交付结果", description: "检查需求和产物的一致性。", enabled: true }],
}));
let extensionConfig = JSON.stringify({ mcpServers: { "review-tool": { command: "review-tool" } } }, null, 2);
const extensionAttempts: Record<string, number> = {};
if (extensionState && extensionCount) useSessionStore.getState().setSession("review-extension-session");
let rules: unknown[] = [];
const orgUser = { id: "review-user", username: "review", displayName: "界面检查", role: "member", clearance: 1 };
const orgScopes = [
  { id: "mine", kind: "personal", name: "我的空间", canPublishDocuments: true },
  { id: "team", kind: "team", name: "产品研发团队", canPublishDocuments: true },
];
const orgDocuments = [
  { id: "review-docx", title: "自动化分析报告功能介绍.docx", sourceType: "docx", status: "ready", byteSize: 453740, scopeId: "team", scopeKind: "team", scopeName: "产品研发团队", ownerId: "another-user", chunkCount: 12, tags: [], updatedAt: 1 },
  { id: "review-xlsx", title: "指标体系模型设计模板.xlsx", sourceType: "xlsx", status: "ready", byteSize: 379494, scopeId: "team", scopeKind: "team", scopeName: "产品研发团队", ownerId: "another-user", chunkCount: 1899, tags: [], updatedAt: 1 },
  { id: "review-pptx", title: "指标体系构建方法论.pptx", sourceType: "pptx", status: "ready", byteSize: 1572864, scopeId: "team", scopeKind: "team", scopeName: "产品研发团队", ownerId: "another-user", chunkCount: 2, tags: [], updatedAt: 1 },
];
if (["conversation", "conversation-layout", "queue"].includes(query.get("surface") ?? "")) {
  const chat = useSessionStore.getState();
  chat.setSession("review-conversation");
  if (query.get("surface") === "queue") {
    useMessageQueueStore.setState({ queues: { "review-conversation": Array.from({ length: 20 }, (_, index) => ({
      id: `queue-review-${index}`, text: `待发送消息 ${index + 1}：核对中文文件与任务交付结果。`,
      attachments: index === 19 ? ["/review/中文附件.docx"] : [], status: "queued", createdAt: Date.now(),
    })) } });
  }
  for (const prompt of [
    "评审投影仪性能与内存泄漏，先看一下实现结构。",
    "这个服务端的启动方式是什么？",
    "手机扫码连接投影 IP 时，局域网发现怎么实现？",
    "检查蓝牙遥控器和手机端的控制逻辑。",
    "APK 打包后怎样验证 WebView 与原生服务的通信？",
    "梳理当前功能的主要风险和下一步计划。",
    "把重要结论整理成一份简短的评审记录。",
  ]) {
    chat.pushUser(prompt, [], "review-conversation");
    chat.pushAssistant("已检查相关实现，并记录了需要继续确认的细节。\n\n下一步可以针对这个问题继续深入。 ".repeat(3));
  }
  const messages = useSessionStore.getState().messages;
  chat.setSession("review-other");
  chat.setMessages(messages.map((message) => ({ ...message, id: `other-${message.id}` })));
  chat.setSession("review-conversation");
  useSessionsStore.setState({ independent: [
    { sessionId: "review-conversation", title: "请检查最新任务和运行状态", cwd: "", status: "working", pinned: true, updatedAt: new Date().toISOString() },
    { sessionId: "review-other", title: "等待授权的另外一个任务", cwd: "", status: "awaiting_permission", updatedAt: new Date().toISOString() },
    { sessionId: "review-done", title: "最近完成的历史任务", cwd: "", status: "completed", updatedAt: new Date().toISOString() },
    { sessionId: "review-news", title: "关注当天 AI 领域的重要动态", cwd: "", status: "completed", updatedAt: new Date(Date.now() - 53 * 60000).toISOString() },
    { sessionId: "review-reading", title: "趣味冷知识随机问答", cwd: "", status: "stopped", updatedAt: new Date(Date.now() - 12 * 3600000).toISOString() },
    { sessionId: "review-weather", title: "查询北京当日天气", cwd: "", status: "completed", updatedAt: new Date(Date.now() - 13 * 3600000).toISOString() },
    { sessionId: "review-choice", title: "随机挑选一个有趣的冷知识", cwd: "", status: "completed", updatedAt: new Date(Date.now() - 25 * 3600000).toISOString() },
    { sessionId: "review-model", title: "比较新模型的编程能力", cwd: "", status: "completed", updatedAt: new Date(Date.now() - 26 * 3600000).toISOString() },
    { sessionId: "review-plugin", title: "添加搜索插件并检查连接配置", cwd: "", status: "failed", updatedAt: new Date(Date.now() - 48 * 3600000).toISOString() },
    { sessionId: "review-writing", title: "部署 writing-dna skill 与验证", cwd: "", status: "completed", updatedAt: new Date(Date.now() - 72 * 3600000).toISOString() },
  ], tasksOpen: true, loading: false, currentSessionId: "review-conversation" });
}
if (query.get("surface") === "sidebar-scroll") {
  const variant = query.get("variant") ?? "both";
  const taskCount = ["projects", "short"].includes(variant) ? 2 : 54;
  const projectCount = ["tasks", "short"].includes(variant) ? 2 : 18;
  useGroupStore.setState({ groups: Array.from({length: Math.min(12, Number(query.get("groups")) || 0)}, (_, index) => ({
    id:`sidebar-group-${index}`, name:`群聊 ${index + 1}`, goal:"侧栏协作", cwd:"/review/EchoAgent", sourceSessionId:null, sourceTeamId:null,
    coordinatorId:"coordinator", members:[], messages:[], works:[], decisions:[], archived:false, pinned:false, paused:false,
    revision:1, updatedAt:12-index, maxCalls:12, tokenBudget:100000,
  })) });
  useSessionsStore.setState({
    independent: Array.from({ length: taskCount }, (_, index) => ({
      sessionId: `sidebar-task-${index}`,
      title: `任务 ${String(index + 1).padStart(2, "0")} · 检查目录与列表滚动`,
      cwd: "/review/EchoAgent",
      status: "completed" as const,
      updatedAt: new Date(Date.now() - index * 3600000).toISOString(),
    })),
    tasksOpen: true,
    projectsOpen: true,
    loading: false,
    currentSessionId: "sidebar-task-0",
  });
  useProjectsStore.setState({
    projects: Array.from({ length: projectCount }, (_, index) => ({
      id: `sidebar-project-${index}`,
      name: `项目 ${String(index + 1).padStart(2, "0")} · EchoAgent 工作区`,
      cwd: `/review/project-${index}`,
      createdAt: new Date().toISOString(),
      connectors: [], experts: [], skills: [], plans: [], tasks: [], assets: [], members: [], conversations: [],
    })),
  });
}
const callbacks = new Map();
let trustResolved = false;
let modelImportAttempts = 0;
Object.assign(window, {
  __TAURI_INTERNALS__: {
    transformCallback: (callback: unknown) => { const id = callbacks.size + 1; callbacks.set(id, callback); return id; },
    unregisterCallback: (id: number) => callbacks.delete(id),
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    invoke: async (command: string, args: any = {}) => {
      if (extensionState === "error" && ["agents_list", "skills_list", "plugins_list", "mcp_list"].includes(command)) {
        extensionAttempts[command] = (extensionAttempts[command] ?? 0) + 1;
        if (extensionAttempts[command] === 1) throw new Error("隔离验收：列表暂不可用");
      }
      switch (command) {
        case "team_snapshot": {
          if (query.get("teamState") === "error") throw new Error("隔离验收：团队快照读取失败");
          return executionReviewTeamSnapshot();
        }
        case "read_text_file": return executionReviewFinalMarkdown;
        case "path_stat": return { path: args.path, absolute: args.path, exists: true, kind: "file" };
        case "list_dir": return [];
        case "agent_list_pending_interactions": {
          const state = query.get("state") ?? "long";
          if (query.get("surface") !== "trust" || trustResolved) return { permissions: [], questions: [], planApprovals: [], folderTrustRequests: [] };
          if (state === "loading") return new Promise(() => {});
          if (state === "error") throw new Error(trustReviewError);
          return trustReviewPending(state as "short" | "long");
        }
        case "folder_trust_respond": trustResolved = true; return true;
        case "providers_list": return { providers: query.has("modelState") ? [{
          id: "review-model-provider", providerKind: "custom", label: "隔离模型连接",
          source: "personal", baseUrl: "https://review.invalid/v1", apiBackend: "chat_completions",
          authScheme: "bearer", credentialConfigured: true,
        }] : [], models: [] };
        case "providers_fetch_models_for_provider": {
          modelImportAttempts += 1;
          if (query.get("modelState") === "loading") return new Promise(() => {});
          if (query.get("modelState") === "load-error" && modelImportAttempts === 1) throw new Error("隔离验证：模型目录暂不可用");
          if (query.get("modelState") === "empty") return [];
          return Array.from({ length: 36 }, (_, index) => ({ id: `review-model-${index + 1}`, ownedBy: "隔离供应商 · 无真实模型请求" }));
        }
        case "providers_save_connection": throw new Error("隔离验证：保存失败，未写入原生配置");
        case "agents_defaults_get": return { defaultModel: "", defaultPermission: "ask", rememberToolApprovals: true };
        case "agent_auth_status": return { ready: false, providers: [], runtimeReady: false, synchronized: true, runtimeModels: [], reason: "尚未配置可用模型" };
        case "desktop_preferences_get": return { closeToTray: true, showNotificationTaskTitle: false };
        case "subagents_config_get": return { maxDepth: 2 };
        case "automations_snapshot": return { automations: query.get("surface") === "automation-flow" && !automationFlowRemoved ? [automationFlowTask] : [], records: [] };
        case "automations_save": {
          if (query.get("surface") !== "automation-flow") throw new Error("This fixture does not save automations");
          if (args.automation.id && automationFlowRemoved) throw new Error("原自动化任务已被移除");
          automationFlowTask = { ...args.automation, id: args.automation.id || "review-new-automation", createdAt: "2026-10-17T00:00:00Z" };
          automationFlowRemoved = false;
          return automationFlowTask;
        }
        case "memory_config_get": return memory;
        case "memory_list": return [
          { scope: "session", path: "2026-09-06-interval-01a074eb.md", content: "<think>The user is asking me to write a memory summary. Looking at this session, I was tasked with researching today's AI news focused on AI coding and embodied intelligence.", size: 180, revision: "r1", modifiedAt: "2026-09-06T10:00:00Z", readOnly: true },
          { scope: "session", path: "2026-09-06-interval-01a074e6.md", content: "<think>The user is asking me to write a memory summary as described in the system prompt. Let me re-read the system prompt instructions.", size: 146, revision: "r2", modifiedAt: "2026-09-06T11:00:00Z", readOnly: true },
        ];
        case "permission_mode_get": return { permissionMode: "ask", configuredPermissionMode: "ask", autoModeAvailable: true, alwaysApproveAvailable: true, locked: false, runtimeSyncState: "offline" };
        case "memory_config_save": memory = { ...memory, ...args.memory }; return memory;
        case "permission_list": return rules;
        case "permission_save": rules = args.rules; return;
        case "automation_capabilities": return { browser: { available: true, browserName: "Chrome" }, computer: { available: true, platform: "macos", screenCapture: true, inputControl: true } };
        case "storage_providers_list": return providers;
        case "storage_provider_upsert": providers = [args.config]; return;
        case "notify_channels_list": return channels;
        case "notify_channel_upsert": channels = [...channels, args.channel]; return;
        case "notify_channel_test": return { ok: true };
        case "weixin_status": return query.get("surface") === "weixin-offline"
          ? { connected: true, botId: "review-bot", activeSession: "review-session-12345678", allowedWorkspaces: ["/review/EchoAgent"], sharedSessions: [{ sessionId: "review-session-12345678", title: "准备发布说明", cwd: "/review/EchoAgent" }], pendingReplies: 3, online: false, lastError: "微信连接超时" }
          : query.get("surface") === "weixin-connected"
          ? { connected: true, botId: "review-bot", activeSession: "review-session-12345678", allowedWorkspaces: ["/review/EchoAgent"], sharedSessions: [{ sessionId: "review-session-12345678", title: "准备发布说明", cwd: "/review/EchoAgent" }], pendingReplies: 0, online: true }
          : { connected: false, allowedWorkspaces: [], sharedSessions: [], pendingReplies: 0, online: false };
        case "weixin_revoke_session": return { connected: true, botId: "review-bot", allowedWorkspaces: ["/review/EchoAgent"], sharedSessions: [], pendingReplies: 0, online: true };
        case "agent_list_workspaces": return [{ cwd: "/review/EchoAgent", sessionCount: 3 }, { cwd: "/review/设计系统", sessionCount: 2 }];
        case "weixin_qr_start": return { qrUrl: "https://weixin.qq.com/x/review-qr" };
        case "weixin_qr_poll": return { status: "expired", connected: false };
        case "agents_list": return agents;
        case "skills_list": return extensionSkills;
        case "skills_toggle": extensionSkills = extensionSkills.map(skill => skill.name === args.name ? { ...skill, enabled: args.enabled } : skill); return;
        case "mcp_list": return extensionConnectors;
        case "mcp_toggle": extensionConnectors = extensionConnectors.map(server => server.name === args.name ? { ...server, enabled: args.enabled } : server); return { warnings: [] };
        case "mcp_delete": extensionConnectors = extensionConnectors.filter(server => server.name !== args.name); return { warnings: [] };
        case "mcp_toggle_tool": extensionConnectors = extensionConnectors.map(server => server.name === args.serverName ? { ...server, tools: server.tools.map(tool => tool.name === args.toolName ? { ...tool, enabled: args.enabled } : tool) } : server); return;
        case "mcp_config_path": return "/review/mcp.json";
        case "mcp_config_read": return { filePath: "/review/mcp.json", content: extensionConfig };
        case "mcp_config_save": {
          extensionConfig = args.content;
          return { appliedLive: Boolean(args.sessionId), serverCount: Object.keys(JSON.parse(extensionConfig).mcpServers ?? {}).length, warnings: [] };
        }
        case "agents_template": return JSON.stringify(args);
        case "agents_save": {
          const entry = { ...JSON.parse(args.raw), name: args.name, path: `/review/${args.name}.md`, scope: "user", raw: args.raw };
          agents = [...agents, entry]; return entry;
        }
        case "plugins_list": return { plugins: extensionPlugins };
        case "plugins_action": extensionPlugins = extensionPlugins.map(plugin => plugin.id === args.action.pluginId ? { ...plugin, enabled: args.action.type === "enable" } : plugin); return { status: "success" };
        case "tasks_list": return [{ id: "review-task", source: "task", description: "执行代码验证和生成报告", status: "running", sessionId: args.sessionId }];
        case "org_session": return { loggedIn: true, organizationMemoryEnabled: true, serverUrl: "https://10.132.19.82:8787", user: orgUser, bootstrap: { apiVersion: 1, user: orgUser, scopes: orgScopes, policy: { allowPersonalCloud: true, allowSkillSubmission: true }, serverTime: 1 } };
        case "org_list_scopes": return orgScopes;
        case "org_list_documents": {
          const items = orgDocuments.filter((document) => !args.scopeId || document.scopeId === args.scopeId);
          return { items, total: items.length, page: 1, size: 20 };
        }
        case "org_list_memories": case "org_list_skills": case "org_skill_submissions_mine": case "org_memory_promotions_mine": return [];
        case "org_document_submissions_mine_page": return { items: [], total: 0, page: 1, size: 20 };
        case "org_fetch_document": return { docId: args.docId, text: "Sheet: 模型设计\n列(2): 指标 | 口径\n第1行: 指标=活跃用户, 口径=当日登录人数", chunks: [{ seq: 0, text: "Sheet: 模型设计\n列(2): 指标 | 口径\n第1行: 指标=活跃用户, 口径=当日登录人数" }] };
        case "plugin:event|listen": return callbacks.size;
        case "plugin:event|unlisten": return;
        case "meeting_list": return [];
        case "meeting_capture_status": return null;
        case "meeting_capture_support": return { systemAudio: true, detail: "首次使用需允许系统音频录制" };
        case "meeting_check_connection": return;
        default: return [];
      }
    },
  },
  __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener: () => {} },
});

function ConversationLayoutFixture() {
  const sessionId = useSessionStore((state) => state.sessionId);
  const [collapsed, setCollapsed] = useState(false);
  return <div style={{ display: "flex", height: "100%" }}>
    {collapsed ? <button type="button" onClick={() => setCollapsed(false)}>展开侧边栏</button> : <Sidebar
      activeNav="新建任务" onNewSession={() => {}} onNavigate={() => {}} onOpenSettings={() => {}} onOpenSearch={() => {}}
      onToggleCollapse={() => setCollapsed(true)} onSelect={(id) => {
        useSessionStore.getState().setSession(id);
        useSessionsStore.setState({ currentSessionId: id });
      }} />}
    <ChatView onSend={() => {}} onCancel={() => {}} title="聊天布局回归" />
    <TasksPanel sessionId={sessionId ?? undefined} />
  </div>;
}

function Fixture() {
  const surface = query.get("surface") ?? "memory";
  const aliases: Record<string, string> = { "技能管理": "技能", "连接器管理": "连接器", "插件管理": "插件" };
  const [label, setLabel] = useState(aliases[query.get("label") ?? ""] ?? query.get("label") ?? "专家·技能·连接器");
  const [createExpertRequested, setCreateExpertRequested] = useState(false);
  const [expertPageOpen, setExpertPageOpen] = useState(false);
  const [cwd, setCwd] = useState("/review/EchoAgent");
  const [automationNotificationSequence, setAutomationNotificationSequence] = useState(0);
  const [automationDraft, setAutomationDraft] = useState(() => buildDraft(
    createAutomationTemplates()[0], "/Users/review/Documents/EchoAgent",
  ));
  if (surface === "automation-flow") return <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
    <div style={{ padding: 8 }}><button type="button" onClick={() => setAutomationNotificationSequence(sequence => sequence + 1)}>模拟任务通知</button></div>
    <AutomationPanel cwd="/review/EchoAgent" notificationAutomationId={automationNotificationSequence ? "review-notified-task" : undefined} notificationAutomationSequence={automationNotificationSequence} />
  </div>;
  if (surface === "collapsed-project" || surface === "collapsed-capabilities") {
    const project = {
      id: "review-project", name: "SKILL安装", createdAt: new Date().toISOString(),
      connectors: [], experts: [], skills: [], plans: [], tasks: [], assets: [], members: [], conversations: [],
    };
    return <div className={`app${query.get("platform") === "mac" ? " app--macos" : ""}`}>
      <div className="app__body app__body--collapsed">
        <main className="app__main">
          <header className="main-page-controls" data-tauri-drag-region>
            <button className="main-topbar__btn" aria-label="展开侧边栏">☰</button>
            <button className="main-topbar__btn" aria-label="新建任务">＋</button>
          </header>
          {surface === "collapsed-project"
            ? <ProjectDetailView project={project} onBack={() => {}} picker={{ options: { connectors: [], experts: [], skills: [] }, loading: false, error: null }} />
            : <PlaceholderPage label="专家·技能·连接器" />}
        </main>
      </div>
    </div>;
  }
  if (surface === "automation-edit") return <div className="automation-panel echo-agent-automation"><AutomationEditPage
    mode="create" draft={automationDraft} setDraft={setAutomationDraft}
    saving={false} workspaces={[{ cwd: "/Users/review/Documents/EchoAgent", sessionCount: 9 }]}
    models={[]} skills={[]} experts={[]} connectors={[]} records={[]}
    onSave={() => {}} onClose={() => {}} onArchiveRecord={() => {}}
    onRetryRecord={() => {}} onDeleteRecord={() => {}}
  /></div>;
  if (surface === "workspace-picker") return <div style={{ height: "100%", padding: "130px 120px", background: "var(--echo-bg-secondary)" }}>
    <WorkspacePicker
      cwd={String.raw`\\?\A:\E\Taurus\Documents\EchoAgent`}
      workspaces={[
        { cwd: String.raw`\\?\A:\E\Taurus\Documents\EchoAgent`, sessionCount: 22 },
        { cwd: String.raw`\\?\A:\E\Taurus\EchoAgentWorkspace\日常`, sessionCount: 34 },
        { cwd: String.raw`\\?\A:\E\Taurus\EchoAgent\snake`, sessionCount: 5 },
      ]}
      onSelectWorkspace={() => {}}
      menuPlacement="bottom"
    />
    <GlobalTooltip />
  </div>;
  if (surface === "sidebar-scroll") return <div style={{ display: "flex", height: "100%" }}>
    <Sidebar
      activeNav="新建任务" onNewSession={() => {}} onSelect={() => {}} onNavigate={() => {}}
      onOpenSettings={() => {}} onOpenSearch={() => {}} onToggleCollapse={() => {}}
      onPlaceholder={() => {}}
    />
    <main style={{ flex: 1, background: "var(--echo-bg-secondary)" }} />
  </div>;
  if (surface === "conversation-layout") return <ConversationLayoutFixture />;
  if (surface.startsWith("modal-")) return <ModalReview variant={surface === "modal-short" ? "short" : surface === "modal-error" ? "error" : "long"} />;
  if (surface === "results") return <ResultReviewFixture />;
  if (surface === "details") return <DetailReview />;
  if (surface === "trust") return <TrustReview variant={(query.get("state") ?? "long") as "short" | "long" | "loading" | "error"} />;
  if (surface === "execution" || surface === "runtime") return <ExecutionReviewFixture />;
  if (surface === "home") return <div style={{ display: "flex", height: "100%" }}>
    <Sidebar activeNav="新建任务" onNewSession={() => {}} onSelect={() => {}} onNavigate={setLabel} onOpenSettings={() => {}} onOpenSearch={() => {}} />
    <HomePage onSend={() => {}} streaming={false} apiReady={query.get("state") !== "unconfigured"} creatingSession={query.get("state") === "loading"} sendError={query.get("state") === "error" ? "会话创建失败，请重试" : null} onOpenSettings={() => {}} onPlaceholder={() => {}} models={[{ id: "review/model", label: "评审模型", providerId: "review", providerKind: "custom" }]} modelId="review/model" cwd="/review/EchoAgent" />
  </div>;
  if (surface === "page") return <PlaceholderPage label={label} onNavigate={setLabel} cwd="/review/EchoAgent" />;
  if (surface === "capabilities") {
    const content = <PlaceholderPage label={label} onNavigate={setLabel} sessionId={extensionCount ? "review-extension-session" : undefined} />;
    if (query.get("extensionShell") !== "1") return content;
    return <div className="app"><div className="app__body">
      <Sidebar activeNav={label} onNewSession={() => {}} onNavigate={setLabel} onOpenSettings={() => {}} onOpenSearch={() => {}} onSelect={() => {}} />
      <main className="app__main">{content}</main>
    </div></div>;
  }
  if (surface === "expert-entry") return <>
    {expertPageOpen ? (
      <div style={{ height: "100%" }}>
        <button type="button" onClick={() => setExpertPageOpen(false)}>返回对话</button>
        <PlaceholderPage label={label} onNavigate={setLabel} createExpertRequested={createExpertRequested} onCreateExpertRequestHandled={() => setCreateExpertRequested(false)} />
      </div>
    ) : <div style={{ padding: 48, fontSize: 32, fontWeight: 700 }}>今天想完成什么？</div>}
    <SecondarySidebar onCreateExpert={() => { setLabel("专家·技能·连接器"); setCreateExpertRequested(true); setExpertPageOpen(true); }} />
  </>;
  if (surface === "conversation" || surface === "queue") return <div style={{ display: "flex", height: "100%" }}>
    <aside style={{ width: "min(250px, 22vw)", flex: "none", borderRight: "1px solid var(--echo-border-default)", background: "var(--echo-bg-secondary)", padding: "24px 16px", boxSizing: "border-box" }}>EchoAgent</aside>
    <ChatView onSend={() => {}} onCancel={() => {}} title="评审投影仪性能与内存泄漏" />
  </div>;
  if (surface === "organization") return <div style={{ height: "100%", overflow: "auto" }}><OrganizationMemoryPanel /></div>;
  if (surface === "meeting") return <MeetingMinutesPanel modelId="review/MiniMax-M3" models={[{ id: "review/MiniMax-M3", label: "MiniMax M3", providerId: "review", providerKind: "custom", source: "personal" }]} />;
  if (surface === "permission-picker") return <div style={{ position: "relative", height: "100%", background: "var(--echo-bg-secondary)" }}>
    <div style={{ position: "absolute", left: "46%", top: "63%" }}><PermissionPicker /></div>
  </div>;
  if (surface === "coding") return <div className="app--macos" style={{ height: "100%" }}><div className="coding-workbench coding-workbench--theia">
    <header className="coding-workbench__topbar"><WorkbenchIdentity onExit={() => {}}>
      <ProjectSwitcher activeCwd={cwd} projects={[{ cwd: "/review/EchoAgent" }, { cwd: "/review/一个名称很长但仍然可以完整查看路径的项目" }]} onSelect={setCwd} onRemove={() => {}} onOpenFolder={() => {}} />
    </WorkbenchIdentity><div /></header>
    <main className="echo-theia-workspace" />
    <div className="echo-theia-agent__splitter" />
    <aside className="echo-theia-agent"><div className="echo-theia-agent__heading">
      <TaskSwitcher
        tasks={[
          { id: "task-1", name: "修复代码开发页面菜单遮挡问题", phase: "delivered", updatedAt: "2026-09-29T10:00:00Z" },
          { id: "task-2", name: "完成任务报告并检查回归测试", phase: "stopped", updatedAt: "2026-09-29T09:00:00Z" },
          { id: "task-3", name: "继续进行中任务的开发", phase: "implementing", updatedAt: "2026-09-29T08:00:00Z" },
        ]}
        activeId={null}
        onSelect={() => {}}
        onNew={() => {}}
        onRename={() => {}}
        onDelete={() => {}}
      />
    </div></aside>
  </div></div>;
  return <SettingsPanel open initialSection={(surface === "weixin-connected" || surface === "weixin-offline" || surface === "weixin-unconnected" ? "weixin-channel" : surface) as SettingsSectionId} cwd={surface === "personal-memory" ? "/Users/fuyuxiang/Documents/EchoAgent" : undefined} onClose={() => {}} />;
}
createRoot(document.getElementById("root")!).render(<ThemeProvider><Fixture /></ThemeProvider>);
