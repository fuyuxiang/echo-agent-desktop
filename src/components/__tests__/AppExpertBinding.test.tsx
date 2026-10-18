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
vi.mock("../HomePage", () => ({ HomePage: (props: ComponentProps<typeof import("../HomePage").HomePage>) => <div>首页
  <button onClick={() => props.onSelectExpert?.({name:"Review",description:"review",scope:"user",path:"/fixture/agents/review.md",raw:"---\nname: Review\n---\nVerify the task"})}>输入菜单选择专家</button>
  <button onClick={() => void props.onSend("my unsent task")}>发送专家任务</button>
  {props.sendError && <div role="alert">{props.sendError}</div>}
</div> }));
vi.mock("../PlaceholderPage", () => ({ PlaceholderPage: () => null }));
vi.mock("../TasksPanel", () => ({ TasksPanel: () => null }));
vi.mock("../SecondarySidebar", () => ({ SecondarySidebar: () => null }));
vi.mock("../TopbarActions", () => ({ TopbarActions: () => null }));
vi.mock("../FolderTrustDialog", () => ({ FolderTrustDialog: () => null }));
vi.mock("../Sidebar", () => ({ Sidebar: () => null }));
vi.mock("../ChatView", () => ({ ChatView: () => <div>已进入会话</div> }));
vi.mock("@/lib/agent-client", async (original) => ({
  ...await original<object>(), agentInit: vi.fn(), agentAuthStatus: vi.fn(), providersList: vi.fn(),
  agentListAllSessions: vi.fn(), agentListWorkspaces: vi.fn(async () => []),
  agentNewSession: vi.fn(async () => "new-session"), agentDeleteSession: vi.fn(async () => ({memorySummariesDeleted:0})), agentSetSessionExpert: vi.fn(async () => true),
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
  vi.mocked(client.agentSetSessionExpert).mockReset().mockResolvedValue(true);
  vi.mocked(invoke).mockImplementation(async command => command === "notification_take_pending_opens" ? [] : null);
});
async function start() { render(<App />); await screen.findByText("首页"); await waitFor(()=>expect(client.providersList).toHaveBeenCalled()); await act(async()=>{}); }

describe("expert task persistent binding admission", () => {
  it("waits for the native binding ACK before showing the task or sending its persona", async () => {
    let resolve!: (value:boolean)=>void;
    vi.mocked(client.agentSetSessionExpert).mockImplementationOnce(()=>new Promise<boolean>(accept=>{resolve=accept;}));
    await start(); fireEvent.click(screen.getByRole("button",{name:"输入菜单选择专家"})); fireEvent.click(screen.getByRole("button",{name:"发送专家任务"}));
    await waitFor(()=>expect(client.agentSetSessionExpert).toHaveBeenCalledWith("new-session","Review","Review","local",undefined,"/fixture/agents/review.md","---\nname: Review\n---\nVerify the task"));
    expect(client.agentSend).not.toHaveBeenCalled(); expect(useSessionsStore.getState().currentSessionId).not.toBe("new-session");
    expect(usePendingExpertStore.getState().expert?.name).toBe("Review");
    await act(async()=>{resolve(true);});
    await waitFor(()=>expect(client.agentSend).toHaveBeenCalled());
    expect(vi.mocked(client.agentSend).mock.calls[0][1]).toContain("Verify the task");
    expect(usePendingExpertStore.getState().expert).toBeNull();
    expect(useSessionsStore.getState().independent.find(session=>session.sessionId==="new-session")?.expertName).toBe("Review");
  });
  it("a binding error preserves pending selection and never sends the user prompt", async () => {
    vi.mocked(client.agentSetSessionExpert).mockRejectedValueOnce(new Error("专家配置已更新，请重新选择"));
    await start(); fireEvent.click(screen.getByRole("button",{name:"输入菜单选择专家"})); fireEvent.click(screen.getByRole("button",{name:"发送专家任务"}));
    await waitFor(()=>expect(client.agentDeleteSession).toHaveBeenCalledWith("new-session","/workspace"));
    expect(client.agentSend).not.toHaveBeenCalled(); expect(usePendingExpertStore.getState().expert?.name).toBe("Review");
    expect(screen.getAllByRole("alert").some(alert => alert.textContent?.includes("专家配置已更新"))).toBe(true);
  });
});
