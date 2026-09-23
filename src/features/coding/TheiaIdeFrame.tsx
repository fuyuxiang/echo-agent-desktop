import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Code2, LoaderCircle, RotateCw } from "lucide-react";

export interface TheiaMutationTicket {
  taskId: string | null;
  closeRound: boolean;
}

export interface TheiaAgentBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface TheiaIdeFrameProps {
  root: string;
  onBeforeMutation: (operation: string, paths: string[]) => Promise<TheiaMutationTicket | null>;
  onAfterMutation: (ticket: TheiaMutationTicket, success: boolean, error?: string) => Promise<void>;
  onActiveFile?: (path: string | null) => void;
  onToast?: (message: string) => void;
  previewRequest?: { url: string; id: number } | null;
  openFileRequest?: { path: string; id: number; line?: number } | null;
  agentVisible?: boolean;
  onAgentBounds?: (bounds: TheiaAgentBounds | null) => void;
  onAgentVisibilityChange?: (visible: boolean) => void;
}

interface TheiaEndpoint {
  url: string;
  embedToken: string;
}

function belongsToWorkspace(root: string, path: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

/** Theia owns the IDE surface; EchoAgent owns the surrounding task UI. */
export function TheiaIdeFrame({
  root,
  onBeforeMutation,
  onAfterMutation,
  onActiveFile,
  onToast,
  previewRequest,
  openFileRequest,
  agentVisible = true,
  onAgentBounds,
  onAgentVisibilityChange,
}: TheiaIdeFrameProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const resettingWorkspace = useRef(false);
  const token = useMemo(() => crypto.randomUUID(), [root]);
  const [endpoint, setEndpoint] = useState<TheiaEndpoint | null>(null);
  const baseUrl = endpoint?.url ?? null;
  const [status, setStatus] = useState<"starting" | "loading" | "ready" | "error">("starting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  useEffect(() => {
    const observer = new MutationObserver(() => {
      setTheme(document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (status !== "ready" || !baseUrl) return;
    frameRef.current?.contentWindow?.postMessage({ type: "echo/set-theme", token, theme }, new URL(baseUrl).origin);
  }, [baseUrl, status, theme, token]);

  useEffect(() => {
    if (status !== "ready" || !baseUrl) return;
    frameRef.current?.contentWindow?.postMessage({ type: "echo/set-agent-visible", token, visible: agentVisible }, new URL(baseUrl).origin);
  }, [agentVisible, baseUrl, status, token]);

  useEffect(() => {
    let cancelled = false;
    setStatus("starting");
    setEndpoint(null);
    onAgentBounds?.(null);
    invoke<TheiaEndpoint>("coding_theia_start", { root })
      .then((next) => {
        if (cancelled) return;
        setEndpoint(next);
        setStatus("loading");
      })
      .catch((reason) => {
        if (cancelled) return;
        setError(String(reason));
        setStatus("error");
      });
    return () => { cancelled = true; };
  }, [root, attempt]);

  useEffect(() => {
    if (status !== "loading") return;
    const timer = window.setTimeout(() => {
      setError("IDE 页面加载超时。请重试；若持续失败，请查看应用数据目录中的 theia.log。");
      setStatus("error");
    }, 60_000);
    return () => window.clearTimeout(timer);
  }, [status]);

  const frameUrl = useMemo(() => {
    if (!endpoint) return null;
    const url = new URL(endpoint.url);
    url.searchParams.set("echoEmbedToken", endpoint.embedToken);
    url.searchParams.set("echoBridgeToken", token);
    url.searchParams.set("echoParentOrigin", window.location.origin);
    url.hash = encodeURI(root.replaceAll("\\", "/"));
    return url.toString();
  }, [endpoint, root, token]);

  useEffect(() => {
    if (status !== "ready" || !baseUrl || !previewRequest) return;
    frameRef.current?.contentWindow?.postMessage({
      type: "echo/open-preview", token, url: previewRequest.url,
    }, new URL(baseUrl).origin);
  }, [baseUrl, previewRequest, status, token]);

  useEffect(() => {
    if (status !== "ready" || !baseUrl || !openFileRequest) return;
    frameRef.current?.contentWindow?.postMessage({
      type: "echo/open-file", token, path: openFileRequest.path, line: openFileRequest.line,
    }, new URL(baseUrl).origin);
  }, [baseUrl, openFileRequest, status, token]);

  useEffect(() => {
    if (!baseUrl) return;
    const theiaOrigin = new URL(baseUrl).origin;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== theiaOrigin || event.source !== frameRef.current?.contentWindow
          || typeof event.data !== "object" || !event.data) return;
      const message = event.data as Record<string, unknown>;
      if (message.token !== token || typeof message.type !== "string") return;
      if (message.type === "echo/ready") {
        resettingWorkspace.current = false;
        setStatus("ready");
        (event.source as Window).postMessage({ type: "echo/request-agent-bounds", token }, theiaOrigin);
        return;
      }
      if (message.type === "echo/agent-bounds") {
        const bounds = message.bounds;
        if (bounds === null) {
          onAgentBounds?.(null);
          onAgentVisibilityChange?.(false);
        } else if (bounds && typeof bounds === "object") {
          const next = bounds as Record<string, unknown>;
          const { left, top, width, height } = next;
          const frame = frameRef.current;
          if (frame && [left, top, width, height].every((value) => typeof value === "number" && Number.isFinite(value))
              && (left as number) >= 0 && (top as number) >= 0
              && (width as number) > 40 && (height as number) > 40
              && (left as number) + (width as number) <= frame.clientWidth + 2
              && (top as number) + (height as number) <= frame.clientHeight + 2) {
            onAgentBounds?.({ left: left as number, top: top as number, width: width as number, height: height as number });
            onAgentVisibilityChange?.(true);
          }
        }
        return;
      }
      if (message.type === "echo/workspace") {
        if (typeof message.path !== "string" || !belongsToWorkspace(root, message.path)
            || !belongsToWorkspace(message.path, root)) {
          if (!resettingWorkspace.current) {
            resettingWorkspace.current = true;
            onToast?.("请使用顶部项目切换器打开代码库，IDE 已返回当前项目");
            setStatus("loading");
            setReloadKey((value) => value + 1);
          }
        }
        return;
      }
      if (message.type === "echo/active-file") {
        onActiveFile?.(typeof message.path === "string" ? message.path : null);
        return;
      }
      if (typeof message.id !== "string" || !event.source) return;
      const target = event.source;
      const respond = (ok: boolean, value?: unknown, reason?: unknown) => {
        (target as Window).postMessage({
          type: "echo/response", token, id: message.id, ok, value,
          error: reason === undefined ? undefined : String(reason),
        }, theiaOrigin);
      };
      if (message.type === "echo/before-mutation") {
        const paths = Array.isArray(message.paths)
          ? message.paths.filter((path): path is string => typeof path === "string")
          : [];
        if (!paths.some((path) => belongsToWorkspace(root, path))) {
          respond(true, { taskId: null, closeRound: false });
          return;
        }
        void onBeforeMutation(String(message.operation ?? "write"), paths)
          .then((ticket) => ticket ? respond(true, ticket) : respond(false, undefined, "当前任务阶段不能修改文件"))
          .catch((reason) => respond(false, undefined, reason));
      } else if (message.type === "echo/after-mutation") {
        const ticket = message.ticket as TheiaMutationTicket | undefined;
        if (!ticket || typeof ticket.closeRound !== "boolean") {
          respond(false, undefined, "无效的文件操作凭据");
          return;
        }
        void onAfterMutation(ticket, message.success === true, typeof message.error === "string" ? message.error : undefined)
          .then(() => respond(true))
          .catch((reason) => {
            onToast?.(`文件已修改，但任务同步失败：${String(reason)}`);
            respond(false, undefined, reason);
          });
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [baseUrl, onActiveFile, onAfterMutation, onAgentBounds, onAgentVisibilityChange, onBeforeMutation, onToast, root, token]);

  return (
    <div className="echo-theia" aria-label="Theia 代码工作台">
      {frameUrl && (
        <iframe
          ref={frameRef}
          key={`${frameUrl}:${reloadKey}`}
          className="echo-theia__frame"
          src={frameUrl}
          title="Echo Code IDE"
          referrerPolicy="no-referrer"
          onError={() => {
            setError("Theia 页面无法加载");
            setStatus("error");
          }}
        />
      )}
      {status !== "ready" && (
        <div className="echo-theia__cover" role="status">
          <Code2 size={26} />
          {status === "error" ? (
            <>
              <strong>IDE 启动失败</strong>
              <p>{error}</p>
              <button type="button" onClick={() => setAttempt((value) => value + 1)}>
                <RotateCw size={14} /> 重试
              </button>
            </>
          ) : (
            <>
              <strong>正在启动 Echo Code IDE</strong>
              <p>{status === "starting" ? "准备本地 Theia 服务…" : "正在加载项目、编辑器与终端…"}</p>
              <LoaderCircle size={17} className="is-spinning" />
            </>
          )}
        </div>
      )}
    </div>
  );
}
