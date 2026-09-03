/**
 * 消息队列 store —— 对齐 EchoAgent `session:enqueueMessage/getMessageQueue/...`。
 *
 * agent 工作时仍可继续排队多条 prompt:编辑/重排/暂停/恢复/取消/立即发送。
 * 每条队列为「按会话隔离」的有序列表;完成一轮对话后由调用方(App)取下一条
 * active(非 paused)项继续 `agentSend`,实现「回完一条自动发下一条」。
 *
 * 仅内存(会话级临时态,切会话保留在 store,不持久化),便于单测。
 */
import { create } from "zustand";

export type QueueItemStatus = "queued" | "paused" | "sending";
type EditableQueueItemStatus = Exclude<QueueItemStatus, "sending">;
export type SendingSettlement = "consume" | "retry";

export interface QueueTerminalPolicy {
  /** How an in-flight queue item should leave the `sending` state. */
  settlement: SendingSettlement;
  /** Whether this terminal event may advance the queue. */
  autoAdvance: boolean;
  /** Whether the conversation should be presented as failed. */
  failed: boolean;
}

export interface QueueItem {
  /** 稳定 id(用于 React key 与操作寻址)。 */
  id: string;
  /** 排队的 prompt 文本。 */
  text: string;
  /** Local paths that must travel with this queued prompt. */
  attachments?: string[];
  status: QueueItemStatus;
  /** 入队时间戳(ms)。 */
  createdAt: number;
}

/** sessionId → 有序队列。 */
type QueueMap = Record<string, QueueItem[]>;

interface QueueState {
  queues: QueueMap;
  /** 入队一条(追加到末尾,默认 queued)。返回新 item 的 id。 */
  enqueue: (sessionId: string, text: string, attachments?: string[]) => string;
  /** 编辑某条文本。 */
  update: (sessionId: string, id: string, text: string) => void;
  /** 删除某条。 */
  remove: (sessionId: string, id: string) => void;
  /** 移动某条到新位置(0-based)。越界则 clamp。 */
  reorder: (sessionId: string, from: number, to: number) => void;
  /** 暂停 / 恢复。 */
  setStatus: (sessionId: string, id: string, status: EditableQueueItemStatus) => void;
  /** Atomically reserve the first queued item so completion events cannot
   *  dispatch the same long-running request twice. */
  claimNext: (sessionId: string) => QueueItem | null;
  /** Settle the oldest in-flight item for a terminal agent event. Consumed
   *  items leave the queue; retryable failures return to `queued`. */
  settleSending: (sessionId: string, settlement: SendingSettlement) => QueueItem | null;
  /** 取下一条 active(非 paused)项并从队列移除;无则返回 null。 */
  shiftNext: (sessionId: string) => QueueItem | null;
  /** 清空某会话的整个队列。 */
  clear: (sessionId: string) => void;
  /** 读取某会话的队列(只读视图)。 */
  getQueue: (sessionId: string) => QueueItem[];
}

const newId = () =>
  `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

/** 安全读写:返回队列的可变副本,缺省为空数组。 */
function queueOf(map: QueueMap, sessionId: string): QueueItem[] {
  return map[sessionId] ?? [];
}

export const useMessageQueueStore = create<QueueState>((set, get) => ({
  queues: {},
  enqueue: (sessionId, text, attachments = []) => {
    const id = newId();
    const item: QueueItem = {
      id,
      text,
      attachments: [...new Set(attachments)],
      status: "queued",
      createdAt: Date.now(),
    };
    set((s) => ({
      queues: { ...s.queues, [sessionId]: [...queueOf(s.queues, sessionId), item] },
    }));
    return id;
  },
  update: (sessionId, id, text) =>
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      if (!q.some((it) => it.id === id)) return s;
      return {
        queues: {
          ...s.queues,
          [sessionId]: q.map((it) => (it.id === id ? { ...it, text } : it)),
        },
      };
    }),
  remove: (sessionId, id) =>
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      if (!q.some((it) => it.id === id)) return s;
      const next = q.filter((it) => it.id !== id);
      const queues = { ...s.queues };
      if (next.length === 0) delete queues[sessionId];
      else queues[sessionId] = next;
      return { queues };
    }),
  reorder: (sessionId, from, to) =>
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      if (from < 0 || from >= q.length || q.length === 0) return s;
      const clampedTo = Math.max(0, Math.min(to, q.length - 1));
      if (from === clampedTo) return s;
      const next = [...q];
      const [moved] = next.splice(from, 1);
      next.splice(clampedTo, 0, moved);
      return { queues: { ...s.queues, [sessionId]: next } };
    }),
  setStatus: (sessionId, id, status) =>
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      if (!q.some((it) => it.id === id)) return s;
      return {
        queues: {
          ...s.queues,
          [sessionId]: q.map((it) => (it.id === id ? { ...it, status } : it)),
        },
      };
    }),
  claimNext: (sessionId) => {
    let claimed: QueueItem | null = null;
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      const idx = q.findIndex((it) => it.status === "queued");
      if (idx === -1) return s;
      const next = [...q];
      claimed = { ...next[idx], status: "sending" };
      next[idx] = claimed;
      return { queues: { ...s.queues, [sessionId]: next } };
    });
    return claimed;
  },
  settleSending: (sessionId, settlement) => {
    let settled: QueueItem | null = null;
    set((s) => {
      const q = queueOf(s.queues, sessionId);
      const idx = q.findIndex((it) => it.status === "sending");
      if (idx === -1) return s;
      settled = q[idx];
      const next = settlement === "retry"
        ? q.map((it, itemIndex) => itemIndex === idx ? { ...it, status: "queued" as const } : it)
        : q.filter((_, itemIndex) => itemIndex !== idx);
      const queues = { ...s.queues };
      if (next.length === 0) delete queues[sessionId];
      else queues[sessionId] = next;
      return { queues };
    });
    return settled;
  },
  shiftNext: (sessionId) => {
    const q = [...queueOf(get().queues, sessionId)];
    const idx = q.findIndex((it) => it.status === "queued");
    if (idx === -1) return null;
    const [item] = q.splice(idx, 1);
    const queues = { ...get().queues };
    if (q.length === 0) delete queues[sessionId];
    else queues[sessionId] = q;
    set({ queues });
    return item;
  },
  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.queues)) return s;
      const queues = { ...s.queues };
      delete queues[sessionId];
      return { queues };
    }),
  getQueue: (sessionId) => queueOf(get().queues, sessionId),
}));

/** 是否存在任意 active(非 paused)项 —— App 判定「回完一条是否自动续发」。 */
export function hasActiveItems(q: QueueItem[]): boolean {
  return q.some((it) => it.status === "queued");
}

/**
 * Convert an agent terminal reason into explicit queue semantics.
 *
 * Cancellation consumes an already-admitted queue item (its user bubble is
 * present in history) but deliberately does not launch the next item. Failed
 * requests remain editable/retryable. Other terminal reasons preserve the
 * existing queue contract and advance to the next item.
 */
export function queueTerminalPolicy(stopReason: string): QueueTerminalPolicy {
  if (["rate_limit", "rate_limited", "error"].includes(stopReason)) {
    return { settlement: "retry", autoAdvance: false, failed: true };
  }
  if (stopReason === "cancelled") {
    return { settlement: "consume", autoAdvance: false, failed: false };
  }
  return { settlement: "consume", autoAdvance: true, failed: false };
}
