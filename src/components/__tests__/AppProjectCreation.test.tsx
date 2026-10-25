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
vi.mock("@/components/ThemeProvider", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("@/components/HomePage", () => ({HomePage: () => <div>首页</div>}));
vi.mock("@/components/PlaceholderPage", () => ({PlaceholderPage: (props: ComponentProps<typeof import("@/components/PlaceholderPage").PlaceholderPage>) =>
  <button onClick={() => {const project=useProjectsStore.getState().projects[0]; if(project) void props.onStartProject?.(project);}}>启动项目</button>}));
vi.mock("@/components/TasksPanel", () => ({ TasksPanel: () => null }));
vi.mock("@/components/SecondarySidebar", () => ({ SecondarySidebar: () => null }));
vi.mock("@/components/TopbarActions", () => ({ TopbarActions: () => null }));
vi.mock("@/components/FolderTrustDialog", () => ({ FolderTrustDialog: () => null }));
vi.mock("@/components/Sidebar", () => ({Sidebar: (props: ComponentProps<typeof import("@/components/Sidebar").Sidebar>) => <aside>
  <button onClick={() => props.onStartProjectConversation?.("project-no-cwd")}>新建项目对话</button>
  <button onClick={() => props.onNavigate?.("项目")}>查看项目</button>
</aside>}));
vi.mock("@/components/ChatView", () => ({ ChatView: (props: ComponentProps<typeof import("@/components/ChatView").ChatView>) => <div>已进入会话<span data-testid="session-cwd">{props.cwd}</span><button onClick={props.onNewTask}>从任务新建</button></div> }));
vi.mock("@/lib/agent-client", async (original) => ({
  ...await original<object>(), agentInit: vi.fn(), agentAuthStatus: vi.fn(), providersList: vi.fn(),
  agentListAllSessions: vi.fn(), agentListWorkspaces: vi.fn(async () => []),
  agentsValidateReferences: vi.fn(async () => {}),
  agentPrepareTaskWorkspace: vi.fn(async () => "/workspace/Tasks/default-task"),
  agentNewSession: vi.fn(async () => "new-session"),
  agentLoadSession: vi.fn(async () => "model-a"), agentSend: vi.fn(async () => {}), projectsSave: vi.fn(async () => {}),
  internalReload: vi.fn(async () => {}), subscribeAgentEvents: vi.fn(async () => () => {}),
}));

import App from "@/App";
import * as client from "@/lib/agent-client";
import { useSessionsStore } from "@/stores/sessions-store";
import { useSessionStore } from "@/stores/session-store";
import { useProjectsStore } from "@/stores/projects-store";

import { usePendingExpertStore } from "@/stores/pending-expert-store";
const auth = { ready:true,runtimeReady:true,synchronized:true,providers:["model-a"],runtimeModels:["model-a"],defaultModelId:"model-a" };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear();
  useSessionsStore.setState(useSessionsStore.getInitialState()); useSessionStore.setState(useSessionStore.getInitialState());
  useProjectsStore.setState({ ...useProjectsStore.getInitialState(), projects: [] }); usePendingExpertStore.getState().clear();
  vi.mocked(client.agentInit).mockResolvedValue({ ok:true,cwd:"/workspace",auth } as never);
  vi.mocked(client.agentAuthStatus).mockResolvedValue(auth);
  vi.mocked(client.providersList).mockResolvedValue({providers:[],models:[{modelId:"model-a",name:"Model A",providerId:"p"}]} as never);
  vi.mocked(client.agentListAllSessions).mockResolvedValue([]);
  vi.mocked(client.agentNewSession).mockReset().mockResolvedValue("new-session");
  vi.mocked(client.agentPrepareTaskWorkspace).mockReset().mockImplementation(async id => `/workspace/Tasks/${id}`);
  vi.mocked(invoke).mockImplementation(async command => command === "notification_take_pending_opens" ? [] : null);
});
async function start() {
  useProjectsStore.setState({projects:[{id:"project-no-cwd",name:"Project",createdAt:"2026-10-26T00:00:00Z",connectors:[],experts:[],skills:[],assets:[],members:[],plans:[],tasks:[],conversations:[]}]});
  render(<App />); await screen.findByText("首页"); await waitFor(()=>expect(client.providersList).toHaveBeenCalled()); await act(async()=>{}); }


async function create(entry: "新建项目对话" | "启动项目") {
  if (entry === "启动项目" && !screen.queryByRole("button",{name:entry})) {
    fireEvent.click(screen.getByRole("button",{name:"查看项目"}));
    await screen.findByRole("button",{name:entry});
  }
  fireEvent.click(screen.getByRole("button",{name:entry}));
}
describe.each(["新建项目对话","启动项目"] as const)("%s creation recovery", entry => {
  it("超时重试沿用原目录，成功后的新任务才分配另一目录", async () => {
    await start();
    vi.mocked(client.agentNewSession).mockRejectedValueOnce(new Error("创建超时，请重试"))
      .mockResolvedValueOnce("reclaimed").mockResolvedValueOnce("next-task");
    await create(entry);
    await screen.findByText(/失败：创建超时/);
    const originalCwd = vi.mocked(client.agentNewSession).mock.calls[0][0];
    await create(entry);
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("reclaimed"));
    expect(vi.mocked(client.agentNewSession).mock.calls[1][0]).toBe(originalCwd);
    expect(useProjectsStore.getState().projects[0].conversations.filter(c => c.sessionId === "reclaimed")).toHaveLength(1);
    await create(entry);
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("next-task"));
    expect(vi.mocked(client.agentNewSession).mock.calls[2][0]).not.toBe(originalCwd);
  });
  it("创建尚未完成时连续点击不会重复创建或发送首条消息", async () => {
    await start();
    let finish!: (id: string) => void;
    vi.mocked(client.agentNewSession).mockImplementationOnce(() => new Promise(resolve => {finish=resolve;}));
    await create(entry);
    await waitFor(() => expect(client.agentNewSession).toHaveBeenCalledOnce());
    await create(entry);
    expect(client.agentNewSession).toHaveBeenCalledOnce();
    await act(async () => finish("created-once"));
    await waitFor(() => expect(useSessionsStore.getState().currentSessionId).toBe("created-once"));
    expect(useProjectsStore.getState().projects[0].conversations).toHaveLength(1);
    expect(client.agentSend).toHaveBeenCalledTimes(entry === "启动项目" ? 1 : 0);
  });
  it("手动指定的项目目录保持固定且不分配默认目录", async () => {
    await start();
    act(() => useProjectsStore.setState({projects:useProjectsStore.getState().projects.map(project => ({...project,cwd:"/manual-repository"}))}));
    await create(entry);
    await waitFor(() => expect(client.agentNewSession).toHaveBeenCalledWith("/manual-repository","model-a"));
    expect(client.agentPrepareTaskWorkspace).not.toHaveBeenCalled();
  });
});
