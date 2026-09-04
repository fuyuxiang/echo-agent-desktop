import { create } from "zustand";
import type {
  Plan,
  PlanUpdate,
  PromptComplete,
  SessionUpdate,
  ToolCallContent,
  ToolCallUpdate,
  UsageUpdate,
} from "@/lib/types";
import {
  ATTACHMENTS_META_KEY,
  normalizeAttachmentPaths,
  parseLegacyAttachmentPrompt,
  stripInjectedUserContext,
} from "@/lib/user-message";

/**
 * A single chat message in the transcript the UI renders.
 *
 * `assistant` messages accumulate `agent_message_chunk` text deltas and may
 * carry tool-call cards interleaved with text. We model the body as an
 * ordered list of "parts" so streaming stays in order.
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  parts: MessagePart[];
  /** Local paths attached to a user prompt, in selection order. */
  attachments?: string[];
  /** ACP prompt index used to merge replayed text/image chunks into one turn. */
  promptIndex?: number;
  /** False while the assistant is still streaming this message. */
  complete: boolean;
}

export type MessagePart =
  | { kind: "text"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool_call"; toolCall: ToolCallView };

/** A tool-call card rendered inline. Mirrors a subset of ToolCallUpdate. */
export interface ToolCallView {
  toolCallId: string;
  title: string;
  kind: string;
  status: "in_progress" | "completed" | "failed";
  content: ToolCallUpdate["content"];
  rawInput?: unknown;
}

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

/** One parked `echo.agent/exit_plan_mode` reverse request. */
export interface PlanApprovalRequest {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  planContent?: string;
}

/**
 * Per-session transcript — the single source of truth.
 *
 * Historically the store kept ONE global `messages`/`streamingMessageId` and
 * wiped them on every session switch, which lost the locally-optimistic user
 * bubbles and had nowhere to accumulate a session that kept streaming in the
 * background after the user switched away. Now every session owns its own
 * transcript, and the top-level `messages`/`streaming`/`usage`/`plan` fields
 * are just a *mirror* of the currently-focused session's transcript (so every
 * existing reader keeps working unchanged).
 *
 * `suppressReplay` is set when we switch back to a session we already have a
 * cached transcript for: the cache IS the truth, so the history replay that
 * `agentLoadSession` re-streams must be ignored for the message-streaming
 * cases (otherwise turns merge and historical usage overwrites the live one).
 */
export interface SessionTranscript {
  messages: ChatMessage[];
  /** Non-null while this session has an in-flight assistant message. Doubles
   *  as the per-session "is streaming" flag. */
  streamingMessageId: string | null;
  usage: Usage;
  plan: Plan | null;
  /** Authoritative mode from ACP CurrentModeUpdate. */
  planMode: boolean;
  /** Ordered, replayable approvals owned by this session. */
  planApprovals: PlanApprovalRequest[];
  suppressReplay: boolean;
}

interface SessionState {
  /** Currently focused session. Top-level mirrors below reflect this one. */
  sessionId: string | null;
  /** Per-session transcripts (single source of truth). */
  transcripts: Record<string, SessionTranscript>;

  // --- mirrors of transcripts[sessionId] (read by the UI) ---
  messages: ChatMessage[];
  /** True between `agent_send` and `agent://complete` for the focused session. */
  streaming: boolean;
  /** Last assistant message id being streamed in the focused session. */
  streamingMessageId: string | null;
  usage: Usage;
  plan: Plan | null;
  planApproval: PlanApprovalRequest | null;

  error: string | null;
  /** Plan mode on/off — mirror of the focused session's authoritative mode. */
  planMode: boolean;

  // --- lifecycle ---
  setSession: (id: string | null) => void;
  reset: () => void;
  /** Start an assistant placeholder in a specific transcript. Defaults to the
   *  focused conversation for ordinary composer sends. */
  startStreaming: (sessionId?: string) => void;
  markComplete: (p: PromptComplete) => void;
  setError: (e: string | null) => void;
  /** Stop a session's stream locally (cancel button): keep any text already
   *  streamed, mark the in-flight message complete, and clear its streaming
   *  flag. Defaults to the focused session. Does NOT talk to the backend. */
  stopStreaming: (sessionId?: string) => void;
  /** Drop a session's cached transcript so the next focus reloads it from
   *  EchoAgent (used after a rewind that rewrites backend history). */
  dropSessionCache: (id: string) => void;
  /** Re-enable replay ingestion for a session once its agentLoadSession call
   *  has finished (so a *new* turn's updates aren't suppressed). */
  clearReplaySuppression: (id?: string) => void;

  // --- transcript ops ---
  /** Append a user message (sent optimistically before the round-trip). */
  pushUser: (text: string, attachments?: string[], sessionId?: string) => void;
  /** Remove the most recent optimistic user message and its empty assistant
   *  placeholder when `agent_send` rejects before the turn starts. */
  rollbackPendingTurn: () => void;
  /** Append an assistant message (for preview mode simulation). */
  pushAssistant: (text: string) => void;
  /** Apply a streamed session/update from the backend. The update is routed
   *  to the transcript it belongs to (`__sessionId`, falling back to the
   *  focused session) so background sessions keep accumulating. */
  applyUpdate: (u: SessionUpdate & { __sessionId?: string }) => void;
  /** Bulk-replace the focused session's messages (history load fallback). */
  setMessages: (msgs: ChatMessage[]) => void;
  /** Replace the focused session's plan. */
  setPlan: (plan: Plan | null) => void;
  /** Apply an authoritative mode value to a session (focused by default). */
  setPlanMode: (enabled: boolean, sessionId?: string) => void;
  requestPlanApproval: (request: PlanApprovalRequest) => void;
  dismissPlanApproval: (requestId: string, sessionId?: string) => void;
}

let seq = 0;
const nextId = () => `m${Date.now()}_${seq++}`;

const EMPTY_TRANSCRIPT: SessionTranscript = {
  messages: [],
  streamingMessageId: null,
  usage: {},
  plan: null,
  planMode: false,
  planApprovals: [],
  suppressReplay: false,
};

const MAX_MESSAGE_TEXT_CHARS = 2_000_000;
const MAX_TOOL_CONTENT_BLOCKS = 256;
const MAX_TOOL_TEXT_CHARS = 1_000_000;
const MAX_TOOL_DIFF_CHARS = 1_000_000;
const MAX_TOOL_IMAGE_BASE64_CHARS = 16 * 1024 * 1024;
const TRUNCATED_OUTPUT_MARKER = "\n\n… 输出过大，已停止在界面中继续累积 …";

function boundedString(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length <= maxChars ? value : value.slice(0, maxChars);
}

function boundedRawInput(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const encoded = JSON.stringify(value);
    if (!encoded || encoded.length <= 256_000) return value;
    return {
      truncated: true,
      preview: encoded.slice(0, 64_000),
      message: "工具参数过大，仅显示前 64,000 个字符",
    };
  } catch {
    return "(工具参数无法显示)";
  }
}

