import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, type MarkdownConfig } from "./markdown/index";
import { ToolCallCard } from "./ToolCallCard";
import { LoadingRow } from "./LoadingRow";
import { FeedbackDialog } from "./FeedbackDialog";
import { AttachmentVisual } from "./AttachmentVisual";
import { useTheme } from "./ThemeProvider";
import { useFeedbackStore, type FeedbackRating } from "@/stores/feedback-store";
import type { ChatMessage, ToolCallView } from "@/stores/session-store";
import { openLocalPath } from "@/lib/agent-client";
import {
  attachmentBasename,
  isImageAttachment,
  stripInjectedUserContext,
} from "@/lib/user-message";
const logoMarkUrl = "/app-icon.png";
import {
  createWebSpeechTtsProvider,
  getActiveTts,
  registerTtsProvider,
} from "@/lib/voice-contract";

let webSpeechTtsRegistered = false;

function ensureWebSpeechTtsRegistered(): void {
  if (webSpeechTtsRegistered || typeof window === "undefined") return;
  webSpeechTtsRegistered = true;
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") return;
  registerTtsProvider(createWebSpeechTtsProvider({
    isAvailable: () => "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined",
    synth: window.speechSynthesis as never,
    createUtterance: (text, lang, opts) => {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = lang;
      utterance.rate = opts?.rate ?? 1;
      utterance.pitch = opts?.pitch ?? 1;
      utterance.onend = () => opts?.onEnd?.();
      utterance.onerror = () => opts?.onError?.();
      return utterance as never;
    },
  }));
}

function speechText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, "代码块已省略。")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Renders one chat message. Assistant messages are left-aligned with avatar +
 * name row; user messages are right-aligned bubbles with no avatar / name.
 *
 * Hover action bar (对齐 EchoAgent):
 *  - user: 复制 / 编辑重发
 *  - assistant: 复制 / 复制 Markdown
 */
