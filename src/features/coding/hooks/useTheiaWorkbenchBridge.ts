import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatMessage } from "@/stores/session-store";
import { localPreviewUrls } from "../lib/preview-url";
import type { TheiaIdeFrameHandle } from "../TheiaIdeFrame";

/** State and layout owned by the embedded IDE bridge, independent of task phases. */
export function useTheiaWorkbenchBridge(
  cwd: string,
  messages: ChatMessage[],
  onToast?: (message: string) => void,
) {
  const [theiaActiveFile, setTheiaActiveFile] = useState<string | null>(null);
  const [theiaActiveSymbol, setTheiaActiveSymbol] = useState<{ path: string; symbol: string } | null>(null);
  const [theiaPreviewInput, setTheiaPreviewInput] = useState("");
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [theiaPreviewOpen, setTheiaPreviewOpen] = useState(false);
  const [theiaAgentOpen, setTheiaAgentOpen] = useState(true);
  const [agentWidth, setAgentWidth] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("echo-agent-panel-width"));
      return saved >= 300 && saved <= 800 ? saved : 410;
    } catch {
      return 410;
    }
  });
  const [theiaDirtyCount, setTheiaDirtyCount] = useState<number | null>(null);
  const [theiaPreviewRequest, setTheiaPreviewRequest] = useState<{ url: string; id: number } | null>(null);
  const [theiaOpenFileRequest, setTheiaOpenFileRequest] = useState<{ path: string; id: number; line?: number } | null>(null);
  const theiaFrameRef = useRef<TheiaIdeFrameHandle>(null);
  const theiaPreviewRef = useRef<HTMLDivElement>(null);
  const workbenchRef = useRef<HTMLDivElement>(null);
  const agentResizeCleanupRef = useRef<(() => void) | null>(null);

  const onDetectedPreviewUrl = useCallback((url: string) => {
    setPreviewUrls((current) => current[0] === url
      ? current : [url, ...current.filter((item) => item !== url)].slice(0, 4));
  }, []);
  useEffect(() => {
    for (const url of localPreviewUrls(messages)) onDetectedPreviewUrl(url);
  }, [messages, onDetectedPreviewUrl]);

  const openTheiaFile = useCallback((rawPath: string, line?: number) => {
    const root = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
    const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/\.\//g, "/");
    if (!path || path.split("/").includes("..")) {
      onToast?.("文件路径无效");
      return;
    }
    const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path) ? path : `${root}/${path}`;
    const compareRoot = /^[A-Za-z]:\//.test(root) ? root.toLowerCase() : root;
    const comparePath = /^[A-Za-z]:\//.test(absolute) ? absolute.toLowerCase() : absolute;
    if (!comparePath.startsWith(`${compareRoot}/`)) {
      onToast?.("只能打开当前项目内的文件");
      return;
    }
    setTheiaOpenFileRequest({ path: absolute, line, id: Date.now() });
  }, [cwd, onToast]);

  useEffect(() => {
    if (!theiaPreviewOpen) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!theiaPreviewRef.current?.contains(event.target as Node)) setTheiaPreviewOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutsideClick);
    return () => document.removeEventListener("mousedown", closeOnOutsideClick);
  }, [theiaPreviewOpen]);

  const resizeAgent = useCallback((clientX: number) => {
    const bounds = workbenchRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const maximum = Math.max(300, Math.min(800, bounds.width - 320));
    setAgentWidth(Math.round(Math.max(300, Math.min(maximum, bounds.right - clientX))));
  }, []);
  const startAgentResize = useCallback(() => {
    const onMove = (event: PointerEvent) => resizeAgent(event.clientX);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      agentResizeCleanupRef.current = null;
    };
    agentResizeCleanupRef.current?.();
    agentResizeCleanupRef.current = onUp;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }, [resizeAgent]);
  useEffect(() => () => agentResizeCleanupRef.current?.(), []);
  useEffect(() => {
    const element = workbenchRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (width <= 0) return;
      const maximum = Math.max(300, Math.min(800, width - 320));
      setAgentWidth((current) => Math.min(current, maximum));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [cwd]);
  useEffect(() => {
    try { window.localStorage.setItem("echo-agent-panel-width", String(agentWidth)); } catch { /* Optional layout preference. */ }
  }, [agentWidth]);

  const resizeAgentByKey = useCallback((key: string) => {
    const width = workbenchRef.current?.getBoundingClientRect().width ?? 0;
    const maximum = width > 0 ? Math.max(300, Math.min(800, width - 320)) : 800;
    setAgentWidth((current) => Math.max(300, Math.min(maximum, current + (key === "ArrowLeft" ? 20 : -20))));
  }, []);

  return {
    theiaActiveFile, setTheiaActiveFile, theiaActiveSymbol, setTheiaActiveSymbol,
    theiaPreviewInput, setTheiaPreviewInput, previewUrls, setPreviewUrls,
    theiaPreviewOpen, setTheiaPreviewOpen, theiaAgentOpen, setTheiaAgentOpen,
    agentWidth, setAgentWidth, theiaDirtyCount, setTheiaDirtyCount,
    theiaPreviewRequest, setTheiaPreviewRequest, theiaOpenFileRequest,
    theiaFrameRef, theiaPreviewRef, workbenchRef,
    onDetectedPreviewUrl, openTheiaFile, startAgentResize, resizeAgentByKey,
  };
}