// Side-channel update listeners: keyed by session id. The inspiration panel
// registers one to accumulate EchoAgent's streamed JSON output for a side session.
// When present, applyUpdate forwards matching updates to the listener IN
// ADDITION to (not instead of) routing them into that session's transcript —
// but the inspiration session is never focused, so the transcript stays inert.
const foreignUpdateListeners = new Map<string, (u: SessionUpdate) => void>();

/** Register a side-channel listener for a specific session id. Returns an
 *  unsubscribe function. */
export function registerForeignUpdateListener(
  sessionId: string,
  cb: (u: SessionUpdate) => void,
): () => void {
  foreignUpdateListeners.set(sessionId, cb);
  return () => {
    // Only delete if still ours (avoids clobbering a re-registration).
    if (foreignUpdateListeners.get(sessionId) === cb) {
      foreignUpdateListeners.delete(sessionId);
    }
  };
}

/**
 * Normalize ACP wire-format `ToolCallContent[]` into the shape the frontend
 * `ToolCallCard` expects.
 *
 * ACP (agent-client-protocol-schema 0.11.x) serializes content as:
 *   - text:  { type: "content", content: { type: "text", text: "…" } }
 *   - image: { type: "content", content: { type: "image", data, mimeType, uri? } }
 *   - link:  { type: "content", content: { type: "resource_link", name, uri } }
 *   - diff:  { type: "diff", path, oldText, newText }
 *   - term:  { type: "terminal", terminalId }
 *
 * The frontend expects:
 *   - text:  { type: "text", text: "…" }
 *   - image: { type: "image", data, mimeType, uri? }
 *   - diff:  { type: "diff", diff: { path, old, new } }
 *   - cmd:   { type: "command_output", command?, output }
 *
 * Variants we don't model (audio, embedded resources) degrade to a text
 * fallback carrying their name/uri instead of silently vanishing.
 */
