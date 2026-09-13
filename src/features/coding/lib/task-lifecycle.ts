import { useEffect, useRef } from "react";

import { useSessionStore } from "@/stores/session-store";

import { codingApi } from "./tauri-api";
import { parseRuntimePlan, runtimePlanFingerprint } from "./workflow-plan";
import { useTaskStore } from "../store/task-store";

/**
 * Bridge between Agent session events and the orchestrator's ChangeSet.
 *
 * Three events matter for the workbench, and all three are driven by the
 * shared session store rather than by parsing tool calls:
 *
 * 1. ACP plan updates are parsed into the persisted execution DAG while the
 *    Agent is working, so progress survives reloads and context compaction.
 * 2. Streaming finishes while the task is Discovering, Implementing or
 *    Repairing → synchronize the final plan and workspace state before the
 *    orchestrator decides whether implementation is complete.
 * 3. Every phase event the orchestrator emits is already mirrored into the
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
  const runtimePlan = useSessionStore((state) =>
    taskSessionId ? state.transcripts[taskSessionId]?.plan ?? null : null,
  );
  const planFingerprint = runtimePlanFingerprint(runtimePlan);
  const lastStreamingRef = useRef(streaming);
  const lastPlanFingerprintRef = useRef("");

  // A different task/session is a different stream edge detector.
  useEffect(() => {
    lastStreamingRef.current = streaming;
    lastPlanFingerprintRef.current = "";
  }, [taskId, taskSessionId]);

  useEffect(() => {
    if (
      !cwd
      || !taskId
      || !taskSessionId
      || !runtimePlan
      || runtimePlan.entries.length === 0
      || !["discovering", "implementing", "repairing"].includes(taskPhase ?? "")
      || planFingerprint === lastPlanFingerprintRef.current
    ) return;
    lastPlanFingerprintRef.current = planFingerprint;
    void codingApi
      .syncPlan(cwd, taskId, parseRuntimePlan(runtimePlan))
      .then(() => useTaskStore.getState().refreshTaskState())
      .catch(async (error) => {
        lastPlanFingerprintRef.current = "";
        await codingApi.reportStartFailed(
          cwd,
          taskId,
          `执行计划无法持久化：${String(error).replace(/^Error:\s*/, "")}`,
        ).catch(() => undefined);
        await useTaskStore.getState().refreshTaskState().catch(() => undefined);
      });
  }, [cwd, planFingerprint, runtimePlan, taskId, taskPhase, taskSessionId]);

  // When streaming falls to false, the Agent just finished a managed turn. The
  // native checkpoint is authoritative in every workspace.
  useEffect(() => {
    if (lastStreamingRef.current === streaming) return;
    lastStreamingRef.current = streaming;
    if (
      streaming
      || !cwd
      || !taskId
      || !taskSessionId
      || !["discovering", "implementing", "repairing"].includes(taskPhase ?? "")
    ) return;
    void (async () => {
      try {
        if (runtimePlan?.entries.length) {
          await codingApi.syncPlan(cwd, taskId, parseRuntimePlan(runtimePlan));
        }
        await codingApi.syncChanges(cwd, taskId);
        await codingApi.reportImplementation(cwd, taskId);
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
  }, [cwd, runtimePlan, streaming, taskId, taskPhase, taskSessionId]);
}
