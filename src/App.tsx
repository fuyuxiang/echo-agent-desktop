import { useCallback, useEffect, useRef, useState } from "react";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { ChatView } from "./components/ChatView";
import { PlaceholderPage } from "./components/PlaceholderPage";
import { Toast } from "./components/Toast";
// PermissionDialog is now inline in ChatView (PermissionInlineCard), not a global modal.
import { ThemeProvider } from "./components/ThemeProvider";
import { SettingsPanel } from "./components/SettingsPanel";
import { SearchOverlay } from "./components/SearchOverlay";
import { AboutDialog } from "./components/AboutDialog";
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
  agentSessionUsage,
  agentAuthStatus,
  providersList,
  flattenModels,
  notificationAppend,
  subscribeAgentEvents,
  type InitResult,
  type WorkspaceInfo,
} from "./lib/agent-client";
import type { AgentEntry, SessionSummary } from "./lib/types";
import { hydrateProjectsFromBackend, useProjectsStore, type ProjectMeta } from "./stores/projects-store";
import { useMessageQueueStore, hasActiveItems } from "./stores/message-queue-store";
import { useSubagentStore } from "./stores/subagent-store";
import { recordCumulativeUsage, recordUsage, loadUsage, loadQuotaConfig } from "./lib/usage-quota";
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

/** Hidden markers wrapping the expert persona in the text sent to the runtime.
 *  The UI strips these (and everything between them) from user messages. */