function normalizeToolCallContent(raw: unknown): ToolCallContent[] {
  if (!Array.isArray(raw)) return [];
  return (raw as unknown[]).slice(0, MAX_TOOL_CONTENT_BLOCKS).map((rawItem) => {
    const item = rawItem && typeof rawItem === "object"
      ? rawItem as Record<string, unknown>
      : {};
    const t = item.type as string;

    // ACP wraps text/images/etc inside { type:"content", content: ContentBlock }.
    if (t === "content") {
      const inner = item.content as Record<string, unknown> | undefined;
      if (inner?.type === "text") {
        return { type: "text" as const, text: boundedString(inner.text, MAX_TOOL_TEXT_CHARS) };
      }
      // EchoAgent's read_file returns ImageContent for image/PDF files
      // (acp_conversion.rs): base64 `data` + `mimeType` (+ optional `uri`).
      if (inner?.type === "image") {
        return {
          type: "image" as const,
          data: boundedString(inner.data, MAX_TOOL_IMAGE_BASE64_CHARS),
          mimeType: boundedString(inner.mimeType, 128) || "image/png",
          uri: typeof inner.uri === "string" ? boundedString(inner.uri, 4_096) : undefined,
        };
      }
      // resource_link carries a human name + URI — degrade to text so the
      // card still shows something useful.
      if (inner?.type === "resource_link") {
        const name = boundedString(inner.name, 4_096);
        const uri = boundedString(inner.uri, 4_096);
        return { type: "text" as const, text: boundedString(uri ? `${name}\n${uri}` : name, MAX_TOOL_TEXT_CHARS) };
      }
      // Embedded resource with inline text — surface the text.
      if (inner?.type === "resource") {
        const res = inner.resource as Record<string, unknown> | undefined;
        if (res && typeof res.text === "string") {
          return { type: "text" as const, text: boundedString(res.text, MAX_TOOL_TEXT_CHARS) };
        }
        return { type: "text" as const, text: "(binary resource)" };
      }
      return { type: "text" as const, text: "" };
    }

    // ACP diff uses flat oldText/newText; frontend expects nested diff.old/new.
    if (t === "diff") {
      const diff = item.diff && typeof item.diff === "object"
        ? item.diff as Record<string, unknown>
        : {};
      return {
        type: "diff" as const,
        diff: {
          path: boundedString(diff.path ?? item.path, 4_096),
          old: boundedString(diff.old ?? item.oldText, MAX_TOOL_DIFF_CHARS),
          new: boundedString(diff.new ?? item.newText, MAX_TOOL_DIFF_CHARS),
        },
      };
    }

    // ACP terminal → frontend command_output placeholder.
    if (t === "terminal") {
      return {
        type: "command_output" as const,
        command: undefined,
        output: `[terminal ${boundedString(item.terminalId, 4_096)}]`,
      };
    }

    if (t === "text") {
      return { type: "text" as const, text: boundedString(item.text, MAX_TOOL_TEXT_CHARS) };
    }
    if (t === "image") {
      return {
        type: "image" as const,
        data: boundedString(item.data, MAX_TOOL_IMAGE_BASE64_CHARS),
        mimeType: boundedString(item.mimeType, 128) || "image/png",
        uri: typeof item.uri === "string" ? boundedString(item.uri, 4_096) : undefined,
      };
    }
    if (t === "command_output") {
      return {
        type: "command_output" as const,
        command: typeof item.command === "string" ? boundedString(item.command, 16_384) : undefined,
        output: boundedString(item.output, MAX_TOOL_TEXT_CHARS),
        exitCode: typeof item.exitCode === "number" || item.exitCode === null
          ? item.exitCode
          : undefined,
      };
    }
    return { type: "text" as const, text: "(不支持的工具输出类型)" };
  });
}

function ensureStreamingAssistant(
  messages: ChatMessage[],
  streamingMessageId: string | null
): { messages: ChatMessage[]; id: string } {
  // Reuse the existing streaming assistant message if it's still incomplete
  // and its last part isn't a terminal tool_call.
  if (streamingMessageId) {
    const idx = messages.findIndex((m) => m.id === streamingMessageId);
    if (idx !== -1 && !messages[idx].complete) {
      return { messages, id: streamingMessageId };
    }
  }
  const id = nextId();
  const asst: ChatMessage = {
    id,
    role: "assistant",
    parts: [],
    complete: false,
  };
  return { messages: [...messages, asst], id };
}

