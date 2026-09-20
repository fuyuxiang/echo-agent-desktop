import { useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  FileCode2,
  FilePlus2,
  FolderPlus,
  ListCollapse,
  LocateFixed,
  RefreshCw,
  X,
} from "lucide-react";

import type { PaletteSymbol } from "../shell/CommandPalette";
import { isDirty, isFileTab, type WorkbenchTab } from "../store/tab-store";

interface FileExplorerViewProps {
  root: string;
  tabs: WorkbenchTab[];
  activeId: string | null;
  symbols: PaletteSymbol[];
  activeFileName?: string;
  showHidden: boolean;
  fileTree: ReactNode;
  onSelectTab: (id: string) => void;
  onCloseTab: (id: string) => void;
  onOpenSymbol: (symbol: PaletteSymbol) => void;
  onNewFile: () => void;
  onNewDirectory: () => void;
  onRefresh: () => void;
  onCollapseAll: () => void;
  onRevealActive: () => void;
  onToggleHidden: () => void;
}

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

function Section({
  title,
  count,
  meta,
  titleHint,
  open,
  onToggle,
  children,
  className = "",
}: {
  title: string;
  count?: number;
  meta?: string;
  titleHint?: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`coding-explorer-section ${className}`.trim()}>
      <button
        type="button"
        className="coding-explorer-section__header"
        aria-expanded={open}
        title={titleHint}
        onClick={onToggle}
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <span>{title}</span>
        {meta && <small>{meta}</small>}
        {count !== undefined && <small>{count}</small>}
      </button>
      {open && <div className="coding-explorer-section__body">{children}</div>}
    </section>
  );
}

/** Explorer composition: open editors, an explicit project root, and outline. */
export function FileExplorerView({
  root,
  tabs,
  activeId,
  symbols,
  activeFileName,
  showHidden,
  fileTree,
  onSelectTab,
  onCloseTab,
  onOpenSymbol,
  onNewFile,
  onNewDirectory,
  onRefresh,
  onCollapseAll,
  onRevealActive,
  onToggleHidden,
}: FileExplorerViewProps) {
  const [openEditorsOpen, setOpenEditorsOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(true);
  const [outlineOpen, setOutlineOpen] = useState(true);
  const openTabs = tabs;

  return (
    <div className="coding-file-explorer">
      <div className="coding-explorer__heading">
        <span>资源管理器</span>
        <span className="coding-explorer__heading-actions">
          <button type="button" onClick={onNewFile} title="新建文件" aria-label="新建文件">
            <FilePlus2 size={13} />
          </button>
          <button type="button" onClick={onNewDirectory} title="新建目录" aria-label="新建目录">
            <FolderPlus size={13} />
          </button>
          <button type="button" onClick={onRefresh} title="刷新资源管理器" aria-label="刷新资源管理器">
            <RefreshCw size={13} />
          </button>
          <button type="button" onClick={onCollapseAll} title="折叠所有目录" aria-label="折叠所有目录">
            <ListCollapse size={13} />
          </button>
          <button
            type="button"
            onClick={onRevealActive}
            title={activeFileName ? "在资源管理器中定位当前文件" : "当前没有打开的文件"}
            aria-label="在资源管理器中定位当前文件"
            disabled={!activeFileName}
          >
            <LocateFixed size={13} />
          </button>
          <button
            type="button"
            className={showHidden ? "is-active" : ""}
            onClick={onToggleHidden}
            title={showHidden ? "不显示隐藏文件" : "显示隐藏文件"}
            aria-label={showHidden ? "不显示隐藏文件" : "显示隐藏文件"}
            aria-pressed={showHidden}
          >
            {showHidden ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        </span>
      </div>

      {openTabs.length > 0 && (
        <Section
          title="已打开的编辑器"
          count={openTabs.length}
          open={openEditorsOpen}
          onToggle={() => setOpenEditorsOpen((value) => !value)}
        >
          <div className="coding-open-editors" role="list" aria-label="已打开的编辑器">
            {openTabs.map((tab) => {
              const label = isFileTab(tab) ? tab.name : tab.title;
              const description = isFileTab(tab)
                ? tab.relativePath
                : tab.type === "virtual"
                  ? `${tab.title} · ${tab.symbol.name}`
                  : tab.title;
              return (
                <div
                  key={tab.id}
                  className={`coding-open-editors__row${tab.id === activeId ? " is-active" : ""}`}
                  role="listitem"
                >
                  <button
                    type="button"
                    className="coding-open-editors__select"
                    onClick={() => onSelectTab(tab.id)}
                    title={description}
                  >
                    <FileCode2 size={12} />
                    <span>{label}</span>
                    {isDirty(tab) && <b aria-label="未保存">●</b>}
                  </button>
                  <button
                    type="button"
                    className="coding-open-editors__close"
                    onClick={() => onCloseTab(tab.id)}
                    aria-label={`关闭 ${label}`}
                  >
                    <X size={11} />
                  </button>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      <Section
        title={basename(root).toLocaleUpperCase()}
        meta="项目根目录"
        titleHint={root}
        open={filesOpen}
        onToggle={() => setFilesOpen((value) => !value)}
        className="coding-explorer-section--files"
      >
        {fileTree}
      </Section>

      <Section
        title="大纲"
        count={activeFileName ? symbols.length : undefined}
        open={outlineOpen}
        onToggle={() => setOutlineOpen((value) => !value)}
      >
        {!activeFileName ? (
          <div className="coding-explorer-section__empty">打开文件后显示代码结构</div>
        ) : symbols.length === 0 ? (
          <div className="coding-explorer-section__empty">当前文件没有可显示的符号</div>
        ) : (
          <div className="coding-outline" aria-label={`${activeFileName} 的大纲`}>
            {symbols.map((symbol, index) => (
              <button
                key={`${symbol.name}:${symbol.line}:${index}`}
                type="button"
                onClick={() => onOpenSymbol(symbol)}
                title={symbol.detail ?? symbol.name}
              >
                <span>{symbol.name}</span>
                {symbol.detail && <small>{symbol.detail}</small>}
                <b>{symbol.line}</b>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}
