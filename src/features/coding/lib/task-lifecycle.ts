import { useEffect, useRef } from "react";

import { useSessionStore } from "@/stores/session-store";

import { codingApi } from "./tauri-api";
import { useTaskStore } from "../store/task-store";

/**
 * Bridge between Agent session events and the orchestrator's ChangeSet.
 *
 * Three events matter for the workbench, and all three are driven by the
 * shared session store rather than by parsing tool calls:
 *
 * 1. Streaming finishes while the task is Analyzing, Implementing or Repairing
 *    → sync the live workspace state into the ChangeSet. Ask completes as a
 *    read-only answer; implementation rounds move to Verifying.
 * 2. Every phase event the orchestrator emits is already mirrored into the
 *    task store (this is wired in the workbench shell).
 *
 * Parsing tool calls to figure out what the Agent did is exactly the kind of
 * fragile inference the old implementation got wrong. Git is used when it is
 * available; ordinary folders use an application-owned checkpoint.
 */
export function useTaskLifecycle(cwd: string | undefined) {
  const taskId = useTaskStore((state) => state.task?.id);
  const taskPhase = useTaskStore((state) => state.task?.phase);
  const taskSessionId = useTaskStore((state) => state.task?.sessionId);
  const streaming = useSessionStore((state) =>
    taskSessionId ? Boolean(state.transcripts[taskSessionId]?.streamingMessageId) : false,
  );
  const lastStreamingRef = useRef(streaming);

  // A different task/session is a different stream edge detector.
  useEffect(() => {
    lastStreamingRef.current = streaming;
  }, [taskId, taskSessionId]);

  // When streaming falls to false, the Agent just finished a managed turn. The
  // native checkpoint is authoritative in every workspace, including Ask mode
  // where it proves that the answer did not alter project files.
  useEffect(() => {
    if (lastStreamingRef.current === streaming) return;
    lastStreamingRef.current = streaming;
    if (
      streaming
      || !cwd
      || !taskId
      || !taskSessionId
      || (taskPhase !== "analyzing" && taskPhase !== "implementing" && taskPhase !== "repairing")
    ) return;
    void (async () => {
      try {
        await codingApi.syncChanges(cwd, taskId);
        if (taskPhase === "analyzing") {
          await codingApi.reportAnalysis(cwd, taskId);
        } else {
          await codingApi.reportImplementation(cwd, taskId);
        }
        await useTaskStore.getState().refreshTaskState();
      } catch (error) {
        // Continuing after a failed sync could falsely report a clean task.
        await codingApi
          .reportStartFailed(
            cwd,
            taskId,
            `无法同步 Agent 产生的文件变更：${String(error).replace(/^Error:\s*/, "")}`,
          )
          .catch(() => undefined);
        await useTaskStore.getState().refreshTaskState().catch(() => undefined);
      }
    })();
  }, [cwd, streaming, taskId, taskPhase, taskSessionId]);
}
