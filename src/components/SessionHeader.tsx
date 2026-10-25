import { useState, type ReactNode, type MutableRefObject } from "react";
import { Folder, PanelRight } from "lucide-react";
import { SidebarToggleIcon, EchoNewTaskIcon } from "@/foundation/components/Icon/icons";
import { displayPath, shortWorkspacePath } from "@/lib/display-path";
import { TopbarTitle } from "./TopbarTitle";
import { TopbarActions, type TopbarActionsProps } from "./TopbarActions";
import { openLocalPath } from "@/lib/markdown-host";

export type WorkspaceTarget = "fileTree" | "changes" | "artifacts" | "browser" | "plan" | "subagents" | "teams";
export interface SessionWorkspaceSummary {
  searchable: boolean;
  hasContent: boolean;
  changeCount: number;
  artifactCount: number;
  hasPlan: boolean;
  planCompleted: number;
  planTotal: number;
  subagentCount: number;
  runningSubagents: number;
  teamCount: number;
  status?: string;
  attention?: boolean;
}
export interface SessionNavigationProps {
  sidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewTask?: () => void;
}

export function SessionNavigation({ sidebarCollapsed, onToggleSidebar, onNewTask }: SessionNavigationProps) {
  return <>
    {onToggleSidebar && <button type="button" className="main-topbar__btn" aria-label={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}
      aria-expanded={!sidebarCollapsed} aria-controls="app-sidebar" onClick={onToggleSidebar} data-tip={sidebarCollapsed ? "展开侧边栏" : "收起侧边栏"}>
      <SidebarToggleIcon size="md" />
    </button>}
    {sidebarCollapsed && onNewTask && <button type="button" className="main-topbar__btn" aria-label="新建任务" data-tip="新建任务" onClick={onNewTask}><EchoNewTaskIcon size="md" /></button>}
  </>;
}

/** One non-scrolling session header. Domain state and workspace navigation stay in ChatView. */
export function SessionHeader({ sessionId, title, cwd, onRename, actions, summary, activeView,
  onView, onCloseView, onToggleWorkspace, onFind, findOpen, onQuestionHistory, navigation, leading, historyDisabled, questionHistoryTriggerRef,
}: {
  questionHistoryTriggerRef?: MutableRefObject<HTMLButtonElement | null>;
  sessionId: string;
  title: string;
  cwd?: string;
  onRename?: (title: string) => Promise<void>;
  actions?: Omit<TopbarActionsProps, "sessionId" | "title">;
  summary: SessionWorkspaceSummary;
  activeView: string | null;
  onView: (view: WorkspaceTarget) => void;
  onCloseView: () => void;
  onToggleWorkspace?: () => void;
  onFind: () => void;
  findOpen: boolean;
  onQuestionHistory?: () => void;
  navigation?: SessionNavigationProps;
  leading?: ReactNode;
  historyDisabled?: boolean;
}) {
  const [renameRequest, setRenameRequest] = useState(0);
  return <header className="main-topbar session-header" data-tauri-drag-region>
    <div className="session-header__navigation"><SessionNavigation {...navigation} />{leading}</div>
    <div className="session-header__identity" data-tauri-drag-region>
      {onRename ? <TopbarTitle key={sessionId} title={title} onRename={onRename} editRequest={renameRequest} /> : <span className="main-topbar__title" title={title}>{title}</span>}
      {cwd && <button type="button" className="session-header__cwd" aria-label="打开工作目录" onClick={() => void openLocalPath(cwd, {cwd, type:"directory", onToast:actions?.onToast})} title={`打开本任务的工作目录：${displayPath(cwd)}。如需切换目录，请新建任务。`}><Folder size={13} aria-hidden="true" /><span>{shortWorkspacePath(cwd)}</span></button>}
    </div>
    <div className="session-header__actions">
      {summary.status && <span className={"session-header__status" + (summary.attention ? " session-header__status--attention" : "")} role="status">{summary.status}</span>}
      {summary.hasPlan && <button type="button" className="session-header__context"
        aria-label={summary.planTotal ? `查看执行计划，已完成 ${summary.planCompleted}/${summary.planTotal} 步` : "查看执行计划"}
        aria-expanded={activeView === "plan"} aria-controls="session-workspace" onClick={() => onView("plan")}>
        {summary.planTotal ? `计划 ${summary.planCompleted}/${summary.planTotal}` : "执行计划"}
      </button>}
      <TopbarActions key={sessionId} sessionId={sessionId} title={title} {...actions} historyDisabled={historyDisabled}
        onFind={summary.searchable ? onFind : undefined} findOpen={findOpen}
        onRename={onRename ? () => setRenameRequest(value => value + 1) : undefined} onQuestionHistory={onQuestionHistory ? trigger => {
          if (questionHistoryTriggerRef) questionHistoryTriggerRef.current = trigger;
          onQuestionHistory();
        } : undefined} />
      <button type="button" className="main-topbar__btn session-header__workspace-toggle"
        aria-label={activeView ? "收起工作区" : "展开工作区"} data-tip={activeView ? "收起工作区" : "展开工作区"}
        aria-expanded={Boolean(activeView)} aria-controls="session-workspace"
        onClick={onToggleWorkspace ?? (() => activeView ? onCloseView() : onView("artifacts"))}>
        <PanelRight size={18} aria-hidden="true" />
        {summary.artifactCount > 0 && <span className="session-header__badge" aria-label={`${summary.artifactCount} 项成果`}>{summary.artifactCount > 99 ? "99+" : summary.artifactCount}</span>}
      </button>
    </div>
  </header>;
}
