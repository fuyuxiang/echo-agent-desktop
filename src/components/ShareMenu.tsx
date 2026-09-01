/**
 * 分享 / 导出菜单 —— 对齐 EchoAgent `share:*`(导出对话 / 分享链接)。
 *
 * EchoAgent 本地导出(markdown/html/text 下载 + mailto 分享意图),不上传云端。
 * 由 ChatView 顶栏「分享」按钮触发。
 */
import { useEffect, useRef, useState } from "react";
import {
  buildSharePayload,
  buildMailtoUrl,
  copyShareText,
  systemShare,
  triggerDownload,
  type ShareFormat,
} from "@/lib/share";
import type { ChatMessage } from "@/stores/session-store";
import { openExternalUrl } from "@/lib/agent-client";

interface ShareMenuProps {
  messages: ChatMessage[];
  title?: string;
  /** 宿主回调(打开系统邮件客户端)。依赖注入便于测试;缺省用 window.open。 */
  openUrl?: (url: string) => void;
  onDone?: (msg: string) => void;
}

export function ShareMenu({ messages, title, openUrl, onDone }: ShareMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const exportAs = (format: ShareFormat) => {
    const payload = buildSharePayload(messages, format, title);
    triggerDownload(payload);
    setOpen(false);
    onDone?.(`已导出 ${payload.filename}`);
  };

  const shareMail = () => {
    const payload = buildSharePayload(messages, "text", title);
    const url = buildMailtoUrl(title || "对话分享", payload.content);
    if (openUrl) {
      openUrl(url);
    } else {
      void openExternalUrl(url).catch((error) => {
        onDone?.(`打开邮件客户端失败：${String(error).replace(/^Error:\s*/, "")}`);
      });
    }
    setOpen(false);
    onDone?.("已打开邮件分享");
  };

  const copyMarkdown = async () => {
    const payload = buildSharePayload(messages, "markdown", title);
    try {
      if (!await copyShareText(payload.content)) throw new Error("当前环境不支持剪贴板");
      setOpen(false);
      onDone?.("已复制 Markdown");
    } catch (error) {
      onDone?.(`复制失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const shareSystem = async () => {
    const payload = buildSharePayload(messages, "text", title);
    try {
      if (!await systemShare(payload, title)) throw new Error("当前系统不支持原生分享");
      setOpen(false);
      onDone?.("已打开系统分享");
    } catch (error) {
      // Cancelling the native share sheet is expected and needs no error toast.
      if ((error as { name?: string })?.name !== "AbortError") {
        onDone?.(`分享失败：${String(error).replace(/^Error:\s*/, "")}`);
      }
    }
  };

  return (
    <div className="share-menu" ref={ref}>
      <button
        type="button"
        className={
          "chatview__artifacts-toggle" +
          (open ? " chatview__artifacts-toggle--active" : "")
        }
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        title="导出 / 分享本会话"
      >
        分享
      </button>
      {open && (
        <div className="share-menu__popover" onClick={(e) => e.stopPropagation()}>
          <div className="share-menu__note">本地分享，不会自动上传会话</div>
          <button type="button" className="share-menu__item" onClick={() => void copyMarkdown()}>
            复制 Markdown
          </button>
          {typeof navigator !== "undefined" && typeof navigator.share === "function" && (
            <button type="button" className="share-menu__item" onClick={() => void shareSystem()}>
              系统分享…
            </button>
          )}
          <div className="share-menu__divider" />
          <button type="button" className="share-menu__item" onClick={() => exportAs("markdown")}>
            导出 Markdown
          </button>
          <button type="button" className="share-menu__item" onClick={() => exportAs("html")}>
            导出 HTML
          </button>
          <button type="button" className="share-menu__item" onClick={() => exportAs("text")}>
            导出纯文本
          </button>
          <div className="share-menu__divider" />
          <button type="button" className="share-menu__item" onClick={shareMail}>
            通过邮件分享
          </button>
        </div>
      )}
    </div>
  );
}
