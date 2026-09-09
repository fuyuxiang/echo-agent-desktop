import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps, ReactNode } from "react";

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
  <><button onClick={() => onSelect("auto-1")}>打开自动化</button><button onClick={() => onSelect("other")}>打开其他任务</button></>
) }));
// Keep the real shell, event handlers and stores; expose its composer contract.
vi.mock("../ChatView", () => ({ ChatView: (props: ComponentProps<typeof import("../ChatView").ChatView>) => (
  <div>
    <span data-testid="model">{props.modelId ?? "unknown"}</span>
    {!props.apiReady && <div role="status">{props.setupHint}</div>}
    <button disabled={!props.apiReady} onClick={() => props.onSend("继续解释")}>追问</button>
    <button onClick={() => props.onModelChange?.("model-b")}>切换模型</button>
  </div>
) }));
vi.mock("@/lib/agent-client", async (original) => ({
  ...await original<object>(),
  agentInit: vi.fn(), agentAuthStatus: vi.fn(), providersList: vi.fn(),
  agentListAllSessions: vi.fn(async () => []), agentListWorkspaces: vi.fn(async () => []),
  agentLoadSession: vi.fn(), agentSend: vi.fn(async () => {}), agentSetModel: vi.fn(async () => {}),
  internalReload: vi.fn(async () => {}), subscribeAgentEvents: vi.fn(),
}));

import App from "@/App";
import * as client from "@/lib/agent-client";
import { useSessionsStore } from "@/stores/sessions-store";
import { useSessionStore } from "@/stores/session-store";

let handlers: Parameters<typeof client.subscribeAgentEvents>[0];
const auth = { ready: true, runtimeReady: true, synchronized: true, providers: ["model-a", "model-b"], runtimeModels: ["model-a", "model-b"], defaultModelId: "model-b" };
function created(currentModelId?: string) {
  act(() => handlers.onAutomationUpdate?.({ phase: "sessionCreated", automationId: "a", automationName: "每日任务", recordId: "r", status: "running", sessionId: "auto-1", cwd: "/workspace", currentModelId }));
}
async function start() {
  render(<App />);
  await screen.findByText("首页");
  await waitFor(() => expect(client.providersList).toHaveBeenCalled());
  // Flush both catalog promises before selecting a task.
  await act(async () => {});
}
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useSessionsStore.setState(useSessionsStore.getInitialState());
  useSessionStore.setState(useSessionStore.getInitialState());
  vi.mocked(client.agentInit).mockResolvedValue({ ok: true, cwd: "/workspace", auth } as never);
  vi.mocked(client.agentAuthStatus).mockResolvedValue(auth);
  vi.mocked(client.providersList).mockResolvedValue({ providers: [], models: [{ modelId: "model-a", name: "模型 A", providerId: "p" }, { modelId: "model-b", name: "模型 B", providerId: "p" }] } as never);
  vi.mocked(client.agentLoadSession).mockResolvedValue("model-a");
  vi.mocked(client.subscribeAgentEvents).mockImplementation(async (value) => { handlers = value; return () => {}; });
});

describe("自动化会话模型同步", () => {
  it("定时任务运行事件不会把用户已暂停的会话改回运行中", async () => {
    await start();
    act(() => useSessionsStore.getState().upsert({
      sessionId: "auto-1",
      cwd: "/workspace",
      title: "已暂停任务",
      status: "paused",
    }));
    created("model-a");
    expect(useSessionsStore.getState().independent[0]).toMatchObject({
      sessionId: "auto-1",
      status: "paused",
      currentModelId: "model-a",
    });
  });

  it("自动化事件保存本次实际模型，打开后可以追问，不改用当前默认模型", async () => {
    await start();
    created("model-a");
    expect(useSessionsStore.getState().independent[0].currentModelId).toBe("model-a");
    fireEvent.click(screen.getByText("打开自动化"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
    expect(screen.getByTestId("model")).toHaveTextContent("model-a");
    expect(useSessionStore.getState().error).toBeNull();
    fireEvent.click(screen.getByText("追问"));
    expect(client.agentSend).toHaveBeenCalledWith("auto-1", "继续解释", [], "继续解释", expect.any(String));
  });

  it("旧事件缺少模型时，加载响应补齐；加载期间不误报未配置", async () => {
    let complete!: (id: string) => void;
    vi.mocked(client.agentLoadSession).mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    await start();
    created();
    fireEvent.click(screen.getByText("打开自动化"));
    expect(await screen.findByRole("status")).toHaveTextContent("正在加载会话信息");
    expect(screen.getByText("追问")).toBeDisabled();
    expect(useSessionStore.getState().error).toBeNull();
    await act(async () => complete("model-a"));
    expect(screen.getByText("追问")).toBeEnabled();
    expect(useSessionsStore.getState().independent[0].currentModelId).toBe("model-a");
  });

  it("重启后从持久化列表打开，运行时模型优先于陈旧摘要", async () => {
    vi.mocked(client.agentListAllSessions).mockResolvedValueOnce([{ sessionId: "auto-1", cwd: "/workspace", title: "历史自动化", currentModelId: "model-b" }]);
    await start();
    fireEvent.click(screen.getByText("打开自动化"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
    expect(screen.getByTestId("model")).toHaveTextContent("model-a");
  });

  it("兼容未返回模型的加载响应，保留创建事件的确定模型", async () => {
    vi.mocked(client.agentLoadSession).mockResolvedValue(null);
    await start();
    created("model-a");
    fireEvent.click(screen.getByText("打开自动化"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
    expect(screen.getByTestId("model")).toHaveTextContent("model-a");
  });

  it("没有任何权威模型信息时不猜默认模型，并允许用户恢复", async () => {
    vi.mocked(client.agentLoadSession).mockResolvedValue(null);
    await start();
    created();
    fireEvent.click(screen.getByText("打开自动化"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("未能获取此会话的模型信息"));
    expect(screen.getByText("追问")).toBeDisabled();
    expect(useSessionStore.getState().error).toBeNull();
    fireEvent.click(screen.getByText("切换模型"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
  });

  it("快速切换会话，迟到的加载响应不覆盖新会话模型", async () => {
    let complete!: (id: string) => void;
    vi.mocked(client.agentLoadSession).mockImplementation((id) => id === "auto-1" ? new Promise((resolve) => { complete = resolve; }) : Promise.resolve("model-b"));
    await start();
    created();
    act(() => useSessionsStore.getState().upsert({ sessionId: "other", cwd: "/workspace", currentModelId: "model-b" }));
    fireEvent.click(screen.getByText("打开自动化"));
    fireEvent.click(screen.getByText("打开其他任务"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
    await act(async () => complete("model-a"));
    expect(screen.getByTestId("model")).toHaveTextContent("model-b");
    expect(screen.getByText("追问")).toBeEnabled();
  });

  it("模型确实不可用时只显示恢复提示，选择有效模型后恢复追问", async () => {
    vi.mocked(client.agentLoadSession).mockResolvedValue("removed-model");
    await start();
    created("removed-model");
    fireEvent.click(screen.getByText("打开自动化"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("removed-model"));
    expect(screen.getByText("追问")).toBeDisabled();
    fireEvent.click(screen.getByText("切换模型"));
    await waitFor(() => expect(screen.getByText("追问")).toBeEnabled());
    // A duplicate creation event must not undo a subsequent user model switch.
    created("model-a");
    expect(screen.getByTestId("model")).toHaveTextContent("model-b");
  });
});
