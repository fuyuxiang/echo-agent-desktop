import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
vi.mock("../Sidebar", () => ({ Sidebar: ({ onSelect }: { onSelect: (id: string) => void }) => (
  <>
    <button onClick={() => onSelect("parent")}>打开母任务</button>
    <button onClick={() => onSelect("other")}>打开其他任务</button>
  </>
) }));
vi.mock("../ChatView", () => ({ ChatView: (props: ComponentProps<typeof import("../ChatView").ChatView>) => {
  const child = props.title === "母任务" ? "child" : "grandchild";
  return <div>
    <span data-testid="active-task">{props.title}</span>
    <span data-testid="restored-row">{props.subagentScrollRestore?.subagentKey ?? ""}</span>
    {props.title !== "孙子代理记录" && <button onClick={() => void props.onOpenSubagentSession?.(child, "/workspace", {
      parentSessionId: props.title === "母任务" ? "parent" : "child",
      parentCwd: "/workspace", subagentKey: child, scrollTop: 360, rowOffset: 72,
    })}>打开子代理</button>}
  </div>;
} }));
vi.mock("@/lib/agent-client", async (original) => ({
  ...await original<object>(),
  agentInit: vi.fn(), agentAuthStatus: vi.fn(), providersList: vi.fn(),
  agentListAllSessions: vi.fn(), agentListWorkspaces: vi.fn(async () => []),
  agentLoadSession: vi.fn(async () => "model-a"),
  internalReload: vi.fn(async () => {}), subscribeAgentEvents: vi.fn(async () => () => {}),
}));

import App from "@/App";
import * as client from "@/lib/agent-client";
import { useSessionsStore } from "@/stores/sessions-store";
import { useSessionStore } from "@/stores/session-store";
import { useProjectsStore } from "@/stores/projects-store";

const catalog = [
  { sessionId: "parent", cwd: "/workspace", title: "母任务", currentModelId: "model-a" },
  { sessionId: "child", cwd: "/workspace", title: "子代理记录", currentModelId: "model-a", hidden: true, sessionKind: "subagent" },
  { sessionId: "grandchild", cwd: "/workspace", title: "孙子代理记录", currentModelId: "model-a", hidden: true, sessionKind: "subagent" },
  { sessionId: "other", cwd: "/workspace", title: "其他任务", currentModelId: "model-a" },
];
const auth = { ready: true, runtimeReady: true, synchronized: true, providers: ["model-a"], runtimeModels: ["model-a"], defaultModelId: "model-a" };

async function start() {
  render(<App />);
  await screen.findByText("首页");
  await waitFor(() => expect(client.agentListAllSessions).toHaveBeenCalled());
  await act(async () => {});
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSessionsStore.setState(useSessionsStore.getInitialState());
  useSessionStore.setState(useSessionStore.getInitialState());
  useProjectsStore.setState({ ...useProjectsStore.getInitialState(), projects: [] });
  vi.mocked(client.agentInit).mockResolvedValue({ ok: true, cwd: "/workspace", auth } as never);
  vi.mocked(client.agentAuthStatus).mockResolvedValue(auth);
  vi.mocked(client.providersList).mockResolvedValue({ providers: [], models: [{ modelId: "model-a", name: "模型 A", providerId: "p" }] } as never);
  vi.mocked(client.agentListAllSessions).mockResolvedValue(catalog);
  vi.mocked(listen).mockImplementation(async () => () => {});
  vi.mocked(invoke).mockImplementation(async (command) => command === "notification_take_pending_opens" ? [] : null);
});

describe("子代理任务层级导航", () => {
  it("返回母任务并恢复进入时的子代理条目，嵌套时逐级返回", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "打开母任务" }));
    expect(await screen.findByTestId("active-task")).toHaveTextContent("母任务");
    fireEvent.click(screen.getByRole("button", { name: "打开子代理" }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("子代理记录"));
    expect(screen.getByRole("button", { name: /返回上级任务：母任务/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "打开子代理" }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("孙子代理记录"));
    fireEvent.click(screen.getByRole("button", { name: /返回上级任务：子代理记录/ }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("子代理记录"));
    expect(screen.getByTestId("restored-row")).toHaveTextContent("grandchild");
    fireEvent.click(screen.getByRole("button", { name: /返回上级任务：母任务/ }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("母任务"));
    expect(screen.getByTestId("restored-row")).toHaveTextContent("child");
    expect(screen.queryByRole("button", { name: /返回上级任务/ })).toBeNull();
  });

  it("普通任务切换会清除子代理返回入口", async () => {
    await start();
    fireEvent.click(screen.getByRole("button", { name: "打开母任务" }));
    await screen.findByTestId("active-task");
    fireEvent.click(screen.getByRole("button", { name: "打开子代理" }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("子代理记录"));
    fireEvent.click(screen.getByRole("button", { name: "打开其他任务" }));
    await waitFor(() => expect(screen.getByTestId("active-task")).toHaveTextContent("其他任务"));
    expect(screen.queryByRole("button", { name: /返回上级任务/ })).toBeNull();
  });

  it("子代理记录无法打开时保留母任务，不产生失效的返回路径", async () => {
    vi.mocked(client.agentListAllSessions).mockResolvedValue(catalog.filter((item) => item.sessionId !== "child"));
    await start();
    fireEvent.click(screen.getByRole("button", { name: "打开母任务" }));
    await screen.findByTestId("active-task");
    const catalogReads = vi.mocked(client.agentListAllSessions).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "打开子代理" }));
    await waitFor(() => expect(client.agentListAllSessions).toHaveBeenCalledTimes(catalogReads + 1));
    expect(screen.getByTestId("active-task")).toHaveTextContent("母任务");
    expect(screen.queryByRole("button", { name: /返回上级任务/ })).toBeNull();
  });
});