function appendText(
  msg: ChatMessage,
  kind: "text" | "thought",
  delta: string
): ChatMessage {
  const parts = [...msg.parts];
  const last = parts[parts.length - 1];
  if (last && last.kind === kind) {
    if (last.text.endsWith(TRUNCATED_OUTPUT_MARKER)) return msg;
    const available = MAX_MESSAGE_TEXT_CHARS - last.text.length - TRUNCATED_OUTPUT_MARKER.length;
    const text = delta.length <= Math.max(0, available)
      ? last.text + delta
      : last.text + delta.slice(0, Math.max(0, available)) + TRUNCATED_OUTPUT_MARKER;
    parts[parts.length - 1] = { kind, text } as MessagePart;
  } else {
    const available = MAX_MESSAGE_TEXT_CHARS - TRUNCATED_OUTPUT_MARKER.length;
    const text = delta.length <= available
      ? delta
      : delta.slice(0, available) + TRUNCATED_OUTPUT_MARKER;
    parts.push({ kind, text } as MessagePart);
  }
  return { ...msg, parts };
}

function userMessageText(message: ChatMessage): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n");
}

function mergePaths(existing: string[] | undefined, incoming: string[]): string[] {
  return [...new Set([...(existing ?? []), ...incoming])];
}

function completeStreamingAssistant(transcript: SessionTranscript): SessionTranscript {
  if (!transcript.streamingMessageId) return transcript;
  const messages = transcript.messages
    .map((message) =>
      message.id === transcript.streamingMessageId
        ? { ...message, complete: true }
        : message
    )
    .filter((message) =>
      !(message.id === transcript.streamingMessageId && message.parts.length === 0)
    );
  return { ...transcript, messages, streamingMessageId: null };
}

interface ReplayedUserChunk {
  text: string;
  attachments: string[];
  promptIndex?: number;
  hasText: boolean;
  hidden: boolean;
}

/** Normalize one ACP UserMessageChunk, including pre-metadata legacy prompts. */
function normalizeUserChunk(update: Record<string, unknown>): ReplayedUserChunk {
  const content = (update.content ?? {}) as Record<string, unknown>;
  const contentMeta = (content._meta ?? {}) as Record<string, unknown>;
  const chunkMeta = (update._meta ?? {}) as Record<string, unknown>;
  const promptIndexValue = chunkMeta.promptIndex ?? chunkMeta.prompt_index;
  const promptIndex = typeof promptIndexValue === "number" ? promptIndexValue : undefined;
  const hidden = chunkMeta.hideFromScrollback === true || chunkMeta.hide_from_scrollback === true;
  const structuredAttachments = normalizeAttachmentPaths(contentMeta[ATTACHMENTS_META_KEY]);
  const imagePath = content.type === "image" && typeof content.uri === "string"
    ? [content.uri]
    : [];

  if (content.type !== "text") {
    return {
      text: "",
      attachments: mergePaths(structuredAttachments, imagePath),
      promptIndex,
      hasText: false,
      hidden,
    };
  }

  const rawText = typeof content.text === "string" ? content.text : "";
  const displayText = typeof contentMeta.displayText === "string"
    ? stripInjectedUserContext(contentMeta.displayText)
    : undefined;
  const legacy = parseLegacyAttachmentPrompt(rawText);
  return {
    text: displayText ?? legacy.text,
    attachments: mergePaths(structuredAttachments, legacy.attachments),
    promptIndex,
    hasText: true,
    hidden,
  };
}

