// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  providersTestModelConnection: vi.fn(),
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

  it("直接填写 Model ID 后测试实际模型并保存个人连接", async () => {
    mocks.providersTestModelConnection.mockResolvedValue(undefined);
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
    fireEvent.change(within(dialog).getByLabelText("模型名称 / ID"), { target: { value: "MiniMax-M3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并保存" }));

    await waitFor(() => {
      expect(mocks.providersTestModelConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          baseUrl: "https://api.minimaxi.com/v1",
          apiKey: "sk-test",
        }),
        "MiniMax-M3",
      );
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

  it("连接编辑器具有初始焦点、Tab 圈定、Escape 与触发器恢复", async () => {
    render(<ModelConnectionsPanel />);
    await screen.findByText("还没有可用模型");
    const opener = screen.getAllByRole("button", { name: "添加个人连接" })[0];
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "添加个人连接" });
    expect(within(dialog).getByLabelText(/连接名称/)).toHaveFocus();
    const last = within(dialog).getByRole("button", { name: "测试并保存" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(within(dialog).getByRole("button", { name: "关闭" })).toHaveFocus();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "添加个人连接" })).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("保存后等待 Runtime 和全局模型状态完全刷新", async () => {
    mocks.providersSaveConnection.mockResolvedValue({
      providerId: "custom",
      modelIds: ["model-a"],
    });
    let resolveReload!: () => void;
    mocks.internalReload.mockImplementation(() => new Promise<void>((resolve) => {
      resolveReload = resolve;
    }));
    let resolveRefresh!: () => void;
    const onModelsChanged = vi.fn(() => new Promise<void>((resolve) => {
      resolveRefresh = resolve;
    }));

    render(<ModelConnectionsPanel onModelsChanged={onModelsChanged} />);
    await screen.findByText("还没有可用模型");
    fireEvent.click(screen.getAllByRole("button", { name: "添加个人连接" })[0]);
    const dialog = screen.getByRole("dialog", { name: "添加个人连接" });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://api.example.com/v1" } });
    fireEvent.change(within(dialog).getByLabelText("API Key"), { target: { value: "sk-test" } });
    fireEvent.change(within(dialog).getByLabelText("模型名称 / ID"), { target: { value: "model-a" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "直接保存" }));

    await waitFor(() => expect(mocks.internalReload).toHaveBeenCalledWith("models"));
    expect(onModelsChanged).not.toHaveBeenCalled();

    await act(async () => resolveReload());
    await waitFor(() => expect(onModelsChanged).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("连接已添加，已配置 1 个模型。")).not.toBeInTheDocument();

    await act(async () => resolveRefresh());
    expect(await screen.findByText("连接已添加，已配置 1 个模型。")).toBeInTheDocument();
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
    mocks.providersList.mockResolvedValue({
      providers: [provider],
      models: [{ modelId: "model-a", remoteModelId: "model-a", providerId: "custom" }],
    });
    mocks.providersTestModelConnection.mockResolvedValue(undefined);
    mocks.providersSaveConnection.mockResolvedValue({ providerId: "custom", modelIds: ["model-a"] });

    render(<ModelConnectionsPanel />);
    await screen.findByText("现有连接", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "编辑连接" }));
    const dialog = screen.getByRole("dialog", { name: "编辑连接" });
    expect(within(dialog).getByLabelText("API Key")).toHaveValue("");
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并保存" }));

    await waitFor(() => {
      expect(mocks.providersTestModelConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom", apiKey: undefined, source: "personal" }),
        "model-a",
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
    fireEvent.click(within(dialog).getByRole("button", { name: "获取模型列表（可选）" }));

    const modelB = await within(dialog).findByRole("checkbox", { name: /model-b/ });
    expect(modelB).toBeChecked();
    fireEvent.click(modelB);
    fireEvent.click(within(dialog).getByRole("button", { name: "直接保存" }));

    await waitFor(() => {
      expect(mocks.providersSaveConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: "custom", apiKey: undefined }),
        [expect.objectContaining({ modelId: "model-a", remoteModelId: "model-a" })],
        true,
      );
    });
  });

  it("服务端不支持 models 接口时仍可手填 Model ID 并直接保存", async () => {
    mocks.providersTestConnection.mockRejectedValue(new Error("404 /models"));
    mocks.providersSaveConnection.mockResolvedValue({
      providerId: "custom",
      modelIds: ["private-model-v2"],
    });

    render(<ModelConnectionsPanel />);
    await screen.findByText("还没有可用模型");
    fireEvent.click(screen.getAllByRole("button", { name: "添加个人连接" })[0]);
    const dialog = screen.getByRole("dialog", { name: "添加个人连接" });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://private.example/v1" } });
    fireEvent.change(within(dialog).getByLabelText("API Key"), { target: { value: "private-key" } });
    fireEvent.change(within(dialog).getByLabelText("模型名称 / ID"), { target: { value: "private-model-v2" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "获取模型列表（可选）" }));
    expect(await within(dialog).findByText(/这不影响手动填写、测试和保存/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "直接保存" }));

    await waitFor(() => {
      expect(mocks.providersSaveConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "",
          baseUrl: "https://private.example/v1",
          apiKey: "private-key",
        }),
        [expect.objectContaining({ remoteModelId: "private-model-v2" })],
        true,
      );
    });
  });

  it("实际模型测试失败时不保存，但允许用户确认后直接保存", async () => {
    mocks.providersTestModelConnection.mockRejectedValue(new Error("自定义网关需要额外参数"));
    mocks.providersSaveConnection.mockResolvedValue({
      providerId: "custom",
      modelIds: ["special-model"],
    });

    render(<ModelConnectionsPanel />);
    await screen.findByText("还没有可用模型");
    fireEvent.click(screen.getAllByRole("button", { name: "添加个人连接" })[0]);
    const dialog = screen.getByRole("dialog", { name: "添加个人连接" });
    fireEvent.change(within(dialog).getByLabelText("Base URL"), { target: { value: "https://special.example/v1" } });
    fireEvent.change(within(dialog).getByLabelText("API Key"), { target: { value: "special-key" } });
    fireEvent.change(within(dialog).getByLabelText("模型名称 / ID"), { target: { value: "special-model" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "测试并保存" }));

    expect(await within(dialog).findByText(/测试失败，尚未保存/)).toBeInTheDocument();
    expect(mocks.providersSaveConnection).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "直接保存" }));
    await waitFor(() => expect(mocks.providersSaveConnection).toHaveBeenCalledTimes(1));
  });

  it("删除已成功但后续全局刷新失败时不保留可重复删除的弹窗", async () => {
    const provider = {
      id: "personal",
      providerKind: "custom" as const,
      label: "个人连接",
      source: "personal" as const,
      credentialConfigured: true,
      baseUrl: "https://api.example.com/v1",
      apiBackend: "chat_completions" as const,
      authScheme: "bearer" as const,
    };
    let deleted = false;
    mocks.providersList.mockImplementation(async () => deleted
      ? { providers: [], models: [] }
      : { providers: [provider], models: [] });
    mocks.providersDeleteProvider.mockImplementation(async () => { deleted = true; });
    const onModelsChanged = vi.fn().mockRejectedValue(new Error("shell refresh failed"));

    render(<ModelConnectionsPanel onModelsChanged={onModelsChanged} />);
    await screen.findByText("个人连接", { selector: "h3" });
    fireEvent.click(screen.getByRole("button", { name: "删除连接" }));
    const dialog = screen.getByRole("alertdialog", { name: "删除连接“个人连接”？" });
    fireEvent.click(within(dialog).getByRole("button", { name: "删除连接" }));

    await waitFor(() => expect(mocks.providersDeleteProvider).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText(/shell refresh failed/)).toHaveTextContent("配置已保存");
    expect(mocks.providersDeleteProvider).toHaveBeenCalledTimes(1);
  });
});
