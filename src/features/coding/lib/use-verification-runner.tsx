import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { ConfirmationOptions } from "@/components/AppDialog";

import { useTaskStore } from "../store/task-store";
import { codingApi } from "./tauri-api";
import type { CodingTask, DetectedCommand } from "./types";

interface VerificationRunnerOptions {
  cwd: string;
  task: CodingTask | null;
  commands: DetectedCommand[];
  detectedReady: boolean;
  setBottomView: (view: "output") => void;
  setCommandOutput: Dispatch<SetStateAction<string>>;
  requestConfirmation: (options: ConfirmationOptions) => void;
  onToast?: (message: string) => void;
}

/**
 * Owns verification consent, process lifecycle and automatic phase handling.
 * Keeping this state machine outside the workbench prevents navigation and
 * editor rendering concerns from becoming coupled to command execution.
 */
export function useVerificationRunner({
  cwd,
  task,
  commands,
  detectedReady,
  setBottomView,
  setCommandOutput,
  requestConfirmation,
  onToast,
}: VerificationRunnerOptions) {
  const [runningVerification, setRunningVerification] = useState(false);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const autoVerificationRef = useRef<string | null>(null);

  const executeVerifications = useCallback(
    async (batch: DetectedCommand[]) => {
      if (!cwd || !task || runningVerification) return;
      const taskId = task.id;
      if (!["verifying", "paused", "stopped", "blocked", "delivered"].includes(task.phase)) {
        onToast?.("当前任务正在执行，暂不能启动新的验证批次");
        return;
      }
      setRunningVerification(true);
      try {
        const startedTask = await codingApi.beginVerification(cwd, taskId);
        autoVerificationRef.current = `${cwd}:${taskId}:${startedTask.updatedAt}`;
        await useTaskStore.getState().refreshTaskState();
      } catch (error) {
        onToast?.(`无法启动验证：${String(error).replace(/^Error:\s*/, "")}`);
        setRunningVerification(false);
        return;
      }
      setCommandOutput("");
      if (batch.length > 0) setBottomView("output");
      let mayReport = batch.length === 0;
      try {
        for (const command of batch) {
          const runId = crypto.randomUUID();
          activeRunIdRef.current = runId;
          setActiveRunId(runId);
          try {
            const approvalToken = command.requiresApproval
              ? await codingApi.approvePlanCommand(cwd, taskId, command.command)
              : undefined;
            const record = await codingApi.runVerification(
              cwd,
              taskId,
              command.kind,
              command.command,
              undefined,
              runId,
              approvalToken,
            );
            mayReport = record.status !== "cancelled";
            if (record.status !== "passed") break;
          } catch (error) {
            const detail = String(error).replace(/^Error:\s*/, "");
            onToast?.(`执行 ${command.command} 失败：${detail}`);
            await codingApi.reportStartFailed(
              cwd,
              taskId,
              `验证命令“${command.command}”未能执行：${detail}`,
            ).catch(() => undefined);
            await useTaskStore.getState().refreshTaskState().catch(() => undefined);
            mayReport = false;
            break;
          }
        }
        if (mayReport) {
          await codingApi.reportVerification(cwd, taskId);
          await useTaskStore.getState().refreshTaskState();
        }
      } catch (error) {
        const detail = String(error).replace(/^Error:\s*/, "");
        onToast?.(`无法更新验证结果：${detail}`);
        await codingApi.reportStartFailed(
          cwd,
          taskId,
          `无法收敛本轮验证结果：${detail}`,
        ).catch(() => undefined);
        await useTaskStore.getState().refreshTaskState().catch(() => undefined);
      } finally {
        activeRunIdRef.current = null;
        setActiveRunId(null);
        setRunningVerification(false);
      }
    },
    [cwd, onToast, runningVerification, setBottomView, setCommandOutput, task],
  );

  const runVerifications = useCallback((batch: DetectedCommand[]) => {
    const planCommands = batch.filter((command) => command.requiresApproval);
    if (planCommands.length === 0) {
      void executeVerifications(batch);
      return;
    }
    requestConfirmation({
      title: "确认运行计划中的验证命令",
      description: (
        <div>
          <p>以下命令由 Agent 执行计划声明，其中可能与工程清单命令重合：</p>
          <ul>
            {planCommands.map((command) => (
              <li key={command.command}><code>{command.command}</code></li>
            ))}
          </ul>
          <p>命令将在当前工作区运行。请仅在确认命令内容可信后继续。</p>
        </div>
      ),
      confirmLabel: "确认并运行",
      danger: true,
      action: () => executeVerifications(batch),
      onError: (error) => onToast?.(`验证失败：${String(error).replace(/^Error:\s*/, "")}`),
    });
  }, [executeVerifications, onToast, requestConfirmation]);

  useEffect(() => {
    if (task?.phase !== "verifying") {
      autoVerificationRef.current = null;
      return;
    }
    if (!detectedReady || runningVerification) return;
    const key = `${cwd}:${task.id}:${task.updatedAt}`;
    if (autoVerificationRef.current === key) return;
    autoVerificationRef.current = key;
    runVerifications(commands);
  }, [commands, cwd, detectedReady, runVerifications, runningVerification, task]);

  return {
    activeRunId,
    activeRunIdRef,
    runningVerification,
    runVerifications,
  };
}
