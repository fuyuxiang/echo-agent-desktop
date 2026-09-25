import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";

import { beginAgentTurn } from "@/lib/agent-turn";
import { agentLoadSession } from "@/lib/agent-client";
import { useSessionStore } from "@/stores/session-store";
import type { SessionTranscript } from "@/stores/session-store";
import { usePermissionStore } from "@/stores/permission-store";
import { useQuestionStore } from "@/stores/question-store";

import { useTaskStore } from "../store/task-store";
import { isBusyPhase } from "./phase";
import { useTaskLifecycle } from "./task-lifecycle";
import { codingApi, onPhaseChanged } from "./tauri-api";
import type { CodingTask, Problem } from "./types";
import {
  buildNodeContinuationInstruction,
  buildPlanRevisionInstruction,
  mergeTaskVerificationCommands,
} from "./workflow";

interface TrackedTask { root: string; taskId: string }
interface RuntimeState {
  tasks: Record<string, TrackedTask>;
  settling: Record<string, boolean>;
  activeRunIds: Record<string, string>;
  track: (root: string, taskId: string) => void;
  untrack: (root: string, taskId: string) => void;
  setSettling: (root: string, taskId: string, value: boolean) => void;
  setActiveRunId: (root: string, taskId: string, runId: string | null) => void;
}

export function codingRuntimeKey(root: string, taskId: string): string {
  return JSON.stringify([root, taskId]);
}

export const useCodingRuntimeStore = create<RuntimeState>((set) => ({
  tasks: {},
  settling: {},
  activeRunIds: {},
  track: (root, taskId) => set((state) => {
    const key = codingRuntimeKey(root, taskId);
    return state.tasks[key] ? state : { tasks: { ...state.tasks, [key]: { root, taskId } } };
  }),
  untrack: (root, taskId) => set((state) => {
    const key = codingRuntimeKey(root, taskId);
    if (!state.tasks[key]) return state;
    const tasks = { ...state.tasks };
    delete tasks[key];
    return { tasks };
  }),
  setSettling: (root, taskId, value) => set((state) => ({
    settling: { ...state.settling, [codingRuntimeKey(root, taskId)]: value },
  })),
  setActiveRunId: (root, taskId, runId) => set((state) => {
    const activeRunIds = { ...state.activeRunIds };
    const key = codingRuntimeKey(root, taskId);
    if (runId) activeRunIds[key] = runId;
    else delete activeRunIds[key];
    return { activeRunIds };
  }),
}));

function repairInstruction(problems: Problem[]): string {
  const documentation = problems.some((problem) => problem.kind === "documentation");
  const details = problems.length > 0
    ? problems.map((problem, index) =>
      `${index + 1}. [${problem.kind}] ${problem.file ?? "未知文件"}${problem.line ? `:${problem.line}` : ""} — ${problem.message}`,
    ).join("\n")
    : "验证未通过，请检查验证命令的真实输出。";
  let instruction = "上一轮验证未通过。检查真实命令输出，修复问题并重新验证；保留现有正确功能。";
  if (documentation) {
    const messages = problems.map((problem) => problem.message).join("\n");
    if (messages.includes("只读代码解释任务")) {
      instruction = "这是只读代码解释任务。撤销本轮产生的文件变更，保留对话中的证据化分析。";
    } else if (messages.includes("未产生任何文件变更")) {
      instruction = "把用户要求的注释或文档写入工程，不要只在对话里给出示例。";
    } else if (messages.includes("变更集中没有")) {
      instruction = "核对原始需求，补齐缺失的注释或文档产物，保持可执行逻辑不变。";
    } else {
      instruction = "修复注释安全检查发现的越界修改，仅保留要求的注释和文档变更。";
    }
  }
  return `${instruction}\n\n${details}`;
}

async function recoverInterruptedRound(root: string, task: CodingTask, transcript: SessionTranscript): Promise<void> {
  if (task.nextAction || !["discovering", "implementing"].includes(task.phase) || transcript.streamingMessageId) return;
  // A replayed completion may belong to an earlier node, not this unfinished round.
  await codingApi.syncChanges(root, task.id);
  await codingApi.reportInterrupted(root, task.id, "paused");
}

