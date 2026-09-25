import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CodingTask } from "../lib/types";

const api = vi.hoisted(() => ({
  listTasks: vi.fn(),
  orchestratorState: vi.fn(),
  syncChanges: vi.fn(),
  reportInterrupted: vi.fn(),
  reportStartFailed: vi.fn(),
}));
const beginAgentTurn = vi.hoisted(() => vi.fn(() => true));
const agentLoadSession = vi.hoisted(() => vi.fn(async (_id: string, _root: string): Promise<string | null> => null));

vi.mock("../lib/tauri-api", () => ({
  codingApi: api,
  onPhaseChanged: vi.fn(async () => () => undefined),
}));
vi.mock("../lib/task-lifecycle", () => ({
  useTaskLifecycle: () => ({ settling: false }),
}));
vi.mock("@/lib/agent-turn", () => ({ beginAgentTurn }));
vi.mock("@/lib/agent-client", () => ({ agentLoadSession }));

import { useSessionStore } from "@/stores/session-store";
import { CodingTaskRuntimeManager, useCodingRuntimeStore } from "../lib/coding-task-runtime";

function task(root: string): CodingTask {
  return {
    schemaVersion: 2,
    id: `${root}-task`,
    name: "后台开发",
    requirement: "修复任务",
    phase: "discovering",
    acceptanceCriteria: [],
    taskNodes: [],
    planIssues: [],
    globalConstraints: [],
    nextAction: "revise_plan",
    sessionId: `${root}-session`,
    createdAt: "2026-09-24T00:00:00Z",
    updatedAt: "2026-09-24T00:00:01Z",
  };
}

const transcript = {
  messages: [],
  streamingMessageId: null,
  pendingSendNowPromptId: null,
  usage: {},
  plan: null,
  planMode: false,
  planApprovals: [],
  suppressReplay: false,
  dismissedControlPromptIds: [],
};

describe("CodingTaskRuntimeManager", () => {
  beforeEach(() => {
    api.listTasks.mockReset();
    api.orchestratorState.mockReset();
    api.syncChanges.mockReset();
    api.reportInterrupted.mockReset();
    api.reportStartFailed.mockReset();
    beginAgentTurn.mockClear();
    agentLoadSession.mockReset();
    agentLoadSession.mockResolvedValue(null);
    useCodingRuntimeStore.setState({ tasks: {}, settling: {}, activeRunIds: {} });
    useSessionStore.setState({
      sessionId: "/other-session",
      transcripts: {
        "/a-session": { ...transcript },
        "/b-session": { ...transcript },
      },
    });
    api.listTasks.mockImplementation(async (root: string) => [{ id: `${root}-task`, phase: "discovering" }]);
    api.orchestratorState.mockImplementation(async (root: string) => ({ task: task(root), problems: [] }));
    api.syncChanges.mockResolvedValue(undefined);
    api.reportInterrupted.mockResolvedValue(undefined);
    api.reportStartFailed.mockResolvedValue(undefined);
  });

  it("continues tasks in both projects without changing the focused session", async () => {
    render(<CodingTaskRuntimeManager roots={["/a", "/b"]} />);
    await waitFor(() => expect(beginAgentTurn).toHaveBeenCalledTimes(2));
    expect(beginAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "/a-session", allowBackgroundSession: true,
    }));
    expect(beginAgentTurn).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "/b-session", allowBackgroundSession: true,
    }));
    expect(useSessionStore.getState().sessionId).toBe("/other-session");
  });

  it("restores an unloaded task session before continuing its persisted action", async () => {
    useSessionStore.setState({ transcripts: {} });
    agentLoadSession.mockImplementation(async (sessionId: string) => {
      useSessionStore.setState({ transcripts: { [sessionId]: { ...transcript } } });
      return null;
    });
    render(<CodingTaskRuntimeManager roots={["/a"]} />);
    await waitFor(() => expect(agentLoadSession).toHaveBeenCalledWith("/a-session", "/a"));
    await waitFor(() => expect(beginAgentTurn).toHaveBeenCalledTimes(1));
  });

  it("pauses an orphaned in-flight round without claiming its last replayed turn completed it", async () => {
    useSessionStore.setState({ transcripts: {} });
    agentLoadSession.mockImplementation(async (sessionId: string) => {
      useSessionStore.setState({ transcripts: { [sessionId]: { ...transcript } } });
      return null;
    });
    api.orchestratorState.mockImplementation(async (root: string) => ({
      task: { ...task(root), nextAction: null, phase: "implementing" }, problems: [],
    }));
    render(<CodingTaskRuntimeManager roots={["/a"]} />);
    await waitFor(() => expect(api.reportInterrupted).toHaveBeenCalledWith("/a", "/a-task", "paused"));
    expect(api.syncChanges).toHaveBeenCalledWith("/a", "/a-task");
    expect(beginAgentTurn).not.toHaveBeenCalled();
  });
});
