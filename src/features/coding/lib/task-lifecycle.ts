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
 * 1. The task moves to Implementing → capture a baseline so the user's
 *    pre-existing dirty files are protected from rollback.
 * 2. Streaming finishes while the task is in Implementing → sync the live
 *    Git state into the ChangeSet and tell the orchestrator the round is
 *    done so it can move to Verifying.
 * 3. Every phase event the orchestrator emits is already mirrored into the
 *    task store (this is wired in the workbench shell).
 *
 * Parsing tool calls to figure out what the Agent did is exactly the kind of
 * fragile inference the old implementation got wrong; Git is the source of
 * truth and the renderer only reacts to it.
 */
export function useTaskLifecycle(cwd: string | undefined) {
  const taskId = useTaskStore((state) => state.task?.id);
  const taskPhase = useTaskStore((state) => state.task?.phase);
  const streaming = useSessionStore((state) => state.streaming);
  const lastStreamingRef = useRef(streaming);

  // Move 1: capture the baseline once, the first time we enter Implementing.
  useEffect(() => {
    if (!cwd || !taskId || taskPhase !== "implementing") return;
    void codingApi.getChangeSet(cwd, taskId).then((set) => {
      // Only record when the baseline was not already taken, otherwise we
      // would re-protect files the Agent has since written on top of.
      if (set.baselineFiles.length > 0) return;
      return codingApi
        .captureBaseline(cwd, taskId, set.changes.map((change) => change.path))
        .catch(() => undefined);
    });
  }, [cwd, taskId, taskPhase]);

  // Move 2: when streaming falls to false while we are in Implementing, the
  // Agent just finished a round. Sync Git into the ChangeSet and tell the
  // orchestrator.
  useEffect(() => {
    if (lastStreamingRef.current === streaming) return;
    lastStreamingRef.current = streaming;
    if (streaming || !cwd || !taskId || taskPhase !== "implementing") return;
    void (async () => {
      try {
        await codingApi.syncFromGit(cwd, taskId);
      } catch {
        // The orchestrator's next verdict will surface the failure through
        // its own phase event; nothing to do here.
      }
      try {
        await codingApi.reportImplementation(cwd, taskId);
        await useTaskStore.getState().refreshTaskState();
      } catch {
        // Same as above; the orchestrator already has the data on disk.
      }
    })();
  }, [cwd, streaming, taskId, taskPhase]);
}