function CodingTaskRuntime({ root, taskId }: TrackedTask) {
  const [task, setTask] = useState<CodingTask | null>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [restoring, setRestoring] = useState(false);
  const refreshGeneration = useRef(0);
  const verificationKey = useRef<string | null>(null);
  const followupKey = useRef<string | null>(null);
  const repairKey = useRef<string | null>(null);
  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const result = await codingApi.orchestratorState(root, taskId);
    if (generation !== refreshGeneration.current) return;
    setTask(result.task);
    setProblems(result.problems);
    const selected = useTaskStore.getState();
    if (selected.root === root && selected.task?.id === taskId) {
      await selected.refreshTaskState();
      await selected.refreshSummaries();
    }
  }, [root, taskId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onPhaseChanged((event) => {
      if (!disposed && event.root === root && event.taskId === taskId) {
        void refresh().catch(() => undefined);
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; unlisten?.(); refreshGeneration.current += 1; };
  }, [refresh, root, taskId]);

  const { settling } = useTaskLifecycle(root, restoring ? null : task, refresh);
  useEffect(() => {
    useCodingRuntimeStore.getState().setSettling(root, taskId, settling);
    return () => useCodingRuntimeStore.getState().setSettling(root, taskId, false);
  }, [root, settling, taskId]);

  const sessionId = task?.sessionId;
  const transcript = useSessionStore((state) => sessionId ? state.transcripts[sessionId] : undefined);
  const streaming = Boolean(transcript?.streamingMessageId);
  const awaitingPermission = usePermissionStore((state) => sessionId ? (state.queues[sessionId]?.length ?? 0) > 0 : false);
  const awaitingQuestion = useQuestionStore((state) => sessionId ? (state.queues[sessionId]?.length ?? 0) > 0 : false);
  const restoredSession = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId || useSessionStore.getState().transcripts[sessionId] || restoredSession.current === sessionId) return;
    restoredSession.current = sessionId;
    let disposed = false;
    setRestoring(true);
    void agentLoadSession(sessionId, root)
      .then(async () => {
        const store = useSessionStore.getState();
        if (!store.transcripts[sessionId]) {
          throw new Error("会话历史未能载入");
        }
        store.finalizeIncompleteReplay(sessionId);
        const latest = await codingApi.orchestratorState(root, taskId);
        const loadedTranscript = useSessionStore.getState().transcripts[sessionId];
        if (loadedTranscript) await recoverInterruptedRound(root, latest.task, loadedTranscript);
        await refresh();
      })
      .catch(async (error) => {
        await codingApi.reportStartFailed(root, taskId, `无法恢复任务会话：${String(error).replace(/^Error:\s*/, "")}`).catch(() => undefined);
        await refresh().catch(() => undefined);
      })
      .finally(() => { if (!disposed) setRestoring(false); });
    return () => { disposed = true; };
  }, [refresh, root, sessionId, taskId]);

  useEffect(() => {
    if (!task || task.phase !== "verifying" || settling) return;
    const key = `${root}:${taskId}:${task.updatedAt}`;
    if (verificationKey.current === key) return;
    verificationKey.current = key;
    void (async () => {
      try {
        const detected = await codingApi.detectCommands(root);
        const commands = mergeTaskVerificationCommands(detected, task);
        // Plan-declared commands require the foreground confirmation dialog.
        if (commands.some((command) => command.requiresApproval)) return;
        const started = await codingApi.beginVerification(root, taskId);
        verificationKey.current = `${root}:${taskId}:${started.updatedAt}`;
        await refresh();
        for (const command of commands) {
          const runId = crypto.randomUUID();
          useCodingRuntimeStore.getState().setActiveRunId(root, taskId, runId);
          const record = await codingApi.runVerification(root, taskId, command.kind, command.command, undefined, runId);
          useCodingRuntimeStore.getState().setActiveRunId(root, taskId, null);
          if (record.status === "cancelled") return;
          if (record.status !== "passed") break;
        }
        await codingApi.reportVerification(root, taskId);
        await refresh();
      } catch (error) {
        await codingApi.reportStartFailed(root, taskId, `自动验证未能完成：${String(error).replace(/^Error:\s*/, "")}`).catch(() => undefined);
        await refresh().catch(() => undefined);
      } finally {
        useCodingRuntimeStore.getState().setActiveRunId(root, taskId, null);
      }
    })();
  }, [refresh, root, settling, task, taskId]);

  useEffect(() => {
    if (!task?.nextAction || !sessionId || !transcript || restoring || streaming || settling || awaitingPermission || awaitingQuestion) return;
    const key = `${task.id}:${task.updatedAt}:${task.nextAction}`;
    if (followupKey.current === key) return;
    const activeNode = task.taskNodes.find((node) => node.status === "running");
    if (task.nextAction === "continue_node" && !activeNode) {
      followupKey.current = key;
      void codingApi.reportStartFailed(root, taskId, "调度器要求继续执行，但没有运行中的节点").then(refresh);
      return;
    }
    followupKey.current = key;
    const text = task.nextAction === "revise_plan"
      ? "正在修订执行计划" : `继续执行 ${activeNode?.planKey ?? "下一节点"}`;
    const prompt = task.nextAction === "revise_plan"
      ? buildPlanRevisionInstruction(task) : buildNodeContinuationInstruction(task, activeNode!);
    if (!beginAgentTurn({ sessionId, promptText: prompt, displayText: text, allowBackgroundSession: true })) {
      void codingApi.reportStartFailed(root, taskId, "Agent 未能接收自动续跑指令").then(refresh);
    }
  }, [awaitingPermission, awaitingQuestion, refresh, restoring, root, sessionId, settling, streaming, task, taskId, transcript]);

  useEffect(() => {
    if (task?.phase !== "repairing" || !sessionId || !transcript || restoring || streaming || settling || awaitingPermission || awaitingQuestion) return;
    const key = `${task.id}:${task.updatedAt}`;
    if (repairKey.current === key) return;
    repairKey.current = key;
    const prompt = repairInstruction(problems);
    if (!beginAgentTurn({ sessionId, promptText: prompt, displayText: prompt, allowBackgroundSession: true })) {
      void codingApi.reportStartFailed(root, taskId, "Agent 未能接收修复指令").then(refresh);
    }
  }, [awaitingPermission, awaitingQuestion, problems, refresh, restoring, root, sessionId, settling, streaming, task, taskId, transcript]);

  return null;
}

export function CodingTaskRuntimeManager({ roots }: { roots: string[] }) {
  const tracked = useCodingRuntimeStore((state) => state.tasks);
  const tasks = useMemo(() => Object.values(tracked), [tracked]);
  const rootsKey = roots.join("\0");
  useEffect(() => {
    let disposed = false;
    const scan = async () => {
      for (const root of roots) {
        const summaries = await codingApi.listTasks(root).catch(() => []);
        if (disposed) return;
        for (const summary of summaries) {
          if (isBusyPhase(summary.phase)) useCodingRuntimeStore.getState().track(root, summary.id);
        }
      }
    };
    void scan();
    const timer = window.setInterval(() => void scan(), 15_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [rootsKey]);

  return <>{tasks.map((entry) => <CodingTaskRuntime key={codingRuntimeKey(entry.root, entry.taskId)} {...entry} />)}</>;
}
