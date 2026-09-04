import { lazy, Suspense, useState, type ReactNode } from "react";
import { AgentToolIcon } from "@/foundation/components/Icon/icons";
import type { ProjectMeta } from "@/stores/projects-store";
import { openExternalUrl, openLocalPath } from "@/lib/agent-client";

const ProjectsPanel = lazy(() =>
  import("./ProjectsPanel").then((module) => ({ default: module.ProjectsPanel })),
);
const ExpertsPanel = lazy(() =>
  import("./experts-panel").then((module) => ({ default: module.ExpertsPanel })),
);
const AutomationPanel = lazy(() =>
  import("./AutomationPanel").then((module) => ({ default: module.AutomationPanel })),
);
const ResourcesPanel = lazy(() =>
  import("./ResourcesPanel").then((module) => ({ default: module.ResourcesPanel })),
);
const MyFilesPanel = lazy(() =>
  import("./MyFilesPanel").then((module) => ({ default: module.MyFilesPanel })),
);
const PluginsPanel = lazy(() =>
  import("./PluginsPanel").then((module) => ({ default: module.PluginsPanel })),
);
const MarketplacePanel = lazy(() =>
  import("./MarketplacePanel").then((module) => ({ default: module.MarketplacePanel })),
);
const KnowledgeBasePanel = lazy(() =>
  import("./KnowledgeBasePanel").then((module) => ({ default: module.KnowledgeBasePanel })),
);
const UsageQuotaPanel = lazy(() =>
  import("./UsageQuotaPanel").then((module) => ({ default: module.UsageQuotaPanel })),
);
const NotifyChannelsPanel = lazy(() =>
  import("./NotifyChannelsPanel").then((module) => ({ default: module.NotifyChannelsPanel })),
);
const CloudStoragePanel = lazy(() =>
  import("./CloudStoragePanel").then((module) => ({ default: module.CloudStoragePanel })),
);
const OrganizationMemoryPanel = lazy(() =>
  import("./OrganizationMemoryPanel").then((module) => ({ default: module.OrganizationMemoryPanel })),
);

function DeferredPanel({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={(
        <div className="placeholder-page" role="status" aria-live="polite">
          <p className="placeholder-page__desc">正在加载…</p>
        </div>
      )}
    >
      {children}
    </Suspense>
  );
}

interface PlaceholderPageProps {
  label: string;
  /** Navigate to another sidebar view (e.g. 自动化 → 管理连接器 → 专家·技能·连接器). */
  onNavigate?: (label: string) => void;
  /** Open a session produced by an automation run record. */
  onOpenSession?: (sessionId: string, cwd?: string) => void;
  /** Navigate to the home page (used after expert summon). */
  onGoHome?: () => void;
  /** Surface transient feedback (errors, success toasts). */
  onToast?: (message: string) => void;
  /** Current cwd (for memory workspace scope, projects panel). */
  cwd?: string;
  /** Switch the active workspace (projects panel). */
  onSelectWorkspace?: (cwd: string) => void;
  /** Current session id (for plugins/marketplace actions that need a session). */
  sessionId?: string;
  /** 项目页：进入项目（新建会话并注入说明）。 */
  onStartProject?: (project: ProjectMeta) => void;
  /** 项目页：在项目中新建对话（创建真实 EchoAgent 会话）。 */
  onStartProjectConversation?: (projectId: string, message: string) => Promise<string | undefined>;
}

