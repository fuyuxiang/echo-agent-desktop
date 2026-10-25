import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));
vi.mock("@/lib/kb-source-storage", () => ({ hydrateKnowledgeSources: vi.fn(async () => {}) }));
vi.mock("@/lib/artifact-catalog", () => ({ indexTaskArtifacts: vi.fn() }));
vi.mock("@/stores/projects-store", async (original) => ({
  ...await original<object>(), hydrateProjectsFromBackend: vi.fn(async () => {}),
}));
vi.mock("../ThemeProvider", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("../TitleBar", () => ({ TitleBar: () => null }));
vi.mock("../HomePage", () => ({ HomePage: () => <div>首页</div> }));
vi.mock("../PlaceholderPage", () => ({ PlaceholderPage: () => null }));
vi.mock("../TasksPanel", () => ({ TasksPanel: () => null }));
vi.mock("../SecondarySidebar", () => ({ SecondarySidebar: () => null }));
vi.mock("../TopbarActions", () => ({ TopbarActions: () => null }));
vi.mock("../FolderTrustDialog", () => ({ FolderTrustDialog: () => null }));
vi.mock("../Sidebar", () => ({ Sidebar: ({ onSelect }: { onSelect: (id: string) => void }) => <>
  <button onClick={() => onSelect("source")}>打开项目源会话</button>
  <button onClick={() => onSelect("other")}>打开其他会话</button>
</> }));
// Real App lifecycle/store/persistence code; child widgets expose their public
// callback. This is a jsdom regression, not a Native or model acceptance.
vi.mock("../ChatView", () => ({ ChatView: (props: ComponentProps<typeof import("../ChatView").ChatView>) => <div>
  <span data-testid="active-title">{props.title}</span>
  <span data-testid="task-refresh">{props.taskRefreshSignal}</span>
  <button onClick={() => {const id=useSessionStore.getState().sessionId; if(id) void props.onPrepareRetry?.(id);}}>预检重试</button>
  <button onClick={() => void props.onForked?.("fork", "source", "/workspace")}>接收真实fork结果</button>
  <button onClick={() => void props.onSend("继续分叉")}>分叉下一轮</button>
</div> }));
vi.mock("@/lib/agent-client", async (original) => ({
  ...await original<object>(), agentInit: vi.fn(), agentAuthStatus: vi.fn(), providersList: vi.fn(),
  agentListAllSessions: vi.fn(), agentListWorkspaces: vi.fn(async () => []),
  agentsValidateReferences: vi.fn(async () => {}),
  agentPrepareSend: vi.fn(async () => {}),
  agentLoadSession: vi.fn(async () => "model-a"), agentSend: vi.fn(async () => {}), projectsSave: vi.fn(async () => {}),
  internalReload: vi.fn(async () => {}), subscribeAgentEvents: vi.fn(async () => () => {}),
}));

import App from "@/App";
import * as client from "@/lib/agent-client";
import { useSessionsStore } from "@/stores/sessions-store";
import { useSessionStore } from "@/stores/session-store";
import { useProjectsStore, type ProjectMeta } from "@/stores/projects-store";

const catalog = [
  { sessionId: "source", cwd: "/workspace", title: "项目源标题", currentModelId: "model-a", permissionMode: "ask" as const },
  { sessionId: "other", cwd: "/workspace", title: "其他标题", currentModelId: "model-a" },
];
const fork = { ...catalog[0], sessionId: "fork" };
const auth = { ready: true, runtimeReady: true, synchronized: true, providers: ["model-a"], runtimeModels: ["model-a"], defaultModelId: "model-a" };
const project = (pending: boolean): ProjectMeta => ({
  id: "project", name: "交付项目", cwd: "/project-workspace", instructions: "保留当前项目契约", createdAt: "2026-09-01T00:00:00Z",
  connectors: [], experts: [], skills: [], assets: [], members: [],
  plans: [{ id: "plan", title: "原计划", status: "completed", sessionId: "source" }],
  tasks: [{ id: "task", title: "原任务", scope: "personal", source: "user", status: "completed", sessionId: "source" }],
  conversations: [{ sessionId: "source", title: "项目源标题", createdAt: "2026-09-01T00:00:00Z", modelId: "model-a", pendingProjectContext: pending }],
});
async function start(pending = true) {
  useProjectsStore.setState({ projects: [project(pending)] }); render(<App />);
  await screen.findByText("首页"); await waitFor(() => expect(client.agentListAllSessions).toHaveBeenCalled()); await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "打开项目源会话" })); await screen.findByTestId("active-title");
  await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("source"));
  // A fork copies persisted history. Its next prompt is not its first user turn.
  act(() => useSessionStore.getState().setMessages([{ id: "original-user", role: "user", complete: true, parts: [{ kind: "text", text: "已有历史" }] }]));
}
function completeFork() {
  vi.mocked(client.agentListAllSessions).mockResolvedValue([...catalog, fork]);
  fireEvent.click(screen.getByRole("button", { name: "接收真实fork结果" }));
}
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useSessionsStore.setState(useSessionsStore.getInitialState()); useSessionStore.setState(useSessionStore.getInitialState());
  useProjectsStore.setState({ ...useProjectsStore.getInitialState(), projects: [] });
  vi.mocked(client.agentInit).mockResolvedValue({ ok: true, cwd: "/workspace", auth } as never);
  vi.mocked(client.agentAuthStatus).mockResolvedValue(auth);
  vi.mocked(client.providersList).mockResolvedValue({ providers: [], models: [{ modelId: "model-a", name: "模型 A", providerId: "p" }] } as never);
  vi.mocked(client.agentListAllSessions).mockResolvedValue(catalog);
  vi.mocked(client.agentLoadSession).mockReset().mockResolvedValue("model-a");
  vi.mocked(client.projectsSave).mockReset().mockResolvedValue(undefined);
  vi.mocked(client.agentSend).mockReset().mockResolvedValue(undefined);
  vi.mocked(client.agentPrepareSend).mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockImplementation(async (command) => command === "notification_take_pending_opens" ? [] : null);
});

