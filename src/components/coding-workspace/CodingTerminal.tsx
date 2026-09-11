import { useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { RefreshCw, TerminalSquare, Trash2 } from "lucide-react";
import {
  codingListenTerminalExit,
  codingListenTerminalOutput,
  codingTerminalClose,
  codingTerminalCreate,
  codingTerminalResize,
  codingTerminalWrite,
  type CodingTerminalEvent,
} from "@/lib/agent-client";

interface CodingTerminalProps {
  root: string;
  onToast?: (message: string) => void;
}

type TerminalStatus = "starting" | "running" | "exited" | "error";

function xtermTheme() {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  return dark
    ? {
        background: "#111418",
        foreground: "#d7dde5",
        cursor: "#80a8ff",
        selectionBackground: "#36548588",
      }
    : {
        background: "#fbfcfe",
        foreground: "#26313f",
        cursor: "#2456a6",
        selectionBackground: "#9ebce788",
      };
}

function decodeTerminalChunk(data: string): Uint8Array {
  const binary = window.atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function CodingTerminal({ root, onToast }: CodingTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalIdRef = useRef<string | null>(null);
  const [generation, setGeneration] = useState(0);
  const [status, setStatus] = useState<TerminalStatus>("starting");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !root) return;

    let disposed = false;
    let createdId: string | null = null;
    let resizeFrame = 0;
    const pendingEvents: CodingTerminalEvent[] = [];
    const pendingExits = new Set<string>();
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: "'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: xtermTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminal.focus();
    setStatus("starting");
    setError(null);

    const writeEvent = (event: CodingTerminalEvent) => {
      if (disposed || !createdId || event.terminalId !== createdId || !event.dataBase64) return;
      try {
        terminal.write(decodeTerminalChunk(event.dataBase64));
      } catch {
        terminal.write("\r\n[EchoAgent] 终端输出解码失败\r\n");
      }
    };
    const markExited = () => {
      if (disposed) return;
      terminal.write("\r\n\x1b[90m[EchoAgent] 终端进程已退出\x1b[0m\r\n");
      setStatus("exited");
    };

    const initialize = async () => {
      let unlistenOutput: (() => void) | undefined;
      let unlistenExit: (() => void) | undefined;
      try {
        [unlistenOutput, unlistenExit] = await Promise.all([
          codingListenTerminalOutput((event) => {
            if (!createdId) {
              pendingEvents.push(event);
              if (pendingEvents.length > 256) pendingEvents.shift();
            }
            else writeEvent(event);
          }),
          codingListenTerminalExit((event) => {
            if (!createdId) pendingExits.add(event.terminalId);
            else if (event.terminalId === createdId) markExited();
          }),
        ]);
        if (disposed) {
          unlistenOutput();
          unlistenExit();
          return;
        }
        try {
          fitAddon.fit();
        } catch {
          // A resize observer below retries once the panel has measurable dimensions.
        }
        const id = await codingTerminalCreate(root, Math.max(20, terminal.cols), Math.max(5, terminal.rows));
        if (disposed) {
          void codingTerminalClose(id).catch(() => undefined);
          return;
        }
        createdId = id;
        terminalIdRef.current = id;
        pendingEvents.splice(0).forEach(writeEvent);
        if (pendingExits.has(id)) markExited();
        else setStatus("running");
        terminal.focus();
      } catch (cause) {
        if (disposed) return;
        const message = String(cause).replace(/^Error:\s*/, "");
        terminal.write(`\r\n\x1b[31m[EchoAgent] 无法启动终端：${message}\x1b[0m\r\n`);
        setError(message);
        setStatus("error");
        onToast?.(`启动交互式终端失败：${message}`);
      }

      return () => {
        unlistenOutput?.();
        unlistenExit?.();
      };
    };

    let removeListeners: (() => void) | undefined;
    void initialize().then((cleanup) => {
      if (disposed) cleanup?.();
      else removeListeners = cleanup;
    });

    const inputSubscription = terminal.onData((data) => {
      const id = terminalIdRef.current;
      if (!id) return;
      void codingTerminalWrite(id, data).catch((cause) => {
        if (!disposed) onToast?.(`终端输入失败：${String(cause).replace(/^Error:\s*/, "")}`);
      });
    });
    const resizeObserver = new ResizeObserver(() => {
      window.cancelAnimationFrame(resizeFrame);
      resizeFrame = window.requestAnimationFrame(() => {
        if (disposed || host.clientWidth < 20 || host.clientHeight < 20) return;
        try {
          fitAddon.fit();
          const id = terminalIdRef.current;
          if (id) void codingTerminalResize(id, terminal.cols, terminal.rows).catch(() => undefined);
        } catch {
          // The terminal can briefly be detached while the bottom panel collapses.
        }
      });
    });
    resizeObserver.observe(host);
    const themeObserver = new MutationObserver(() => {
      terminal.options.theme = xtermTheme();
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      removeListeners?.();
      inputSubscription.dispose();
      resizeObserver.disconnect();
      themeObserver.disconnect();
      window.cancelAnimationFrame(resizeFrame);
      const id = createdId;
      terminalIdRef.current = null;
      terminal.dispose();
      if (id) void codingTerminalClose(id).catch(() => undefined);
    };
  }, [generation, root]);

  const close = async () => {
    const id = terminalIdRef.current;
    if (!id) return;
    terminalIdRef.current = null;
    try {
      await codingTerminalClose(id);
      setStatus("exited");
    } catch (cause) {
      onToast?.(`关闭终端失败：${String(cause).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="coding-interactive-terminal">
      <div className="coding-interactive-terminal__toolbar">
        <span><TerminalSquare size={13} />Shell</span>
        <code title={root}>{root}</code>
        <span className={`is-${status}`}>{status === "starting" ? "启动中" : status === "running" ? "运行中" : status === "exited" ? "已退出" : "启动失败"}</span>
        <button type="button" onClick={() => setGeneration((value) => value + 1)} disabled={status === "starting"} title="重启终端"><RefreshCw size={13} />重启</button>
        <button type="button" onClick={() => void close()} disabled={!terminalIdRef.current || status !== "running"} title="关闭终端"><Trash2 size={13} /></button>
      </div>
      {error && <div className="coding-interactive-terminal__error" role="alert">{error}</div>}
      <div ref={hostRef} className="coding-interactive-terminal__host" aria-label="代码工作台交互式终端" />
    </div>
  );
}
