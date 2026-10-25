/** Session management and advanced actions; all exports share one destination. */
import { useRef, useState, useLayoutEffect } from "react";
import { Pencil, Search, List, History, GitFork, Download, MessageCircle } from "lucide-react";
import { ArchiveIcon, LoadingIcon, MoreDotsIcon, PinFilledIcon } from "@/foundation/components/Icon/icons";
import { useSessionStore } from "@/stores/session-store";
import { agentSetSessionPinned, agentSetSessionArchived } from "@/lib/agent-client";
import { weixinHandoff } from "@/lib/weixin-client";
import type { SessionSummary } from "@/lib/types";
import { ActionMenu } from "./ActionMenu";
import { ShareMenu } from "./ShareMenu";

export interface TopbarActionsProps {
  sessionId: string;
  title: string;
  pinned?: boolean;
  onToast?: (msg: string) => void;
  onSessionsChanged?: (patch?: Partial<SessionSummary>) => void;
  onArchived?: (archived: boolean) => void;
  onRename?: () => void;
  onRewind?: () => void;
  onFork?: () => void;
  onFind?: () => void;
  findOpen?: boolean;
  onQuestionHistory?: (trigger: HTMLButtonElement | null) => void;
  historyDisabled?: boolean;
}

export function TopbarActions({ sessionId, title, pinned, onToast, onSessionsChanged, onArchived,
  onRename, onRewind, onFork, onQuestionHistory, historyDisabled, onFind, findOpen,
}: TopbarActionsProps) {
  const [busy, setBusy] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => { setShareOpen(false); setBusy(false); }, [sessionId]);
  const messages = useSessionStore(s => s.messages);
  const hasContent = messages.some(m => m.parts.length > 0 || m.attachments?.length);
  const run = async (action: () => Promise<void>, restore: HTMLButtonElement | null) => {
    setBusy(true);
    try { await action(); }
    finally {
      setBusy(false);
      window.requestAnimationFrame(() => {
        if (restore?.isConnected) restore.focus({ preventScroll: true });
      });
    }
  };

  return <>
    <ActionMenu label="任务操作" menuLabel="当前会话操作" resetKey={sessionId} busy={busy}
      trigger={busy ? <LoadingIcon size="md" spin /> : <MoreDotsIcon size="md" />}>
      {({ close, triggerRef }) => {
        const invoke = (action: () => void, restore = true) => {
          close();
          if (restore) triggerRef.current?.focus();
          action();
        };
        return <>
          {onRename && <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => invoke(onRename, false)}><Pencil size={15} />重命名会话</button>}
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => {
            close();
            void run(async () => {
              try {
                await agentSetSessionPinned(sessionId, !pinned);
                onToast?.(pinned ? "已取消置顶" : "已置顶");
                onSessionsChanged?.({ pinned: !pinned });
              } catch (e) { onToast?.(`操作失败：${String(e).replace(/^Error:\s*/, "")}`); }
            }, triggerRef.current);
          }}><PinFilledIcon size="sm" /><span>{pinned ? "取消置顶" : "置顶会话"}</span></button>
          {(onFind || onRewind || onFork || onQuestionHistory) && <>
            <div role="separator" className="action-menu__separator" />
            {onFind && <button type="button" role="menuitem" className="topbar-actions__item" aria-label="查找当前会话" aria-expanded={findOpen} onClick={() => invoke(onFind)}><Search size={15} />查找当前会话<span className="action-menu__meta">⌘ / Ctrl F</span></button>}
            {onQuestionHistory && <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => invoke(() => onQuestionHistory(triggerRef.current))}><List size={15} />对话目录</button>}
            {onRewind && <button type="button" role="menuitem" className="topbar-actions__item" disabled={historyDisabled} onClick={() => invoke(onRewind)} title="将文件或对话恢复到历史节点"><History size={15} />回溯…</button>}
            {onFork && <button type="button" role="menuitem" className="topbar-actions__item" disabled={historyDisabled} onClick={() => invoke(onFork)} title="复制当前完整会话并创建分支"><GitFork size={15} />分叉…</button>}
          </>}
          {hasContent && <>
            <div role="separator" className="action-menu__separator" />
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => {
              returnFocus.current = triggerRef.current;
              invoke(() => setShareOpen(true), false);
            }}><Download size={15} />导出整个会话…</button>
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => {
              close();
              void run(async () => {
                try { onToast?.(await weixinHandoff(sessionId)); }
                catch (e) { onToast?.(`微信交接失败：${String(e).replace(/^Error:\s*/, "")}`); }
              }, triggerRef.current);
            }}><MessageCircle size={15} />在微信继续</button>
          </>}
          <div role="separator" className="action-menu__separator" />
          <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => {
            close();
            void run(async () => {
              try {
                const archived = await agentSetSessionArchived(sessionId, true);
                onToast?.("已归档，可在“设置 → 数据管理 → 已归档”中恢复");
                onSessionsChanged?.({ archived });
                onArchived?.(archived);
              } catch (e) { onToast?.(`归档失败：${String(e).replace(/^Error:\s*/, "")}`); }
            }, triggerRef.current);
          }}><ArchiveIcon size="sm" /><span>归档会话</span></button>
        </>;
      }}
    </ActionMenu>
    <ShareMenu key={sessionId} messages={messages} title={title} onDone={onToast}
      controlledOpen={shareOpen} onClose={() => setShareOpen(false)} returnFocus={returnFocus.current} saveMarkdown />
  </>;
}
