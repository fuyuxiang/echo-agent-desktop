// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providersList: vi.fn(),
  agentsDefaultsGet: vi.fn(),
  agentsDefaultsSave: vi.fn(),
  internalReload: vi.fn(),
  providersDeleteModel: vi.fn(),
  providersDeleteProvider: vi.fn(),
  providersFetchModelsForProvider: vi.fn(),
  providersSaveConnection: vi.fn(),
  providersSaveModel: vi.fn(),
  providersTestConnection: vi.fn(),
  orgSession: vi.fn(),
  orgSyncModelConfig: vi.fn(),
  listenOrgModelsChanged: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({
  ...mocks,
}));

vi.mock("@/lib/org-client", () => ({
  orgSession: mocks.orgSession,
  orgSyncModelConfig: mocks.orgSyncModelConfig,
  listenOrgModelsChanged: mocks.listenOrgModelsChanged,
}));

import { ModelConnectionsPanel } from "../ModelConnectionsPanel";
import { resetOrgSessionMirror } from "@/stores/org-session-store";

const defaults = {
  defaultModel: "",
  defaultPermission: "",
  rememberToolApprovals: null,
};

describe("ModelConnectionsPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOrgSessionMirror();
    mocks.providersList.mockResolvedValue({ providers: [], models: [] });
    mocks.agentsDefaultsGet.mockResolvedValue(defaults);
    mocks.internalReload.mockResolvedValue(undefined);
    mocks.orgSession.mockResolvedValue({ loggedIn: false });
    mocks.listenOrgModelsChanged.mockResolvedValue(() => {});
  });

  it("明确展示组织托管来源且不提供编辑或删除入口", async () => {
    mocks.providersList.mockResolvedValue({
      providers: [{
        id: "echoagent-organization",
        providerKind: "custom",
        label: "组织提供",
        source: "organization",
        managed: true,
        credentialConfigured: true,
        baseUrl: "https://organization.example/v1",
        apiBackend: "chat_completions",
        authScheme: "bearer",
        syncedAt: 1_800_000_000_000,
      }],
      models: [{
        modelId: "organization/MiniMax-M3",
        remoteModelId: "MiniMax-M3",
        providerId: "echoagent-organization",
        name: "MiniMax-M3",
        managed: true,
      }],
    });

    render(<ModelConnectionsPanel />);

    expect(await screen.findByText("组织托管")).toBeInTheDocument();
    expect(screen.getByText("由组织安全配置 · 不可查看")).toBeInTheDocument();
    expect(screen.getByText("组织提供", { selector: "strong" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑连接" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "删除连接" })).not.toBeInTheDocument();
    expect(screen.getByText("远端模型 ID：MiniMax-M3")).toBeInTheDocument();
  });

  it("通过测试连接和选择模型一次性保存个人连接", async () => {
    mocks.providersTestConnection.mockResolvedValue([
      { id: "MiniMax-M3", ownedBy: "MiniMax" },
      { id: "MiniMax-Text-01", ownedBy: "MiniMax" },
    ]);
    mocks.providersSaveConnection.mockResolvedValue({
      providerId: "custom",
      modelIds: ["MiniMax-M3"],
    });

    render(<ModelConnectionsPanel />);
    await screen.findByText("还没有可用模型");
    fireEvent.click(screen.getAllByRole("button", { name: "添加个人连接" })[0]);

    const dialog = screen.getByRole("dialog", { name: "添加个人连接" });
    fireEvent.change(within(dialog).getByLabelText(/连接名称/), { target: { value: "我的 MiniMax" } });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://api.minimaxi.com/v1" } });
    fireEvent.change(within(dialog).getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并获取模型" }));

    const modelCheckbox = await within(dialog).findByRole("checkbox", { name: /MiniMax-M3/ });
    fireEvent.click(modelCheckbox);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存连接和 1 个模型" }));

    await waitFor(() => {
      expect(mocks.providersSaveConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "",
          label: "我的 MiniMax",
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "sk-test",
          providerKind: "custom",
        }),
        [expect.objectContaining({ modelId: "", remoteModelId: "MiniMax-M3" })],
        true,
      );
    });
    expect(mocks.internalReload).toHaveBeenCalledWith("models");
  });

  it("编辑连接时留空密钥并由原生层复用已保存凭据", async () => {
    const provider = {
      id: "custom",
      providerKind: "custom" as const,
      label: "现有连接",
      source: "personal" as const,
      credentialConfigured: true,
      baseUrl: "https://api.example.com/v1",
      apiBackend: "chat_completions" as const,
      authScheme: "bearer" as const,
    };
    mocks.providersList.mockResolvedValue({ providers: [provider], models: [] });
    mocks.providersTestConnection.mockResolvedValue([{ id: "model-a" }]);

    render(<ModelConnectionsPanel />);
    await screen.findByText("现有连接", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "编辑连接" }));
    const dialog = screen.getByRole("dialog", { name: "编辑连接" });
    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并获取模型" }));

    await waitFor(() => {
      expect(mocks.providersTestConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom", apiKey: undefined, source: "personal" }),
      );
    });
  });

  it("编辑连接时以当前勾选结果替换该连接的模型", async () => {
    const provider = {
      id: "custom",
      providerKind: "custom" as const,
      label: "现有连接",
      source: "personal" as const,
      credentialConfigured: true,
      baseUrl: "https://api.example.com/v1",
      apiBackend: "chat_completions" as const,
      authScheme: "bearer" as const,
    };
    mocks.providersList.mockResolvedValue({
      providers: [provider],
      models: [
        { modelId: "model-a", remoteModelId: "model-a", providerId: "custom" },
        { modelId: "model-b", remoteModelId: "model-b", providerId: "custom" },
      ],
    });
    mocks.providersTestConnection.mockResolvedValue([{ id: "model-a" }, { id: "model-b" }]);
    mocks.providersSaveConnection.mockResolvedValue({ providerId: "custom", modelIds: ["model-a"] });

    render(<ModelConnectionsPanel />);
    await screen.findByText("现有连接", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "编辑连接" }));
    const dialog = screen.getByRole("dialog", { name: "编辑连接" });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并获取模型" }));

    const modelB = await within(dialog).findByRole("checkbox", { name: /model-b/ });
    expect(modelB).toBeChecked();
    fireEvent.click(modelB);
    fireEvent.click(within(dialog).getByRole("button", { name: "保存连接和 1 个模型" }));

    await waitFor(() => {
      expect(mocks.providersSaveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom", apiKey: undefined }),
        [expect.objectContaining({ modelId: "model-a", remoteModelId: "model-a" })],
        true,
      );
    });
  });
});
