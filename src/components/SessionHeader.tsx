import { useState, type ReactNode, type MutableRefObject } from "react";
import { Files, Folder, Search, X, PanelRight, Globe, ListChecks, Users, GitCompareArrows } from "lucide-react";
import { SidebarToggleIcon, EchoNewTaskIcon } from "@/foundation/components/Icon/icons";
import { displayPath, shortWorkspacePath } from "@/lib/display-path";
import { TopbarTitle } from "./TopbarTitle";
import { TopbarActions, type TopbarActionsProps } from "./TopbarActions";
import { ActionMenu } from "./ActionMenu";

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
  onView, onCloseView, onFind, findOpen, onQuestionHistory, navigation, leading, historyDisabled, questionHistoryTriggerRef,
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
  onFind: () => void;
  findOpen: boolean;
  onQuestionHistory?: () => void;
  navigation?: SessionNavigationProps;
  leading?: ReactNode;
  historyDisabled?: boolean;
}) {
  const [renameRequest, setRenameRequest] = useState(0);
  const context = summary.hasPlan ? { view: "plan" as const, label: summary.planTotal ? `计划 ${summary.planCompleted}/${summary.planTotal}` : "执行计划" }
    : summary.changeCount ? { view: "changes" as const, label: `变更 ${summary.changeCount}` }
    : summary.artifactCount ? { view: "artifacts" as const, label: `产物 ${summary.artifactCount}` }
    : summary.subagentCount ? { view: "subagents" as const, label: `协作 ${summary.subagentCount}` }
    : summary.teamCount ? { view: "teams" as const, label: `团队 ${summary.teamCount}` } : null;
  return <header className="main-topbar session-header" data-tauri-drag-region>
    <div className="session-header__navigation"><SessionNavigation {...navigation} />{leading}</div>
    <div className="session-header__identity" data-tauri-drag-region>
      {onRename ? <TopbarTitle key={sessionId} title={title} onRename={onRename} editRequest={renameRequest} /> : <span className="main-topbar__title" title={title}>{title}</span>}
      {cwd && <span className="session-header__cwd" title={`本任务绑定的工作目录：${displayPath(cwd)}。如需切换目录，请新建任务。`}><Folder size={13} aria-hidden="true" /><span>{shortWorkspacePath(cwd)}</span></span>}
    </div>
    <div className="session-header__actions">
      {summary.status && <span className={"session-header__status" + (summary.attention ? " session-header__status--attention" : "")} role="status">{summary.status}</span>}
      {context && <button type="button" className="session-header__context" aria-expanded={activeView === context.view} onClick={() => onView(context.view)}>{context.label}</button>}
      {summary.searchable && <button type="button" className="main-topbar__btn" aria-label="查找当前会话" title="查找当前会话 (Ctrl/Cmd+F)" aria-expanded={findOpen} onClick={onFind}><Search size={17} /></button>}
      <ActionMenu label="工作区" menuLabel="工作区视图" resetKey={sessionId}
        triggerClassName="session-header__workspace" trigger={<><PanelRight size={16} /><span>工作区</span></>}>
        {({ close }) => {
          const select = (view: WorkspaceTarget) => { close(true); onView(view); };
          return <>
            <div className="action-menu__heading">工作目录与浏览</div>
            {cwd && <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("fileTree")}><Folder size={15} />文件<span className="action-menu__meta">工作目录</span></button>}
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("browser")}><Globe size={15} />网页预览</button>
            {(summary.hasContent || summary.changeCount > 0 || summary.artifactCount > 0) && <>
            <div role="separator" className="action-menu__separator" />
            <div className="action-menu__heading">文件与交付</div>
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("changes")}><GitCompareArrows size={15} />文件变更<span className="action-menu__meta">{summary.changeCount || "暂无"}</span></button>
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("artifacts")}><Files size={15} />任务产物<span className="action-menu__meta">{summary.artifactCount || "暂无"}</span></button>
            </>}
            <div role="separator" className="action-menu__separator" />
            <div className="action-menu__heading">任务详情</div>
            {summary.hasPlan && <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("plan")}><ListChecks size={15} />执行计划<span className="action-menu__meta">{summary.planTotal ? `${summary.planCompleted}/${summary.planTotal}` : "待确认"}</span></button>}
            {summary.subagentCount > 0 && <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("subagents")}><Users size={15} />协作详情<span className="action-menu__meta">{summary.runningSubagents ? `${summary.runningSubagents} 项进行中` : summary.subagentCount}</span></button>}
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => select("teams")}><Users size={15} />{summary.teamCount ? "团队详情" : "管理任务团队"}</button>
            {activeView && <><div role="separator" className="action-menu__separator" /><button type="button" role="menuitem" className="topbar-actions__item" onClick={() => { close(true); onCloseView(); }}><X size={15} />关闭工作视图</button></>}
          </>;
        }}
      </ActionMenu>
      <TopbarActions key={sessionId} sessionId={sessionId} title={title} {...actions} historyDisabled={historyDisabled}
        onRename={onRename ? () => setRenameRequest(value => value + 1) : undefined} onQuestionHistory={onQuestionHistory ? trigger => {
          if (questionHistoryTriggerRef) questionHistoryTriggerRef.current = trigger;
          onQuestionHistory();
        } : undefined} />
    </div>
  </header>;
}