export function MessageItem({
  message,
  streaming,
  markdownConfig,
  cwd,
  sessionId,
  onOpenTool,
  onEditResend,
  onRetry,
  onToast,
}: {
  message: ChatMessage;
  streaming: boolean;
  markdownConfig?: MarkdownConfig;
  /** Workspace used to resolve relative attachment paths. */
  cwd?: string;
  /** Current session id — needed to key feedback entries. */
  sessionId?: string;
  onToast?: (msg: string) => void;
  /** Open tool detail in the right-side panel (Phase 2). */
  onOpenTool?: (tc: ToolCallView) => void;
  /** Put text back into the composer for re-editing (user messages only). */
  onEditResend?: (text: string, attachments: string[]) => void;
  /** Regenerate this response (last assistant message only): rewinds the
   *  conversation to the preceding user prompt and resends it. */
  onRetry?: () => void;
}) {
  const { theme } = useTheme();
  const [speaking, setSpeaking] = useState(false);
  const stopSpeakingRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopSpeakingRef.current?.(), []);

  const copyText = useCallback(
    (text: string, label: string) => {
      if (navigator.clipboard?.writeText) {
        navigator.clipboard
          .writeText(text)
          .then(() => onToast?.(label))
          .catch(() => onToast?.("复制失败"));
      } else {
        onToast?.("当前环境不支持剪贴板");
      }
    },
    [onToast],
  );

  /** Extract plain text from all text parts (for copy), stripping hidden persona. */
  const plainText = message.parts
    .filter((p) => p.kind === "text")
    .map((p) => (message.role === "user" ? stripInjectedUserContext(p.text) : p.text))
    .join("\n");

  /** Extract markdown (text + thought) for "copy as markdown". */
  const markdownText = message.parts
    .map((p) => {
      if (p.kind === "text") return p.text;
      if (p.kind === "thought") return `<details>\n<summary>深度思考</summary>\n\n${p.text}\n\n</details>`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  const toggleSpeak = useCallback(() => {
    if (speaking) {
      stopSpeakingRef.current?.();
      stopSpeakingRef.current = null;
      setSpeaking(false);
      return;
    }
    ensureWebSpeechTtsRegistered();
    const provider = getActiveTts();
    const text = speechText(plainText);
    if (!provider || !text) {
      onToast?.(provider ? "该回复没有可朗读文本" : "当前系统不支持语音朗读");
      return;
    }
    setSpeaking(true);
    stopSpeakingRef.current = provider.speak(text, "zh-CN", {
      onEnd: () => {
        stopSpeakingRef.current = null;
        setSpeaking(false);
      },
      onError: () => {
        stopSpeakingRef.current = null;
        setSpeaking(false);
        onToast?.("语音朗读失败");
      },
    });
  }, [onToast, plainText, speaking]);

  if (message.role === "user") {
    const attachments = message.attachments ?? [];
    return (
      <div className="msg msg--user">
        <div>
          <div className={"msg__bubble" + (attachments.length ? " msg__bubble--with-attachments" : "")}>
            {attachments.length > 0 && (
              <div className="msg__attachments" role="list" aria-label="附件">
                {attachments.map((path) => {
                  const name = attachmentBasename(path);
                  const image = isImageAttachment(path);
                  const extension = name.includes(".")
                    ? name.slice(name.lastIndexOf(".") + 1).toUpperCase()
                    : "FILE";
                  return (
                    <div key={path} className="msg__attachment-item" role="listitem">
                      <button
                        type="button"
                        className={"msg__attachment" + (image ? " msg__attachment--image" : "")}
                        title={path}
                        aria-label={`打开附件 ${name}`}
                        onClick={() => {
                          void openLocalPath(path, cwd).catch((error) => {
                            onToast?.(`打开附件失败：${String(error).replace(/^Error:\s*/, "")}`);
                          });
                        }}
                      >
                        <AttachmentVisual path={path} />
                        <span className="msg__attachment-copy">
                          <span className="msg__attachment-name">{name}</span>
                          <span className="msg__attachment-type">
                            {extension} {image ? "图片" : "文件"}
                          </span>
                        </span>
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            {message.parts.map((p, i) =>
              p.kind === "text" ? <span key={i}>{stripInjectedUserContext(p.text)}</span> : null
            )}
          </div>
          {/* Hover actions */}
          <div className="msg__actions">
            <button
              type="button"
              className="msg__action-btn"
              onClick={() => copyText(plainText, "已复制")}
              title="复制"
            >
              复制
            </button>
            {onEditResend && (
              <button
                type="button"
                className="msg__action-btn"
                onClick={() => onEditResend(plainText, attachments)}
                title="编辑并重新发送"
              >
                编辑
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg msg--assistant">
      <div>
        <div className="msg__header">
          <span className="msg__avatar">
            <img src={logoMarkUrl} alt="" aria-hidden="true" draggable={false} />
          </span>
          <span className="msg__name">EchoAgent</span>
          {/* Hover actions — inline in header for assistant messages */}
          {message.complete && (
            <div className="msg__actions msg__actions--inline">
              <button
                type="button"
                className="msg__action-btn"
                onClick={() => copyText(plainText, "已复制")}
                title="复制纯文本"
              >
                复制
              </button>
              <button
                type="button"
                className="msg__action-btn"
                onClick={() => copyText(markdownText, "已复制 Markdown")}
                title="复制 Markdown 源码"
              >
                MD
              </button>
              <button
                type="button"
                className="msg__action-btn"
                onClick={toggleSpeak}
                title={speaking ? "停止朗读" : "朗读回复"}
                aria-pressed={speaking}
              >
                {speaking ? "停止" : "朗读"}
              </button>
              {onRetry && (
                <button
                  type="button"
                  className="msg__action-btn"
                  onClick={onRetry}
                  title="重新生成回复（回溯后重发）"
                >
                  重试
                </button>
              )}
              {sessionId && (
                <FeedbackButtons sessionId={sessionId} messageId={message.id} />
              )}
            </div>
          )}
        </div>
        <div className="msg__body">
          {/* Placeholder state: the assistant message exists but no content
              has streamed in yet. Render the avatar (header above) + the
              shimmering "preparing / waiting for model" loading row with a
              rotating tip — mirrors EchoAgent's pending-assistant view. */}
          {message.parts.length === 0 && !message.complete && <LoadingRow />}
          {message.parts.map((p, i) => {
            if (p.kind === "text") {
              return (
                <Markdown
                  key={i}
                  complete={message.complete}
                  markdownTheme="loose"
                  theme={theme}
                  config={markdownConfig}
                >
                  {p.text}
                </Markdown>
              );
            }
            if (p.kind === "thought") {
              return (
                <details key={i} className="msg__thought">
                  <summary>深度思考</summary>
                  <div className="msg__thought-body">
                    <Markdown
                      complete={message.complete}
                      markdownTheme="reasoning"
                      theme={theme}
                      config={markdownConfig}
                    >
                      {p.text}
                    </Markdown>
                  </div>
                </details>
              );
            }
            return (
              <ToolCallCard
                key={p.toolCall.toolCallId || i}
                tc={p.toolCall}
                onOpen={onOpenTool}
              />
            );
          })}
          {streaming &&
            message.complete === false &&
            message.parts.length > 0 && (
              <span className="msg__caret">▋</span>
            )}
        </div>
      </div>
    </div>
  );
}

/**
 * 反馈按钮(👍/👎)—— 对齐 EchoAgent message-feedback。
 *
 * 本地持久化(toggle:再点同向取消)。无后端上报(EchoAgent 是 BYOK,无可上报通道)。
 * 选中的方向高亮(填充),未选中保持描边。
 */
function FeedbackButtons({
  sessionId,
  messageId,
}: {
  sessionId: string;
  messageId: string;
}) {
  const entry = useFeedbackStore(
    (s) => s.entries[`${sessionId}:${messageId}`] ?? null,
  );
  const setRating = useFeedbackStore((s) => s.setRating);
  const current = entry?.rating ?? null;
  // 点赞/踩:记录方向并打开完整评分弹窗(对齐 EchoAgent rating bar + 弹窗)。
  const [dialogOpen, setDialogOpen] = useState<FeedbackRating | null>(null);
  const click = (r: FeedbackRating) => {
    // 再点已选中方向 → 取消(不弹窗)。
    if (current === r) {
      setRating(sessionId, messageId, r);
      return;
    }
    setRating(sessionId, messageId, r);
    setDialogOpen(r);
  };
  return (
    <span className="msg__feedback">
      <button
        type="button"
        className={
          "msg__action-btn msg__feedback-btn" +
          (current === "up" ? " msg__feedback-btn--active" : "")
        }
        onClick={() => click("up")}
        title={current === "up" ? "取消赞" : "赞"}
        aria-label="赞"
        aria-pressed={current === "up"}
      >
        👍
      </button>
      <button
        type="button"
        className={
          "msg__action-btn msg__feedback-btn" +
          (current === "down" ? " msg__feedback-btn--active" : "")
        }
        onClick={() => click("down")}
        title={current === "down" ? "取消踩" : "踩"}
        aria-label="踩"
        aria-pressed={current === "down"}
      >
        👎
      </button>
      {dialogOpen && (
        <FeedbackDialog
          open={dialogOpen !== null}
          sessionId={sessionId}
          messageId={messageId}
          rating={dialogOpen}
          onClose={() => setDialogOpen(null)}
        />
      )}
    </span>
  );
}
