import { useCallback, useEffect, useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { ChatView } from "./components/ChatView";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { Toast } from "./components/Toast";
// PermissionDialog is now inline in ChatView (PermissionInlineCard), not a global modal.
import { ThemeProvider } from "./components/ThemeProvider";
import { SettingsPanel, type SettingsSectionId } from "./components/SettingsPanel";
import { SearchOverlay } from "./components/SearchOverlay";
import { AboutDialog } from "./components/AboutDialog";
import { UpdateDialog } from "./components/UpdateDialog";
import { FolderTrustDialog } from "./components/FolderTrustDialog";
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
  const [modelSwitching, setModelSwitching] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [homeSendError, setHomeSendError] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cwdRef = useRef<string>("");
  const modelsRef = useRef<ModelOption[]>([]);
  const authReadyRef = useRef(false);
  const promptedUpdateVersionRef = useRef<string | null>(null);
  const newSessionPendingRef = useRef(false);

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

  /** Re-fetch providers + auth readiness after Settings add/edit/delete.
   *
   * Previously this only updated `models`, so the home Composer still saw
   * `apiReady=false` (from the cold-start `init.auth.ready`) and stayed
   * disabled with "请先配置 API Key" — looking like nothing changed.
   * Also, the first added model was never auto-selected as currentModelId.
   */
  const refreshModels = useCallback(async () => {
    try {
      const [list, auth] = await Promise.all([providersList(), agentAuthStatus()]);
      const options = flattenModels(list);
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
        return resolveConfiguredModelId(options, prev);
      });

      // Unlock the home Composer as soon as a configured provider exists.
      setInit((prev) => (prev ? { ...prev, auth } : prev));
      authReadyRef.current = auth.ready;
    } catch {
      // Non-fatal — the picker keeps its previous list.
    }
  }, [sessionsStore]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;

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
        cwdRef.current = result.cwd;
        sessionsStore.getState().setHomeCwd(result.cwd);
        setInit(result);
        authReadyRef.current = result.auth.ready;

        unlisten = await subscribeAgentEvents({
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
          onGitHead: () => {
            void agentListWorkspaces().then(setWorkspaces).catch(() => {});
            const cwd = cwdRef.current;
            if (cwd) {
              void agentListSessions(cwd).then((list) => {
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
            const payload = (p ?? {}) as { enabled?: boolean };
            if (typeof payload.enabled === "boolean") {
              sessionStore.getState().setPlanMode(payload.enabled);
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
            reportEvent("agent_died", "error", { reason });
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

        // Sidebar now shows two groups: 任务 (the inbox cwd's sessions) +
        // 空间 (one node per other working directory). Load both up front;
        // 空间 node children are lazy-loaded when a node is expanded.
        const [independent, ws] = await Promise.all([
          agentListSessions(result.cwd),
          agentListWorkspaces(),
        ]);
        sessionsStore.getState().setIndependent(independent);
        sessionsStore.getState().setWorkspaces(ws);
        setWorkspaces(ws);

        // Load the model list (from config.toml [model.*]) for the picker.
        // Each model becomes one ModelOption; the id is the EchoAgent routing slug.
        const providers = await providersList();
        const providerOptions = flattenModels(providers);
        setModels(providerOptions);
        modelsRef.current = providerOptions;

        // The runtime reports an internal default even when the user has not
        // configured any provider. Only expose that id if it also exists in the
        // user's [model.*] catalog; otherwise select the first configured model
        // or leave the selection empty.
        const activeId = sessionsStore.getState().currentSessionId;
        setCurrentModelId(activeId
          ? resolveSessionModelId(
              providerOptions,
              findSessionSummary(activeId)?.currentModelId,
            )
          : resolveConfiguredModelId(
              providerOptions,
              undefined,
              result.defaultModelId,
            ));
      } catch (e) {
        setInitError(String(e));
      }
    })();
    return () => {
      if (unlisten) unlisten();
    };
  }, [sessionStore, sessionsStore, permissionStore, questionStore]);

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
    if (newSessionPendingRef.current) return false;
    const modelId = requireConfiguredModel();
    if (!modelId) return false;
    if (!ensureQuotaAllowsSend()) return false;
    newSessionPendingRef.current = true;
    setCreatingSession(true);
    setHomeSendError(null);
    try {
      const cwd = cwdRef.current;
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

  const handleCancel = async () => {
    if (!currentSessionId) return;
    const sessionId = currentSessionId;
    try {
      await agentCancel(sessionId);
    } catch (e) {
      if (sessionStore.getState().sessionId === sessionId) {
        sessionStore.getState().setError(friendlyError(e));
      }
    } finally {
      // Don't rely on the backend emitting a `complete` for the cancel (it may
      // be dropped by routing after a fast switch). Finalize locally so the
      // Composer's stop button and the loading row don't hang. Already-streamed
      // text is kept; only the in-flight flag is cleared.
      sessionStore.getState().stopStreaming(sessionId);
      // Always release the queue row, including when forwarding the cancel
      // notification failed. The prompt has already been admitted into
      // conversation history, so consuming it avoids a duplicate retry. A
      // later terminal event / Promise callback is an idempotent no-op.
      useMessageQueueStore.getState().settleSending(sessionId, "consume");
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
          await agentLoadSession(
            sessionId,
            findSessionSummary(sessionId)?.cwd ?? cwdRef.current,
          );
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
    cwdRef.current = newCwd;
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
    void agentListSessions(newCwd)
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
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(null);
    sessionStore.getState().reset();
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };

  /** Navigate to home page without resetting session state (used after expert summon). */
  const handleGoHome = () => {
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(null);
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };

  // Application-level shortcuts shown in Settings. Composer-specific Enter,
  // Shift+Enter, slash and @ behavior stays scoped to the input component.
  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.repeat) return;
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
        const list = await agentListSessions(cwd);
        sessionsStore.getState().setWorkspaceSessions(cwd, list);
      } catch (e) {
        showToast(`加载空间会话失败：${String(e)}`);
      }
    }
  };

  const handleSelectSession = async (sessionId: string, sessionCwd?: string) => {
    const entry = findSessionSummary(sessionId);
    const persistedModelId = entry?.currentModelId;
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
      await agentLoadSession(sessionId, sessionCwd ?? "");
      const transcript = sessionStore.getState().transcripts[sessionId];
      if (transcript) {
        indexTaskArtifacts(
          sessionId,
          entry?.title ?? "未命名任务",
          entry?.cwd ?? sessionCwd ?? "",
          transcript.messages,
        );
      }
      if (!selectedModelId) {
        sessionStore.getState().setError(
          persistedModelId
            ? `⚠️ 此会话绑定的模型「${persistedModelId}」尚未配置。请在输入框右下角选择已配置模型后再发送。`
            : "⚠️ 无法确定此会话的模型。请在输入框右下角重新选择模型后再发送。",
        );
      }
      // Populate the context-usage pill for the freshly loaded session.
    } catch (e) {
      sessionStore.getState().setError(friendlyError(e));
    } finally {
      // Replay window is over: a *new* turn's updates for this session must be
      // ingested again. (No-op when there was no cached transcript to suppress.)
      sessionStore.getState().clearReplaySuppression(sessionId);
    }
  };

  // Rewind rewrites the backend history, so our cached transcript is stale —
  // drop it and reload from EchoAgent so the UI matches the rolled-back state.
  const handleRewound = () => {
    const id = sessionStore.getState().sessionId;
    if (!id) return;
    sessionStore.getState().dropSessionCache(id);
    sessionStore.getState().setSession(id); // empty cache → replay refills
    void agentLoadSession(id, cwdRef.current).catch((e) =>
      sessionStore.getState().setError(friendlyError(e))
    );
  };

  // Fork copies the session to a new id — jump to it so the user sees the
  // branch they just created (and it appears in the sidebar).
  const handleForked = (newId: string) => {
    const cwd = cwdRef.current;
    const modelId = resolveSessionModelId(models, currentModelId);
    setPlaceholderView(null);
    sessionsStore.getState().setCurrent(newId);
    sessionsStore.getState().upsert({
      sessionId: newId,
      title: "分叉会话",
      cwd,
      currentModelId: modelId,
    });
    sessionStore.getState().setSession(newId);
    void agentLoadSession(newId, cwd).catch((e) =>
      sessionStore.getState().setError(friendlyError(e))
    );
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
        await memoryAppend(remember.scope, remember.content, cwdRef.current);
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
        sessionStore.getState().setPlanMode(enabled);
        showToast(enabled ? "已开启计划模式" : "已关闭计划模式");
        return true;
      }
      case "fork": {
        const sessionId = sessionsStore.getState().currentSessionId;
        if (!sessionId) {
          showToast("/fork 需要先创建会话");
          return false;
        }
        const cwd = findSessionSummary(sessionId)?.cwd || cwdRef.current;
        const newId = await sessionFork(sessionId, cwd);
        cwdRef.current = cwd;
        handleForked(newId);
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
    try {
      if (project.cwd) {
        cwdRef.current = project.cwd;
      }
      setPlaceholderView(null);
      const cwd = cwdRef.current;
      const sessionId = await agentNewSession(cwd, modelId);
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
      sessionStore.getState().setError(friendlyError(e));
      const sid = sessionStore.getState().sessionId;
      if (sid) sessionsStore.getState().upsert({ sessionId: sid, status: "failed" });
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
    try {
      const cwd = project.cwd || cwdRef.current;
      const sessionId = await agentNewSession(cwd, modelId);

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
      sessionStore.getState().setError(friendlyError(e));
      const sid = sessionStore.getState().sessionId;
      if (sid) sessionsStore.getState().upsert({ sessionId: sid, status: "failed" });
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
          {initError ? (
            <div className="app__notice app__notice--err">
              初始化失败:{initError}
              <br />
              请在「设置 → 模型」配置模型厂商和 API Key 后重试。
            </div>
          ) : !init ? (
            <div className="app__notice">正在本地初始化 agent…</div>
          ) : !init.ok ? (
            <div className="app__notice app__notice--err">
              EchoAgent 未就绪:{init.auth.reason ?? "未知原因"}
              <br />
              请在「设置 → 模型」配置模型厂商和 API Key。
            </div>
          ) : placeholderView ? (
            <PlaceholderPage
              label={placeholderView}
              onNavigate={handleNavigate}
              onOpenSession={handleSelectSession}
              onGoHome={handleGoHome}
              onToast={showToast}
              cwd={cwdRef.current}
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
              apiReady={chatReady}
              setupHint={chatSetupHint}
              onOpenSettings={() => openSettings("model")}
              modelId={currentModelId}
              models={models}
              onModelChange={handleModelChange}
              cwd={cwdRef.current}
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
              cwd={cwdRef.current}
              workspaces={workspaces}
              onSelectWorkspace={handleSelectWorkspace}
              onSelectExpert={handleStartWithExpert}
              onNavigateConnectors={() => setPlaceholderView("专家·技能·连接器")}
              commandRefreshKey={commandRefreshKey}
              onClientSlashCommand={handleClientSlashCommand}
            />
          )}
        </main>
      </div>
      <Toast message={toast} />
      <SearchOverlay
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSelect={handleSelectSession}
      />
      <SettingsPanel
        open={settingsOpen}
        initialSection={settingsSection}
        sessionId={currentSessionId ?? undefined}
        onClose={() => setSettingsOpen(false)}
        onModelsChanged={refreshModels}
      />
      <AboutDialog
        open={aboutOpen}
        onClose={() => setAboutOpen(false)}
        init={init}
        onCheckForUpdates={handleCheckForUpdates}
      />
      <UpdateDialog open={updateDialogOpen} onClose={() => setUpdateDialogOpen(false)} />
      <FolderTrustDialog
        request={trustRequest}
        onResolve={() => setTrustRequest(null)}
        onToast={showToast}
      />
      <TasksPanel refreshSignal={taskRefreshSignal} onToast={showToast} />
      <SecondarySidebar onSelectExpert={handleStartWithExpert} onToast={showToast} />
    </div>
  );
}