function applyUserChunk(transcript: SessionTranscript, chunk: ReplayedUserChunk): SessionTranscript {
  const messages = [...transcript.messages];

  // A prompt may replay as text followed by one or more image blocks. Merge
  // every block carrying the same promptIndex into the already-created turn.
  if (chunk.promptIndex !== undefined) {
    const matchingIndex = messages.findIndex(
      (message) => message.role === "user" && message.promptIndex === chunk.promptIndex,
    );
    if (matchingIndex !== -1) {
      const current = messages[matchingIndex];
      const nextText = chunk.hasText && chunk.text && userMessageText(current) !== chunk.text
        ? [...current.parts, { kind: "text" as const, text: chunk.text }]
        : current.parts;
      messages[matchingIndex] = {
        ...current,
        parts: nextText,
        attachments: mergePaths(current.attachments, chunk.attachments),
      };
      return { ...transcript, messages };
    }
  }

  // Live sends are inserted optimistically just before an empty assistant
  // placeholder. Reconcile the ACP echo with that message instead of adding a
  // duplicate bubble; structured replay metadata enriches it with attachments.
  const placeholderIndex = transcript.streamingMessageId
    ? messages.findIndex((message) => message.id === transcript.streamingMessageId)
    : -1;
  const optimisticIndex = placeholderIndex > 0 ? placeholderIndex - 1 : -1;
  const optimistic = optimisticIndex >= 0 ? messages[optimisticIndex] : undefined;
  if (
    optimistic?.role === "user"
    && optimistic.promptIndex === undefined
    && (!chunk.hasText || userMessageText(optimistic) === chunk.text)
  ) {
    messages[optimisticIndex] = {
      ...optimistic,
      promptIndex: chunk.promptIndex,
      attachments: mergePaths(optimistic.attachments, chunk.attachments),
    };
    return { ...transcript, messages };
  }

  // A new replayed user turn closes the previous assistant turn. Insert it
  // before an empty live placeholder if one exists, otherwise append normally.
  const completed = completeStreamingAssistant({ ...transcript, messages });
  const user: ChatMessage = {
    id: nextId(),
    role: "user",
    parts: chunk.text ? [{ kind: "text", text: chunk.text }] : [],
    attachments: chunk.attachments,
    promptIndex: chunk.promptIndex,
    complete: true,
  };
  return { ...completed, messages: [...completed.messages, user] };
}

function upsertToolCall(msg: ChatMessage, tc: ToolCallView): ChatMessage {
  const parts = [...msg.parts];
  const idx = parts.findIndex(
    (p) => p.kind === "tool_call" && p.toolCall.toolCallId === tc.toolCallId
  );
  if (idx === -1) {
    parts.push({ kind: "tool_call", toolCall: tc });
  } else {
    parts[idx] = { kind: "tool_call", toolCall: tc };
  }
  return { ...msg, parts };
}

/** Derive the top-level mirror fields from a (possibly null) transcript. */
function mirrorOf(t: SessionTranscript | undefined) {
  return {
    messages: t?.messages ?? [],
    streamingMessageId: t?.streamingMessageId ?? null,
    streaming: (t?.streamingMessageId ?? null) != null,
    usage: t?.usage ?? {},
    plan: t?.plan ?? null,
    planMode: t?.planMode ?? false,
    planApproval: t?.planApprovals?.[0] ?? null,
  };
}