/** EchoAgent 功能面板（项目/组织/专家能力/自动化/个人记忆/插件市场）。 */
export function PlaceholderPage({
  label,
  onNavigate,
  onOpenSession,
  onGoHome,
  onToast,
  cwd,
  onSelectWorkspace,
  sessionId,
  onStartProject,
  onStartProjectConversation,
}: PlaceholderPageProps) {
  if (label === "项目") {
    return (
      <DeferredPanel>
        <ProjectsPanel
          cwd={cwd}
          onSelectWorkspace={onSelectWorkspace}
          onToast={onToast}
          onStartProject={onStartProject}
          onStartProjectConversation={onStartProjectConversation}
          onOpenSession={onOpenSession}
          onOpenAutomation={() => onNavigate?.("自动化")}
        />
      </DeferredPanel>
    );
  }

  if (label === "组织") {
    return <DeferredPanel><OrganizationMemoryPanel onToast={onToast} /></DeferredPanel>;
  }

  if (["专家·技能·连接器", "技能", "连接器"].includes(label)) {
    const initialTab = label === "技能" ? "skills" : label === "连接器" ? "connectors" : "experts";
    return (
      <DeferredPanel>
        <ExpertsPanel onGoHome={onGoHome} onToast={onToast} initialTab={initialTab} />
      </DeferredPanel>
    );
  }

  if (label === "自动化") {
    return (
      <DeferredPanel>
        <AutomationPanel onToast={onToast} onNavigate={onNavigate} onOpenSession={onOpenSession} cwd={cwd} />
      </DeferredPanel>
    );
  }

  if (label === "插件·市场" || label === "插件市场") {
    return (
      <DeferredPanel>
        <PluginsMarketTabs
          key={label}
          sessionId={sessionId}
          onToast={onToast}
          initialTab={label === "插件市场" ? "marketplace" : "plugins"}
        />
      </DeferredPanel>
    );
  }

  if (label === "更多" || label === "资料库" || label === "个人记忆") {
    return (
      <DeferredPanel>
        <ResourcesPanel cwd={cwd} sessionId={sessionId} onToast={onToast} />
      </DeferredPanel>
    );
  }

  if (label === "我的文件") {
    return <DeferredPanel><MyFilesPanel cwd={cwd} onToast={onToast} /></DeferredPanel>;
  }

  // 知识库(可插拔源,对齐 EchoAgent knowledge-base-panel)。
  if (label === "知识库") {
    return (
      <DeferredPanel>
        <div className="placeholder-page placeholder-page--panel">
          <KnowledgeBasePanel
            onOpen={(id, url) => {
              const target = url ?? id;
              const open = /^https?:\/\//i.test(target)
                ? openExternalUrl(target)
                : openLocalPath(target, cwd);
              void open.catch((error) => onToast?.(`打开知识条目失败：${String(error).replace(/^Error:\s*/, "")}`));
            }}
            onToast={onToast}
          />
        </div>
      </DeferredPanel>
    );
  }

  // 用量配额(对齐 EchoAgent credit-usage)。
  if (label === "用量统计") {
    return (
      <DeferredPanel>
        <div className="placeholder-page placeholder-page--panel">
          <UsageQuotaPanel />
        </div>
      </DeferredPanel>
    );
  }

  // 通知渠道(对齐 EchoAgent IM 渠道)。
  if (label === "通知渠道") {
    return (
      <DeferredPanel>
        <div className="placeholder-page placeholder-page--panel">
          <NotifyChannelsPanel onToast={onToast} />
        </div>
      </DeferredPanel>
    );
  }

  // 云存储(对齐 EchoAgent 腾讯 Drive)。
  if (label === "云存储") {
    return (
      <DeferredPanel>
        <div className="placeholder-page placeholder-page--panel">
          <CloudStoragePanel onToast={onToast} />
        </div>
      </DeferredPanel>
    );
  }

  // 未注册的路由应该只会由损坏的持久化状态或新旧版本不兼容触发。
  return (
    <div className="placeholder-page">
      <AgentToolIcon size="xl" color="var(--echo-text-tertiary)" />
      <h2 className="placeholder-page__title">无法打开「{label}」</h2>
      <p className="placeholder-page__desc">当前版本未注册该功能路由，请返回首页重试。</p>
      {onGoHome && <button type="button" className="btn btn--primary" onClick={onGoHome}>返回首页</button>}
    </div>
  );
}

/** 双 tab 容器：插件（已安装）/ 市场（可浏览安装）。 */
import { PuzzlePieceIcon, RepoIcon } from "@/foundation/components/Icon/icons";
function PluginsMarketTabs({
  sessionId,
  onToast,
  initialTab = "plugins",
}: {
  sessionId?: string;
  onToast?: (msg: string) => void;
  initialTab?: "plugins" | "marketplace";
}) {
  const [tab, setTab] = useState<"plugins" | "marketplace">(initialTab);
  return (
    <div className="plugins-market-wrap">
      <div className="plugins-market-tabs">
        <button
          className={`plugins-market-tab ${tab === "plugins" ? "plugins-market-tab--active" : ""}`}
          onClick={() => setTab("plugins")}
        >
          <PuzzlePieceIcon size="sm" /> 插件
        </button>
        <button
          className={`plugins-market-tab ${tab === "marketplace" ? "plugins-market-tab--active" : ""}`}
          onClick={() => setTab("marketplace")}
        >
          <RepoIcon size="sm" /> 市场
        </button>
      </div>
      {tab === "plugins" ? (
        <PluginsPanel sessionId={sessionId} onToast={onToast} />
      ) : (
        <MarketplacePanel sessionId={sessionId} onToast={onToast} />
      )}
    </div>
  );
}
