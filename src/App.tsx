import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { Toast } from "./components/Toast";
// PermissionDialog is now inline in ChatView (PermissionInlineCard), not a global modal.
import { ThemeProvider } from "./components/ThemeProvider";
import type { SettingsSectionId } from "./components/SettingsPanel";
import { TasksPanel } from "./components/TasksPanel";
import { SecondarySidebar } from "./components/SecondarySidebar";
import { TopbarActions } from "./components/TopbarActions";
import { SidebarToggleIcon, EchoNewTaskIcon } from "./foundation/components/Icon/icons";
import type { ModelOption } from "./components/ModelSelector";
import {
  isConfiguredModelId,
  resolveConfiguredModelId,
  resolveSessionModelId,
} from "./lib/model-selection";
import { useSessionStore } from "./stores/session-store";
import { useSessionsStore } from "./stores/sessions-store";
import { usePermissionStore } from "./stores/permission-store";
import { useQuestionStore } from "./stores/question-store";
import { usePendingExpertStore } from "./stores/pending-expert-store";
import { TopbarTitle } from "./components/TopbarTitle";
import { ThumbImg } from "./components/experts-panel/shared/ThumbImg";
import {
  agentInit,
  agentNewSession,
  agentSend,
  agentCancel,
  agentLoadSession,
  agentListSessions,
  agentListWorkspaces,
  agentRenameSession,
  agentSetModel,
  agentSetSessionExpert,
  agentAuthStatus,
  sessionFork,
  togglePlanMode,
  providersList,
  flattenModels,
  filterModelsByRuntimeCatalog,
  notificationAppend,
  memoryAppend,
  internalReload,
  subscribeAgentEvents,
  type InitResult,
  type WorkspaceInfo,
} from "./lib/agent-client";
import type { AgentEntry, SessionSummary } from "./lib/types";
import { hydrateProjectsFromBackend, useProjectsStore, type ProjectMeta } from "./stores/projects-store";
import {
  useMessageQueueStore,
  hasActiveItems,
  queueTerminalPolicy,
} from "./stores/message-queue-store";
import { useSubagentStore } from "./stores/subagent-store";
import {
  checkQuota,
  consumeQuotaAlert,
  isQuotaBlocking,
  recordTurnUsage,
  loadUsage,
  loadQuotaConfig,
  type QuotaConfig,
  type UsageRecord,
} from "./lib/usage-quota";
import {
  registerTelemetryProvider,
  createConsoleTelemetryProvider,
  reportEvent,
  type TelemetryProvider,
} from "./lib/telemetry-contract";
import { defaultHttpSender, exportEventsBatch, type OtlpConfig } from "./lib/otlp-exporter";
import { IS_MACOS } from "./lib/platform";
import { friendlyError } from "./lib/error-format";
import { applySessionScopedFailure } from "./lib/session-scoped-failure";
import { isGlobalShortcutBlocked } from "./lib/keyboard-scope";
import { hydrateKnowledgeSources } from "./lib/kb-source-storage";
import { permissionModeFromEvent, usePermissionModeStore } from "./stores/permission-mode-store";
import { buildProjectPrompt } from "./lib/project-context";
import { migrateCatalogRootStorage } from "./lib/catalog-root-storage";
import { parseRememberArguments, type SlashCommandInvocation } from "./lib/slash-commands";
import { useUpdateStore } from "./stores/update-store";
import { useOrgSessionStore } from "./stores/org-session-store";
import { indexTaskArtifacts } from "./lib/artifact-catalog";
import { EXPERT_PERSONA_BEGIN, EXPERT_PERSONA_END } from "./lib/user-message";
import { beginAgentTurn } from "./lib/agent-turn";

const ChatView = lazy(() => import("./components/ChatView").then((module) => ({ default: module.ChatView })));
const SettingsPanel = lazy(() => import("./components/SettingsPanel").then((module) => ({ default: module.SettingsPanel })));
const SearchOverlay = lazy(() => import("./components/SearchOverlay").then((module) => ({ default: module.SearchOverlay })));
const AboutDialog = lazy(() => import("./components/AboutDialog").then((module) => ({ default: module.AboutDialog })));
const UpdateDialog = lazy(() => import("./components/UpdateDialog").then((module) => ({ default: module.UpdateDialog })));
const FolderTrustDialog = lazy(() => import("./components/FolderTrustDialog").then((module) => ({ default: module.FolderTrustDialog })));

function publishQuotaAlert(
  records: UsageRecord[],
  config: QuotaConfig | null,
  sessionId: string,
): void {
  const level = consumeQuotaAlert(records, config);
  if (!level || !config) return;
  const quota = checkQuota(records, config);
  const periodLabel = config.period === "daily" ? "今日" : "本月";
  const title = level === "exceeded" ? "Token 配额已达上限" : "Token 配额接近上限";
  const body = `${periodLabel}已用 ${quota.used.toLocaleString()} / ${quota.limit.toLocaleString()} Token`
    + (config.enforcement === "block" && level === "exceeded" ? "，已暂停桌面端手动发送" : "");
  void notificationAppend("quota", title, body, sessionId, level === "exceeded" ? "error" : "warn")
    .catch(() => {});
}

/**
 * Derive a short sidebar title from the user's first message.
 * Mirrors EchoAgent's `title_fallback_from_user_text`: strip system/skill markup,
 * take the first ~10 words, cap at 40 chars.
 */
function deriveTitle(text: string): string {
  // Strip <system-reminder>…</system-reminder> blocks (system-injected context).
  let clean = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  // Strip skill XML markup (<command-name>…</command-name> etc.).
  clean = clean.replace(/<\/?command-(?:name|message|args)>/g, "").trim();
  if (!clean) clean = text.trim();
  // Take first 10 whitespace-delimited words.
  const words = clean.split(/\s+/).slice(0, 10).join(" ");
  if (!words) return "新会话";
  return words.length > 40 ? words.slice(0, 40) + "…" : words;
}

/**
 * Strip YAML frontmatter (`---\n...\n---`) from a markdown agent file and
 * return only the body (the system prompt content).
 */
function extractMarkdownBody(raw: string): string {
  const trimmed = raw.trimStart();
  if (!trimmed.startsWith("---")) return raw.trim();
  const afterOpen = trimmed.indexOf("\n");
  if (afterOpen === -1) return raw.trim();
  const rest = trimmed.slice(afterOpen + 1);
  const closeIdx = rest.search(/\n---\s*(\n|$)/);
  if (closeIdx === -1) return raw.trim();
  return rest.slice(closeIdx + 1).replace(/^\n---\s*/, "").trim();
}

