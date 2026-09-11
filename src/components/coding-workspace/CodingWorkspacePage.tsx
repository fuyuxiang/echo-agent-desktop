import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CircleDot,
  Code2,
  Download,
  FileCode2,
  FileDiff,
  FilePlus2,
  FileText,
  Files,
  FolderGit2,
  FolderPlus,
  GitBranch,
  GitCompareArrows,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Network,
  PackageSearch,
  PanelBottom,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Square,
  TerminalSquare,
  TestTube2,
  Wrench,
  X,
} from "lucide-react";
import type {
  CodingGitFile,
  CodingGitSnapshot,
  CodingSearchHit,
  CodingWorkspaceAnalysis,
  WorkspaceInfo,
} from "@/lib/agent-client";
import {
  agentSetModel,
  codingAnalyzeWorkspace,
  codingCancelCommand,
  codingCreateEntry,
  codingGitDiff,
  codingGitSetStaged,
  codingGitSnapshot,
  codingListenCommandOutput,
  codingReadDocument,
  codingRunCommand,
  codingSearchWorkspace,
  codingWriteDocument,
  exportTextFile,
  filesystemPickDirectory,
  readTextFile,
  setPlanMode as setAgentPlanMode,
} from "@/lib/agent-client";
import { FileTreeView } from "@/components/workspace-panel/FileTreeView";
import { WorkspacePicker } from "@/components/WorkspacePicker";
import { ModelSelector, type ModelOption } from "@/components/ModelSelector";
import { PermissionPicker } from "@/components/PermissionPicker";
import { PermissionInlineCard } from "@/components/PermissionDialog";
import { QuestionInlineCard } from "@/components/QuestionInlineCard";
import { PlanPanel } from "@/components/PlanPanel";
import { ExecutionProcess } from "@/components/ExecutionProcess";
import { Markdown } from "@/components/Markdown";
import { useSessionStore } from "@/stores/session-store";
import { useSessionsStore } from "@/stores/sessions-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useQuestionStore } from "@/stores/question-store";
import { riskLabel } from "@/lib/command-risk";
import { CodingEditor, type CodingEditorDiagnostic } from "./CodingEditor";
import { CodingTerminal } from "./CodingTerminal";
import {
  CODING_DOC_PATHS,
  buildCodingAgentPrompt,
  buildCodingFollowupPrompt,
  buildDocumentationPrompt,
  buildVerificationReport,
  checkCodingCommandRisk,
  collectAgentValidations,
  codingChangedFilesSinceBaseline,
  codingProtocolFailureCount,
  createAcceptanceCriteria,
  deriveQualityGates,
  deriveTaskNodes,
  isDocumentationLevelSatisfied,
  inspectCodingRun,
  loadCodingSnapshot,
  resolveCodingModeForRequest,
  saveCodingSnapshot,
  validationFromResult,
  type AcceptanceCriterion,
  type CodingAgentMode,
  type CodingRunHealth,
  type QualityGate,
  type CodingDocLevel,
  type CodingRunSnapshot,
  type ValidationRecord,
} from "@/lib/coding-workspace";

type ExplorerView = "files" | "search" | "changes" | "context";
type AgentView = "tasks" | "chat" | "acceptance";
type BottomView = "terminal" | "validation" | "problems" | "tests" | "report" | "trace";
type CenterView = "editor" | "evidence";

interface OpenFile {
  path: string;
  relativePath: string;
  name: string;
  original: string;
  draft: string;
  hash: string;
  language: string;
  lineEnding: "LF" | "CRLF";
  size: number;
  loading: boolean;
  error?: string;
  conflict?: boolean;
}

interface WorkspaceProblem {
  title: string;
  detail: string;
  kind: "error" | "warning";
  path?: string;
  line?: number;
  column?: number;
}

interface CodingWorkspacePageProps {
  cwd?: string;
  workspaces?: WorkspaceInfo[];
  onSelectWorkspace?: (cwd: string) => void;
  onToast?: (message: string) => void;
  apiReady?: boolean;
  onOpenSettings?: () => void;
  onExit?: () => void;
  models?: ModelOption[];
  defaultModelId?: string;
  onStartRun?: (
    root: string,
    prompt: string,
    displayText: string,
    options: { mode: CodingAgentMode; modelId?: string },
  ) => Promise<string | undefined>;
  onResumeRun?: (sessionId: string, root: string) => Promise<boolean>;
  onSend?: (promptText: string, displayText?: string) => boolean | void | Promise<boolean | void>;
  onCancel?: () => void;
}

const EMPTY_SNAPSHOT = (root: string): CodingRunSnapshot => ({
  version: 2,
  root,
  requirement: "",
  acceptanceCriteria: [],
  validationRecords: [],
  docLevels: [],
  mode: "craft",
  contextPaths: [],
  reviewedFiles: [],
});

