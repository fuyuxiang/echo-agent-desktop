import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  agentListPendingInteractions,
  agentListAllSessions,
  agentListSessions,
  agentResolvePlanApproval,
  agentResolveQuestion,
  automationsRun,
  folderTrustRespond,
  setPlanMode,
  taskKill,
  tasksList,
} from "../agent-client";

const invokeMock = vi.mocked(invoke);

describe("agent interaction command contracts", () => {
  beforeEach(() => invokeMock.mockReset());

  it("passes exact typed question and plan outcomes", async () => {
    invokeMock.mockResolvedValue(true);
    await expect(
      agentResolveQuestion("question-1", {
        outcome: "skip_interview",
        partialAnswers: { Question: "Choice" },
      }),
    ).resolves.toBe(true);
    await agentResolvePlanApproval("plan-1", "cancelled", "revise this");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "agent_resolve_question", {
      requestId: "question-1",
      answers: null,
      annotations: null,
      partialAnswers: { Question: "Choice" },
      outcome: "skip_interview",
      cancelled: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "agent_resolve_plan_approval", {
      requestId: "plan-1",
      outcome: "cancelled",
      feedback: "revise this",
    });
  });

  it("uses request identities for trust and pending replay", async () => {
    invokeMock.mockResolvedValueOnce(true).mockResolvedValueOnce({
      permissions: [],
      questions: [],
      planApprovals: [],
      folderTrustRequests: [],
    });
    await folderTrustRespond("trust-1", false);
    await agentListPendingInteractions("session-1");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "folder_trust_respond", {
      requestId: "trust-1",
      trusted: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "agent_list_pending_interactions", {
      sessionId: "session-1",
    });
  });

  it("keeps mode setting idempotent and archived listing opt-in", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setPlanMode("session-1", true);
    await agentListAllSessions(true);
    await agentListSessions("/repo");
    await agentListSessions("/repo", true);

    expect(invokeMock).toHaveBeenNthCalledWith(1, "set_plan_mode", {
      sessionId: "session-1",
      enabled: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "agent_list_all_sessions", {
      includeArchived: true,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "agent_list_sessions", {
      cwd: "/repo",
      includeArchived: false,
    });
    expect(invokeMock).toHaveBeenNthCalledWith(4, "agent_list_sessions", {
      cwd: "/repo",
      includeArchived: true,
    });
  });

  it("returns the durable automation run record id", async () => {
    invokeMock.mockResolvedValue("run-123");
    await expect(automationsRun("automation-1")).resolves.toBe("run-123");
  });

  it("scopes running-task queries and kills to the selected session", async () => {
    invokeMock.mockResolvedValue([]);

    await tasksList("session-1");
    await taskKill("session-1", "task-7", "task");
    await taskKill("session-1", "subagent-8", "subagent");

    expect(invokeMock).toHaveBeenNthCalledWith(1, "tasks_list", {
      sessionId: "session-1",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "task_kill", {
      sessionId: "session-1",
      taskId: "task-7",
      source: "task",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(3, "task_kill", {
      sessionId: "session-1",
      taskId: "subagent-8",
      source: "subagent",
    });
  });
});