describe("project fork continuation", () => {
  it("回复预检失败后刷新目录状态，并保留已有历史", async () => {
    await start();
    await waitFor(() => expect(Number(screen.getByTestId("task-refresh").textContent)).toBeGreaterThan(0));
    const before = Number(screen.getByTestId("task-refresh").textContent);
    const messages = useSessionStore.getState().messages;
    vi.mocked(client.agentPrepareSend).mockRejectedValueOnce(new Error("原目录已丢失"));
    fireEvent.click(screen.getByRole("button",{name:"预检重试"}));
    await waitFor(() => expect(client.agentPrepareSend).toHaveBeenCalledWith("source","/workspace"));
    await waitFor(() => expect(Number(screen.getByTestId("task-refresh").textContent)).toBeGreaterThan(before));
    expect(useSessionStore.getState().messages).toEqual(messages);
    expect(await screen.findByText("暂时无法重试：原目录已丢失")).toBeVisible();
  });
  it.each([true, false])("inherits pending=%s without cloning work items; next turn follows that exact contract", async (pending) => {
    await start(pending); const before = structuredClone(useProjectsStore.getState().projects[0]); completeFork();
    await waitFor(() => expect(useProjectsStore.getState().projects[0].conversations).toEqual(expect.arrayContaining([
      expect.objectContaining({ sessionId: "fork", title: "项目源标题", modelId: "model-a", pendingProjectContext: pending }),
    ])));
    await waitFor(() => expect(client.projectsSave).toHaveBeenCalled());
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("fork"));
    act(() => useSessionStore.getState().setMessages([{ id: "copied-user", role: "user", complete: true, parts: [{ kind: "text", text: "已有历史" }] }]));
    fireEvent.click(screen.getByRole("button", { name: "分叉下一轮" }));
    await waitFor(() => expect(client.agentSend).toHaveBeenCalled());
    const calls = vi.mocked(client.agentSend).mock.calls;
    const sent = calls[calls.length - 1];
    expect(sent[0]).toBe("fork"); expect(sent[1].includes("保留当前项目契约")).toBe(pending);
    if (pending) expect(client.agentsValidateReferences).toHaveBeenCalledWith("/workspace", []);
    expect(useSessionsStore.getState().independent.find(s => s.sessionId === "fork")?.cwd).toBe("/workspace");
    const saved = useProjectsStore.getState().projects[0];
    expect(saved.plans).toEqual(before.plans); expect(saved.tasks).toEqual(before.tasks);
    expect(saved.conversations.find((item) => item.sessionId === "source")).toEqual(before.conversations[0]);
  });

  it("failed association leaves the created fork independent with an actionable retry message", async () => {
    await start(); vi.mocked(client.projectsSave).mockRejectedValueOnce(new Error("disk full")); completeFork();
    await waitFor(() => expect(client.projectsSave).toHaveBeenCalled());
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("fork"));
    expect(useSessionsStore.getState().independent.some((item) => item.sessionId === "fork")).toBe(true);
    expect(useProjectsStore.getState().projects[0].conversations.map((item) => item.sessionId)).toEqual(["source"]);
    expect(await screen.findByText(/分叉已创建.*独立会话.*移入项目/)).toBeInTheDocument();
    expect(client.agentLoadSession).toHaveBeenCalledWith("fork", "/workspace");
  });

  it("awaits real project-save ACK and a slow association cannot steal another selected session", async () => {
    await start(); let release!: () => void;
    vi.mocked(client.projectsSave).mockImplementationOnce(() => new Promise<void>((accept) => { release = accept; }));
    completeFork(); await waitFor(() => expect(client.projectsSave).toHaveBeenCalled());
    expect(useSessionsStore.getState().currentSessionId).toBe("source");
    fireEvent.click(screen.getByRole("button", { name: "打开其他会话" }));
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("other"));
    await act(async () => { release(); });
    expect(useSessionsStore.getState().currentSessionId).toBe("other");
    expect(vi.mocked(client.agentLoadSession).mock.calls.some(([id]) => id === "fork")).toBe(false);
    expect(useProjectsStore.getState().projects[0].conversations.some((item) => item.sessionId === "fork")).toBe(true);
  });
});