/** Find a session in either sidebar group without depending on a render. */
function findSessionSummary(sessionId: string): SessionSummary | undefined {
  const state = useSessionsStore.getState();
  return state.independent.find((entry) => entry.sessionId === sessionId)
    ?? Object.values(state.workspaceSessions)
      .flat()
      .find((entry) => entry.sessionId === sessionId);
}

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  const [init, setInit] = useState<InitResult | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [initAttempt, setInitAttempt] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>("model");
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [trustRequest, setTrustRequest] = useState<{ cwd?: string; reason?: string } | null>(null);
  const [taskRefreshSignal, setTaskRefreshSignal] = useState(0);
  const [commandRefreshKey, setCommandRefreshKey] = useState(0);
  const [placeholderView, setPlaceholderView] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelCatalogError, setModelCatalogError] = useState<string | null>(null);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [homeSendError, setHomeSendError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  /** Workspace selected for the next session; independent of the active session cwd. */
  const [newSessionTargetCwd, setNewSessionTargetCwd] = useState("");
  const [cancellingSessionId, setCancellingSessionId] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const modelsRef = useRef<ModelOption[]>([]);
  const authReadyRef = useRef(false);
  const promptedUpdateVersionRef = useRef<string | null>(null);
  const newSessionPendingRef = useRef(false);
  const selectionGenerationRef = useRef(0);
  const sessionCatalogGenerationRef = useRef(0);
  const modelCatalogGenerationRef = useRef(0);

  const sessionStore = useSessionStore;
  const sessionsStore = useSessionsStore;
  const permissionStore = usePermissionStore;
  const questionStore = useQuestionStore;
  const updateStatus = useUpdateStore((state) => state.status);
  const availableUpdateVersion = useUpdateStore((state) => state.update?.version);

  const openSettings = useCallback((section: SettingsSectionId = "model") => {
    setSettingsSection(section);
    setSettingsOpen(true);
  }, []);
  const resolveTrustRequest = useCallback(() => setTrustRequest(null), []);

  useEffect(() => {
    migrateCatalogRootStorage();
    void useOrgSessionStore.getState().hydrate();
    void hydrateKnowledgeSources().catch((error) => {
      console.error("[EchoAgent] Failed to hydrate knowledge sources:", error);
      setToast("知识源后端数据读取失败");
    });
    void hydrateProjectsFromBackend().catch((error) => {
      console.error("[EchoAgent] Failed to hydrate projects:", error);
      setToast("项目后端数据读取失败，已使用本地缓存");
    });
  }, []);

  // Organization hydration may race the native agent startup. Once the agent
  // channel is ready, re-advertise the final server-managed Skills and the
  // downloaded organization model so both catalogs observe the restored state.
  useEffect(() => {
    if (!init?.ok) return;
    void useOrgSessionStore.getState().hydrate()
      .then(() => Promise.all([internalReload("skills"), internalReload("models")]))
      .catch(() => {});
  }, [init?.ok]);

  // Update checks run after the shell is interactive and never block agent
  // initialization. Offline/VPN failures stay silent until the user opens the
  // updater manually from Help.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void useUpdateStore.getState().check(false);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (updateStatus !== "available" || !availableUpdateVersion) return;
    if (promptedUpdateVersionRef.current === availableUpdateVersion) return;
    promptedUpdateVersionRef.current = availableUpdateVersion;
    setUpdateDialogOpen(true);
  }, [availableUpdateVersion, updateStatus]);

  const handleCheckForUpdates = useCallback(() => {
    setUpdateDialogOpen(true);
    void useUpdateStore.getState().check(true);
  }, []);

  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  useEffect(() => {
    authReadyRef.current = !!init?.auth.ready;
  }, [init?.auth.ready]);

  /** Session/workspace discovery is recoverable and must not take down the shell. */
  const refreshSessionCatalog = useCallback(async (cwdOverride?: string) => {
    const cwd = cwdOverride ?? sessionsStore.getState().homeCwd;
    if (!cwd) return;
    const generation = ++sessionCatalogGenerationRef.current;
    const store = sessionsStore.getState();
    store.setLoading(true);
    store.setError(null);
    const [sessionResult, workspaceResult] = await Promise.allSettled([
      agentListSessions(cwd, true),
      agentListWorkspaces(),
    ]);
    if (sessionCatalogGenerationRef.current !== generation) return;
    const failures: string[] = [];
    if (sessionResult.status === "fulfilled") {
      sessionsStore.getState().setIndependent(sessionResult.value);
    } else {
      failures.push(`会话：${friendlyError(sessionResult.reason)}`);
    }
    if (workspaceResult.status === "fulfilled") {
      sessionsStore.getState().setWorkspaces(workspaceResult.value);
      setWorkspaces(workspaceResult.value);
    } else {
      failures.push(`工作区：${friendlyError(workspaceResult.reason)}`);
    }
    const latest = sessionsStore.getState();
    latest.setError(failures.length > 0 ? failures.join("；") : null);
    latest.setLoading(false);
  }, [sessionsStore]);

  /** Re-fetch providers + auth readiness after Settings add/edit/delete.
   *
   * Previously this only updated `models`, so the home Composer still saw
   * `apiReady=false` (from the cold-start `init.auth.ready`) and stayed
   * disabled with "请先配置 API Key" — looking like nothing changed.
   * Also, the first added model was never auto-selected as currentModelId.
   */
  const refreshModels = useCallback(async (preferredDefaultId?: string) => {
    const generation = ++modelCatalogGenerationRef.current;
    setModelCatalogError(null);
    try {
      const [list, auth] = await Promise.all([providersList(), agentAuthStatus()]);
      if (modelCatalogGenerationRef.current !== generation) return;
      // Show only what the Runtime can actually serve. `[models]` filters
      // (allowed_models / hidden_models / disabled_models) are applied inside
      // the Runtime, so a disk entry can be absent from its catalog — offering
      // it here would let the user pick a model the backend then refuses.
      // While the catalog is still empty (init in flight) keep the disk list, or
      // the picker would blank out on every cold start.
      const options = filterModelsByRuntimeCatalog(
        flattenModels(list),
        auth.runtimeModels,
      );
      setModels(options);
      modelsRef.current = options;

      // Never fall back an active session to a different model in the UI. The
      // backend session keeps its persisted model until set_model succeeds.
      setCurrentModelId((prev) => {
        const activeId = sessionsStore.getState().currentSessionId;
        if (activeId) {
          return resolveSessionModelId(
            options,
            findSessionSummary(activeId)?.currentModelId,
          );
        }
        return resolveConfiguredModelId(options, prev, preferredDefaultId);
      });

      // Unlock the home Composer as soon as a configured provider exists.
      setInit((prev) => (prev ? { ...prev, auth } : prev));
      authReadyRef.current = auth.ready;
    } catch (error) {
      if (modelCatalogGenerationRef.current !== generation) return;
      // Non-fatal — the picker keeps its previous list and exposes a retry.
      setModelCatalogError(friendlyError(error));
    }
  }, [sessionsStore]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    setInitError(null);

    // 开发环境保留最小化控制台遥测；生产环境不把事件属性写进 DevTools。
    const devMode = (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;
    if (devMode) {
      registerTelemetryProvider(
        createConsoleTelemetryProvider({
          sink: (e) => console.debug(`[telemetry] ${e.level.toUpperCase()} ${e.name}`),
        }),
      );
    }
    // 若用户配置了 OTLP endpoint,额外注册 OTLP 导出 provider(自托管监控)。
    const otlpEndpoint = typeof localStorage !== "undefined" ? localStorage.getItem("echoagent.otlp.endpoint") : null;
    if (otlpEndpoint) {
      const otlpConfig: OtlpConfig = { endpoint: otlpEndpoint, serviceName: "echoagent" };
      const otlpProvider: TelemetryProvider = {
        id: "otlp",
        isEnabled: () => true,
        reportEvent: (e) => {
          void exportEventsBatch([e], otlpConfig, defaultHttpSender).then((result) => {
            if (!result.ok) console.warn(`[telemetry] OTLP export failed: HTTP ${result.status}`);
          }).catch((error) => console.warn("[telemetry] OTLP export failed:", error));
        },
        reportMetric: () => {},
      };
      registerTelemetryProvider(otlpProvider);
    }
    reportEvent("app_started", "info");

    (async () => {
      try {
        const result = await agentInit();
        // EchoAgent rejects an empty cwd ("Path is not absolute"), so every session
        // needs an absolute path. We treat EchoAgent's initial cwd as the "inbox":
        // 新建任务 aims at it (⇒ 任务 group), and the user can re-aim a new
        // session at another directory via the Composer workspace picker
        // (⇒ that 空间 node). homeCwd drives the store's group routing.
        if (disposed) return;
        setNewSessionTargetCwd(result.cwd);
        sessionsStore.getState().setHomeCwd(result.cwd);
        setInit(result);
        authReadyRef.current = result.auth.ready;

        const stopListening = await subscribeAgentEvents({
          onUpdate: (u) => {
            const updateType = (u as { sessionUpdate?: string; type?: string }).sessionUpdate
              ?? (u as { type?: string }).type;
            if (updateType === "available_commands_update") {
              setCommandRefreshKey((value) => value + 1);
            }
            if (updateType === "memory_flush_completed") {
              const result = (u as { result?: string }).result;
              showToast(result ? `记忆已落盘：${result}` : "记忆已落盘");
            } else if (updateType === "memory_dream_completed") {
              const result = (u as { result?: string }).result;
              showToast(result ? `记忆整理完成：${result}` : "记忆整理完成");
            } else if (updateType === "memory_session_saved") {
              showToast("已保存会话记忆");
            }
            sessionStore.getState().applyUpdate(u);
          },
          onPermission: (p) => {
            reportEvent("permission_request", "warn", { sessionId: p.sessionId });
            permissionStore.getState().request(p);
            void notificationAppend(
              "permission",
              p.options?.[0]?.title ?? "工具执行权限请求",
              undefined,
              p.sessionId,
              "warn",
            );
          },
          onPermissionMode: (payload) => {
            const mode = permissionModeFromEvent(payload);
            if (mode) usePermissionModeStore.getState().setMode(mode);
          },
          onGitHead: (payload) => {
            void agentListWorkspaces().then((nextWorkspaces) => {
              sessionsStore.getState().setWorkspaces(nextWorkspaces);
              setWorkspaces(nextWorkspaces);
            }).catch(() => {});
            const eventSessionId = (payload as { sessionId?: string } | null)?.sessionId;
            const cwd = eventSessionId
              ? findSessionSummary(eventSessionId)?.cwd
              : findSessionSummary(sessionsStore.getState().currentSessionId ?? "")?.cwd;
            if (cwd) {
              void agentListSessions(cwd, true).then((list) => {
                if (cwd === sessionsStore.getState().homeCwd) {
                  sessionsStore.getState().setIndependent(list);
                } else {
                  sessionsStore.getState().setWorkspaceSessions(cwd, list);
                }
              }).catch(() => {});
            }
          },
          onComplete: (p) => {
            reportEvent("session_complete", "info", { sessionId: p.sessionId, stopReason: p.stopReason });
            const summary = findSessionSummary(p.sessionId);
            const queuePolicy = queueTerminalPolicy(p.stopReason);
            // prompt_complete is the authoritative terminal signal and arrives
            // before PromptRequest resolves. Settle the in-flight queue row now
            // so it cannot remain visually stuck while post-turn work finishes.
            useMessageQueueStore.getState().settleSending(
              p.sessionId,
              queuePolicy.settlement,
            );
            // Completion is routed by session id in the transcript store. This
            // also finalizes a background conversation after the user switches
            // away; side-channel sessions are not added to the sidebar because
            // they have no SessionSummary entry.
            sessionStore.getState().markComplete(p);
            if (summary) {
              sessionsStore.getState().upsert({
                sessionId: p.sessionId,
                status: queuePolicy.failed ? "failed" : "completed",
              });
              const transcript = sessionStore.getState().transcripts[p.sessionId];
              if (transcript) {
                indexTaskArtifacts(p.sessionId, summary.title, summary.cwd, transcript.messages);
              }

            }

            // Unknown side-channel sessions and failed turns must never start a
            // queued follow-up automatically.
            // A user cancellation/pause and every non-success terminal reason
            // intentionally stop queue progression. In particular, cancelled
            // must never make a paused conversation start the next prompt.
            if (!summary || !queuePolicy.autoAdvance) return;
            // Refresh the composer context-usage pill after each turn.
            // Internal/external notifications are dispatched by the Rust bridge
            // for every session (including background automation sessions).
            // 消息队列自动续发(对齐 EchoAgent message-queue):该会话若有 active
            // 队列项,取下一条继续发送,实现「回完一条自动发下一条」。
            const q = useMessageQueueStore.getState().getQueue(p.sessionId);
            if (hasActiveItems(q)) {
              const queuedModelId = resolveSessionModelId(
                modelsRef.current,
                findSessionSummary(p.sessionId)?.currentModelId,
              );
              if (!authReadyRef.current || !queuedModelId) {
                if (sessionStore.getState().sessionId === p.sessionId) {
                  sessionStore.getState().setError(
                    "⚠️ 已暂停自动续发：当前会话的模型未配置，请重新选择模型。",
                  );
                }
                sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "failed" });
                return;
              }
              const next = useMessageQueueStore.getState().claimNext(p.sessionId);
              if (next) {
                // PromptRequest resolves after the full model turn. Claim the
                // item before sending so the completion event cannot dispatch
                // this same item again while that promise is still pending.
                sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "working" });
                sessionStore.getState().pushUser(next.text, next.attachments, p.sessionId);
                sessionStore.getState().startStreaming(p.sessionId);
                agentSend(p.sessionId, next.text, next.attachments, next.text).then(() => {
                  useMessageQueueStore.getState().remove(p.sessionId, next.id);
                }).catch((e) => {
                  // Preserve a rejected queued message for retry and finalize
                  // the placeholder in the transcript it actually belongs to.
                  useMessageQueueStore.getState().setStatus(p.sessionId, next.id, "queued");
                  sessionStore.getState().markComplete({
                    sessionId: p.sessionId,
                    promptId: "",
                    stopReason: "error",
                  });
                  if (sessionStore.getState().sessionId === p.sessionId) {
                    sessionStore.getState().setError(friendlyError(e));
                  }
                  sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "failed" });
                });
              }
            }
          },
          onTurnUsage: (payload) => {
            const config = loadQuotaConfig();
            const fallbackModelId = findSessionSummary(payload.sessionId)?.currentModelId;
            const next = recordTurnUsage(loadUsage(), {
              sessionId: payload.sessionId,
              promptId: payload.promptId,
              usage: payload.usage,
              occurredAt: payload.occurredAt,
              eventId: payload.eventId,
              fallbackModelId,
            }, config ?? undefined);
            publishQuotaAlert(next, config, payload.sessionId);
          },
          onSummary: ({ sessionId, title }) => {
            // EchoAgent generated (or we renamed) a session title — update the
            // sidebar entry in place. This overrides the "新会话" placeholder
            // set optimistically in handleSendNew. Stamp updatedAt so the
            // sidebar can re-sort the freshly-active session to the top.
            sessionsStore.getState().upsert({
              sessionId,
              title,
              updatedAt: new Date().toISOString(),
            });
            // Sync title into the owning project's conversation list.
            const allProjects = useProjectsStore.getState().projects;
            for (const p of allProjects) {
              if (p.conversations.some((c) => c.sessionId === sessionId)) {
                useProjectsStore.getState().updateConversationTitle(p.id, sessionId, title);
                break;
              }
            }
            void notificationAppend(
              "summary",
              `生成会话标题：${title}`,
              undefined,
              sessionId,
              "info",
            );
          },
          onFolderTrust: (p) => {
            // EchoAgent asks the user to trust a folder before running tools.
            const req = (p ?? {}) as { cwd?: string; reason?: string };
            setTrustRequest({ cwd: req.cwd, reason: req.reason });
            void notificationAppend(
              "folder_trust",
              `请求信任文件夹：${req.cwd ?? "(unknown)"}`,
              req.reason,
              undefined,
              "warn",
            );
          },
          onPlanMode: (p) => {
            // Plan mode toggled (by us or by EchoAgent). Mirror into the session store.
            const payload = (p ?? {}) as { enabled?: boolean; sessionId?: string };
            if (typeof payload.enabled === "boolean") {
              sessionStore.getState().setPlanMode(payload.enabled, payload.sessionId);
              void notificationAppend(
                "plan_mode",
                payload.enabled ? "进入计划模式" : "退出计划模式",
                undefined,
                undefined,
                "info",
              );
            }
          },
          onMcpStatus: (p) => {
            void notificationAppend(
              "mcp_status",
              "MCP 连接器状态变化",
              typeof p === "string" ? p : JSON.stringify(p).slice(0, 200),
              undefined,
              "info",
            );
          },
          onModelsUpdate: () => {
            // EchoAgent reloaded its model catalog — keep picker + ready state in sync.
            void refreshModels();
            void notificationAppend(
              "models_update",
              "模型列表已更新",
              undefined,
              undefined,
              "info",
            );
          },
          onTaskUpdate: () => {
            // A background task changed state — bump the signal so TasksPanel refreshes.
            setTaskRefreshSignal((n) => n + 1);
            void notificationAppend(
              "task_update",
              "后台任务状态变化",
              undefined,
              undefined,
              "info",
            );
          },
          onQuestion: (q) => {
            questionStore.getState().request(q);
          },
          onAgentDied: ({ reason }) => {
            console.error('[EchoAgent] Agent thread died:', reason);
            const message = `AI 引擎异常退出：${reason}。请重启应用。`;
            setToast(`⚠️ ${message}`);
            setInit((previous) => previous
              ? {
                ...previous,
                auth: {
                  ...previous.auth,
                  ready: false,
                  runtimeReady: false,
                  synchronized: false,
                  runtimeModels: [],
                  lastRuntimeError: reason,
                  reason: message,
                },
              }
              : previous);
            authReadyRef.current = false;
            sessionStore.getState().setError(message);
            // Keep the detailed native error local: provider/runtime errors can
            // contain endpoints or filesystem paths and must not be forwarded
            // to an optional telemetry collector.
            reportEvent("agent_died", "error");
          },
          onSubagent: (e) => {
            useSubagentStore.getState().applyEvent(e);
          },
          onTurnError: (e) => {
            // EchoAgent reports mid-turn failures (429 while a tool was running,
            // connection reset, …) via prompt_complete with stopReason
            // "rate_limit"/"error". Surface a friendly message instead of
            // silently marking the turn complete.
            console.warn('[EchoAgent] Turn ended abnormally:', e);
            if (findSessionSummary(e.sessionId)) {
              sessionsStore.getState().upsert({ sessionId: e.sessionId, status: "failed" });
            }
            // Only surface for the focused session — background sessions
            // finalizing after a switch shouldn't hijack the error banner.
            const currentSessionId = sessionStore.getState().sessionId;
            if (currentSessionId && e.sessionId && e.sessionId !== currentSessionId) {
              return;
            }
            const msg =
              e.kind === "rate_limit"
                ? "⚠️ API 速率限制已触发（执行工具期间）。请等待 1-2 分钟后重试，或缩短对话上下文（新建会话）。"
                : e.detail
                  ? friendlyError(e.detail)
                  : "⚠️ 本轮执行出错，请重试。";
            sessionStore.getState().setError(msg);
            reportEvent("turn_error", "error", { sessionId: e.sessionId, kind: e.kind });
          },
        });
        if (disposed) {
          stopListening();
          return;
        }
        unlisten = stopListening;

        // These catalogs fail independently. Keep the shell usable and expose
        // local retry controls instead of converting a disk/index hiccup into a
        // fatal initialization screen.
        void refreshSessionCatalog(result.cwd);
        void refreshModels(result.defaultModelId);
      } catch (e) {
        if (!disposed) setInitError(friendlyError(e));
      }
    })();
    return () => {
      disposed = true;
      if (unlisten) unlisten();
    };
  }, [
    initAttempt,
    sessionStore,
    sessionsStore,
    permissionStore,
    questionStore,
    refreshModels,
    refreshSessionCatalog,
  ]);

  const currentSessionId = sessionsStore((s) => s.currentSessionId);
  // The active session's sidebar entry (title + cwd), looked up across the
  // 任务 + 空间 groups — drives the topbar title on the conversation page and
  // the cwd scoping of a manual rename (mirrors EchoAgent's topbar).
  const currentEntry = sessionsStore((s) => {
    const id = s.currentSessionId;
    if (!id) return undefined;
    const inTasks = s.independent.find((x) => x.sessionId === id);
    if (inTasks) return inTasks;
    for (const cwd of Object.keys(s.workspaceSessions)) {
      const hit = s.workspaceSessions[cwd].find((x) => x.sessionId === id);
      if (hit) return hit;
    }
    return undefined;
  });
  const currentTitle = currentEntry?.title || "";
  const activeSessionCwd = currentEntry?.cwd;
  const streaming = sessionStore((s) => s.streaming);
  const newSessionModelId = resolveConfiguredModelId(models, currentModelId);
  const activeSessionModelId = resolveSessionModelId(models, currentModelId);
  const modelConfigured = currentSessionId
    ? activeSessionModelId !== undefined
    : newSessionModelId !== undefined;
  const chatReady = !!init?.auth.ready && !!activeSessionModelId && !modelSwitching;
  const runtimeSetupHint = init?.auth.reason ?? "请先在「设置 → 模型」配置 API Key";
  const chatSetupHint = modelSwitching
    ? "正在切换模型…"
    : models.length === 0
      ? "请先在「设置 → 模型」配置模型"
      : !activeSessionModelId
        ? "此会话的模型未配置，请在右下角重新选择模型"
        : runtimeSetupHint;

  const showToast = (message: string, durationMs = 2000) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), durationMs);
  };

  const requireConfiguredModel = (): string | undefined => {
    if (!init?.auth.ready) {
      showToast(runtimeSetupHint, 5000);
      openSettings("model");
      return undefined;
    }
    if (newSessionModelId) return newSessionModelId;
    showToast("请先在「设置 → 模型」配置模型");
    openSettings("model");
    return undefined;
  };
  const handleNavigate = (label: string) => {
    if (label === "用量统计") {
      openSettings("usage");
      return;
    }
    selectionGenerationRef.current += 1;
    setPlaceholderView(label);
    sessionsStore.getState().setCurrent(null);
    sessionStore.getState().reset();
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };
  const handlePlaceholder = (label: string) => {
    // Route a few sidebar shortcut buttons to real panels instead of toasts.
    if (label === "用户中心") {
      handleNavigate("组织");
      return;
    }
    if (label === "通知") {
      // Open the settings → 通知中心 tab where all EchoAgent
      // events are logged.
      openSettings("agent-mail");
      return;
    }
    showToast(`${label} 即将上线`);
  };

  // Sidebar project node click → open the Projects panel with that project selected.
  const handleOpenProjectFromSidebar = (projectId: string) => {
    useProjectsStore.getState().setActiveProjectId(projectId);
    handleNavigate("项目");
  };

  const ensureQuotaAllowsSend = (): boolean => {
    const config = loadQuotaConfig();
    if (!isQuotaBlocking(loadUsage(), config)) return true;
    const quota = checkQuota(loadUsage(), config!);
    showToast(`已达 ${quota.limit.toLocaleString()} Token 配额，请先在「用量统计」调整上限或策略`);
    return false;
  };

  const handleSendNew = async (text: string, attachments: string[] = []): Promise<boolean> => {
    // Composer also locks its button while this promise is pending, but this
    // app-level guard survives a view remount and protects every programmatic
    // caller from creating duplicate sessions for one submission.
    if ((!text.trim() && attachments.length === 0) || newSessionPendingRef.current) return false;
    const modelId = requireConfiguredModel();
    if (!modelId) return false;
    if (!ensureQuotaAllowsSend()) return false;
    newSessionPendingRef.current = true;
    setCreatingSession(true);
    setHomeSendError(null);
    try {
      const cwd = newSessionTargetCwd;
      const sessionId = await agentNewSession(cwd, modelId);
      setCurrentModelId(modelId);
      sessionsStore.getState().setCurrent(sessionId);
      setPlaceholderView(null);
      sessionsStore.getState().upsert({
        sessionId,
        title: deriveTitle(text),
        cwd,
        status: "working",
        currentModelId: modelId,
      });
      sessionStore.getState().setSession(sessionId);

      // Check for pending expert — inject persona invisibly.
      const pending = usePendingExpertStore.getState().expert;
      let textForAgent = text;
      if (pending && pending.prompt) {
        // Wrap persona in hidden markers. EchoAgent sees it as instructions;
        // MessageItem strips it from display on history replay.
        textForAgent = `${EXPERT_PERSONA_BEGIN}\n${pending.prompt}\n${EXPERT_PERSONA_END}\n\n${text}`;
        // Bind expert to session for persistence + UI badge.
        agentSetSessionExpert(sessionId, pending.expertId, pending.name, pending.source, pending.avatarLocal)
          .catch(() => {});
        sessionsStore.getState().upsert({ sessionId, expertId: pending.expertId, expertName: pending.name, expertAvatar: pending.avatarLocal });
        usePendingExpertStore.getState().clear();
      }

      const accepted = beginAgentTurn({
        sessionId,
        promptText: textForAgent,
        displayText: text,
        attachments,
      });
      if (!accepted) return false;
      setHomeSendError(null);
      return true;
    } catch (e) {
      console.error('[EchoAgent] handleSendNew error:', e);
      const error = friendlyError(e);
      setHomeSendError(error);
      showToast(`创建会话失败：${error}`, 6000);
      return false;
    } finally {
      newSessionPendingRef.current = false;
      setCreatingSession(false);
    }
  };

  const handleSendCurrent = async (text: string, attachments: string[] = []): Promise<boolean> => {
    if (!text.trim() && attachments.length === 0) return false;
    if (!currentSessionId) return handleSendNew(text, attachments);
    // Guard against double-send / send-during-streaming. Composer also guards
    // via its `streaming` prop, but that value can be stale within the same
    // render tick; the store flag is the source of truth. A second pushUser +
    // startStreaming would orphan an empty placeholder that never completes.
    if (sessionStore.getState().streaming) return false;
    if (modelSwitching) {
      showToast("正在切换模型，请稍候");
      return false;
    }
    if (!init?.auth.ready) {
      showToast(runtimeSetupHint, 5000);
      openSettings("model");
      return false;
    }
    if (!activeSessionModelId) {
      showToast("当前会话的模型未配置，请先在输入框右下角重新选择模型");
      return false;
    }
    if (!ensureQuotaAllowsSend()) return false;
    try {
      // A conversation created from the project node may intentionally be
      // empty. Bind the project contract to its first real user turn so the
      // session does not silently behave like an ordinary workspace chat.
      const project = useProjectsStore.getState().projects.find((item) =>
        item.conversations.some((conversation) => conversation.sessionId === currentSessionId),
      );
      const isFirstUserTurn = !sessionStore.getState().messages.some(
        (message) => message.role === "user",
      );
      const textForAgent = project && isFirstUserTurn
        ? buildProjectPrompt(project, text)
        : text;
      const accepted = beginAgentTurn({
        sessionId: currentSessionId,
        promptText: textForAgent,
        displayText: text,
        attachments,
      });
      if (!accepted) {
        showToast("当前会话已切换，请重新发送");
        return false;
      }
      return true;
    } catch (e) {
      sessionStore.getState().rollbackPendingTurn();
      sessionStore.getState().setError(friendlyError(e));
      sessionsStore.getState().upsert({ sessionId: currentSessionId, status: "failed" });
      return false;
    }
  };

  const handleCancel = async (): Promise<boolean> => {
    if (!currentSessionId || cancellingSessionId) return false;
    const sessionId = currentSessionId;
    setCancellingSessionId(sessionId);
    try {
      await agentCancel(sessionId);
      // Don't rely on the backend emitting a terminal event for a fast cancel.
      // Only finalize locally after the cancel request was actually accepted.
      sessionStore.getState().stopStreaming(sessionId);
      useMessageQueueStore.getState().settleSending(sessionId, "consume");
      return true;
    } catch (e) {
      if (sessionStore.getState().sessionId === sessionId) {
        sessionStore.getState().setError(friendlyError(e));
      }
      showToast(`停止失败：${friendlyError(e)}`, 5000);
      return false;
    } finally {
      setCancellingSessionId((pending) => pending === sessionId ? null : pending);
    }
  };

  // Topbar title rename — EchoAgent's `echo.agent/session/rename`. EchoAgent broadcasts
  // SessionSummaryGenerated on success (agent://summary → onSummary upserts the
  // same entry); we also upsert optimistically to avoid a flicker while the
  // event round-trips. On failure we rethrow so TopbarTitle reverts its draft.
  const handleRenameTitle = async (newTitle: string) => {
    if (!currentEntry) return;
    try {
      await agentRenameSession(currentEntry.sessionId, newTitle, currentEntry.cwd);
      sessionsStore.getState().upsert({
        sessionId: currentEntry.sessionId,
        title: newTitle,
      });
    } catch (e) {
      showToast(`重命名失败：${String(e).replace(/^Error:\s*/, "")}`);
      throw e;
    }
  };

  // Model picker: switch the current session's model via EchoAgent's set_model.
  // If there's no session yet, we just remember the choice and apply it in
  // handleSendNew when the session is created.
  const handleModelChange = async (modelId: string) => {
    if (!isConfiguredModelId(models, modelId)) {
      showToast("该模型已不在配置列表中");
      return;
    }
    if (!currentSessionId) {
      setCurrentModelId(modelId);
      return;
    }
    if (modelSwitching) return;

    const sessionId = currentSessionId;
    const commit = () => {
      sessionsStore.getState().upsert({
        sessionId,
        currentModelId: modelId,
      });
      if (sessionsStore.getState().currentSessionId === sessionId) {
        setCurrentModelId(modelId);
        sessionStore.getState().setError(null);
      }
    };
    setModelSwitching(true);
    // EchoAgent only knows about sessions it has *loaded* into memory. A session
    // picked from the sidebar (agent_list_sessions) isn't loaded until
    // agentLoadSession runs, and after an agent restart even a freshly-used
    // session can be gone. set_session_model then fails with
    // "unknown session id". Recover transparently: load the session into the
    // agent (replaying its history) and retry the switch once.
    const trySet = () => agentSetModel(sessionId, modelId);
    try {
      await trySet();
      commit();
    } catch (e) {
      const msg = String(e);
      // Incompatible harness is a hard error — loading won't help.
      if (/incompatible|start_new_session/i.test(msg)) {
        showToast("该会话无法切换到此模型，请新建会话");
        return;
      }
      // Session genuinely unknown to EchoAgent — load it (with its own cwd) then
      // retry. currentEntry carries the cwd the session belongs to.
      if (/unknown session/i.test(msg)) {
        try {
          const sessionCwd = findSessionSummary(sessionId)?.cwd;
          if (!sessionCwd) {
            showToast("模型切换失败：无法确定当前会话的工作区");
            return;
          }
          await agentLoadSession(sessionId, sessionCwd);
          await trySet();
          commit();
          return;
        } catch (e2) {
          showToast(`模型切换失败：${String(e2).replace(/^Error:\s*/, "")}`);
          return;
        }
      }
      showToast(`模型切换失败：${msg.replace(/^Error:\s*/, "")}`);
    } finally {
      setModelSwitching(false);
    }
  };

  // Workspace picker: only re-aim the "target cwd" for the NEXT new session.
  // In the two-section model the sidebar already shows every workspace, so we
  // must NOT clear the current transcript or rebuild the list here — picking a
  // directory just decides which group the next 新建任务 lands in (empty =
  // 任务 group, a real dir = that 空间 node).
  // No agent re-init is needed: spawn_agent_runtime ignores its cwd and every session
  // carries its own cwd at new_session/load_session time.
  const handleSelectWorkspace = (newCwd: string) => {
    setNewSessionTargetCwd(newCwd);
    // Refresh the workspace list so a freshly picked directory appears in the
    // picker and sidebar without requiring an app restart.
    void agentListWorkspaces().then((ws) => {
      sessionsStore.getState().setWorkspaces(ws);
      setWorkspaces(ws);
    }).catch(() => {/* non-fatal */});
    // Refresh the sidebar's session list for the newly picked cwd (list_sessions
    // already filters by cwd server-side). Picking the inbox cwd refreshes the
    // 任务 group; any other cwd loads + expands that 空间 node immediately,
    // instead of waiting for the user to expand it.
    if (!newCwd) return;
    void agentListSessions(newCwd, true)
      .then((list) => {
        const store = sessionsStore.getState();
        if (newCwd === store.homeCwd) {
          store.setIndependent(list);
        } else {
          store.setWorkspaceSessions(newCwd, list);
          store.setExpanded(newCwd, true);
        }
      })
      .catch(() => {/* non-fatal */});
  };

  const handleNewSession = () => {
    selectionGenerationRef.current += 1;
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(null);
    sessionStore.getState().reset();
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };

  /** Navigate to home page without resetting session state (used after expert summon). */
  const handleGoHome = () => {
    selectionGenerationRef.current += 1;
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(null);
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };

  const leaveSessionIfCurrent = (sessionId: string) => {
    if (sessionsStore.getState().currentSessionId !== sessionId) return;
    selectionGenerationRef.current += 1;
    sessionsStore.getState().setCurrent(null);
    sessionStore.getState().reset();
    setPlaceholderView(null);
    setCurrentModelId((previous) => resolveConfiguredModelId(models, previous));
  };

  const handleSessionArchived = (sessionId: string, archived: boolean) => {
    sessionsStore.getState().upsert({ sessionId, archived });
    useProjectsStore.getState().setSessionArchived(sessionId, archived);
    if (archived) leaveSessionIfCurrent(sessionId);
  };

  const handleSessionDeleted = (sessionId: string) => {
    useProjectsStore.getState().removeSessionReferences(sessionId);
    leaveSessionIfCurrent(sessionId);
  };

  // Application-level shortcuts shown in Settings. Composer-specific Enter,
  // Shift+Enter, slash and @ behavior stays scoped to the input component.
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
      // A modal owns the keyboard while it is open. This also covers dialogs
      // mounted inside ChatView (for example message feedback), not just Shell
      // state, and prevents shortcuts from mutating content behind an overlay.
      if (isGlobalShortcutBlocked()) return;
      const key = event.key.toLowerCase();
      if (key === "n") {
        event.preventDefault();
        setSettingsOpen(false);
        setSearchOpen(false);
        handleNewSession();
      } else if (key === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === ",") {
        event.preventDefault();
        openSettings("model");
      } else if (key === "b") {
        event.preventDefault();
        setSidebarCollapsed((value) => !value);
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [models]);

  // 空间节点展开/折叠: 记录展开态, 首次展开时懒加载该 cwd 的子会话。
  const handleToggleWorkspace = async (cwd: string, next: boolean) => {
    sessionsStore.getState().setExpanded(cwd, next);
    if (next && sessionsStore.getState().workspaceSessions[cwd] === undefined) {
      try {
        const list = await agentListSessions(cwd, true);
        sessionsStore.getState().setWorkspaceSessions(cwd, list);
      } catch (e) {
        showToast(`加载空间会话失败：${String(e)}`);
      }
    }
  };

  const handleSelectSession = async (sessionId: string, sessionCwd?: string) => {
    const generation = ++selectionGenerationRef.current;
    let entry = findSessionSummary(sessionId);
    // FTS/project/automation links may point at a session whose workspace node
    // has never been expanded. Hydrate the complete summary before navigating
    // so title, model and cwd are all authoritative.
    if (!entry) {
      if (!sessionCwd) {
        showToast("无法打开会话：缺少所属工作区信息", 5000);
        return;
      }
      try {
        const list = await agentListSessions(sessionCwd, true);
        if (selectionGenerationRef.current !== generation) return;
        const store = sessionsStore.getState();
        if (sessionCwd === store.homeCwd) store.setIndependent(list);
        else store.setWorkspaceSessions(sessionCwd, list);
        entry = list.find((item) => item.sessionId === sessionId);
      } catch (error) {
        if (selectionGenerationRef.current === generation) {
          showToast(`加载会话信息失败：${friendlyError(error)}`, 6000);
        }
        return;
      }
    }
    if (selectionGenerationRef.current !== generation) return;
    if (!entry) {
      showToast("无法打开会话：会话不存在、已归档或当前无权访问", 5000);
      return;
    }
    if (entry.archived) {
      showToast("请先在会话操作菜单中恢复该归档会话");
      return;
    }
    const persistedModelId = entry.currentModelId;
    const selectedModelId = resolveSessionModelId(models, persistedModelId);
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(sessionId);
    // Reflect the model actually persisted by this session. Do not fall back to
    // the first configured model: that would only change the picker, not the
    // backend session, and could route the next prompt to stale runtime settings.
    setCurrentModelId(selectedModelId);
    // setSession no longer wipes the transcript — it just moves focus. If we
    // already have a cached transcript for this session it arms replay
    // suppression so EchoAgent's history re-stream can't duplicate/merge it; if we
    // don't (first open / post-restart) the upcoming replay fills the empty
    // transcript. Either way the focused mirror is refreshed in one step.
    sessionStore.getState().setSession(sessionId);
    try {
      // Load with the session's OWN cwd (independent sessions have cwd="").
      // Viewing a 空间 child must NOT re-aim the new-session target directory.
      await agentLoadSession(sessionId, entry.cwd);
      const transcript = sessionStore.getState().transcripts[sessionId];
      if (transcript) {
        indexTaskArtifacts(
          sessionId,
          entry.title ?? "未命名任务",
          entry.cwd,
          transcript.messages,
        );
      }
      if (!selectedModelId && sessionsStore.getState().currentSessionId === sessionId) {
        sessionStore.getState().setError(
          persistedModelId
            ? `⚠️ 此会话绑定的模型「${persistedModelId}」尚未配置。请在输入框右下角选择已配置模型后再发送。`
            : "⚠️ 无法确定此会话的模型。请在输入框右下角重新选择模型后再发送。",
        );
      }
      // Populate the context-usage pill for the freshly loaded session.
    } catch (e) {
      if (sessionsStore.getState().currentSessionId === sessionId) {
        sessionStore.getState().setError(friendlyError(e));
      }
    } finally {
      // Replay window is over: a *new* turn's updates for this session must be
      // ingested again. (No-op when there was no cached transcript to suppress.)
      sessionStore.getState().clearReplaySuppression(sessionId);
    }
  };

  // Rewind rewrites the backend history, so our cached transcript is stale —
  // drop it and reload from EchoAgent so the UI matches the rolled-back state.
  const handleRewound = async (rewoundSessionId: string) => {
    const entry = findSessionSummary(rewoundSessionId);
    sessionStore.getState().dropSessionCache(rewoundSessionId);
    // Rewind may finish after the user switches away. The old cache still has
    // to be invalidated, but must not steal focus or surface errors in the new chat.
    if (sessionsStore.getState().currentSessionId !== rewoundSessionId) return;
    if (!entry?.cwd) {
      sessionStore.getState().setError("无法重载回溯会话：缺少工作区信息");
      return;
    }
    sessionStore.getState().setSession(rewoundSessionId);
    try {
      await agentLoadSession(rewoundSessionId, entry.cwd);
    } catch (error) {
      if (sessionsStore.getState().currentSessionId === rewoundSessionId) {
        sessionStore.getState().setError(friendlyError(error));
      }
    }
  };

  // Fork copies the session to a new id — jump to it so the user sees the
  // branch they just created (and it appears in the sidebar).
  const handleForked = (newId: string, sourceSessionId: string, sourceCwd?: string) => {
    const source = findSessionSummary(sourceSessionId);
    const cwd = source?.cwd ?? sourceCwd;
    if (!cwd) {
      showToast("分叉已创建，但缺少工作区信息，请刷新会话列表");
      void refreshSessionCatalog();
      return;
    }
    const modelId = resolveSessionModelId(models, source?.currentModelId);
    sessionsStore.getState().upsert({
      sessionId: newId,
      title: source?.title ? `${source.title}（分叉）` : "分叉会话",
      cwd,
      currentModelId: modelId,
    });
    // A slow fork must not hijack a conversation the user selected meanwhile.
    if (sessionsStore.getState().currentSessionId !== sourceSessionId) return;
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(newId);
    sessionStore.getState().setSession(newId);
    void agentLoadSession(newId, cwd).catch((e) => {
      if (sessionsStore.getState().currentSessionId === newId) {
        sessionStore.getState().setError(friendlyError(e));
      }
    });
  };

  /** Execute commands owned by the desktop shell. Runtime commands and Skills
   *  never reach this switch; Composer sends those through ACP unchanged. */
  const handleClientSlashCommand = async ({
    name,
    args,
  }: SlashCommandInvocation): Promise<boolean> => {
    switch (name) {
      case "new":
      case "clear":
        setSettingsOpen(false);
        setSearchOpen(false);
        handleNewSession();
        return true;
      case "search":
      case "history":
        setSearchOpen(true);
        return true;
      case "help":
        openSettings("help");
        return true;
      case "model":
        openSettings("model");
        return true;
      case "settings": {
        const aliases: Record<string, SettingsSectionId> = {
          "": "model",
          model: "model",
          agent: "agent-settings",
          memory: "memory",
          security: "security",
          help: "help",
          shortcuts: "shortcuts",
          data: "data",
          usage: "usage",
          general: "general",
          notifications: "agent-mail",
        };
        const section = aliases[args.toLowerCase()];
        if (!section) {
          showToast("用法：/settings model|agent|memory|usage|security|help");
          return false;
        }
        openSettings(section);
        return true;
      }
      case "projects":
        handleNavigate("项目");
        return true;
      case "agents":
        handleNavigate("专家·技能·连接器");
        return true;
      case "skills":
        handleNavigate("技能");
        return true;
      case "connectors":
        handleNavigate("连接器");
        return true;
      case "automation":
        handleNavigate("自动化");
        return true;
      case "marketplace":
        handleNavigate("插件市场");
        return true;
      case "usage":
        handleNavigate("用量统计");
        return true;
      case "remember": {
        const remember = parseRememberArguments(args);
        if (!remember) {
          showToast("用法：/remember [global|workspace] <内容>");
          return false;
        }
        const activeId = sessionsStore.getState().currentSessionId;
        const memoryCwd = activeId
          ? findSessionSummary(activeId)?.cwd
          : newSessionTargetCwd;
        if (!memoryCwd) {
          showToast("无法确定当前工作区，记忆未保存");
          return false;
        }
        await memoryAppend(remember.scope, remember.content, memoryCwd);
        showToast(remember.scope === "global" ? "已保存到全局记忆" : "已保存到当前工作区记忆");
        return true;
      }
      case "plan": {
        const sessionId = sessionsStore.getState().currentSessionId;
        if (!sessionId) {
          showToast("/plan 需要先创建会话");
          return false;
        }
        const normalized = args.toLowerCase();
        if (normalized && !["on", "off", "toggle"].includes(normalized)) {
          showToast("用法：/plan [on|off]");
          return false;
        }
        const current = sessionStore.getState().planMode;
        const enabled = normalized === "on"
          ? true
          : normalized === "off"
            ? false
            : !current;
        await togglePlanMode(sessionId, enabled);
        showToast(enabled ? "已请求开启计划模式" : "已请求关闭计划模式");
        return true;
      }
      case "fork": {
        const sessionId = sessionsStore.getState().currentSessionId;
        if (!sessionId) {
          showToast("/fork 需要先创建会话");
          return false;
        }
        const source = findSessionSummary(sessionId);
        const cwd = source?.cwd;
        if (!cwd) {
          showToast("无法分叉：当前会话缺少工作区信息");
          return false;
        }
        const newId = await sessionFork(sessionId, cwd);
        handleForked(newId, sessionId, cwd);
        showToast(`已分叉到新会话 ${newId.slice(0, 8)}`);
        return true;
      }
      case "rename": {
        const sessionId = sessionsStore.getState().currentSessionId;
        const entry = sessionId ? findSessionSummary(sessionId) : undefined;
        if (!sessionId || !entry) {
          showToast("/rename 需要当前会话");
          return false;
        }
        if (!args.trim()) {
          showToast("用法：/rename <新标题>");
          return false;
        }
        await agentRenameSession(sessionId, args.trim(), entry.cwd);
        sessionsStore.getState().upsert({ sessionId, title: args.trim() });
        showToast("会话已重命名");
        return true;
      }
      default:
        // The command catalog and this executor are deliberately kept in one
        // typed contract; returning false preserves the user's input if a new
        // command is added without its action being wired.
        showToast(`未实现的桌面命令：/${name}`);
        return false;
    }
  };

  // Select an expert from the + menu (chat or home composer). Instead of
  // immediately creating a session, set the pending expert and go home so the
  // user can type their message with the expert badge visible.
  const handleStartWithExpert = (
    agent: AgentEntry,
    _meta?: { expertId?: string; source?: string },
  ) => {
    const promptBody = agent.raw
      ? extractMarkdownBody(agent.raw)
      : agent.description ?? "";
    usePendingExpertStore.getState().set({
      name: agent.name,
      prompt: promptBody,
      description: agent.description ?? agent.name,
      expertId: _meta?.expertId ?? agent.name,
      source: _meta?.source ?? agent.scope ?? "local",
    });
    handleGoHome();
  };

  // 进入本地项目：把种子会话瞄到项目关联目录（使其归入对应空间节点），
  // 新建会话并注入项目说明作为种子消息。
  const handleStartProject = async (project: ProjectMeta) => {
    const modelId = requireConfiguredModel();
    if (!modelId) return;
    if (!ensureQuotaAllowsSend()) return;
    let startedSessionId: string | undefined;
    try {
      setPlaceholderView(null);
      const cwd = project.cwd || newSessionTargetCwd;
      const sessionId = await agentNewSession(cwd, modelId);
      startedSessionId = sessionId;
      setCurrentModelId(modelId);
      sessionsStore.getState().setCurrent(sessionId);
      sessionsStore.getState().upsert({
        sessionId,
        title: project.name,
        cwd,
        status: "working",
        currentModelId: modelId,
      });
      sessionStore.getState().setSession(sessionId);
      // Register the session as a project conversation.
      useProjectsStore.getState().addConversation(project.id, {
        sessionId,
        title: project.name,
        createdAt: new Date().toISOString(),
      });
      const seed = `开始「${project.name}」项目，请先根据项目配置确认目标、约束和下一步。`;
      sessionStore.getState().pushUser(seed);
      sessionStore.getState().startStreaming();
      await agentSend(sessionId, buildProjectPrompt(project, seed), [], seed);
    } catch (e) {
      if (startedSessionId) {
        applySessionScopedFailure({
          failedSessionId: startedSessionId,
          currentSessionId: sessionStore.getState().sessionId,
          message: friendlyError(e),
          setStatus: (sessionId, status) => sessionsStore.getState().upsert({ sessionId, status }),
          setCurrentError: (message) => sessionStore.getState().setError(message),
        });
      }
      showToast(`启动项目失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  // 在项目中新建对话（从侧栏 + 按钮或项目详情页 Composer 触发）。
  // 创建 EchoAgent 会话 → 注册到项目 conversations → 打开 ChatView → 可选发送首条消息。
  const handleStartProjectConversation = async (projectId: string, message?: string) => {
    const project = useProjectsStore.getState().projects.find((p) => p.id === projectId);
    if (!project) return;
    const modelId = requireConfiguredModel();
    if (!modelId) return;
    if (message && !ensureQuotaAllowsSend()) return;
    let startedSessionId: string | undefined;
    try {
      const cwd = project.cwd || newSessionTargetCwd;
      const sessionId = await agentNewSession(cwd, modelId);
      startedSessionId = sessionId;

      const title = message ? deriveTitle(message) : `${project.name} 对话`;

      // Register conversation in the project.
      useProjectsStore.getState().addConversation(projectId, {
        sessionId,
        title,
        createdAt: new Date().toISOString(),
      });

      // Navigate to chat view.
      setPlaceholderView(null);
      setCurrentModelId(modelId);
      sessionsStore.getState().setCurrent(sessionId);
      sessionsStore.getState().upsert({
        sessionId,
        title,
        cwd,
        status: message ? "working" : "pending",
        currentModelId: modelId,
      });
      sessionStore.getState().setSession(sessionId);

      if (message) {
        // Every new runtime session needs the project contract; previous
        // project conversations do not share an ACP context window.
        const prompt = buildProjectPrompt(project, message);
        sessionStore.getState().pushUser(message);
        sessionStore.getState().startStreaming();
        await agentSend(sessionId, prompt, [], message);
      }
      return sessionId;
    } catch (e) {
      if (startedSessionId) {
        applySessionScopedFailure({
          failedSessionId: startedSessionId,
          currentSessionId: sessionStore.getState().sessionId,
          message: friendlyError(e),
          setStatus: (sessionId, status) => sessionsStore.getState().upsert({ sessionId, status }),
          setCurrentError: (message) => sessionStore.getState().setError(message),
        });
      }
      showToast(`创建项目对话失败：${String(e).replace(/^Error:\s*/, "")}`);
      return undefined;
    }
  };

  const activeNav = placeholderView ?? (currentSessionId ? "" : "新建任务");

  return (
    <div className={"app" + (IS_MACOS ? " app--macos" : "")}>
      {/* macOS 使用系统原生 Overlay 标题栏(红绿灯 + 原生菜单栏),
          不再渲染自绘 TitleBar;Windows/Linux 保持自绘。 */}
      {!IS_MACOS && (
        <TitleBar
          onPlaceholder={handlePlaceholder}
          onShowAbout={() => setAboutOpen(true)}
          onCheckForUpdates={handleCheckForUpdates}
        />
      )}
      <div className={"app__body" + (sidebarCollapsed ? " app__body--collapsed" : "")}>
        <Sidebar
          onNewSession={handleNewSession}
          onSelect={handleSelectSession}
          onNavigate={handleNavigate}
          onOpenSettings={() => openSettings("model")}
          onToggleCollapse={() => setSidebarCollapsed(true)}
          onToggleWorkspace={handleToggleWorkspace}
          onOpenSearch={() => setSearchOpen(true)}
          onPlaceholder={handlePlaceholder}
          onToast={showToast}
          onOpenProject={handleOpenProjectFromSidebar}
          onStartProjectConversation={handleStartProjectConversation}
          onSessionArchived={handleSessionArchived}
          onSessionDeleted={handleSessionDeleted}
          onRetrySessions={() => void refreshSessionCatalog()}
          activeNav={activeNav}
        />
        <main className="app__main">
          {/* 全局 topbar 仅对话页需要：会话标题 +（侧栏折叠时）展开/新建。
              首页、项目、自动化等其它页面不占 48px，各自顶栏贴顶即可。
              侧栏折叠且非对话页时，用悬浮按钮提供展开入口。
              注:Tauri 2 只认 data-tauri-drag-region(CSS 的 -webkit-app-region
              不生效);按钮等子元素不是拖拽目标,不影响点击。 */}
          {!placeholderView && currentSessionId ? (
            <header className="main-topbar" data-tauri-drag-region>
              <div className="main-topbar__left">
                {sidebarCollapsed && (
                  <>
                    <button
                      className="main-topbar__btn"
                      aria-label="展开侧边栏"
                      data-tip="展开侧边栏"
                      onClick={() => setSidebarCollapsed(false)}
                    >
                      <SidebarToggleIcon size="md" />
                    </button>
                    <button
                      className="main-topbar__btn"
                      aria-label="新建任务"
                      data-tip="新建任务"
                      onClick={handleNewSession}
                    >
                      <EchoNewTaskIcon size="md" />
                    </button>
                  </>
                )}
                <TopbarTitle title={currentTitle} onRename={handleRenameTitle} />
                {currentEntry?.expertName && (
                  <span className="expert-badge" data-tip={`专家：${currentEntry.expertName}`}>
                    <ThumbImg name={currentEntry.expertName} local={currentEntry.expertAvatar} size={18} shape="circle" />
                    {currentEntry.expertName}
                  </span>
                )}
                {currentSessionId && (
                  <TopbarActions
                    sessionId={currentSessionId}
                    title={currentTitle}
                    pinned={currentEntry?.pinned}
                    onToast={showToast}
                    onSessionsChanged={(patch) => {
                      if (patch) sessionsStore.getState().upsert({ sessionId: currentSessionId, ...patch });
                    }}
                    onArchived={(archived) => handleSessionArchived(currentSessionId, archived)}
                  />
                )}
              </div>
            </header>
          ) : (
            sidebarCollapsed && (
              <div className="main-topbar-float">
                <button
                  className="main-topbar__btn"
                  aria-label="展开侧边栏"
                  data-tip="展开侧边栏"
                  onClick={() => setSidebarCollapsed(false)}
                >
                  <SidebarToggleIcon size="md" />
                </button>
                <button
                  className="main-topbar__btn"
                  aria-label="新建任务"
                  data-tip="新建任务"
                  onClick={handleNewSession}
                >
                  <EchoNewTaskIcon size="md" />
                </button>
              </div>
            )
          )}
          {init?.ok && modelCatalogError && (
            <div className="app__notice app__notice--err" role="alert">
              模型列表加载失败：{modelCatalogError}
              <button type="button" className="btn btn--ghost" onClick={() => void refreshModels()}>
                重试
              </button>
            </div>
          )}
          {initError ? (
            <div className="app__notice app__notice--err">
              初始化失败:{initError}
              <br />
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => {
                  setInit(null);
                  setInitError(null);
                  setInitAttempt((attempt) => attempt + 1);
                }}
              >
                重试初始化
              </button>
            </div>
          ) : !init ? (
            <div className="app__notice">正在本地初始化 agent…</div>
          ) : !init.ok ? (
            <div className="app__notice app__notice--err">
              EchoAgent 未就绪:{init.auth.reason ?? "未知原因"}
              <br />
              请在「设置 → 模型」配置模型厂商和 API Key。
            </div>
          ) : (
            <Suspense fallback={<div className="app__notice" role="status">正在加载界面…</div>}>
              {placeholderView ? (
                <PlaceholderPage
                  label={placeholderView}
                  onNavigate={handleNavigate}
                  onOpenSession={handleSelectSession}
                  onGoHome={handleGoHome}
                  onToast={showToast}
                  cwd={newSessionTargetCwd}
                  onSelectWorkspace={handleSelectWorkspace}
                  sessionId={currentSessionId ?? undefined}
                  onStartProject={handleStartProject}
                  onStartProjectConversation={handleStartProjectConversation}
                />
              ) : currentSessionId ? (
                <ChatView
                  title={currentTitle}
                  onSend={handleSendCurrent}
                  onCancel={handleCancel}
                  cancelling={cancellingSessionId === currentSessionId}
                  apiReady={chatReady}
                  setupHint={chatSetupHint}
                  onOpenSettings={() => openSettings("model")}
                  modelId={currentModelId}
                  models={models}
                  onModelChange={handleModelChange}
                  cwd={activeSessionCwd}
                  newSessionTargetCwd={newSessionTargetCwd}
                  workspaces={workspaces}
                  onSelectWorkspace={handleSelectWorkspace}
                  onRewound={handleRewound}
                  onForked={handleForked}
                  onToast={showToast}
                  onSelectExpert={handleStartWithExpert}
                  onNavigateConnectors={() => setPlaceholderView("专家·技能·连接器")}
                  commandRefreshKey={commandRefreshKey}
                  onClientSlashCommand={handleClientSlashCommand}
                />
              ) : (
                <HomePage
                  onSend={handleSendNew}
                  streaming={streaming}
                  apiReady={init.auth.ready && modelConfigured}
                  setupHint={init.auth.reason}
                  creatingSession={creatingSession}
                  sendError={homeSendError}
                  onOpenSettings={() => openSettings("model")}
                  onPlaceholder={handlePlaceholder}
                  modelId={currentModelId}
                  models={models}
                  onModelChange={handleModelChange}
                  cwd={newSessionTargetCwd}
                  workspaces={workspaces}
                  onSelectWorkspace={handleSelectWorkspace}
                  onSelectExpert={handleStartWithExpert}
                  onNavigateConnectors={() => setPlaceholderView("专家·技能·连接器")}
                  commandRefreshKey={commandRefreshKey}
                  onClientSlashCommand={handleClientSlashCommand}
                />
              )}
            </Suspense>
          )}
        </main>
      </div>
      <Toast message={toast} />
      {searchOpen && (
        <Suspense fallback={null}>
          <SearchOverlay
            open
            onClose={() => setSearchOpen(false)}
            onSelect={handleSelectSession}
          />
        </Suspense>
      )}
      {settingsOpen && (
        <Suspense fallback={null}>
          <SettingsPanel
            open
            initialSection={settingsSection}
            sessionId={currentSessionId ?? undefined}
            onClose={() => setSettingsOpen(false)}
            onModelsChanged={refreshModels}
          />
        </Suspense>
      )}
      {aboutOpen && (
        <Suspense fallback={null}>
          <AboutDialog
            open
            onClose={() => setAboutOpen(false)}
            init={init}
            onCheckForUpdates={handleCheckForUpdates}
          />
        </Suspense>
      )}
      {updateDialogOpen && (
        <Suspense fallback={null}>
          <UpdateDialog open onClose={() => setUpdateDialogOpen(false)} />
        </Suspense>
      )}
      <Suspense fallback={null}>
        <FolderTrustDialog
          request={trustRequest}
          onResolve={resolveTrustRequest}
          onToast={showToast}
        />
      </Suspense>
      <TasksPanel refreshSignal={taskRefreshSignal} onToast={showToast} />
      <SecondarySidebar onSelectExpert={handleStartWithExpert} onToast={showToast} />
    </div>
  );
}
