import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, LoaderCircle } from "lucide-react";

import type { ChatMessage } from "@/stores/session-store";

import type { BottomView } from "../store/workbench-store";
import type { DetectedCommand, Problem, VerificationRecord } from "../lib/types";
import { CodingTerminal } from "./CodingTerminal";
import { ProblemsView } from "./ProblemsView";
import { VerificationView } from "./VerificationView";

interface BottomPanelProps {
  root: string;
  view: BottomView;
  onViewChange: (view: BottomView) => void;
  onCollapse: () => void;
  onResize: (height: number) => void;
  height: number;
  problems: Problem[];
  records: VerificationRecord[];
  detected: DetectedCommand[];
  running: boolean;
  hasTask: boolean;
  /** Live output of the command currently running. */
  output: string;
  messages: ChatMessage[];
  terminalActivated: boolean;
  onActivateTerminal: () => void;
  onOpenProblem: (problem: Problem) => void;
  onRun: (command: DetectedCommand) => void;
  onRunAll: () => void;
  onToast?: (message: string) => void;
}

const TABS: Array<{ id: BottomView; label: string }> = [
  { id: "problems", label: "问题" },
  { id: "tests", label: "验证" },
  { id: "output", label: "输出" },
  { id: "terminal", label: "终端" },
  { id: "trace", label: "轨迹" },
];

/** Tool calls the Agent made, newest last. */
function TraceView({ messages }: { messages: ChatMessage[] }) {
  const calls = messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.kind === "tool_call" ? [{ ...part.toolCall, startedAt: message.startedAt }] : [],
    ),
  );
  if (calls.length === 0) {
    return <div className="coding-panel__empty">Agent 尚未调用工具</div>;
  }
  return (
    <div className="coding-panel__list">
      {calls.map((call, index) => (
        <div key={`${call.toolCallId}:${index}`} className={`coding-trace is-${call.status}`}>
          {call.status === "completed" ? (
            <CheckCircle2 size={12} />
          ) : call.status === "failed" ? (
            <AlertTriangle size={12} />
          ) : (
            <LoaderCircle size={12} className="is-spinning" />
          )}
          <b>{index + 1}</b>
          <span>{call.title}</span>
          <code>{call.kind}</code>
          <small>{call.startedAt ? new Date(call.startedAt).toLocaleTimeString() : ""}</small>
        </div>
      ))}
    </div>
  );
}

/**
 * Bottom dock. Collapsed by default so the workbench stays quiet; each tab is a
 * destination the status bar and command palette can open directly.
 *
 * The terminal is mounted once activated and then kept alive across tab switches,
 * because a PTY session must not be dropped just because the user looked at test
 * results.
 */
export function BottomPanel({
  root,
  view,
  onViewChange,
  onCollapse,
  onResize,
  height,
  problems,
  records,
  detected,
  running,
  hasTask,
  output,
  messages,
  terminalActivated,
  onActivateTerminal,
  onOpenProblem,
  onRun,
  onRunAll,
  onToast,
}: BottomPanelProps) {
  const outputRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => {
    if (view === "output" && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output, view]);

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const move = (moveEvent: PointerEvent) => {
      onResize(window.innerHeight - moveEvent.clientY);
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  };

  return (
    <section className="coding-bottom" style={{ height }}>
      <div
        className="coding-bottom__resizer"
        role="separator"
        aria-orientation="horizontal"
        aria-label="调整开发工具面板高度"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp") onResize(height + 16);
          if (event.key === "ArrowDown") onResize(height - 16);
        }}
      />
      <div className="coding-bottom__tabs" role="tablist" aria-label="开发工具面板">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            className={view === tab.id ? "is-active" : ""}
            onClick={() => {
              if (tab.id === "terminal") onActivateTerminal();
              onViewChange(tab.id);
            }}
          >
            {tab.label}
            {tab.id === "problems" && problems.length > 0 && <b>{problems.length}</b>}
            {tab.id === "tests" && records.length > 0 && <b>{records.length}</b>}
          </button>
        ))}
        <button
          type="button"
          className="coding-bottom__collapse"
          onClick={onCollapse}
          aria-label="收起面板"
        >
          <ChevronDown size={14} />
        </button>
      </div>

      <div className="coding-bottom__body">
        {view === "problems" && (
          <ProblemsView problems={problems} onOpenProblem={onOpenProblem} />
        )}
        {view === "tests" && (
          <VerificationView
            records={records}
            detected={detected}
            running={running}
            hasTask={hasTask}
            onRun={onRun}
            onRunAll={onRunAll}
            onOpenOutput={() => onViewChange("output")}
          />
        )}
        {view === "output" && (
          <pre className="coding-bottom__output" ref={outputRef}>
            {output || "尚无命令输出。"}
          </pre>
        )}
        {view === "trace" && <TraceView messages={messages} />}

        {/* Kept mounted once activated so the PTY survives tab switches. */}
        {terminalActivated && (
          <div className="coding-bottom__terminal" hidden={view !== "terminal"}>
            <CodingTerminal root={root} onToast={onToast} />
          </div>
        )}
      </div>
    </section>
  );
}
