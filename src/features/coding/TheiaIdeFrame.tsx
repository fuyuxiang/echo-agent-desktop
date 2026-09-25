import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
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

export interface TheiaIdeFrameHandle {
  getDirtyCount: () => Promise<number>;
  saveAll: () => Promise<boolean>;
}

interface TheiaIdeFrameProps {
  root: string;
  onBeforeMutation: (operation: string, paths: string[]) => Promise<TheiaMutationTicket | null>;
  onAfterMutation: (ticket: TheiaMutationTicket, success: boolean, error?: string) => Promise<void>;
  onActiveFile?: (path: string | null) => void;
  onActiveSymbol?: (value: { path: string; symbol: string } | null) => void;
  onPreviewUrl?: (url: string) => void;
  onToast?: (message: string) => void;
  previewRequest?: { url: string; id: number } | null;
  openFileRequest?: { path: string; id: number; line?: number } | null;
  agentVisible?: boolean;
  onAgentBounds?: (bounds: TheiaAgentBounds | null) => void;
  onAgentVisibilityChange?: (visible: boolean) => void;
  onDirtyChange?: (count: number | null) => void;
}

interface TheiaEndpoint {
  url: string;
  embedToken: string;
}

function belongsToWorkspace(root: string, path: string): boolean {
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  if (path.replaceAll("\\", "/").split("/").includes("..")) return false;
  const normalizedRoot = normalize(root);
  const normalizedPath = normalize(path);
  const windows = /^[A-Za-z]:\//.test(normalizedRoot);
  const compareRoot = windows ? normalizedRoot.toLowerCase() : normalizedRoot;
  const comparePath = windows ? normalizedPath.toLowerCase() : normalizedPath;
  return comparePath === compareRoot || comparePath.startsWith(`${compareRoot}/`);
}