function basename(path: string): string {
  const segments = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function workspaceFilePath(root: string, path: string): string {
  if (/^(?:[a-z]:[\\/]|[\\/]{2}|\/)/i.test(path)) return path;
  return `${root.replace(/[\\/]+$/, "")}/${path.replace(/^[\\/]+/, "")}`;
}

function statusLabel(status: QualityGate["status"]): string {
  if (status === "satisfied") return "已满足";
  if (status === "in_progress") return "验证中";
  return "未满足";
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${durationMs}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

const MAX_TERMINAL_RENDER_CHARS = 1_000_000;

function appendTerminalOutput(previous: string, chunk: string): string {
  const next = previous + chunk;
  if (next.length <= MAX_TERMINAL_RENDER_CHARS) return next;
  return `…较早的终端输出已省略…\n${next.slice(-MAX_TERMINAL_RENDER_CHARS)}`;
}

function updateSnapshotValue(
  previous: CodingRunSnapshot,
  update: Partial<CodingRunSnapshot> | ((snapshot: CodingRunSnapshot) => CodingRunSnapshot),
): CodingRunSnapshot {
  return typeof update === "function" ? update(previous) : { ...previous, ...update };
}

function CodingActivityBar({
  active,
  onChange,
  onOpenSettings,
}: {
  active: ExplorerView;
  onChange: (view: ExplorerView) => void;
  onOpenSettings?: () => void;
}) {
  const items: Array<{ view: ExplorerView; label: string; icon: ReactNode }> = [
    { view: "files", label: "资源管理器", icon: <Files size={22} /> },
    { view: "search", label: "全局搜索", icon: <Search size={22} /> },
    { view: "changes", label: "源代码管理", icon: <GitBranch size={22} /> },
    { view: "context", label: "工程上下文", icon: <PackageSearch size={22} /> },
  ];
  return (
    <nav className="coding-activitybar" aria-label="代码工作台活动栏">
      <div className="coding-activitybar__primary">
        {items.map((item) => (
          <button
            type="button"
            key={item.view}
            className={active === item.view ? "is-active" : ""}
            onClick={() => onChange(item.view)}
            aria-label={item.label}
            aria-pressed={active === item.view}
            title={item.label}
          >
            {item.icon}
          </button>
        ))}
      </div>
      <button type="button" onClick={onOpenSettings} aria-label="代码开发设置" title="模型与开发设置">
        <Settings2 size={21} />
      </button>
    </nav>
  );
}

export function CodingWorkspacePage({
  cwd,
  workspaces = [],
  onSelectWorkspace,
  onToast,
  apiReady = false,
  onOpenSettings,
  onExit,
  models = [],
  defaultModelId,
  onStartRun,
  onResumeRun,
  onSend,
  onCancel,
}: CodingWorkspacePageProps) {
  const root = cwd ?? "";
  const [analysis, setAnalysis] = useState<CodingWorkspaceAnalysis | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [gitState, setGitState] = useState<CodingGitSnapshot | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [gitRevision, setGitRevision] = useState(0);
  const [gitDiff, setGitDiff] = useState("");
  const [gitDiffPath, setGitDiffPath] = useState<string | null>(null);
  const [gitActionPath, setGitActionPath] = useState<string | null>(null);
  const [selectedDirectoryPath, setSelectedDirectoryPath] = useState(root);
  const [newEntryKind, setNewEntryKind] = useState<"file" | "directory" | null>(null);
  const [newEntryName, setNewEntryName] = useState("");
  const [creatingEntry, setCreatingEntry] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<CodingSearchHit[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [revealLocation, setRevealLocation] = useState<{ path: string; line: number; column: number; key: number } | null>(null);
  const [scanRevision, setScanRevision] = useState(0);
  const [fileTreeRevision, setFileTreeRevision] = useState(0);
  const [explorerView, setExplorerView] = useState<ExplorerView>("files");
  const [agentView, setAgentView] = useState<AgentView>("tasks");
  const [bottomView, setBottomView] = useState<BottomView>("validation");
  const [centerView, setCenterView] = useState<CenterView>("editor");
  const [bottomOpen, setBottomOpen] = useState(true);
  const [bottomHeight, setBottomHeight] = useState(188);
  const [terminalActivated, setTerminalActivated] = useState(false);
  const [snapshot, setSnapshotState] = useState<CodingRunSnapshot>(() => EMPTY_SNAPSHOT(root));
  const [requirementDraft, setRequirementDraft] = useState("");
  const [criteriaDraft, setCriteriaDraft] = useState("");
  const [agentMode, setAgentMode] = useState<CodingAgentMode>("craft");
  const [selectedModelId, setSelectedModelId] = useState<string | undefined>(defaultModelId);
  const [contextPaths, setContextPaths] = useState<string[]>([]);
  const [startingRun, setStartingRun] = useState(false);
  const [runStartError, setRunStartError] = useState<string | null>(null);
  const [resumingRun, setResumingRun] = useState(false);
  const [followup, setFollowup] = useState("");
  const [sendingFollowup, setSendingFollowup] = useState(false);
  const [freshSessionReason, setFreshSessionReason] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [fileMode, setFileMode] = useState<"edit" | "diff" | "git" | "preview">("edit");
  const [savingFile, setSavingFile] = useState(false);
  const [editorDiagnostics, setEditorDiagnostics] = useState<Record<string, CodingEditorDiagnostic[]>>({});
  const [terminalCommand, setTerminalCommand] = useState("");
  const [runningCommand, setRunningCommand] = useState<string | null>(null);
  const [activeCommandRunId, setActiveCommandRunId] = useState<string | null>(null);
  const [riskConfirmation, setRiskConfirmation] = useState<string | null>(null);
  const [terminalOutput, setTerminalOutput] = useState("请选择检测命令，或输入需要在当前工作区执行的命令。\n");
  const [evidenceSelection, setEvidenceSelection] = useState<QualityGate["id"]>("change_review");
  const [clock, setClock] = useState(() => Date.now());
  const transcript = useSessionStore((state) => snapshot.sessionId
    ? state.transcripts[snapshot.sessionId]
    : undefined);
  const focusedSessionId = useSessionsStore((state) => state.currentSessionId);
  const focusedSessionModelId = useSessionsStore((state) => {
    const sessionId = state.currentSessionId;
    return sessionId
      ? state.independent.find((session) => session.sessionId === sessionId)?.currentModelId
      : undefined;
  });
  const focusedSessionError = useSessionStore((state) => state.error);
  const messages = transcript?.messages ?? [];
  const plan = transcript?.plan ?? null;
  const streaming = Boolean(transcript?.streamingMessageId);
  const awaitingPlanApproval = Boolean(transcript?.planApprovals?.length);
  const pendingQuestion = useQuestionStore((state) => snapshot.sessionId
    ? state.queues[snapshot.sessionId]?.[0] ?? null
    : null);
  const pendingPermission = usePermissionStore((state) => snapshot.sessionId
    ? state.queues[snapshot.sessionId]?.[0] ?? null
    : null);
  const sessionFocused = Boolean(snapshot.sessionId && focusedSessionId === snapshot.sessionId);
  const activeCommandRunIdRef = useRef<string | null>(null);
  const commandStreamedRef = useRef(false);
  const protocolStopRef = useRef<string | null>(null);
  const autoResumeAttemptRef = useRef<string | null>(null);
  const workspaceRootRef = useRef(root);
  const openFilePathsRef = useRef(new Set<string>());
  workspaceRootRef.current = root;

  const setSnapshot = useCallback((
    update: Partial<CodingRunSnapshot> | ((snapshot: CodingRunSnapshot) => CodingRunSnapshot),
  ) => {
    setSnapshotState((previous) => {
      const next = updateSnapshotValue(previous, update);
      if (next.root) saveCodingSnapshot(next);
      return next;
    });
  }, []);

  const beginBottomResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomHeight;
    const maxHeight = Math.max(180, window.innerHeight * 0.65);
    const handleMove = (moveEvent: PointerEvent) => {
      setBottomHeight(Math.round(Math.min(maxHeight, Math.max(120, startHeight + startY - moveEvent.clientY))));
    };
    const handleUp = () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      document.body.classList.remove("coding-is-resizing-bottom");
    };
    document.body.classList.add("coding-is-resizing-bottom");
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp, { once: true });
  }, [bottomHeight]);

  useEffect(() => {
    const next = root ? loadCodingSnapshot(root) ?? EMPTY_SNAPSHOT(root) : EMPTY_SNAPSHOT("");
    setSnapshotState(next);
    setRequirementDraft(next.requirement);
    setCriteriaDraft(next.acceptanceCriteria.map((criterion) => criterion.content).join("\n"));
    setAgentMode(next.mode);
    setSelectedModelId(next.modelId ?? defaultModelId);
    setContextPaths(next.contextPaths);
    setSelectedDirectoryPath(root);
    setNewEntryKind(null);
    setNewEntryName("");
    setRunStartError(null);
    setFreshSessionReason(null);
    setEditorDiagnostics({});
    protocolStopRef.current = null;
    openFilePathsRef.current.clear();
    setOpenFiles([]);
    setActiveFilePath(null);
    setAnalysis(null);
    setAnalysisError(null);
    setGitState(null);
    setGitError(null);
    setGitDiff("");
    setGitDiffPath(null);
    setSearchQuery("");
    setSearchResults([]);
    setSearchError(null);
  }, [root]); // default model changes are handled without resetting the open editor state below.

  useEffect(() => {
    if (selectedModelId && models.some((model) => model.id === selectedModelId)) return;
    // A persisted session must not visually claim it has switched models until
    // the Runtime accepts agentSetModel. Leave it unselected so the user's next
    // selection performs the real backend update.
    if (snapshot.sessionId) {
      setSelectedModelId(undefined);
      return;
    }
    setSelectedModelId(defaultModelId && models.some((model) => model.id === defaultModelId)
      ? defaultModelId
      : models[0]?.id);
  }, [defaultModelId, models, selectedModelId, snapshot.sessionId]);

  useEffect(() => {
    if (!sessionFocused || !snapshot.sessionId || !focusedSessionModelId) return;
    if (!models.some((model) => model.id === focusedSessionModelId)) return;
    setSelectedModelId(focusedSessionModelId);
    if (snapshot.modelId !== focusedSessionModelId) {
      setSnapshot((previous) => ({ ...previous, modelId: focusedSessionModelId }));
    }
  }, [focusedSessionModelId, models, sessionFocused, setSnapshot, snapshot.modelId, snapshot.sessionId]);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setAnalysisLoading(true);
    setAnalysisError(null);
    void codingAnalyzeWorkspace(root)
      .then((next) => {
        if (!cancelled) {
          setAnalysis(next);
          setTerminalCommand((current) => current || next.validationCommands[0] || "");
        }
      })
      .catch((error) => {
        if (!cancelled) setAnalysisError(String(error).replace(/^Error:\s*/, ""));
      })
      .finally(() => {
        if (!cancelled) setAnalysisLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root, scanRevision]);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    setGitLoading(true);
    setGitError(null);
    void codingGitSnapshot(root)
      .then((next) => {
        if (!cancelled) setGitState(next);
      })
      .catch((error) => {
        if (!cancelled) setGitError(String(error).replace(/^Error:\s*/, ""));
      })
      .finally(() => {
        if (!cancelled) setGitLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [gitRevision, root]);

  useEffect(() => {
    const query = searchQuery.trim();
    if (!root || query.length < 2) {
      setSearchResults([]);
      setSearchError(null);
      setSearchLoading(false);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setSearchLoading(true);
      setSearchError(null);
      void codingSearchWorkspace(root, query)
        .then((results) => {
          if (!cancelled) setSearchResults(results);
        })
        .catch((error) => {
          if (!cancelled) setSearchError(String(error).replace(/^Error:\s*/, ""));
        })
        .finally(() => {
          if (!cancelled) setSearchLoading(false);
        });
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [root, searchQuery]);

  useEffect(() => {
    if (!streaming || !root) return;
    const timer = window.setInterval(() => setGitRevision((value) => value + 1), 2_500);
    return () => window.clearInterval(timer);
  }, [root, streaming]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [streaming]);

  useEffect(() => {
    if (streaming || !snapshot.sessionId) return;
    setGitRevision((value) => value + 1);
    setFileTreeRevision((value) => value + 1);
  }, [messages.length, snapshot.sessionId, streaming]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void codingListenCommandOutput((event) => {
      if (event.runId !== activeCommandRunIdRef.current) return;
      commandStreamedRef.current = true;
      setTerminalOutput((previous) => appendTerminalOutput(previous, event.data));
    }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {
      // Browser tests and non-Tauri previews do not expose an event bridge.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!root) return;
    let cancelled = false;
    const entries = Object.entries(CODING_DOC_PATHS) as Array<[CodingDocLevel, string]>;
    void Promise.all(entries.map(async ([level, path]) => {
      try {
        const content = await readTextFile(path, root, 256 * 1024);
        return isDocumentationLevelSatisfied(level, content) ? level : null;
      } catch {
        return null;
      }
    })).then((levels) => {
      if (cancelled) return;
      const docLevels = levels.filter((level): level is CodingDocLevel => level != null);
      setSnapshot((previous) => {
        if (previous.docLevels.join("|") === docLevels.join("|")) return previous;
        return { ...previous, docLevels };
      });
    });
    return () => {
      cancelled = true;
    };
  }, [messages.length, root, scanRevision, streaming, setSnapshot]);

  const tasks = useMemo(() => deriveTaskNodes(plan), [plan]);
  const historicalProtocolFailures = useMemo(
    () => codingProtocolFailureCount(messages),
    [messages],
  );
  const changedScope = useMemo(
    () => codingChangedFilesSinceBaseline(gitState, snapshot.baselineGit),
    [gitState, snapshot.baselineGit],
  );
  const runHealth = useMemo(() => inspectCodingRun({
    messages,
    streaming,
    mode: snapshot.mode,
    plan,
    awaitingQuestion: Boolean(pendingQuestion),
    awaitingPermission: Boolean(pendingPermission),
    awaitingApproval: awaitingPlanApproval,
    runtimeError: sessionFocused ? focusedSessionError : null,
    requirement: snapshot.requirement,
    changedFileCount: changedScope.agent.length,
    hasGit: gitState?.hasGit,
  }), [awaitingPlanApproval, changedScope.agent.length, focusedSessionError, gitState?.hasGit, messages, pendingPermission, pendingQuestion, plan, sessionFocused, snapshot.mode, snapshot.requirement, streaming]);
  const lastTimedAssistant = [...messages].reverse().find((message) =>
    message.role === "assistant" && message.startedAt != null);
  const activeTimedAssistant = transcript?.streamingMessageId
    ? messages.find((message) => message.id === transcript.streamingMessageId)
    : undefined;
  const runElapsedMs = pendingQuestion || pendingPermission || awaitingPlanApproval
    ? 0
    : streaming && activeTimedAssistant?.startedAt != null
      ? Math.max(0, clock - activeTimedAssistant.startedAt)
    : lastTimedAssistant?.startedAt != null && lastTimedAssistant.completedAt != null
      ? Math.max(0, lastTimedAssistant.completedAt - lastTimedAssistant.startedAt)
      : 0;
  const agentValidations = useMemo(() => collectAgentValidations(messages), [messages]);
  const allValidations = useMemo(() => {
    const byId = new Map<string, ValidationRecord>();
    [...snapshot.validationRecords, ...agentValidations].forEach((record) => byId.set(record.id, record));
    return [...byId.values()].sort((left, right) => left.startedAt.localeCompare(right.startedAt));
  }, [agentValidations, snapshot.validationRecords]);
  const evidence = useMemo(() => deriveQualityGates({
    analysis,
    plan,
    messages,
    validations: snapshot.validationRecords,
    git: gitState,
    criteria: snapshot.acceptanceCriteria,
    reviewedFiles: snapshot.reviewedFiles,
    mode: snapshot.mode,
  }), [analysis, gitState, messages, plan, snapshot.acceptanceCriteria, snapshot.mode, snapshot.reviewedFiles, snapshot.validationRecords]);
  const activeEvidence = evidence.find((item) => item.id === evidenceSelection) ?? evidence[0];
  const activeFile = openFiles.find((file) => file.path === activeFilePath) ?? null;
  const hasUnsavedFiles = useMemo(
    () => openFiles.some((file) => !file.loading && file.draft !== file.original),
    [openFiles],
  );

  useEffect(() => {
    if (!hasUnsavedFiles) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedFiles]);

  useEffect(() => {
    const activeTurnId = transcript?.streamingMessageId;
    const activeTurn = transcript?.messages.find((message) => message.id === activeTurnId);
    // agentLoadSession replays durable history incrementally. An old broken
    // turn can temporarily become the tail while replay is still in progress;
    // it is evidence for the UI, never authority to cancel the current actor.
    if (activeTurn?.replayed) return;
    if (!streaming || runHealth.issue?.code !== "tool_protocol_incompatible" || !activeTurnId) return;
    if (protocolStopRef.current === activeTurnId) return;
    protocolStopRef.current = activeTurnId;
    onToast?.("已停止异常空转：当前模型连续返回无参数工具调用");
    onCancel?.();
  }, [onCancel, onToast, runHealth.issue?.code, streaming, transcript?.messages, transcript?.streamingMessageId]);
  const problems = useMemo<WorkspaceProblem[]>(() => [
    ...(runHealth.issue ? [{ title: runHealth.issue.title, detail: runHealth.issue.detail, kind: runHealth.issue.severity }] : []),
    ...(runStartError ? [{ title: "Coding Agent 启动失败", detail: runStartError, kind: "error" as const }] : []),
    ...(analysisError ? [{ title: "工程分析失败", detail: analysisError, kind: "error" as const }] : []),
    ...(gitError ? [{ title: "Git 状态读取失败", detail: gitError, kind: "error" as const }] : []),
    ...(analysis?.truncated ? [{ title: "工程分析达到文件上限", detail: "索引结果为部分结果，可缩小工作区后重新分析。", kind: "warning" as const }] : []),
    ...(gitState?.files.filter((file) => file.status === "conflict").map((file) => ({ title: "Git 冲突", detail: file.path, kind: "error" as const })) ?? []),
    ...allValidations
      .filter((record) => record.status === "failed" || record.status === "timed_out")
      .map((record) => ({ title: `${record.label}失败`, detail: record.command, kind: "error" as const })),
    ...Object.values(editorDiagnostics).flat().map((diagnostic) => ({
      title: `${basename(diagnostic.path)}:${diagnostic.line}:${diagnostic.column}`,
      detail: diagnostic.message,
      kind: diagnostic.severity,
      path: diagnostic.path,
      line: diagnostic.line,
      column: diagnostic.column,
    })),
  ], [allValidations, analysis?.truncated, analysisError, editorDiagnostics, gitError, gitState?.files, runHealth.issue, runStartError]);

  const switchWorkspace = useCallback((nextRoot: string) => {
    if (!nextRoot || nextRoot === root) return;
    if (hasUnsavedFiles && !window.confirm("当前工作区有未保存的文件。切换工作区将丢失这些草稿，确认继续吗？")) return;
    onSelectWorkspace?.(nextRoot);
  }, [hasUnsavedFiles, onSelectWorkspace, root]);

  const exitWorkspace = useCallback(() => {
    if (hasUnsavedFiles && !window.confirm("当前工作区有未保存的文件。退出代码开发将丢失这些草稿，确认继续吗？")) return;
    onExit?.();
  }, [hasUnsavedFiles, onExit]);

  const selectWorkspace = useCallback(async () => {
    try {
      const selected = await filesystemPickDirectory();
      if (selected) switchWorkspace(selected);
    } catch (error) {
      onToast?.(`选择工作区失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [onToast, switchWorkspace]);

  const openFile = useCallback(async (path: string) => {
    const requestedPath = workspaceFilePath(root, path);
    setActiveFilePath(requestedPath);
    setFileMode("edit");
    if (openFilePathsRef.current.has(requestedPath)) return;
    openFilePathsRef.current.add(requestedPath);
    const pending: OpenFile = {
      path: requestedPath,
      relativePath: path,
      name: basename(requestedPath),
      original: "",
      draft: "",
      hash: "",
      language: "plaintext",
      lineEnding: "LF",
      size: 0,
      loading: true,
    };
    setOpenFiles((previous) => [...previous, pending]);
    try {
      const document = await codingReadDocument(root, requestedPath);
      if (workspaceRootRef.current !== root) return;
      if (document.path !== requestedPath) {
        openFilePathsRef.current.delete(requestedPath);
        openFilePathsRef.current.add(document.path);
      }
      setOpenFiles((previous) => previous.map((file) => file.path === requestedPath
        ? {
            ...file,
            path: document.path,
            relativePath: document.relativePath,
            original: document.content,
            draft: document.content,
            hash: document.hash,
            language: document.language,
            lineEnding: document.lineEnding,
            size: document.size,
            loading: false,
          }
        : file));
      setActiveFilePath(document.path);
    } catch (error) {
      if (workspaceRootRef.current !== root) return;
      setOpenFiles((previous) => previous.map((file) => file.path === requestedPath
        ? { ...file, loading: false, error: String(error).replace(/^Error:\s*/, "") }
        : file));
    }
  }, [root]);

  const createWorkspaceEntry = useCallback(async () => {
    const name = newEntryName.trim();
    if (!newEntryKind || !name || creatingEntry) return;
    setCreatingEntry(true);
    try {
      const createdPath = await codingCreateEntry(
        root,
        selectedDirectoryPath || root,
        name,
        newEntryKind === "directory",
      );
      setFileTreeRevision((value) => value + 1);
      setGitRevision((value) => value + 1);
      setScanRevision((value) => value + 1);
      setNewEntryKind(null);
      setNewEntryName("");
      if (newEntryKind === "directory") {
        setSelectedDirectoryPath(createdPath);
        onToast?.(`已创建目录 ${name}`);
      } else {
        onToast?.(`已创建文件 ${name}`);
        await openFile(createdPath);
      }
    } catch (error) {
      onToast?.(`创建失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setCreatingEntry(false);
    }
  }, [creatingEntry, newEntryKind, newEntryName, onToast, openFile, root, selectedDirectoryPath]);

  const updateEditorDiagnostics = useCallback((path: string, diagnostics: CodingEditorDiagnostic[]) => {
    setEditorDiagnostics((previous) => {
      if (diagnostics.length === 0) {
        if (!(path in previous)) return previous;
        const next = { ...previous };
        delete next[path];
        return next;
      }
      return {
        ...previous,
        [path]: diagnostics,
      };
    });
  }, []);

  const reloadFile = useCallback(async (file: OpenFile) => {
    if (file.draft !== file.original && !window.confirm(`重新加载会放弃“${file.name}”的未保存修改，确认继续？`)) return;
    setOpenFiles((previous) => previous.map((entry) => entry.path === file.path
      ? { ...entry, loading: true, error: undefined, conflict: false }
      : entry));
    try {
      const document = await codingReadDocument(root, file.path);
      setOpenFiles((previous) => previous.map((entry) => entry.path === file.path
        ? {
            ...entry,
            original: document.content,
            draft: document.content,
            hash: document.hash,
            language: document.language,
            lineEnding: document.lineEnding,
            size: document.size,
            loading: false,
            conflict: false,
          }
        : entry));
    } catch (error) {
      setOpenFiles((previous) => previous.map((entry) => entry.path === file.path
        ? { ...entry, loading: false, error: String(error).replace(/^Error:\s*/, "") }
        : entry));
    }
  }, [root]);

  const openGitChange = useCallback(async (file: CodingGitFile) => {
    setCenterView("editor");
    setGitDiffPath(file.path);
    setGitDiff("正在读取 Git Diff…");
    setFileMode("git");
    setSnapshot((previous) => previous.reviewedFiles.includes(file.path)
      ? previous
      : { ...previous, reviewedFiles: [...previous.reviewedFiles, file.path] });
    try {
      const diff = await codingGitDiff(root, file.path);
      setGitDiff(diff || (file.untracked ? "未跟踪文件尚无 HEAD Diff；打开文件可查看完整内容。" : "当前文件没有可显示的文本 Diff。"));
    } catch (error) {
      setGitDiff(`读取 Git Diff 失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [root, setSnapshot]);

  const setFileStaged = useCallback(async (file: CodingGitFile, staged: boolean) => {
    if (gitActionPath) return;
    setGitActionPath(file.path);
    try {
      const next = await codingGitSetStaged(root, file.path, staged);
      setGitState(next);
      onToast?.(staged ? `已暂存 ${file.path}` : `已取消暂存 ${file.path}`);
    } catch (error) {
      onToast?.(`${staged ? "暂存" : "取消暂存"}失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setGitActionPath(null);
    }
  }, [gitActionPath, onToast, root]);

  const openSearchHit = useCallback((hit: CodingSearchHit) => {
    const path = workspaceFilePath(root, hit.path);
    setRevealLocation({ path, line: hit.line, column: hit.column, key: Date.now() });
    void openFile(path);
  }, [openFile, root]);

  const closeFile = useCallback((path: string) => {
    const target = openFiles.find((file) => file.path === path);
    if (target && target.draft !== target.original && !window.confirm(`“${target.name}”有未保存修改，确认关闭？`)) return;
    openFilePathsRef.current.delete(path);
    const next = openFiles.filter((file) => file.path !== path);
    setOpenFiles(next);
    if (activeFilePath === path) {
      setActiveFilePath(next[next.length - 1]?.path ?? null);
    }
  }, [activeFilePath, openFiles]);

  const updateDraft = useCallback((draft: string) => {
    if (!activeFilePath) return;
    setOpenFiles((previous) => previous.map((file) => file.path === activeFilePath ? { ...file, draft } : file));
  }, [activeFilePath]);

  const saveActiveFile = useCallback(async () => {
    if (!activeFile || activeFile.draft === activeFile.original) return;
    setSavingFile(true);
    try {
      const document = await codingWriteDocument(root, activeFile.path, activeFile.draft, activeFile.hash);
      setOpenFiles((previous) => previous.map((file) => file.path === activeFile.path
        ? {
            ...file,
            original: document.content,
            draft: document.content,
            hash: document.hash,
            lineEnding: document.lineEnding,
            size: document.size,
            conflict: false,
          }
        : file));
      setFileTreeRevision((value) => value + 1);
      setScanRevision((value) => value + 1);
      setGitRevision((value) => value + 1);
      onToast?.(`已保存 ${activeFile.name}`);
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      if (message.includes("保存冲突")) {
        setOpenFiles((previous) => previous.map((file) => file.path === activeFile.path
          ? { ...file, conflict: true }
          : file));
      }
      onToast?.(`保存失败：${message}`);
    } finally {
      setSavingFile(false);
    }
  }, [activeFile, onToast, root]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "s") return;
      if (!activeFile || activeFile.draft === activeFile.original) return;
      event.preventDefault();
      void saveActiveFile();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeFile, saveActiveFile]);

  const launchRun = useCallback(async (
    requirement: string,
    displayText: string,
    mode: CodingAgentMode,
    acceptanceCriteria: AcceptanceCriterion[],
  ): Promise<boolean> => {
    const normalizedRequirement = requirement.trim();
    if (!root) {
      onToast?.("请先选择代码工作区");
      return false;
    }
    if (!normalizedRequirement) {
      onToast?.("请先填写开发需求");
      return false;
    }
    if (!apiReady) {
      onOpenSettings?.();
      return false;
    }
    if (!selectedModelId) {
      onToast?.("请先选择可用模型");
      return false;
    }
    const prompt = buildCodingAgentPrompt(normalizedRequirement, acceptanceCriteria, analysis, {
      mode,
      contextPaths,
      baselineGit: gitState,
    });
    const prepared: CodingRunSnapshot = {
      version: 2,
      root,
      requirement: normalizedRequirement,
      acceptanceCriteria,
      validationRecords: [],
      docLevels: [],
      startedAt: new Date().toISOString(),
      mode,
      modelId: selectedModelId,
      contextPaths,
      reviewedFiles: [],
      baselineGit: gitState ?? undefined,
    };
    setRunStartError(null);
    setStartingRun(true);
    try {
      const sessionId = await onStartRun?.(root, prompt, displayText.trim() || normalizedRequirement, {
        mode,
        modelId: selectedModelId,
      });
      if (sessionId) {
        setSnapshot({ ...prepared, sessionId });
        setRequirementDraft(normalizedRequirement);
        setCriteriaDraft(acceptanceCriteria.map((criterion) => criterion.content).join("\n"));
        setAgentMode(mode);
        setAgentView(mode === "ask" ? "chat" : "tasks");
        setFreshSessionReason(null);
        protocolStopRef.current = null;
        useSessionStore.getState().setError(null);
        onToast?.(mode === "plan"
          ? "Plan 任务已启动，Agent 正在分析工程"
          : mode === "craft"
            ? "Craft 任务已启动，Agent 将直接完成修改和验证"
            : "Ask 会话已启动，Agent 将只读分析代码库");
        return true;
      } else {
        const message = "未能创建代码开发会话，请检查模型配置、额度或 Agent Runtime 状态后重试。";
        setRunStartError(message);
        onToast?.(message);
        return false;
      }
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      setRunStartError(message);
      onToast?.(`启动代码开发失败：${message}`);
      return false;
    } finally {
      setStartingRun(false);
    }
  }, [analysis, apiReady, contextPaths, gitState, onOpenSettings, onStartRun, onToast, root, selectedModelId, setSnapshot]);

  const startRun = useCallback(async () => {
    const requirement = requirementDraft.trim();
    const resolution = resolveCodingModeForRequest(agentMode, requirement);
    if (resolution.autoAdjusted) {
      onToast?.("检测到需要写入代码，已使用 Craft 模式开始开发");
    }
    await launchRun(
      requirement,
      requirement,
      resolution.mode,
      createAcceptanceCriteria(criteriaDraft),
    );
  }, [agentMode, criteriaDraft, launchRun, onToast, requirementDraft]);

  const resumeRun = useCallback(async () => {
    if (!snapshot.sessionId || !onResumeRun) return;
    setResumingRun(true);
    try {
      const resumed = await onResumeRun(snapshot.sessionId, root);
      if (resumed) onToast?.("已恢复代码开发会话");
      else onToast?.("未能恢复代码开发会话，可以新建任务继续开发");
    } catch (error) {
      onToast?.(`恢复开发会话失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setResumingRun(false);
    }
  }, [onResumeRun, onToast, root, snapshot.sessionId]);

  useEffect(() => {
    if (!snapshot.sessionId || sessionFocused || !onResumeRun) return;
    if (autoResumeAttemptRef.current === snapshot.sessionId) return;
    autoResumeAttemptRef.current = snapshot.sessionId;
    void resumeRun();
  }, [onResumeRun, resumeRun, sessionFocused, snapshot.sessionId]);

  const sendFollowup = useCallback(async (text = followup) => {
    if (!text.trim() || !onSend || !sessionFocused) return;
    setSendingFollowup(true);
    try {
      const displayText = text.trim();
      const resolution = resolveCodingModeForRequest(snapshot.mode, displayText);
      const baseRequirement = snapshot.requirement.trim();
      const combinedRequirement = baseRequirement && baseRequirement !== displayText
        ? `${baseRequirement}\n\n补充要求：${displayText}`
        : displayText;
      const freshResolution = resolution.intent === "unknown"
        ? resolveCodingModeForRequest(snapshot.mode, combinedRequirement)
        : resolution;
      const needsFreshSession = freshResolution.autoAdjusted
        || historicalProtocolFailures >= 3
        || Boolean(freshSessionReason);
      if (needsFreshSession) {
        if (freshResolution.autoAdjusted) {
          onToast?.("这是代码实施要求，已自动切换到 Craft 并创建干净会话");
        } else {
          onToast?.(freshSessionReason ?? "已隔离旧会话的异常工具历史，正在创建干净会话");
        }
        const criteria = snapshot.acceptanceCriteria.length > 0
          ? snapshot.acceptanceCriteria.map((criterion) => ({ ...criterion, verified: false }))
          : createAcceptanceCriteria("");
        const launched = await launchRun(combinedRequirement, displayText, freshResolution.mode, criteria);
        if (launched) setFollowup("");
        return;
      }
      const promptText = buildCodingFollowupPrompt(displayText, resolution.mode, contextPaths);
      const accepted = await onSend(promptText, displayText);
      if (accepted !== false) {
        setFollowup("");
        useSessionStore.getState().setError(null);
      }
    } finally {
      setSendingFollowup(false);
    }
  }, [contextPaths, followup, freshSessionReason, historicalProtocolFailures, launchRun, onSend, onToast, sessionFocused, snapshot.acceptanceCriteria, snapshot.mode, snapshot.requirement]);

  const changeAgentMode = useCallback(async (next: CodingAgentMode) => {
    if (next === agentMode) return;
    if (streaming) {
      onToast?.("请先等待当前执行结束，或停止后再切换模式");
      return;
    }
    if (snapshot.sessionId && sessionFocused) {
      try {
        await setAgentPlanMode(snapshot.sessionId, next === "plan");
      } catch (error) {
        onToast?.(`切换模式失败：${String(error).replace(/^Error:\s*/, "")}`);
        return;
      }
    }
    setAgentMode(next);
    setSnapshot((previous) => ({ ...previous, mode: next }));
    if (next === "ask" && snapshot.mode !== "ask") {
      setFreshSessionReason("下次发送将创建只读 Ask 会话，确保不沿用开发任务的写入权限");
    } else if (historicalProtocolFailures >= 3) {
      setFreshSessionReason("当前会话存在异常工具记录，下次发送将自动使用干净会话");
    } else {
      setFreshSessionReason(null);
    }
    onToast?.(`已切换到 ${next === "ask" ? "Ask" : next === "craft" ? "Craft" : "Plan"} 模式`);
  }, [agentMode, historicalProtocolFailures, onToast, sessionFocused, setSnapshot, snapshot.mode, snapshot.sessionId, streaming]);

  const selectCodingModel = useCallback(async (modelId: string) => {
    if (streaming) {
      onToast?.("请先停止当前执行，再切换模型");
      return;
    }
    if (snapshot.sessionId && sessionFocused) {
      try {
        await agentSetModel(snapshot.sessionId, modelId);
        useSessionsStore.getState().upsert({ sessionId: snapshot.sessionId, currentModelId: modelId });
        useSessionStore.getState().setError(null);
      } catch (error) {
        onToast?.(`切换模型失败：${String(error).replace(/^Error:\s*/, "")}`);
        return;
      }
    }
    setSelectedModelId(modelId);
    if (snapshot.sessionId) setSnapshot((previous) => ({ ...previous, modelId }));
    if (historicalProtocolFailures >= 3) {
      const reason = "模型已切换；下次发送将创建干净会话，不携带旧模型的错误工具记录";
      setFreshSessionReason(reason);
      onToast?.(reason);
    }
  }, [historicalProtocolFailures, onToast, sessionFocused, setSnapshot, snapshot.sessionId, streaming]);

  const toggleContextPath = useCallback((path: string) => {
    const normalized = path.trim();
    if (!normalized) return;
    setContextPaths((previous) => {
      const next = previous.includes(normalized)
        ? previous.filter((item) => item !== normalized)
        : [...previous, normalized].slice(-30);
      if (snapshot.sessionId) setSnapshot((current) => ({ ...current, contextPaths: next }));
      return next;
    });
  }, [setSnapshot, snapshot.sessionId]);

  const requestDocumentation = useCallback(async () => {
    if (!snapshot.requirement) {
      onToast?.("请先启动代码开发任务");
      return;
    }
    setAgentView("chat");
    await sendFollowup(buildDocumentationPrompt(snapshot.requirement));
  }, [onToast, sendFollowup, snapshot.requirement]);

  const executeCommand = useCallback(async (command: string): Promise<ValidationRecord | null> => {
    const normalized = command.trim();
    if (!normalized || runningCommand) return null;
    const risk = checkCodingCommandRisk(normalized);
    if (risk.level === "high") {
      onToast?.(`工作台拒绝执行高危命令：${risk.reasons.join("；")}`);
      return null;
    }
    if (risk.level === "medium" && riskConfirmation !== normalized) {
      setRiskConfirmation(normalized);
      onToast?.(`检测到${riskLabel(risk.level)}操作，请再次点击运行以确认`);
      return null;
    }
    setRiskConfirmation(null);
    setRunningCommand(normalized);
    const runId = `coding-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    setActiveCommandRunId(runId);
    activeCommandRunIdRef.current = runId;
    commandStreamedRef.current = false;
    setBottomOpen(true);
    setBottomView("validation");
    const startedAt = new Date().toISOString();
    setTerminalOutput((previous) => appendTerminalOutput(previous, `\n$ ${normalized}\n`));
    try {
      const result = await codingRunCommand(root, normalized, runId);
      const record = validationFromResult(result, startedAt);
      setSnapshot((previous) => ({
        ...previous,
        validationRecords: [...previous.validationRecords, record].slice(-50),
      }));
      if (!commandStreamedRef.current) {
        const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
        if (output) setTerminalOutput((previous) => appendTerminalOutput(previous, `${output}${output.endsWith("\n") ? "" : "\n"}`));
      }
      const resultLabel = result.cancelled ? "已停止" : result.timedOut ? "超时" : `退出码 ${result.exitCode ?? "无"}`;
      setTerminalOutput((previous) => appendTerminalOutput(previous, `[${resultLabel} · ${formatDuration(result.durationMs)}]\n`));
      setGitRevision((value) => value + 1);
      if (record.status === "passed") onToast?.(`${record.label}通过`);
      else if (record.status === "cancelled") onToast?.("命令已停止");
      else onToast?.(`${record.label}未通过，可让 Agent 根据日志继续修复`);
      return record;
    } catch (error) {
      const message = String(error).replace(/^Error:\s*/, "");
      setTerminalOutput((previous) => appendTerminalOutput(previous, `${message}\n`));
      onToast?.(`命令执行失败：${message}`);
      return null;
    } finally {
      activeCommandRunIdRef.current = null;
      setActiveCommandRunId(null);
      setRunningCommand(null);
    }
  }, [onToast, riskConfirmation, root, runningCommand, setSnapshot]);

  const stopCommand = useCallback(async () => {
    if (!activeCommandRunId) return;
    try {
      await codingCancelCommand(activeCommandRunId);
    } catch (error) {
      onToast?.(`停止命令失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [activeCommandRunId, onToast]);

  const runValidationSuite = useCallback(async () => {
    const commands = analysis?.validationCommands ?? [];
    if (commands.length === 0) {
      onToast?.("未识别到自动验证命令，请在终端中手动输入");
      return;
    }
    for (const command of commands) {
      const result = await executeCommand(command);
      if (!result || result.status !== "passed") break;
    }
  }, [analysis?.validationCommands, executeCommand, onToast]);

  const exportReport = useCallback(async () => {
    const content = buildVerificationReport({
      snapshot: { ...snapshot, validationRecords: allValidations },
      analysis,
      evidence,
      tasks,
      changedFiles: gitState,
    });
    try {
      const output = await exportTextFile(
        `${analysis?.name ?? "workspace"}-代码开发验收报告.md`,
        content,
        "md",
      );
      if (output) onToast?.("验收报告已导出");
    } catch (error) {
      onToast?.(`导出失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  }, [allValidations, analysis, evidence, gitState, onToast, snapshot, tasks]);

  const resetRun = useCallback(() => {
    if (snapshot.requirement && !window.confirm("确认新建代码开发任务？当前工作区文件不会被修改，但本地验收状态将重置。")) return;
    const next = EMPTY_SNAPSHOT(root);
    setSnapshot(next);
    setRequirementDraft("");
    setCriteriaDraft("");
    setAgentMode("craft");
    setContextPaths([]);
    setFreshSessionReason(null);
    setAgentView("tasks");
    autoResumeAttemptRef.current = null;
  }, [root, setSnapshot, snapshot.requirement]);

  if (!root) {
    return (
      <div className="coding-workspace coding-workspace--empty">
        <header className="coding-workspace__topbar" data-tauri-drag-region>
          <div className="coding-workspace__brand">
            <button type="button" onClick={exitWorkspace} aria-label="返回 EchoAgent" title="返回 EchoAgent"><ArrowLeft size={17} /></button>
            <Code2 size={17} /><strong>Echo Code</strong>
          </div>
          <div className="coding-workspace__command"><FolderGit2 size={14} /><span>尚未打开工作区</span></div>
          <div className="coding-workspace__top-actions"><span className="coding-workspace__runtime"><Bot size={14} /> Agent Runtime 已就绪</span></div>
        </header>
        <CodingActivityBar active={explorerView} onChange={setExplorerView} onOpenSettings={onOpenSettings} />
        <aside className="coding-empty__explorer">
          <div><strong>资源管理器</strong><span>EXPLORER</span></div>
          <p>请先打开一个代码文件夹</p>
        </aside>
        <div className="coding-empty__content">
          <div className="coding-empty__icon"><FolderGit2 size={34} /></div>
          <span className="coding-empty__eyebrow">AI-NATIVE DEVELOPMENT</span>
          <h1>打开代码库，开始工程级开发</h1>
          <p>在同一个工作台中分析代码、制定计划、编辑文件、运行终端并验证变更。</p>
          <button type="button" className="coding-primary-btn" onClick={selectWorkspace}>
            <FolderGit2 size={16} /> 选择代码文件夹
          </button>
          {workspaces.length > 0 && onSelectWorkspace && (
            <div className="coding-empty__recent">
              <span>最近工作区</span>
              {workspaces.slice(0, 5).map((workspace) => (
                <button key={workspace.cwd} type="button" onClick={() => switchWorkspace(workspace.cwd)}>
                  <FolderGit2 size={15} />
                  <span><strong>{basename(workspace.cwd)}</strong><small>{workspace.cwd}</small></span>
                  <ChevronRight size={15} />
                </button>
              ))}
            </div>
          )}
        </div>
        <aside className="coding-empty__agent">
          <div className="coding-empty__agent-title"><Bot size={16} /><strong>Code Agent</strong><Plus size={16} /></div>
          <div><Code2 size={25} /><strong>等待工作区</strong><p>打开项目后，可以在这里选择 Ask、Craft 或 Plan 模式。</p></div>
        </aside>
        <footer className="coding-workspace__statusbar"><span><Circle size={10} />Agent 空闲</span><span className="coding-workspace__statusbar-spacer" /><span>Echo Code</span></footer>
      </div>
    );
  }

  return (
    <div
      className={`coding-workspace${bottomOpen ? " coding-workspace--bottom-open" : ""}`}
      style={{ "--coding-bottom-height": `${bottomHeight}px` } as CSSProperties}
    >
      <header className="coding-workspace__topbar" data-tauri-drag-region>
        <div className="coding-workspace__brand">
          <button type="button" onClick={exitWorkspace} aria-label="返回 EchoAgent" title="返回 EchoAgent"><ArrowLeft size={17} /></button>
          <Code2 size={17} /><strong>Echo Code</strong>
        </div>
        <div className="coding-workspace__command">
          <FolderGit2 size={17} />
          <strong>{analysis?.name ?? basename(root)}</strong>
          {gitState?.hasGit && <><span>/</span><GitBranch size={14} /><span>{gitState.branch || "detached HEAD"}</span></>}
          {gitState && <span className="coding-workspace__changes"><CircleDot size={13} /> {gitState.files.length} 个 Git 变更</span>}
        </div>
        <div className="coding-workspace__top-actions">
          <div className="coding-workspace__view-switch" role="group" aria-label="代码工作台视图">
            <button type="button" className={centerView === "editor" ? "is-active" : ""} onClick={() => setCenterView("editor")}>开发视图</button>
            <button type="button" className={centerView === "evidence" ? "is-active" : ""} onClick={() => setCenterView("evidence")}>验收视图</button>
          </div>
          {analysis && <span className="coding-workspace__runtime"><ShieldCheck size={14} /> {analysis.projectType || "通用工程"} · 已授权</span>}
          <button type="button" className="coding-icon-btn" onClick={() => { setScanRevision((value) => value + 1); setGitRevision((value) => value + 1); }} aria-label="刷新代码库" title="刷新工程上下文和 Git 状态" disabled={analysisLoading || gitLoading}>
            <RefreshCw size={15} className={analysisLoading || gitLoading ? "is-spinning" : ""} />
          </button>
          {streaming && <button type="button" className="coding-stop-btn" onClick={onCancel}><Square size={13} /> 停止</button>}
        </div>
      </header>

      <CodingActivityBar active={explorerView} onChange={setExplorerView} onOpenSettings={onOpenSettings} />

      <aside className="coding-explorer">
        <div className="coding-explorer__heading">
          <span>{explorerView === "files" ? "项目资源管理器" : explorerView === "search" ? `代码搜索 ${searchResults.length}` : explorerView === "changes" ? `Git 变更 ${gitState?.files.length ?? 0}` : "工程上下文"}</span>
          <div className="coding-explorer__heading-actions">
            {explorerView === "files" && <button type="button" aria-label="新建文件" title={`在 ${selectedDirectoryPath || root} 中新建文件`} onClick={() => { setNewEntryKind("file"); setNewEntryName(""); }}><FilePlus2 size={13} /></button>}
            {explorerView === "files" && <button type="button" aria-label="新建目录" title={`在 ${selectedDirectoryPath || root} 中新建目录`} onClick={() => { setNewEntryKind("directory"); setNewEntryName(""); }}><FolderPlus size={13} /></button>}
            <button type="button" aria-label="刷新当前视图" onClick={() => { setFileTreeRevision((value) => value + 1); setGitRevision((value) => value + 1); }}><RefreshCw size={13} /></button>
          </div>
        </div>
        {explorerView === "files" && newEntryKind && (
          <form className="coding-explorer__new-entry" onSubmit={(event) => { event.preventDefault(); void createWorkspaceEntry(); }}>
            <span>{newEntryKind === "file" ? <FilePlus2 size={13} /> : <FolderPlus size={13} />}<small title={selectedDirectoryPath}>{selectedDirectoryPath === root ? "根目录" : basename(selectedDirectoryPath)}</small></span>
            <input
              autoFocus
              value={newEntryName}
              onChange={(event) => setNewEntryName(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape") { setNewEntryKind(null); setNewEntryName(""); } }}
              placeholder={newEntryKind === "file" ? "文件名，如 feature.ts" : "目录名"}
              aria-label={newEntryKind === "file" ? "新文件名" : "新目录名"}
              disabled={creatingEntry}
            />
            <button type="submit" aria-label="确认创建" disabled={!newEntryName.trim() || creatingEntry}>{creatingEntry ? <LoaderCircle size={12} className="is-spinning" /> : <Check size={12} />}</button>
            <button type="button" aria-label="取消创建" onClick={() => { setNewEntryKind(null); setNewEntryName(""); }} disabled={creatingEntry}><X size={12} /></button>
          </form>
        )}
        <div className="coding-explorer__body">
          {explorerView === "files" && (
            <FileTreeView
              key={`${root}:${fileTreeRevision}`}
              rootPath={root}
              selectedPath={activeFilePath ?? undefined}
              selectedDirectoryPath={selectedDirectoryPath}
              onFileSelect={openFile}
              onDirectorySelect={setSelectedDirectoryPath}
              onToast={onToast}
            />
          )}
          {explorerView === "search" && (
            <div className="coding-search">
              <label>
                <Search size={13} />
                <input autoFocus value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="搜索代码文本（至少 2 个字符）" aria-label="搜索代码" />
                {searchLoading && <LoaderCircle size={13} className="is-spinning" />}
              </label>
              {searchError && <div className="coding-muted-row is-error"><AlertTriangle size={14} />{searchError}</div>}
              {!searchLoading && searchQuery.trim().length >= 2 && searchResults.length === 0 && !searchError && <div className="coding-muted-row">没有找到匹配代码</div>}
              <div className="coding-search__results">
                {searchResults.map((hit, index) => (
                  <button type="button" key={`${hit.path}:${hit.line}:${hit.column}:${index}`} onClick={() => openSearchHit(hit)}>
                    <span><FileCode2 size={13} /><strong>{hit.path}</strong><b>{hit.line}:{hit.column}</b></span>
                    <code>{hit.preview}</code>
                  </button>
                ))}
              </div>
            </div>
          )}
          {explorerView === "changes" && (
            <div className="coding-change-list">
              {gitLoading && <div className="coding-muted-row"><LoaderCircle size={14} className="is-spinning" />正在读取 Git 状态…</div>}
              {!gitLoading && !gitState?.hasGit && <div className="coding-muted-row">当前工作区不是 Git 仓库，变更审查不可用</div>}
              {!gitLoading && gitState?.hasGit && gitState.files.length === 0 && <div className="coding-muted-row">工作区干净，没有未提交变更</div>}
              {gitState?.files.map((file) => (
                <button type="button" key={file.path} onClick={() => void openGitChange(file)}>
                  <FileDiff size={15} />
                  <span><strong>{basename(file.path)}</strong><small>{file.path}</small></span>
                  {snapshot.reviewedFiles.includes(file.path) && <CheckCircle2 size={13} className="coding-change-reviewed" aria-label="已审查" />}
                  <em className={`is-${file.status}`}>{file.status === "untracked" ? "U" : file.status === "added" ? "A" : file.status === "deleted" ? "D" : file.status === "renamed" ? "R" : file.status === "conflict" ? "!" : "M"}</em>
                  <b>+{file.added} −{file.removed}</b>
                </button>
              ))}
            </div>
          )}
          {explorerView === "context" && (
            <div className="coding-context-view">
              <section>
                <strong>模块与依赖</strong>
                {analysis?.modules.map((module) => (
                  <div className="coding-context-module" key={`${module.path}:${module.name}`}>
                    <span><Braces size={13} />{module.name}</span>
                    <b>{module.kind}</b>
                    <code>{module.path}</code>
                    {module.dependencies.length > 0 && <small><Network size={11} />依赖 {module.dependencies.join("、")}</small>}
                  </div>
                ))}
              </section>
              <section>
                <strong>项目指令</strong>
                {(analysis?.instructionFiles ?? []).length > 0
                  ? analysis?.instructionFiles.map((path) => <button type="button" key={path} onClick={() => void openFile(path)}><FileText size={13} /><span>{path}</span></button>)
                  : <p>未发现 AGENTS.md 或 .echoagent 规则文件</p>}
              </section>
              <section>
                <strong>技术栈</strong>
                <p>{analysis?.projectType || "通用工程"}</p>
                {analysis?.languages.slice(0, 6).map((item) => <div key={item.language}><span>{item.language}</span><b>{item.files}</b></div>)}
              </section>
              <section>
                <strong>验证策略</strong>
                {analysis?.validationCommands.length
                  ? analysis.validationCommands.map((command) => <code key={command}>{command}</code>)
                  : <p>未从构建清单识别到命令</p>}
              </section>
              <small>扫描于 {analysis?.scannedAt ? new Date(analysis.scannedAt).toLocaleTimeString() : "—"} · {analysis?.fileCount ?? 0} 个文件{analysis?.truncated ? "（部分索引）" : ""}</small>
            </div>
          )}
        </div>
        <div className="coding-explorer__footer">
          <button type="button" onClick={selectWorkspace}><FolderGit2 size={14} />切换工作区</button>
          {onSelectWorkspace && <WorkspacePicker cwd={root} workspaces={workspaces} onSelectWorkspace={switchWorkspace} />}
        </div>
      </aside>

      <main className="coding-center">
        {centerView === "editor" ? (
          <>
            <div className="coding-editor-tabs">
              {openFiles.map((file) => (
                <button type="button" key={file.path} className={file.path === activeFilePath && fileMode !== "git" ? "is-active" : ""} onClick={() => { setActiveFilePath(file.path); setFileMode("edit"); }} title={file.path}>
                  <FileCode2 size={14} /><span>{file.name}</span>{file.draft !== file.original && <i />}
                  <span role="button" aria-label={`关闭 ${file.name}`} onClick={(event) => { event.stopPropagation(); closeFile(file.path); }}><X size={12} /></span>
                </button>
              ))}
              {gitDiffPath && (
                <button type="button" className={fileMode === "git" ? "is-active" : ""} onClick={() => setFileMode("git")} title={`HEAD ↔ ${gitDiffPath}`}>
                  <GitCompareArrows size={14} /><span>{basename(gitDiffPath)} · Git Diff</span>
                  <span role="button" aria-label="关闭 Git Diff" onClick={(event) => { event.stopPropagation(); setGitDiffPath(null); setGitDiff(""); setFileMode("edit"); }}><X size={12} /></span>
                </button>
              )}
              {activeFile && (
                <div className="coding-editor-tabs__actions">
                  <button type="button" className={fileMode === "edit" ? "is-active" : ""} onClick={() => setFileMode("edit")}>编辑</button>
                  <button type="button" className={fileMode === "diff" ? "is-active" : ""} onClick={() => setFileMode("diff")}>未保存 Diff</button>
                  {activeFile.language === "html" && <button type="button" className={fileMode === "preview" ? "is-active" : ""} onClick={() => setFileMode("preview")}>预览</button>}
                </div>
              )}
            </div>
            {fileMode === "git" && gitDiffPath ? (
              <div className="coding-editor-shell">
                <div className="coding-editor-toolbar">
                  <span><GitCompareArrows size={13} />HEAD ↔ {gitDiffPath}</span>
                  <div>
                    {(() => {
                      const change = gitState?.files.find((file) => file.path === gitDiffPath);
                      if (!change) return null;
                      return change.staged && !change.unstaged
                        ? <button type="button" disabled={gitActionPath === change.path} onClick={() => void setFileStaged(change, false)}><RotateCcw size={13} />取消暂存</button>
                        : <button type="button" disabled={gitActionPath === change.path} onClick={() => void setFileStaged(change, true)}><Check size={13} />暂存文件</button>;
                    })()}
                    {gitState?.files.find((file) => file.path === gitDiffPath)?.status !== "deleted" && (
                      <button type="button" onClick={() => void openFile(gitDiffPath)}><FileCode2 size={13} />打开文件</button>
                    )}
                    <button type="button" onClick={() => {
                      const file = gitState?.files.find((entry) => entry.path === gitDiffPath);
                      if (file) void openGitChange(file);
                    }}><RefreshCw size={13} />刷新 Diff</button>
                  </div>
                </div>
                <pre className="coding-git-diff" aria-label={`${gitDiffPath} 的 Git 差异`}>{gitDiff}</pre>
                <div className="coding-editor-status"><span><GitBranch size={13} />{gitState?.branch || "detached HEAD"}</span><span>{gitState?.head || "HEAD"}</span><span>只读审查</span></div>
              </div>
            ) : activeFile ? (
              <div className="coding-editor-shell">
                <div className="coding-editor-toolbar">
                  <span>{activeFile.relativePath.split(/[/\\]/).join(" › ")}</span>
                  <div>
                    <button
                      type="button"
                      className={contextPaths.includes(activeFile.relativePath) ? "is-active" : ""}
                      onClick={() => toggleContextPath(activeFile.relativePath)}
                      title="把当前文件作为 Agent 的优先上下文"
                    >
                      <Bot size={13} />{contextPaths.includes(activeFile.relativePath) ? "已加入上下文" : "加入 Agent 上下文"}
                    </button>
                    {activeFile.conflict && <button type="button" className="is-warning" onClick={() => void reloadFile(activeFile)}><RefreshCw size={13} />外部已修改，重新加载</button>}
                    {activeFile.draft !== activeFile.original && <button type="button" onClick={() => updateDraft(activeFile.original)}><RotateCcw size={13} />撤销未保存</button>}
                    <button type="button" className="coding-save-btn" disabled={savingFile || activeFile.conflict || activeFile.draft === activeFile.original} onClick={() => void saveActiveFile()}><Save size={13} />{savingFile ? "保存中" : "保存"}</button>
                  </div>
                </div>
                {fileMode === "preview" && activeFile.language === "html" ? (
                  <iframe
                    className="coding-html-preview"
                    title={`${activeFile.name} 预览`}
                    sandbox="allow-scripts"
                    srcDoc={activeFile.draft}
                  />
                ) : activeFile.loading ? (
                  <div className="coding-editor-state"><LoaderCircle className="is-spinning" />正在读取文件…</div>
                ) : activeFile.error ? (
                  <div className="coding-editor-state is-error"><AlertTriangle />{activeFile.error}</div>
                ) : (
                  <CodingEditor
                    path={activeFile.path}
                    language={activeFile.language}
                    original={activeFile.original}
                    value={activeFile.draft}
                    mode={fileMode === "diff" ? "diff" : "edit"}
                    readOnly={activeFile.conflict}
                    reveal={revealLocation?.path === activeFile.path ? revealLocation : undefined}
                    onChange={updateDraft}
                    onSave={() => void saveActiveFile()}
                    onDiagnostics={updateEditorDiagnostics}
                  />
                )}
                <div className="coding-editor-status"><span><ShieldCheck size={13} />工作区已授权</span><span>UTF-8 · {activeFile.lineEnding}</span><span>{activeFile.language} · {(activeFile.size / 1024).toFixed(1)} KB</span></div>
              </div>
            ) : (
              <div className="coding-editor-welcome">
                <div className="coding-editor-welcome__mark"><Code2 size={33} /></div>
                <h1>Echo Code</h1>
                <p>从右侧 Code Agent 输入开发需求，或从左侧资源管理器打开文件。</p>
                <div className="coding-editor-welcome__actions">
                  <button type="button" onClick={() => setExplorerView("files")}><Files size={15} /><span><strong>浏览项目文件</strong><small>资源管理器</small></span></button>
                  <button type="button" onClick={() => setExplorerView("search")}><Search size={15} /><span><strong>全局搜索代码</strong><small>搜索</small></span></button>
                  <button type="button" onClick={() => { setBottomOpen(true); setBottomView("terminal"); setTerminalActivated(true); }}><TerminalSquare size={15} /><span><strong>打开集成终端</strong><small>终端</small></span></button>
                </div>
              </div>
            )}
          </>
        ) : (
          <EvidenceCenter
            evidence={evidence}
            selected={activeEvidence}
            analysis={analysis}
            changes={gitState}
            tasks={tasks}
            validations={allValidations}
            onSelect={setEvidenceSelection}
            onExport={exportReport}
          />
        )}
      </main>

      <aside className="coding-agent-panel">
        <div className="coding-agent-panel__title">
          <span><Bot size={16} /><strong>Code Agent</strong></span>
          <button type="button" onClick={resetRun} disabled={streaming} aria-label="新建开发任务" title="新建开发任务"><Plus size={16} /></button>
        </div>
        <div className="coding-agent-panel__tabs" role="tablist" aria-label="Coding Agent 面板">
          <button type="button" role="tab" aria-selected={agentView === "tasks"} className={agentView === "tasks" ? "is-active" : ""} onClick={() => setAgentView("tasks")}><ListChecks size={14} />任务 {tasks.length > 0 && <span>{tasks.filter((task) => task.status === "completed").length}/{tasks.length}</span>}</button>
          <button type="button" role="tab" aria-selected={agentView === "chat"} className={agentView === "chat" ? "is-active" : ""} onClick={() => setAgentView("chat")}><Code2 size={14} />Agent</button>
          <button type="button" role="tab" aria-selected={agentView === "acceptance"} className={agentView === "acceptance" ? "is-active" : ""} onClick={() => setAgentView("acceptance")}><CheckCircle2 size={14} />验收</button>
        </div>
        <div className="coding-agent-panel__body">
          {!snapshot.sessionId ? (
            <div className="coding-agent-onboarding">
              <div className="coding-agent-onboarding__mark"><Code2 size={24} /></div>
              <strong>准备好开始开发</strong>
              <p>在下方描述需求，Agent 会先读取工程规则和相关代码，再按所选模式执行。</p>
              {analysisLoading ? (
                <span className="coding-agent-onboarding__loading"><LoaderCircle size={13} className="is-spinning" />正在建立工程索引…</span>
              ) : analysis ? (
                <div className="coding-agent-onboarding__facts">
                  <span><b>{analysis.fileCount.toLocaleString()}</b>代码文件</span>
                  <span><b>{analysis.modules.length}</b>识别模块</span>
                  <span><b>{analysis.validationCommands.length}</b>验证命令</span>
                  <span><b>{analysis.instructionFiles.length}</b>工程规则</span>
                </div>
              ) : null}
              {analysisError && <div className="coding-agent-onboarding__error"><AlertTriangle size={13} />{analysisError}</div>}
              <small><ShieldCheck size={12} />写文件和高风险命令继续遵循当前权限策略</small>
            </div>
          ) : !sessionFocused ? (
            <div className="coding-agent-empty">
              <RotateCcw size={24} />
              <strong>开发会话未加载</strong>
              <p>工作台已保存任务状态，正在自动恢复上次开发上下文。</p>
              {snapshot.requirement && <blockquote>{snapshot.requirement}</blockquote>}
              <div className="coding-agent-empty__actions">
                <button type="button" className="coding-primary-btn" disabled={resumingRun || !onResumeRun} onClick={() => void resumeRun()}>{resumingRun ? <><LoaderCircle size={14} className="is-spinning" />恢复中…</> : "恢复开发会话"}</button>
                <button type="button" onClick={resetRun} disabled={resumingRun}>新建开发任务</button>
              </div>
            </div>
          ) : (
            <>
              <CodingRunStatus
                health={runHealth}
                elapsedMs={runElapsedMs}
                onOpenTrace={() => { setBottomOpen(true); setBottomView("trace"); }}
                onRetry={() => void startRun()}
                retrying={startingRun || streaming}
                modelReady={Boolean(selectedModelId)}
              />
              {(pendingPermission || pendingQuestion) && (
                <div className="coding-agent-interaction" aria-label="Agent 正在等待你的操作">
                  {pendingPermission && <PermissionInlineCard sessionId={snapshot.sessionId ?? null} />}
                  {pendingQuestion && <QuestionInlineCard sessionId={snapshot.sessionId ?? null} />}
                </div>
              )}
              {agentView === "tasks" ? (
                <div className="coding-tasks-view">
                  <div className="coding-goal-card"><span>开发目标</span><strong>{snapshot.requirement}</strong></div>
                  <TaskDag tasks={tasks} health={runHealth} mode={snapshot.mode} />
                  {snapshot.mode === "plan" && <PlanPanel sessionId={snapshot.sessionId} onSend={onSend} onToast={onToast} />}
                </div>
              ) : agentView === "chat" ? (
                <div className="coding-agent-chat">
              {messages.length === 0 && <div className="coding-muted-row">Agent 正在准备工程上下文…</div>}
              {messages.slice(-10).map((message) => message.role === "user" ? (
                <div className="coding-agent-chat__user" key={message.id}>
                  {message.parts.filter((part) => part.kind === "text").map((part, index) => part.kind === "text" && <Markdown key={index} complete>{part.text}</Markdown>)}
                </div>
              ) : (
                <ExecutionProcess
                  key={message.id}
                  parts={message.parts}
                  active={!message.complete}
                  startedAt={message.startedAt}
                  completedAt={message.completedAt}
                  stopReason={message.stopReason}
                  cancelTrigger={message.cancelTrigger}
                  cancellationCategory={message.cancellationCategory}
                  agentResult={message.agentResult}
                />
              ))}
                </div>
              ) : (
                <AcceptanceView criteria={snapshot.acceptanceCriteria} evidence={evidence} onChange={(acceptanceCriteria) => setSnapshot({ acceptanceCriteria })} />
              )}
            </>
          )}
        </div>
        {!snapshot.sessionId ? (
          <CodeAgentStarter
            requirement={requirementDraft}
            criteria={criteriaDraft}
            starting={startingRun}
            startError={runStartError}
            apiReady={apiReady}
            mode={agentMode}
            models={models}
            modelId={selectedModelId}
            contextPaths={contextPaths}
            preExistingChanges={gitState?.files.length ?? 0}
            onRequirementChange={setRequirementDraft}
            onCriteriaChange={setCriteriaDraft}
            onModeChange={(mode) => void changeAgentMode(mode)}
            onModelChange={(modelId) => void selectCodingModel(modelId)}
            onRemoveContext={toggleContextPath}
            onStart={startRun}
            onOpenSettings={onOpenSettings}
            onToast={onToast}
          />
        ) : sessionFocused && (
          <div className="coding-agent-panel__composer">
            <div className="coding-agent-panel__mode-row">
              <AgentModeSwitcher mode={agentMode} onChange={(mode) => void changeAgentMode(mode)} disabled={streaming} compact />
              <ModelSelector modelId={selectedModelId} models={models} onModelChange={(modelId) => void selectCodingModel(modelId)} />
            </div>
            {contextPaths.length > 0 && (
              <div className="coding-context-chips" aria-label="Agent 上下文">
                {contextPaths.map((path) => <button type="button" key={path} onClick={() => toggleContextPath(path)} title="移除上下文"><FileCode2 size={11} />{path}<X size={10} /></button>)}
              </div>
            )}
            {freshSessionReason && (
              <div className="coding-agent-panel__fresh-session" role="status">
                <ShieldCheck size={13} />
                <span>{freshSessionReason}</span>
              </div>
            )}
            {agentMode === "plan" && (
              <div className="coding-agent-panel__mode-guidance">
                <ListChecks size={13} />
                <span>Plan 会先澄清需求并等待计划批准；要直接生成文件，请使用 Craft。</span>
              </div>
            )}
            <textarea aria-label="给 Coding Agent 的补充要求" value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder="继续当前任务；新需求请点击右上角 + 新建开发任务…" rows={2} disabled={sendingFollowup || streaming} />
            <div>
              <span className="coding-agent-panel__composer-tools">
                <PermissionPicker onToast={onToast} sessionId={snapshot.sessionId} />
                <button type="button" onClick={() => void requestDocumentation()} disabled={streaming || sendingFollowup}><FileText size={13} />生成变更文档</button>
              </span>
              <button type="button" className="coding-send-btn" onClick={() => void sendFollowup()} disabled={!followup.trim() || sendingFollowup || streaming} aria-label="发送给 Coding Agent"><Send size={15} /></button>
            </div>
          </div>
        )}
      </aside>

      <section className="coding-bottom-panel">
        <div
          className="coding-bottom-panel__resizer"
          role="separator"
          aria-label="调整终端与验证面板高度"
          aria-orientation="horizontal"
          aria-valuemin={120}
          aria-valuemax={Math.round(window.innerHeight * 0.65)}
          aria-valuenow={bottomHeight}
          tabIndex={0}
          onPointerDown={beginBottomResize}
          onKeyDown={(event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            setBottomHeight((value) => Math.min(Math.round(window.innerHeight * 0.65), Math.max(120, value + (event.key === "ArrowUp" ? 16 : -16))));
          }}
        />
        <div className="coding-bottom-panel__tabs" role="tablist" aria-label="执行与验证中心">
          <button type="button" role="tab" aria-selected={bottomView === "terminal"} className={bottomView === "terminal" ? "is-active" : ""} onClick={() => { setTerminalActivated(true); setBottomOpen(true); setBottomView("terminal"); }}><TerminalSquare size={14} />终端</button>
          <button type="button" role="tab" aria-selected={bottomView === "validation"} className={bottomView === "validation" ? "is-active" : ""} onClick={() => { setBottomOpen(true); setBottomView("validation"); }}><Play size={13} />验证命令</button>
          <button type="button" role="tab" aria-selected={bottomView === "problems"} className={bottomView === "problems" ? "is-active" : ""} onClick={() => { setBottomOpen(true); setBottomView("problems"); }}>问题 <span>{problems.length}</span></button>
          <button type="button" role="tab" aria-selected={bottomView === "tests"} className={bottomView === "tests" ? "is-active" : ""} onClick={() => { setBottomOpen(true); setBottomView("tests"); }}><TestTube2 size={14} />测试 <span>{allValidations.length}</span></button>
          <button type="button" role="tab" aria-selected={bottomView === "report"} className={bottomView === "report" ? "is-active" : ""} onClick={() => { setBottomOpen(true); setBottomView("report"); }}>验证报告</button>
          <button type="button" role="tab" aria-selected={bottomView === "trace"} className={bottomView === "trace" ? "is-active" : ""} onClick={() => { setBottomOpen(true); setBottomView("trace"); }}>执行轨迹</button>
          <div className="coding-bottom-panel__actions">
            <button type="button" onClick={() => void runValidationSuite()} disabled={Boolean(runningCommand) || !analysis?.validationCommands.length}><Play size={13} />运行全部验证</button>
            <button type="button" onClick={() => setBottomOpen((value) => !value)} aria-label={bottomOpen ? "收起底部面板" : "展开底部面板"}><ChevronDown size={14} className={!bottomOpen ? "is-collapsed" : ""} /></button>
          </div>
        </div>
        <div className="coding-bottom-panel__body" hidden={!bottomOpen}>
            {terminalActivated && (
              <div className="coding-bottom-panel__terminal" hidden={bottomView !== "terminal"}>
              <CodingTerminal root={root} onToast={onToast} />
              </div>
            )}
            {bottomView === "validation" && (
              <div className="coding-terminal-view">
                <div className="coding-terminal-view__main">
                  <pre role="log" aria-label="终端输出">{terminalOutput}</pre>
                  <form onSubmit={(event) => { event.preventDefault(); void executeCommand(terminalCommand); }}>
                    <span>$</span><input value={terminalCommand} onChange={(event) => { setTerminalCommand(event.target.value); setRiskConfirmation(null); }} aria-label="终端命令" placeholder="输入工作区命令" disabled={Boolean(runningCommand)} />
                    {runningCommand
                      ? <button type="button" className="is-stop" onClick={() => void stopCommand()}><Square size={13} />停止</button>
                      : <button type="submit" disabled={!terminalCommand.trim()}><Play size={14} />{riskConfirmation === terminalCommand.trim() ? "确认运行" : "运行"}</button>}
                  </form>
                </div>
                <div className="coding-validation-presets">
                  <strong>工程验证</strong>
                  {analysis?.validationCommands.length ? analysis.validationCommands.map((command) => (
                    <button type="button" key={command} onClick={() => { setTerminalCommand(command); void executeCommand(command); }} disabled={Boolean(runningCommand)}><Play size={13} /><code>{command}</code></button>
                  )) : <span>未自动识别命令</span>}
                  <p><ShieldCheck size={12} />工作目录固定为当前代码库；这是本机 Shell，高危命令由原生策略拒绝。</p>
                </div>
              </div>
            )}
            {bottomView === "problems" && <ProblemsView problems={problems} onOpen={(problem) => {
              if (!problem.path || !problem.line || !problem.column) return;
              setCenterView("editor");
              setFileMode("edit");
              setRevealLocation({ path: problem.path, line: problem.line, column: problem.column, key: Date.now() });
              void openFile(problem.path);
            }} />}
            {bottomView === "tests" && <ValidationsView records={allValidations} />}
            {bottomView === "report" && <CompactReport evidence={evidence} onOpenFull={() => setCenterView("evidence")} onExport={exportReport} />}
            {bottomView === "trace" && <TraceView messages={messages} />}
        </div>
      </section>

      <footer className="coding-workspace__statusbar">
        <span><GitBranch size={12} />{gitState?.branch || "无 Git 分支"}</span>
        <span>{analysis?.fileCount.toLocaleString() ?? 0} 个文件</span>
        <span>{analysis?.modules.length ?? 0} 个模块</span>
        {snapshot.sessionId && <span>{snapshot.mode === "ask" ? "Ask" : snapshot.mode === "craft" ? "Craft" : "Plan"}</span>}
        {changedScope.preExisting.length > 0 && <span title={changedScope.preExisting.join("\n")}>基线变更 {changedScope.preExisting.length}</span>}
        {changedScope.agent.length > 0 && <span title={changedScope.agent.join("\n")}>任务变更 {changedScope.agent.length}</span>}
        <span className="coding-workspace__statusbar-spacer" />
        {runHealth.phase === "failed" ? <span className="is-error"><AlertTriangle size={12} />{runHealth.label}</span> : ["awaiting_input", "awaiting_approval"].includes(runHealth.phase) ? <span className="is-waiting"><MessageCircleQuestion size={12} />{runHealth.label}</span> : streaming ? <span className="is-running"><LoaderCircle size={12} className="is-spinning" />{runHealth.label}</span> : runningCommand ? <span className="is-running"><LoaderCircle size={12} className="is-spinning" />验证执行中</span> : <span><Circle size={10} />Agent 空闲</span>}
        <button type="button" onClick={resetRun} disabled={streaming} title={streaming ? "Agent 执行期间请先停止当前任务" : undefined}><Plus size={12} />新开发任务</button>
      </footer>
    </div>
  );
}

const CODING_MODE_INFO: Record<CodingAgentMode, { label: string; title: string; description: string }> = {
  ask: { label: "Ask", title: "理解与问答", description: "只读分析代码、解释实现和定位问题" },
  craft: { label: "Craft", title: "快速开发", description: "目标明确时直接修改并运行验证" },
  plan: { label: "Plan", title: "工程任务", description: "先生成计划，批准后执行跨文件开发" },
};

function AgentModeSwitcher({
  mode,
  onChange,
  disabled = false,
  compact = false,
}: {
  mode: CodingAgentMode;
  onChange: (mode: CodingAgentMode) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <div className={`coding-mode-switcher${compact ? " is-compact" : ""}`} role="radiogroup" aria-label="Agent 编程模式">
      {(Object.keys(CODING_MODE_INFO) as CodingAgentMode[]).map((entry) => {
        const info = CODING_MODE_INFO[entry];
        const Icon = entry === "ask" ? MessageCircleQuestion : entry === "craft" ? Wrench : ListChecks;
        return (
          <button
            type="button"
            role="radio"
            aria-checked={mode === entry}
            className={mode === entry ? "is-active" : ""}
            onClick={() => onChange(entry)}
            disabled={disabled}
            key={entry}
            title={info.description}
          >
            <Icon size={compact ? 12 : 15} />
            <span><strong>{info.label}</strong>{!compact && <small>{info.title}</small>}</span>
          </button>
        );
      })}
    </div>
  );
}

function CodingRunStatus({
  health,
  elapsedMs,
  onOpenTrace,
  onRetry,
  retrying,
  modelReady,
}: {
  health: CodingRunHealth;
  elapsedMs: number;
  onOpenTrace: () => void;
  onRetry: () => void;
  retrying: boolean;
  modelReady: boolean;
}) {
  const active = ["preparing", "analyzing", "planning", "implementing", "verifying"].includes(health.phase);
  const waiting = ["awaiting_input", "awaiting_approval"].includes(health.phase);
  return (
    <section className={`coding-run-status is-${health.phase}`} aria-live="polite">
      <div className="coding-run-status__headline">
        <span>{active ? <LoaderCircle size={14} className="is-spinning" /> : waiting ? <MessageCircleQuestion size={14} /> : health.phase === "failed" ? <AlertTriangle size={14} /> : health.phase === "completed" ? <CheckCircle2 size={14} /> : <Bot size={14} />}</span>
        <div><strong>{health.label}</strong><small>{health.detail}</small></div>
        {elapsedMs > 0 && <time>{formatDuration(elapsedMs)}</time>}
      </div>
      {health.toolCount > 0 && (
        <div className="coding-run-status__metrics">
          <span>{health.completedToolCount}/{health.toolCount} 操作完成</span>
          {health.failedToolCount > 0 && <span className="is-error">{health.failedToolCount} 项失败</span>}
        </div>
      )}
      {health.issue && (
        <div className={`coding-run-issue is-${health.issue.severity}`} role="alert">
          <strong>{health.issue.title}</strong>
          <p>{health.issue.detail}</p>
          <small>{health.issue.action}</small>
          <div><button type="button" onClick={onOpenTrace}>查看执行轨迹</button><button type="button" onClick={onRetry} disabled={retrying || !modelReady}>{retrying ? "重试中…" : "新建干净会话重试"}</button></div>
        </div>
      )}
    </section>
  );
}

function CodeAgentStarter({
  requirement,
  criteria,
  starting,
  startError,
  apiReady,
  mode,
  models,
  modelId,
  contextPaths,
  preExistingChanges,
  onRequirementChange,
  onCriteriaChange,
  onModeChange,
  onModelChange,
  onRemoveContext,
  onStart,
  onOpenSettings,
  onToast,
}: {
  requirement: string;
  criteria: string;
  starting: boolean;
  startError: string | null;
  apiReady: boolean;
  mode: CodingAgentMode;
  models: ModelOption[];
  modelId?: string;
  contextPaths: string[];
  preExistingChanges: number;
  onRequirementChange: (value: string) => void;
  onCriteriaChange: (value: string) => void;
  onModeChange: (mode: CodingAgentMode) => void;
  onModelChange: (modelId: string) => void;
  onRemoveContext: (path: string) => void;
  onStart: () => void;
  onOpenSettings?: () => void;
  onToast?: (message: string) => void;
}) {
  const resolution = resolveCodingModeForRequest(mode, requirement);
  const actionLabel = resolution.mode === "ask"
    ? "开始只读分析"
    : resolution.mode === "craft"
      ? "开始快速开发"
      : "分析并生成计划";

  return (
    <div className="coding-agent-starter">
      {contextPaths.length > 0 && (
        <div className="coding-context-chips" aria-label="Agent 上下文">{contextPaths.map((path) => <button type="button" key={path} onClick={() => onRemoveContext(path)} title="移除上下文"><FileCode2 size={11} />{path}<X size={10} /></button>)}</div>
      )}
      <textarea
        aria-label="开发需求"
        value={requirement}
        onChange={(event) => onRequirementChange(event.target.value)}
        rows={4}
        placeholder="描述开发需求，@ 引用文件，/ 使用命令…"
      />
      <details className="coding-agent-starter__criteria">
        <summary><ListChecks size={13} /><span>验收标准</span><small>{criteria.trim() ? "已填写" : "可选"}</small><ChevronDown size={13} /></summary>
        <textarea
          aria-label="验收标准"
          value={criteria}
          onChange={(event) => onCriteriaChange(event.target.value)}
          rows={3}
          placeholder={"每行一条，例如：\n关键流程可正常使用\n自动化测试全部通过"}
        />
      </details>
      {preExistingChanges > 0 && <div className="coding-agent-starter__notice"><GitCompareArrows size={13} />已保护任务前的 {preExistingChanges} 个 Git 变更</div>}
      {resolution.autoAdjusted && <div className="coding-agent-starter__notice is-mode-suggestion"><Wrench size={13} />检测到代码实施要求，发送时将使用 Craft 模式真正写入并验证文件</div>}
      {!apiReady && <div className="coding-agent-starter__warning"><AlertTriangle size={13} />尚未配置可用模型。<button type="button" onClick={onOpenSettings}>前往设置</button></div>}
      {startError && <div className="coding-agent-starter__warning" role="alert"><AlertTriangle size={13} />{startError}</div>}
      <div className="coding-agent-starter__controls">
        <AgentModeSwitcher mode={mode} onChange={onModeChange} disabled={starting} compact />
        <ModelSelector modelId={modelId} models={models} onModelChange={onModelChange} />
      </div>
      <div className="coding-agent-starter__toolbar">
        <PermissionPicker onToast={onToast} />
        <span className="coding-agent-starter__skills" title="自动使用已启用的编程 Skill"><Wrench size={13} />Coding Skills</span>
        <span className="coding-agent-starter__mode-label">{CODING_MODE_INFO[resolution.mode].title}</span>
        <button
          type="button"
          className="coding-send-btn"
          disabled={starting || !requirement.trim() || !modelId}
          onClick={onStart}
          aria-label={actionLabel}
          title={actionLabel}
        >
          {starting ? <LoaderCircle size={15} className="is-spinning" /> : <Send size={15} />}
        </button>
      </div>
    </div>
  );
}

function TaskDag({
  tasks,
  health,
  mode,
}: {
  tasks: ReturnType<typeof deriveTaskNodes>;
  health: CodingRunHealth;
  mode: CodingAgentMode;
}) {
  const completed = tasks.filter((task) => task.status === "completed").length;
  const progress = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  if (tasks.length === 0) {
    const active = ["preparing", "analyzing", "planning", "implementing", "verifying"].includes(health.phase);
    const waiting = ["awaiting_input", "awaiting_approval"].includes(health.phase);
    return (
      <div className={`coding-task-empty is-${health.phase}`}>
        {active && <LoaderCircle size={15} className="is-spinning" />}
        {waiting && <MessageCircleQuestion size={15} />}
        {health.phase === "failed" && <AlertTriangle size={15} />}
        <span>{health.phase === "failed" || waiting
          ? health.label
          : mode === "ask"
            ? active ? "Agent 正在只读分析代码库…" : "Ask 模式结果会显示在 Agent 页签"
            : mode === "craft"
              ? active ? health.label : "Craft 模式会直接实施，不强制生成任务计划"
              : active ? health.label : "等待 Agent 提交任务计划"}</span>
      </div>
    );
  }
  return (
    <div className="coding-task-dag">
      <div className="coding-task-dag__head"><span>任务依赖图</span><b>{completed}/{tasks.length} · {progress}%</b></div>
      <div className="coding-task-dag__progress"><span style={{ width: `${progress}%` }} /></div>
      {tasks.map((task) => (
        <div className={`coding-task-node is-${task.status}`} key={task.id}>
          <div className="coding-task-node__rail">{task.status === "completed" ? <CheckCircle2 size={15} /> : task.status === "in_progress" ? <LoaderCircle size={15} className="is-spinning" /> : <Circle size={14} />}</div>
          <div><span><b>{task.id}</b>{task.dependencies.length > 0 && <small>依赖 {task.dependencies.join("、")}</small>}</span><strong>{task.content}</strong>{task.relatedFiles.length > 0 && <code>{task.relatedFiles.join(" · ")}</code>}</div>
        </div>
      ))}
    </div>
  );
}

function AcceptanceView({
  criteria,
  evidence,
  onChange,
}: {
  criteria: AcceptanceCriterion[];
  evidence: QualityGate[];
  onChange: (criteria: AcceptanceCriterion[]) => void;
}) {
  return (
    <div className="coding-acceptance-view">
      <div className="coding-acceptance-view__heading"><strong>需求验收标准</strong><span>{criteria.filter((item) => item.verified).length}/{criteria.length}</span></div>
      {criteria.map((criterion) => (
        <label key={criterion.id}>
          <input type="checkbox" checked={criterion.verified} onChange={(event) => onChange(criteria.map((item) => item.id === criterion.id ? { ...item, verified: event.target.checked } : item))} />
          <span>{criterion.content}</span>
        </label>
      ))}
      <hr />
      <div className="coding-acceptance-view__heading"><strong>交付质量门禁</strong><span>{evidence.filter((item) => item.status === "satisfied").length}/{evidence.length}</span></div>
      {evidence.map((item) => <div className={`coding-gate is-${item.status}`} key={item.id}>{item.status === "satisfied" ? <CheckCircle2 size={15} /> : item.status === "in_progress" ? <LoaderCircle size={15} /> : <Circle size={15} />}<span><strong>{item.title}</strong><small>{item.summary}</small></span></div>)}
      <p className="coding-acceptance-view__note"><ShieldCheck size={13} />自动门禁只依据 Git、计划和真实命令结果；业务验收由你逐条确认。</p>
    </div>
  );
}

function EvidenceCenter({
  evidence,
  selected,
  analysis,
  changes,
  tasks,
  validations,
  onSelect,
  onExport,
}: {
  evidence: QualityGate[];
  selected: QualityGate;
  analysis: CodingWorkspaceAnalysis | null;
  changes: CodingGitSnapshot | null;
  tasks: ReturnType<typeof deriveTaskNodes>;
  validations: ValidationRecord[];
  onSelect: (id: QualityGate["id"]) => void;
  onExport: () => void;
}) {
  return (
    <div className="coding-evidence-center">
      <div className="coding-evidence-center__head"><span><h1>代码交付质量</h1><p>{analysis?.name ?? "当前工作区"} · 所有结论均关联当前工程的真实证据</p></span><button type="button" className="coding-primary-btn" onClick={onExport}><Download size={14} />导出报告</button></div>
      <div className="coding-evidence-center__summary">
        <div><span>质量门禁</span><strong>{evidence.filter((item) => item.status === "satisfied").length}/{evidence.length}</strong></div>
        <div><span>任务</span><strong>{tasks.filter((task) => task.status === "completed").length}/{tasks.length}</strong></div>
        <div><span>Git 变更</span><strong>{changes?.files.length ?? 0}</strong></div>
        <div><span>验证通过</span><strong>{validations.filter((record) => record.status === "passed").length}/{validations.length}</strong></div>
      </div>
      <div className="coding-evidence-center__grid">
        {evidence.map((item, index) => (
          <button type="button" key={item.id} className={`${item.id === selected.id ? "is-selected" : ""} is-${item.status}`} onClick={() => onSelect(item.id)}>
            <span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><b>{item.status === "satisfied" ? <Check size={13} /> : item.status === "in_progress" ? <LoaderCircle size={13} /> : <Circle size={13} />}{statusLabel(item.status)}</b><small>{item.summary}</small>
          </button>
        ))}
      </div>
      <section className="coding-evidence-detail">
        <div><span>证据详情</span><strong>{selected.title}</strong><p>{selected.summary}</p></div>
        {selected.evidence.length > 0 ? <ul>{selected.evidence.map((entry, index) => <li key={`${entry}:${index}`}><CheckCircle2 size={14} /><code>{entry}</code></li>)}</ul> : <div className="coding-evidence-detail__empty">当前还没有足以完成此能力门禁的真实证据。</div>}
      </section>
    </div>
  );
}

function ProblemsView({ problems, onOpen }: { problems: WorkspaceProblem[]; onOpen: (problem: WorkspaceProblem) => void }) {
  if (problems.length === 0) return <div className="coding-bottom-empty"><CheckCircle2 size={20} />当前没有检测到问题</div>;
  return <div className="coding-problems">{problems.map((problem, index) => <button type="button" key={`${problem.title}:${index}`} className={`is-${problem.kind}`} onClick={() => onOpen(problem)} disabled={!problem.path}><AlertTriangle size={15} /><span><strong>{problem.title}</strong><small>{problem.detail}</small></span>{problem.path && <code>{problem.path}</code>}</button>)}</div>;
}

function ValidationsView({ records }: { records: ValidationRecord[] }) {
  if (records.length === 0) return <div className="coding-bottom-empty"><TestTube2 size={20} />尚未执行编译或测试验证</div>;
  return <div className="coding-validations">{[...records].reverse().map((record) => <div key={record.id} className={`is-${record.status}`}><span>{record.status === "passed" ? <CheckCircle2 size={15} /> : record.status === "running" ? <LoaderCircle size={15} className="is-spinning" /> : <AlertTriangle size={15} />}<strong>{record.label}</strong><code>{record.command}</code></span><span><b>{record.testSummary ?? (record.status === "passed" ? "通过" : "失败")}</b><small>退出码 {record.exitCode ?? "无"} · {formatDuration(record.durationMs)}</small></span></div>)}</div>;
}

function CompactReport({ evidence, onOpenFull, onExport }: { evidence: QualityGate[]; onOpenFull: () => void; onExport: () => void }) {
  return <div className="coding-compact-report"><div>{evidence.map((item) => <span key={item.id} className={`is-${item.status}`}>{item.status === "satisfied" ? <CheckCircle2 size={14} /> : <Circle size={14} />}{item.title}<b>{statusLabel(item.status)}</b></span>)}</div><section><strong>{evidence.filter((item) => item.status === "satisfied").length}/{evidence.length} 项质量门禁已通过</strong><p>未满足项不会被报告为通过；请完成计划、审查 Git Diff、运行工程验证并逐条验收需求。</p><button type="button" onClick={onOpenFull}>打开完整质量视图</button><button type="button" onClick={onExport}><Download size={13} />导出报告</button></section></div>;
}

function TraceView({ messages }: { messages: ReturnType<typeof useSessionStore.getState>["messages"] }) {
  const calls = messages.flatMap((message) => message.parts.flatMap((part) => part.kind === "tool_call" ? [{ ...part.toolCall, startedAt: message.startedAt }] : []));
  if (calls.length === 0) return <div className="coding-bottom-empty"><PanelBottom size={20} />Agent 尚未调用外部工具</div>;
  return <div className="coding-trace">{calls.map((call, index) => <div key={`${call.toolCallId}:${index}`} className={`is-${call.status}`}><span>{call.status === "completed" ? <CheckCircle2 size={14} /> : call.status === "failed" ? <AlertTriangle size={14} /> : <LoaderCircle size={14} className="is-spinning" />}<b>{index + 1}</b></span><strong>{call.title}</strong><code>{call.kind}</code><small>{call.startedAt ? new Date(call.startedAt).toLocaleTimeString() : ""}</small></div>)}</div>;
}
