/**
 * 消息队列面板 —— 对齐 EchoAgent `echo-chat-ui/message-queue-panel`。
 *
 * agent 流式工作时,用户仍可继续排队 prompt。本面板渲染某会话的队列条目,
 * 支持编辑/删除/上移下移/暂停/恢复/立即发送。流式结束后由 App 自动续发
 * 下一条 active 项(本面板的「立即发送」是手动触发)。
 */
import { useState } from "react";
import { useMessageQueueStore, type QueueItem } from "@/stores/message-queue-store";
import { attachmentBasename } from "@/lib/user-message";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  XCloseIcon,
  PauseIcon,
  PlayIcon,
} from "@/foundation/components/Icon/icons";

interface QueuePanelProps {
  sessionId: string;
  /** agent 正在回复时，「发送」改为安全的「置顶」，不会丢失队列项。 */
  streaming?: boolean;
  /** 手动发送一条；返回 false 表示未接受，队列项必须保留。 */
  onSendNow?: (text: string, attachments?: string[]) => boolean | void | Promise<boolean | void>;
}

export function QueuePanel({ sessionId, streaming = false, onSendNow }: QueuePanelProps) {
  const queue = useMessageQueueStore((s) => s.queues[sessionId] ?? []);
  const remove = useMessageQueueStore((s) => s.remove);
  const reorder = useMessageQueueStore((s) => s.reorder);
  const setStatus = useMessageQueueStore((s) => s.setStatus);
  const update = useMessageQueueStore((s) => s.update);
  const [sendingId, setSendingId] = useState<string | null>(null);

  if (queue.length === 0) return null;

  return (
    <div className="queue-panel" role="list" aria-label="待发送队列">
      <div className="queue-panel__head">
        <span>待发送队列({queue.length})</span>
        <span className="queue-panel__hint">agent 完成回复后自动发送下一条</span>
      </div>
      {queue.map((item, idx) => (
        <QueueRow
          key={item.id}
          sessionId={sessionId}
          item={item}
          index={idx}
          total={queue.length}
          onRemove={() => remove(sessionId, item.id)}
          onUp={() => reorder(sessionId, idx, idx - 1)}
          onDown={() => reorder(sessionId, idx, idx + 1)}
          onTogglePause={() =>
            setStatus(sessionId, item.id, item.status === "paused" ? "queued" : "paused")
          }
          onCommitEdit={(text) => update(sessionId, item.id, text)}
          sendLabel={streaming ? (idx === 0 ? "已置顶" : "置顶") : (sendingId === item.id ? "发送中" : "发送")}
          sendTitle={streaming ? (idx === 0 ? "已是下一条" : "设为下一条自动发送") : "立即发送"}
          sendDisabled={item.status === "paused" || sendingId !== null || (streaming && idx === 0) || (!streaming && !onSendNow)}
          onSendNow={async () => {
            if (streaming) {
              reorder(sessionId, idx, 0);
              return;
            }
            if (!onSendNow || sendingId !== null) return;
            setSendingId(item.id);
            try {
              const accepted = await onSendNow(item.text, item.attachments ?? []);
              if (accepted !== false) remove(sessionId, item.id);
            } catch {
              // Sending failed: retain the item so the user can retry or edit it.
            } finally {
              setSendingId(null);
            }
          }}
        />
      ))}
    </div>
  );
}

interface QueueRowProps {
  sessionId: string;
  item: QueueItem;
  index: number;
  total: number;
  onRemove: () => void;
  onUp: () => void;
  onDown: () => void;
  onTogglePause: () => void;
  onCommitEdit: (text: string) => void;
  onSendNow: () => void | Promise<void>;
  sendLabel: string;
  sendTitle: string;
  sendDisabled: boolean;
}

function QueueRow({
  item,
  index,
  total,
  onRemove,
  onUp,
  onDown,
  onTogglePause,
  onCommitEdit,
  onSendNow,
  sendLabel,
  sendTitle,
  sendDisabled,
}: QueueRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const paused = item.status === "paused";
  const sending = item.status === "sending";

  const commit = () => {
    const t = draft.trim();
    if (t) onCommitEdit(t);
    else onRemove();
    setEditing(false);
  };

  return (
    <div
      className={
        "queue-row"
        + (paused ? " queue-row--paused" : "")
        + (sending ? " queue-row--sending" : "")
      }
      role="listitem"
    >
      <span className="queue-row__index">{index + 1}</span>
      {editing && !sending ? (
        <textarea
          className="queue-row__edit"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setDraft(item.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="queue-row__content">
          <span
            className="queue-row__text"
            title={sending ? "发送中" : "点击编辑"}
            onClick={() => {
              if (sending) return;
              setDraft(item.text);
              setEditing(true);
            }}
          >
            {item.text}
          </span>
          {(item.attachments?.length ?? 0) > 0 && (
            <span className="queue-row__attachments" aria-label="队列附件">
              {item.attachments!.map((path) => (
                <span key={path} className="queue-row__attachment" title={path}>
                  📎 {attachmentBasename(path)}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
      <span className="queue-row__actions">
        <button
          type="button"
          className="queue-row__btn"
          onClick={onUp}
          disabled={sending || index === 0}
          title="上移"
          aria-label="上移"
        >
          <ChevronLeftIcon size="sm" />
        </button>
        <button
          type="button"
          className="queue-row__btn"
          onClick={onDown}
          disabled={sending || index === total - 1}
          title="下移"
          aria-label="下移"
        >
          <ChevronRightIcon size="sm" />
        </button>
        <button
          type="button"
          className="queue-row__btn"
          onClick={onTogglePause}
          disabled={sending}
          title={sending ? "发送中" : paused ? "恢复" : "暂停"}
          aria-label={sending ? "发送中" : paused ? "恢复" : "暂停"}
          aria-pressed={paused}
        >
          {paused ? <PlayIcon size="sm" /> : <PauseIcon size="sm" />}
        </button>
        <button
          type="button"
          className="queue-row__btn queue-row__btn--send"
          onClick={onSendNow}
          disabled={sending || sendDisabled}
          title={sendTitle}
          aria-label={sendTitle}
        >
          {sending ? "发送中" : sendLabel}
        </button>
        <button
          type="button"
          className="queue-row__btn"
          onClick={onRemove}
          disabled={sending}
          title="删除"
          aria-label="删除"
        >
          <XCloseIcon size="sm" />
        </button>
      </span>
    </div>
  );
}