export const EXPERT_PERSONA_BEGIN = "<!--EXPERT_PERSONA_BEGIN-->";
export const EXPERT_PERSONA_END = "<!--EXPERT_PERSONA_END-->";

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
  const [searchOpen, setSearchOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [trustRequest, setTrustRequest] = useState<{ cwd?: string; reason?: string } | null>(null);
  const [taskRefreshSignal, setTaskRefreshSignal] = useState(0);
  const [placeholderView, setPlaceholderView] = useState<string | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [currentModelId, setCurrentModelId] = useState<string | undefined>(undefined);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelSwitching, setModelSwitching] = useState(false);
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cwdRef = useRef<string>("");
  const modelsRef = useRef<ModelOption[]>([]);
  const authReadyRef = useRef(false);

  const sessionStore = useSessionStore;
  const sessionsStore = useSessionsStore;
  const permissionStore = usePermissionStore;
  const questionStore = useQuestionStore;

  useEffect(() => {
    migrateCatalogRootStorage();
    void hydrateKnowledgeSources().catch((error) => {
      console.error("[EchoAgent] Failed to hydrate knowledge sources:", error);
      setToast("知识源后端数据读取失败");
    });
    void hydrateProjectsFromBackend().catch((error) => {
      console.error("[EchoAgent] Failed to hydrate projects:", error);
      setToast("项目后端数据读取失败，已使用本地缓存");
    });
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

      // Unlock the home Composer as soon as a BYOK provider exists (or OAuth).
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
            const abnormal = ["rate_limit", "rate_limited", "error"].includes(p.stopReason);
            // Completion is routed by session id in the transcript store. This
            // also finalizes a background conversation after the user switches
            // away; side-channel sessions are not added to the sidebar because
            // they have no SessionSummary entry.
            sessionStore.getState().markComplete(p);
            if (summary) {
              sessionsStore.getState().upsert({
                sessionId: p.sessionId,
                status: abnormal ? "failed" : "completed",
              });

              // PromptComplete currently contains no usage in the Rust bridge.
              // Query EchoAgent's real cumulative counters and persist only the
              // per-session delta. If a future bridge supplies per-turn usage,
              // retain it as a compatibility fallback.
              const modelId = summary.currentModelId ?? "unknown";
              void agentSessionUsage(p.sessionId).then((usage) => {
                recordCumulativeUsage(loadUsage(), {
                  sessionId: p.sessionId,
                  modelId,
                  inputTokens: usage.inputTokens ?? 0,
                  outputTokens: usage.outputTokens ?? 0,
                }, loadQuotaConfig() ?? undefined);
              }).catch(() => {
                if (p.usage && (p.usage.promptTokens || p.usage.completionTokens)) {
                  recordUsage(loadUsage(), {
                    sessionId: p.sessionId,
                    modelId,
                    promptTokens: p.usage.promptTokens ?? 0,
                    completionTokens: p.usage.completionTokens ?? 0,
                  }, loadQuotaConfig() ?? undefined);
                }
              });
            }

            // Unknown side-channel sessions and failed turns must never start a
            // queued follow-up automatically.
            if (!summary || abnormal) return;
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
                sessionStore.getState().setError(
                  "⚠️ 已暂停自动续发：当前会话的模型未配置，请重新选择模型。",
                );
                sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "failed" });
                return;
              }
              const next = q.find((item) => item.status === "queued");
              if (next) {
                // Keep the queue item until agentSend acknowledges the request;
                // a rejected invoke therefore cannot silently lose user input.
                sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "working" });
                sessionStore.getState().pushUser(next.text);
                sessionStore.getState().startStreaming();
                agentSend(p.sessionId, next.text).then(() => {
                  useMessageQueueStore.getState().remove(p.sessionId, next.id);
                }).catch((e) => {
                  sessionStore.getState().setError(friendlyError(e));
                  sessionsStore.getState().upsert({ sessionId: p.sessionId, status: "failed" });
                });
              }
            }
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
            setToast(`⚠️ AI 引擎异常退出：${reason}。请重启应用。`);
            sessionStore.getState().setError(`AI 引擎异常退出：${reason}`);
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
  const chatSetupHint = modelSwitching
    ? "正在切换模型…"
    : models.length === 0
      ? "请先在「设置 → 模型」配置模型"
      : !activeSessionModelId
        ? "此会话的模型未配置，请在右下角重新选择模型"
        : "请先在「设置 → 模型」配置 API Key";

  const showToast = (message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  };

  const requireConfiguredModel = (): string | undefined => {
    if (!init?.auth.ready) {
      showToast("请先在「设置 → 模型」配置 API Key");
      setSettingsOpen(true);
      return undefined;
    }
    if (newSessionModelId) return newSessionModelId;
    showToast("请先在「设置 → 模型」配置模型");
    setSettingsOpen(true);
    return undefined;
  };
  const handlePlaceholder = (label: string) => {
    // Route a few sidebar shortcut buttons to real panels instead of toasts.
    if (label === "用户中心") {
      setSettingsOpen(true);
      return;
    }
    if (label === "通知") {
      // Open the settings → 通知中心 tab where all EchoAgent
      // events are logged.
      setSettingsOpen(true);
      return;
    }
    showToast(`${label} 即将上线`);
  };
  const handleNavigate = (label: string) => {
    setPlaceholderView(label);
    sessionsStore.getState().setCurrent(null);
    sessionStore.getState().reset();
    setCurrentModelId((prev) => resolveConfiguredModelId(models, prev));
  };

  // Sidebar project node click → open the Projects panel with that project selected.
  const handleOpenProjectFromSidebar = (projectId: string) => {
    useProjectsStore.getState().setActiveProjectId(projectId);
    handleNavigate("项目");
  };

  const handleSendNew = async (text: string, attachments: string[] = []): Promise<boolean> => {
    const modelId = requireConfiguredModel();
    if (!modelId) return false;
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

      // UI shows only the user's visible text.
      sessionStore.getState().pushUser(text);
      sessionStore.getState().startStreaming();
      await agentSend(sessionId, textForAgent, attachments);
      return true;
    } catch (e) {
      console.error('[EchoAgent] handleSendNew error:', e);
      sessionStore.getState().rollbackPendingTurn();
      sessionStore.getState().setError(friendlyError(e));
      const sid = sessionStore.getState().sessionId;
      if (sid) sessionsStore.getState().upsert({ sessionId: sid, status: "failed" });
      return false;
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
      showToast("请先在「设置 → 模型」配置 API Key");
      setSettingsOpen(true);
      return false;
    }
    if (!activeSessionModelId) {
      showToast("当前会话的模型未配置，请先在输入框右下角重新选择模型");
      return false;
    }
    try {
      sessionsStore.getState().upsert({ sessionId: currentSessionId, status: "working" });
      sessionStore.getState().pushUser(text);
      sessionStore.getState().startStreaming();
      await agentSend(currentSessionId, text, attachments);
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
    try {
      await agentCancel(currentSessionId);
    } catch (e) {
      sessionStore.getState().setError(friendlyError(e));
    } finally {
      // Don't rely on the backend emitting a `complete` for the cancel (it may
      // be dropped by routing after a fast switch). Finalize locally so the
      // Composer's stop button and the loading row don't hang. Already-streamed
      // text is kept; only the in-flight flag is cleared.
      sessionStore.getState().stopStreaming();
    }
  };

  // Topbar title rename — EchoAgent's `x.ai/session/rename`. EchoAgent broadcasts
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
        setSettingsOpen(true);
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
    // backend session, and could route the next prompt to stale Grok settings.
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
      await agentSend(sessionId, buildProjectPrompt(project, seed));
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
        await agentSend(sessionId, prompt);
      }
    } catch (e) {
      sessionStore.getState().setError(friendlyError(e));
      const sid = sessionStore.getState().sessionId;
      if (sid) sessionsStore.getState().upsert({ sessionId: sid, status: "failed" });
      showToast(`创建项目对话失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  };

  const activeNav = placeholderView ?? (currentSessionId ? "" : "新建任务");

  return (
    <div className={"app" + (IS_MACOS ? " app--macos" : "")}>
      {/* macOS 使用系统原生 Overlay 标题栏(红绿灯 + 原生菜单栏),
          不再渲染自绘 TitleBar;Windows/Linux 保持自绘。 */}
      {!IS_MACOS && (
        <TitleBar onPlaceholder={handlePlaceholder} onShowAbout={() => setAboutOpen(true)} />
      )}
      <div className={"app__body" + (sidebarCollapsed ? " app__body--collapsed" : "")}>
        <Sidebar
          onNewSession={handleNewSession}
          onSelect={handleSelectSession}
          onNavigate={handleNavigate}
          onOpenSettings={() => setSettingsOpen(true)}
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
              请在「设置 → 账户管理」设置 xAI API Key，或在「设置 → 模型」配置 BYOK provider 后重试。
            </div>
          ) : !init ? (
            <div className="app__notice">正在本地初始化 agent…</div>
          ) : !init.ok ? (
            <div className="app__notice app__notice--err">
              EchoAgent 未就绪:{init.auth.reason ?? "未知原因"}
              <br />
              请在「设置 → 账户管理」设置 xAI API Key，或在「设置 → 模型」配置 BYOK provider。
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
              onSend={handleSendCurrent}
              onCancel={handleCancel}
              apiReady={chatReady}
              setupHint={chatSetupHint}
              onOpenSettings={() => setSettingsOpen(true)}
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
            />
          ) : (
            <HomePage
              onSend={handleSendNew}
              streaming={streaming}
              apiReady={init.auth.ready && modelConfigured}
              onOpenSettings={() => setSettingsOpen(true)}
              onPlaceholder={handlePlaceholder}
              modelId={currentModelId}
              models={models}
              onModelChange={handleModelChange}
              cwd={cwdRef.current}
              workspaces={workspaces}
              onSelectWorkspace={handleSelectWorkspace}
              onSelectExpert={handleStartWithExpert}
              onNavigateConnectors={() => setPlaceholderView("专家·技能·连接器")}
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
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} onModelsChanged={refreshModels} />
      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} init={init} />
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