export const useSessionStore = create<SessionState>((set, get) => {
  /**
   * Apply a pure reducer to one session's transcript and, if that session is
   * the focused one, refresh the top-level mirror in the same `set` call so
   * readers never see a half-updated pair.
   */
  const applyToTranscript = (
    sid: string | null,
    reducer: (t: SessionTranscript) => SessionTranscript,
  ) =>
    set((s) => {
      if (!sid) return s; // nowhere to route — drop
      const prev = s.transcripts[sid] ?? { ...EMPTY_TRANSCRIPT };
      const next = reducer(prev);
      if (next === prev) return s;
      const transcripts = { ...s.transcripts, [sid]: next };
      // If we mutated the focused session, keep the mirror in lock-step.
      if (sid === s.sessionId) {
        return { transcripts, ...mirrorOf(next) };
      }
      return { transcripts };
    });

  return {
    sessionId: null,
    transcripts: {},
    messages: [],
    streaming: false,
    streamingMessageId: null,
    usage: {},
    plan: null,
    planApproval: null,
    error: null,
    planMode: false,

    setSession: (id) =>
      set((s) => {
        // Switching focus never destroys transcripts. If we have a cached
        // transcript for the target, it's the truth: arm replay suppression
        // so agentLoadSession's re-streamed history can't merge/overwrite it,
        // and mirror it (streaming stays true if it was mid-stream). If we
        // don't (first open / after restart), seed an empty, non-suppressed
        // transcript that the upcoming replay will fill.
        const hasCache =
          id != null && Object.prototype.hasOwnProperty.call(s.transcripts, id);
        let transcripts = s.transcripts;
        if (id != null && !hasCache) {
          transcripts = { ...s.transcripts, [id]: { ...EMPTY_TRANSCRIPT } };
        } else if (id != null && hasCache) {
          const t = s.transcripts[id];
          if (!t.suppressReplay) {
            transcripts = {
              ...s.transcripts,
              [id]: { ...t, suppressReplay: true },
            };
          }
        }
        const focused = id != null ? transcripts[id] : undefined;
        return {
          sessionId: id,
          transcripts,
          ...mirrorOf(focused),
          error: null,
        };
      }),

    reset: () =>
      set(() => ({
        sessionId: null,
        // Keep transcripts (so a stray background stream can still land and a
        // later refocus restores it); just clear the focused mirror.
        ...mirrorOf(undefined),
        error: null,
      })),

    startStreaming: (sessionId) => {
      // Optimistically insert an empty assistant placeholder so the avatar +
      // "preparing" loading row appears immediately after the user message,
      // instead of a blank gap until the first streamed chunk arrives.
      const sid = sessionId ?? get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => {
        const id = nextId();
        const placeholder: ChatMessage = {
          id,
          role: "assistant",
          parts: [],
          complete: false,
        };
        return {
          ...t,
          streamingMessageId: id,
          messages: [...t.messages, placeholder],
        };
      });
      // Local error banner doesn't belong to the transcript; clear it globally.
      set({ error: null });
    },

    rollbackPendingTurn: () => {
      const sid = get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => {
        const placeholderIndex = t.messages.findIndex(
          (message) => message.id === t.streamingMessageId,
        );
        if (placeholderIndex < 0) return t;
        const placeholder = t.messages[placeholderIndex];
        if (placeholder.parts.length > 0) return t;
        const messages = [...t.messages];
        messages.splice(placeholderIndex, 1);
        const previous = messages[placeholderIndex - 1];
        if (previous?.role === "user") messages.splice(placeholderIndex - 1, 1);
        return { ...t, messages, streamingMessageId: null };
      });
    },

    markComplete: (p) => {
      // Route by the complete's own sessionId so a background session finishing
      // after we switched away finalizes ITS transcript (clearing its streaming
      // flag) instead of clobbering the focused one.
      const target = (p as { sessionId?: string }).sessionId ?? get().sessionId;
      applyToTranscript(target, (t) => {
        const messages = t.messages
          .map((m) =>
            m.id === t.streamingMessageId ? { ...m, complete: true } : m
          )
          // Drop the placeholder if nothing was ever streamed into it —
          // otherwise we'd be left with an empty avatar bubble.
          .filter(
            (m) => !(m.id === t.streamingMessageId && m.parts.length === 0)
          );
        return {
          ...t,
          messages,
          streamingMessageId: null,
          usage: { ...t.usage, ...p.usage },
        };
      });
    },

    setError: (e) => {
      // Error is a global UI banner; also finalize the focused transcript's
      // empty placeholder so the spinner doesn't hang.
      const sid = get().sessionId;
      if (sid) {
        applyToTranscript(sid, (t) => ({
          ...t,
          streamingMessageId: null,
          messages: t.messages.filter(
            (m) => !(m.id === t.streamingMessageId && m.parts.length === 0)
          ),
        }));
      }
      set({ error: e });
    },

    stopStreaming: (sessionId) => {
      // Cancel button: keep whatever already streamed, just close the turn.
      const sid = sessionId ?? get().sessionId;
      if (!sid) {
        set({ error: null });
        return;
      }
      applyToTranscript(sid, (t) => {
        if (t.streamingMessageId == null) return t;
        const messages = t.messages
          .map((m) =>
            m.id === t.streamingMessageId ? { ...m, complete: true } : m
          )
          .filter(
            (m) => !(m.id === t.streamingMessageId && m.parts.length === 0)
          );
        return { ...t, messages, streamingMessageId: null };
      });
    },

    dropSessionCache: (id) =>
      set((s) => {
        if (!Object.prototype.hasOwnProperty.call(s.transcripts, id)) return {};
        const transcripts = { ...s.transcripts };
        delete transcripts[id];
        // If we just dropped the focused session, refresh the mirror to empty
        // (a subsequent setSession+load will refill it from EchoAgent).
        if (id === s.sessionId) {
          return { transcripts, ...mirrorOf(undefined) };
        }
        return { transcripts };
      }),

    clearReplaySuppression: (id) => {
      const target = id ?? get().sessionId;
      if (!target) return;
      applyToTranscript(target, (t) =>
        t.suppressReplay ? { ...t, suppressReplay: false } : t
      );
    },

    pushUser: (text, attachments = [], sessionId) => {
      const sid = sessionId ?? get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => ({
        ...t,
        messages: [
          ...t.messages,
          {
            id: nextId(),
            role: "user",
            parts: [{ kind: "text", text }],
            attachments: normalizeAttachmentPaths(attachments),
            complete: true,
          },
        ],
      }));
    },

    pushAssistant: (text) => {
      const sid = get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => ({
        ...t,
        streamingMessageId: null,
        messages: [
          ...t.messages,
          {
            id: nextId(),
            role: "assistant",
            parts: [{ kind: "text", text }],
            complete: true,
          },
        ],
      }));
    },

    applyUpdate: (u) => {
      const foreignSid = (u as { __sessionId?: string }).__sessionId;
      // Side-channel (inspiration panel) still gets a copy when registered.
      if (foreignSid) {
        const cb = foreignUpdateListeners.get(foreignSid);
        if (cb) cb(u);
      }
      // Route into the transcript this update belongs to. No attribution and
      // no focused session → nowhere to put it, drop (don't pollute).
      const target = foreignSid ?? get().sessionId;
      if (!target) return;

      // ACP's SessionUpdate uses `sessionUpdate` as the tag field (not `type`).
      // Some updates may use `type` (older path); accept both.
      const t = ((u as { sessionUpdate?: string }).sessionUpdate ??
        (u as { type?: string }).type) as string;

      // Replay-suppression gate: when we refocused a cached transcript, the
      // history EchoAgent re-streams must NOT touch the message stream (it would
      // merge turns / overwrite usage). Usage/plan are also part of the cache,
      // so suppress them too during replay.
      const REPLAY_SUPPRESSED = new Set([
        "user_message_chunk",
        "agent_message_chunk",
        "agent_thought_chunk",
        "tool_call",
        "tool_call_update",
        "usage_update",
        "plan",
        "turn_completed",
      ]);

      applyToTranscript(target, (tr) => {
        if (tr.suppressReplay && REPLAY_SUPPRESSED.has(t)) return tr;

        // Extract text delta from a content field that may be a single
        // TextContent object ({type:"text",text:"..."}) OR an array of them.
        const extractDelta = (content: unknown): string => {
          if (!content) return "";
          if (Array.isArray(content)) {
            // Cap while extracting, before allocating a joined intermediate.
            // A malformed/provider-controlled update may contain an enormous
            // number of blocks or many multi-megabyte strings; appendText's
            // final cap alone would be too late to avoid the temporary spike.
            const chunks: string[] = [];
            let remaining = MAX_MESSAGE_TEXT_CHARS;
            for (const block of content.slice(0, MAX_TOOL_CONTENT_BLOCKS)) {
              if (remaining === 0) break;
              const text = boundedString(
                (block as { text?: unknown } | null)?.text,
                remaining,
              );
              if (!text) continue;
              chunks.push(text);
              remaining -= text.length;
            }
            return chunks.join("");
          }
          return boundedString(
            (content as { text?: unknown }).text,
            MAX_MESSAGE_TEXT_CHARS,
          );
        };

        switch (t) {
          case "user_message_chunk": {
            const chunk = normalizeUserChunk(u as unknown as Record<string, unknown>);
            if (chunk.hidden || (!chunk.text && chunk.attachments.length === 0)) return tr;
            return applyUserChunk(tr, chunk);
          }
          case "agent_message_chunk": {
            const delta = extractDelta((u as { content?: unknown }).content);
            if (!delta) return tr;
            const { messages, id } = ensureStreamingAssistant(
              tr.messages,
              tr.streamingMessageId
            );
            const idx = messages.findIndex((m) => m.id === id);
            messages[idx] = appendText(messages[idx], "text", delta);
            return { ...tr, messages: [...messages], streamingMessageId: id };
          }
          case "agent_thought_chunk": {
            const delta = extractDelta((u as { content?: unknown }).content);
            if (!delta) return tr;
            const { messages, id } = ensureStreamingAssistant(
              tr.messages,
              tr.streamingMessageId
            );
            const idx = messages.findIndex((m) => m.id === id);
            messages[idx] = appendText(messages[idx], "thought", delta);
            return { ...tr, messages: [...messages], streamingMessageId: id };
          }
          case "tool_call": {
            const raw = u as unknown as Record<string, unknown>;
            const { messages, id } = ensureStreamingAssistant(
              tr.messages,
              tr.streamingMessageId
            );
            const idx = messages.findIndex((m) => m.id === id);
            // ACP omits `kind` when it's "other" and `status` when it's
            // "pending" (the defaults). Provide sensible fallbacks.
            const status = (raw.status as string) || "in_progress";
            const view: ToolCallView = {
              toolCallId:
                boundedString(raw.toolCallId ?? raw.tool_call_id, 4_096),
              title: boundedString(raw.title, 4_096),
              kind: boundedString(raw.kind, 128) || "other",
              status: status === "completed" || status === "failed"
                ? status
                : "in_progress",
              content: normalizeToolCallContent(raw.content),
              rawInput: boundedRawInput(raw.rawInput ?? raw.raw_input),
            };
            messages[idx] = upsertToolCall(messages[idx], view);
            return { ...tr, messages: [...messages], streamingMessageId: id };
          }
          case "tool_call_update": {
            // ACP serializes ToolCallUpdate with `#[serde(flatten)]` on the
            // fields struct, so status/content/etc. sit at the TOP LEVEL of
            // the JSON alongside toolCallId — there is no nested `update` key.
            const raw = u as unknown as Record<string, unknown>;
            const tcId =
              (raw.toolCallId as string) ?? (raw.tool_call_id as string);
            const deltaFields: Record<string, unknown> = {};
            if (raw.kind !== undefined) deltaFields.kind = boundedString(raw.kind, 128) || "other";
            if (raw.title !== undefined) deltaFields.title = boundedString(raw.title, 4_096);
            if (raw.status !== undefined) {
              deltaFields.status = raw.status === "completed" || raw.status === "failed"
                ? raw.status
                : "in_progress";
            }
            if (raw.content !== undefined) deltaFields.content = raw.content;
            if (raw.rawInput !== undefined) deltaFields.rawInput = boundedRawInput(raw.rawInput);
            if (raw.raw_input !== undefined && deltaFields.rawInput === undefined)
              deltaFields.rawInput = boundedRawInput(raw.raw_input);
            if (deltaFields.content !== undefined) {
              deltaFields.content = normalizeToolCallContent(
                deltaFields.content
              );
            }
            // Patch the matching tool card across the transcript (not only the
            // streaming message — a late update may target an older turn).
            const messages = tr.messages.map((m) => {
              const has = m.parts.some(
                (p) =>
                  p.kind === "tool_call" && p.toolCall.toolCallId === tcId
              );
              if (!has) return m;
              const parts = m.parts.map((p) => {
                if (p.kind !== "tool_call") return p;
                if (p.toolCall.toolCallId !== tcId) return p;
                return {
                  ...p,
                  toolCall: { ...p.toolCall, ...deltaFields } as ToolCallView,
                };
              });
              return { ...m, parts };
            });
            return { ...tr, messages };
          }
          case "usage_update": {
            const uu = u as unknown as UsageUpdate;
            return { ...tr, usage: { ...tr.usage, ...uu.usage } };
          }
          case "plan": {
            const uu = u as unknown as PlanUpdate;
            return { ...tr, plan: uu.plan ?? null };
          }
          case "current_mode_update": {
            const raw = u as unknown as Record<string, unknown>;
            const modeId = raw.currentModeId ?? raw.current_mode_id;
            // Unknown modes are intentionally not treated as plan mode.
            return { ...tr, planMode: modeId === "plan" };
          }
          case "plan_approval_request": {
            const request = u as unknown as PlanApprovalRequest;
            const existing = tr.planApprovals ?? [];
            if (existing.some((item) => item.requestId === request.requestId)) return tr;
            return { ...tr, planApprovals: [...existing, request] };
          }
          case "plan_approval_resolved": {
            const requestId = (u as unknown as { requestId?: string }).requestId;
            if (!requestId) return tr;
            return {
              ...tr,
              planApprovals: (tr.planApprovals ?? []).filter(
                (item) => item.requestId !== requestId,
              ),
            };
          }
          case "turn_completed":
            return completeStreamingAssistant(tr);
          default:
            return tr;
        }
      });
    },

    setMessages: (msgs) => {
      const sid = get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => ({ ...t, messages: msgs }));
    },

    setPlan: (plan) => {
      const sid = get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (t) => ({ ...t, plan }));
    },

    setPlanMode: (enabled, sessionId) => {
      const sid = sessionId ?? get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (transcript) => ({ ...transcript, planMode: enabled }));
    },

    requestPlanApproval: (request) => {
      applyToTranscript(request.sessionId, (transcript) => {
        const pending = transcript.planApprovals ?? [];
        if (pending.some((item) => item.requestId === request.requestId)) return transcript;
        return { ...transcript, planApprovals: [...pending, request] };
      });
    },

    dismissPlanApproval: (requestId, sessionId) => {
      const sid = sessionId ?? get().sessionId;
      if (!sid) return;
      applyToTranscript(sid, (transcript) => ({
        ...transcript,
        planApprovals: (transcript.planApprovals ?? []).filter(
          (item) => item.requestId !== requestId,
        ),
      }));
    },
  };
});

export type { ToolCallUpdate };
