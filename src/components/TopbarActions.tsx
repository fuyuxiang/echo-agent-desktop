/** Current-conversation tools; session management lives in the sidebar menu. */
import { useRef, useState, useLayoutEffect } from "react";
import { Search, History, GitFork, Download } from "lucide-react";
import { MoreDotsIcon } from "@/foundation/components/Icon/icons";
import { useSessionStore } from "@/stores/session-store";
import { ActionMenu } from "./ActionMenu";
import { ShareMenu } from "./ShareMenu";

export interface TopbarActionsProps {
  sessionId: string;
  title: string;
  onToast?: (msg: string) => void;
  onRewind?: () => void;
  onFork?: () => void;
  onFind?: () => void;
  findOpen?: boolean;
  historyDisabled?: boolean;
}

export function TopbarActions({ sessionId, title, onToast,
  onRewind, onFork, historyDisabled, onFind, findOpen,
}: TopbarActionsProps) {
  const [shareOpen, setShareOpen] = useState(false);
  const returnFocus = useRef<HTMLButtonElement | null>(null);
  useLayoutEffect(() => { setShareOpen(false); }, [sessionId]);
  const messages = useSessionStore(s => s.messages);
  const hasContent = messages.some(m => m.parts.length > 0 || m.attachments?.length);
  if (!onFind && !onRewind && !onFork && !hasContent) return null;

  return <>
    <ActionMenu label="任务操作" menuLabel="当前会话操作" resetKey={sessionId}
      trigger={<MoreDotsIcon size="md" />}>
      {({ close, triggerRef }) => {
        const invoke = (action: () => void, restore = true) => {
          close();
          if (restore) triggerRef.current?.focus();
          action();
        };
        return <>
          {onFind && <button type="button" role="menuitem" className="topbar-actions__item" aria-label="查找当前会话" aria-expanded={findOpen} onClick={() => invoke(onFind)}><Search size={15} />查找当前会话<span className="action-menu__meta">⌘ / Ctrl F</span></button>}
          {onRewind && <button type="button" role="menuitem" className="topbar-actions__item" disabled={historyDisabled} onClick={() => invoke(onRewind)} title="将文件或对话恢复到历史节点"><History size={15} />回溯…</button>}
          {onFork && <button type="button" role="menuitem" className="topbar-actions__item" disabled={historyDisabled} onClick={() => invoke(onFork)} title="复制当前完整会话并创建分支"><GitFork size={15} />分叉…</button>}
          {hasContent && <>
            {(onFind || onRewind || onFork) && <div role="separator" className="action-menu__separator" />}
            <button type="button" role="menuitem" className="topbar-actions__item" onClick={() => {
              returnFocus.current = triggerRef.current;
              invoke(() => setShareOpen(true), false);
            }}><Download size={15} />导出整个会话…</button>
          </>}
        </>;
      }}
    </ActionMenu>
    <ShareMenu key={sessionId} messages={messages} title={title} onDone={onToast}
      controlledOpen={shareOpen} onClose={() => setShareOpen(false)} returnFocus={returnFocus.current} saveMarkdown />
  </>;
}
