import { useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";
import { codingApi, onWorkspaceFileRemoved, onWorkspaceFileUpdated } from "../lib/tauri-api";
import { useTaskStore } from "../store/task-store";
import type { TheiaMutationTicket } from "../TheiaIdeFrame";

/** Apply task phase rules to manual edits and reconcile external disk changes. */
export function useCodingMutationLifecycle(
  cwd: string,
  onToast: ((message: string) => void) | undefined,
  setReportRevision: Dispatch<SetStateAction<number>>,
) {
  const taskId = useTaskStore((state) => state.task?.id);
  const taskSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const prepareManualMutation = useCallback(async (): Promise<TheiaMutationTicket | null> => {
    const activeTask = useTaskStore.getState().task;
    if (!activeTask) return { taskId: null, closeRound: false };
    if (["discovering", "implementing", "repairing"].includes(activeTask.phase)) {
      return { taskId: activeTask.id, closeRound: false };
    }
    if (["paused", "stopped", "blocked", "delivered"].includes(activeTask.phase)) {
      try {
        await codingApi.beginFollowup(cwd, activeTask.id, "用户在编辑器中继续修改工程文件");
        await useTaskStore.getState().refreshTaskState();
        return { taskId: activeTask.id, closeRound: true };
      } catch (error) {
        onToast?.(`当前任务不能继续编辑：${String(error).replace(/^Error:\s*/, "")}`);
        return null;
      }
    }
    onToast?.(activeTask.phase === "verifying"
      ? "正在验证当前改动，请等待验证结束后再编辑"
      : "当前任务阶段不能修改文件");
    return null;
  }, [cwd, onToast]);

  const finishManualMutation = useCallback(async (ticket: TheiaMutationTicket) => {
    if (!ticket.taskId) return;
    await codingApi.syncChanges(cwd, ticket.taskId);
    if (ticket.closeRound) await codingApi.reportImplementation(cwd, ticket.taskId);
    await useTaskStore.getState().refreshTaskState();
  }, [cwd]);

  const blockInterruptedManualMutation = useCallback(async (ticket: TheiaMutationTicket, reason: string) => {
    if (!ticket.taskId || !ticket.closeRound) return;
    await codingApi.reportStartFailed(cwd, ticket.taskId, reason).catch(() => undefined);
    await useTaskStore.getState().refreshTaskState().catch(() => undefined);
  }, [cwd]);

  const queueTaskChangeSync = useCallback(() => {
    const currentTaskId = useTaskStore.getState().task?.id;
    if (!cwd || !currentTaskId) return;
    if (taskSyncTimerRef.current !== null) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = setTimeout(() => {
      taskSyncTimerRef.current = null;
      if (useTaskStore.getState().root !== cwd || useTaskStore.getState().task?.id !== currentTaskId) return;
      void codingApi.syncChanges(cwd, currentTaskId)
        .then(() => {
          if (useTaskStore.getState().root !== cwd || useTaskStore.getState().task?.id !== currentTaskId) return;
          return useTaskStore.getState().refreshTaskState();
        })
        .then(() => {
          if (useTaskStore.getState().root === cwd && useTaskStore.getState().task?.id === currentTaskId) {
            setReportRevision((value) => value + 1);
          }
        })
        .catch((error) => onToast?.(`同步任务变更失败：${String(error).replace(/^Error:\s*/, "")}`));
    }, 300);
  }, [cwd, onToast, setReportRevision]);

  useEffect(() => () => {
    if (taskSyncTimerRef.current !== null) clearTimeout(taskSyncTimerRef.current);
    taskSyncTimerRef.current = null;
  }, [cwd, taskId]);

  useEffect(() => {
    if (!cwd) return;
    let disposed = false;
    const unlisteners: Array<() => void> = [];
    void onWorkspaceFileUpdated((event) => {
      if (!disposed && event.root === cwd) queueTaskChangeSync();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    void onWorkspaceFileRemoved((event) => {
      if (!disposed && event.root === cwd) queueTaskChangeSync();
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    });
    return () => {
      disposed = true;
      for (const unlisten of unlisteners) unlisten();
    };
  }, [cwd, queueTaskChangeSync]);

  return { prepareManualMutation, finishManualMutation, blockInterruptedManualMutation };
}