/** Theia owns the IDE surface; EchoAgent owns the surrounding task UI. */
export const TheiaIdeFrame = forwardRef<TheiaIdeFrameHandle, TheiaIdeFrameProps>(function TheiaIdeFrame({
  root,
  onBeforeMutation,
  onAfterMutation,
  onActiveFile,
  onActiveSymbol,
  onPreviewUrl,
  onToast,
  previewRequest,
  openFileRequest,
  agentVisible = true,
  onAgentBounds,
  onAgentVisibilityChange,
  onDirtyChange,
}, ref) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const pendingRequests = useRef(new Map<string, { resolve: (count: number) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> }>());
  const lastKnownDirtyCount = useRef<number | null>(null);
  const hasBeenReady = useRef(false);
  const resettingWorkspace = useRef(false);
  const hasVisibleAgentDock = useRef(false);
  const token = useMemo(() => crypto.randomUUID(), [root]);
  const [endpoint, setEndpoint] = useState<TheiaEndpoint | null>(null);
  const baseUrl = endpoint?.url ?? null;
  const [status, setStatus] = useState<"starting" | "loading" | "ready" | "error">("starting");
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [reloadKey, setReloadKey] = useState(0);
  const [theme, setTheme] = useState(() => document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

  const requestCount = useCallback((type: "echo/save-all" | "echo/get-dirty") => {
    if (type === "echo/get-dirty" && status !== "ready") {
      if (lastKnownDirtyCount.current !== null) return Promise.resolve(lastKnownDirtyCount.current);
      if (!hasBeenReady.current) return Promise.resolve(0);
      return Promise.reject(new Error("IDE 已断开，无法确认未保存文件"));
    }
    if (status !== "ready" || !baseUrl || !frameRef.current?.contentWindow) {
      return Promise.reject(new Error("IDE 尚未加载完成"));
    }
    const id = crypto.randomUUID();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.current.delete(id);
        reject(new Error("等待 IDE 响应超时"));
      }, 20_000);
      pendingRequests.current.set(id, { resolve, reject, timer });
      frameRef.current?.contentWindow?.postMessage({ type, token, id }, new URL(baseUrl).origin);
    });
  }, [baseUrl, status, token]);

  useImperativeHandle(ref, () => ({
    getDirtyCount: () => requestCount("echo/get-dirty"),
    saveAll: async () => {
      const count = await requestCount("echo/save-all");
      return count === 0;
    },
  }), [requestCount]);

  useEffect(() => () => {
    for (const request of pendingRequests.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("IDE 已关闭"));
    }
    pendingRequests.current.clear();
  }, []);

  useEffect(() => {
    lastKnownDirtyCount.current = null;
    hasBeenReady.current = false;
  }, [root]);

  useEffect(() => {
    for (const request of pendingRequests.current.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("IDE 已重新加载，请重试"));
    }
    pendingRequests.current.clear();
  }, [reloadKey, root]);

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
    onDirtyChange?.(null);
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
    hasVisibleAgentDock.current = false;
  }, [frameUrl, reloadKey]);

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
        hasBeenReady.current = true;
        setStatus("ready");
        (event.source as Window).postMessage({ type: "echo/request-agent-bounds", token }, theiaOrigin);
        return;
      }
      if (message.type === "echo/dirty-state") {
        if (typeof message.count === "number" && Number.isSafeInteger(message.count) && message.count >= 0) {
          lastKnownDirtyCount.current = message.count;
          onDirtyChange?.(message.count);
        }
        return;
      }
      if (message.type === "echo/response" && typeof message.id === "string") {
        const request = pendingRequests.current.get(message.id);
        if (!request) return;
        pendingRequests.current.delete(message.id);
        clearTimeout(request.timer);
        if (message.ok === true && typeof message.value === "number" && Number.isSafeInteger(message.value) && message.value >= 0) {
          lastKnownDirtyCount.current = message.value;
          onDirtyChange?.(message.value);
          request.resolve(message.value);
        }
        else request.reject(new Error(typeof message.error === "string" ? message.error : "IDE 保存失败"));
        return;
      }
      if (message.type === "echo/agent-bounds") {
        const bounds = message.bounds;
        if (bounds === null) {
          onAgentBounds?.(null);
          // Theia emits an empty measurement before its right dock finishes
          // opening. Only a previously visible dock can be user-collapsed.
          if (hasVisibleAgentDock.current) onAgentVisibilityChange?.(false);
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
            hasVisibleAgentDock.current = true;
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
            onDirtyChange?.(null);
            setStatus("loading");
            setReloadKey((value) => value + 1);
          }
        }
        return;
      }
      if (message.type === "echo/active-file") {
        onActiveFile?.(typeof message.path === "string" && belongsToWorkspace(root, message.path) ? message.path : null);
        return;
      }
      if (message.type === "echo/active-symbol") {
        onActiveSymbol?.(
          typeof message.path === "string"
          && belongsToWorkspace(root, message.path)
          && typeof message.symbol === "string"
          && /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/.test(message.symbol)
            ? { path: message.path, symbol: message.symbol }
            : null,
        );
        return;
      }
      if (message.type === "echo/preview-url") {
        if (typeof message.url !== "string") return;
        try {
          const url = new URL(message.url);
          if ((url.protocol === "http:" || url.protocol === "https:")
              && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
            onPreviewUrl?.(url.toString());
          }
        } catch {
          // Ignore terminal text that is not a valid local preview URL.
        }
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
        const paths = message.paths;
        if (!Array.isArray(paths) || paths.length === 0 || !paths.every(
          (path): path is string => typeof path === "string" && belongsToWorkspace(root, path),
        )) {
          respond(false, undefined, "只能修改当前项目内的文件；跨项目移动请在项目外单独处理");
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
  }, [baseUrl, onActiveFile, onActiveSymbol, onPreviewUrl, onAfterMutation, onAgentBounds, onAgentVisibilityChange, onBeforeMutation, onDirtyChange, onToast, root, token]);

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
});
