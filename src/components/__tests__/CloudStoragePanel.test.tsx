import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CloudStoragePanel } from "../CloudStoragePanel";
import { getStorageProvider, saveStorageProviderConfig } from "@/lib/cloud-storage";
import { open, save } from "@tauri-apps/plugin-dialog";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("@/lib/cloud-storage", () => ({
  hydrateStorageProviders: vi.fn().mockResolvedValue([{
    id: "dav", label: "团队网盘", kind: "webdav", baseUrl: "https://dav.example.com", username: "alice", password: "••••", enabled: true,
  }]),
  saveStorageProviderConfig: vi.fn().mockResolvedValue(undefined),
  removeStorageProviderConfig: vi.fn(),
  testStorageProviderConfig: vi.fn(),
  createTauriWebDavProvider: vi.fn((config) => ({ ...config })),
  registerStorageProvider: vi.fn(),
  unregisterStorageProvider: vi.fn(),
  listStorageProviders: vi.fn(() => [{ id: "dav", label: "团队网盘" }]),
  getStorageProvider: vi.fn(),
  normalizePath: vi.fn((path: string) => path.replace(/\/+/g, "/") || "/"),
  joinStoragePath: vi.fn((base: string, name: string) => (base === "/" ? "" : base) + "/" + name),
}));

describe("CloudStoragePanel", () => {
  const provider = {
    list: vi.fn().mockResolvedValue([{ path: "/report.pdf", name: "report.pdf", isDir: false, size: 2048 }]),
    readText: vi.fn(), writeText: vi.fn(), delete: vi.fn(), makeDir: vi.fn(),
    uploadFile: vi.fn().mockResolvedValue(10),
    downloadFile: vi.fn().mockResolvedValue(2048),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStorageProvider).mockReturnValue(provider as never);
  });

  async function selectProvider() {
    render(<CloudStoragePanel />);
    const select = await screen.findByRole("combobox");
    fireEvent.change(select, { target: { value: "dav" } });
    await screen.findByText("report.pdf");
  }

  it("可编辑已有配置并保留密码掩码", async () => {
    await selectProvider();
    fireEvent.click(screen.getByRole("button", { name: "编辑配置" }));
    expect(screen.getByPlaceholderText("显示名")).toHaveValue("团队网盘");
    expect(screen.getByDisplayValue("••••")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(saveStorageProviderConfig).toHaveBeenCalledWith(expect.objectContaining({ id: "dav", password: "••••" })));
  });

  it("上传和下载都使用原生文件选择结果", async () => {
    vi.mocked(open).mockResolvedValue("/tmp/upload.txt");
    vi.mocked(save).mockResolvedValue("/tmp/report.pdf");
    await selectProvider();
    fireEvent.click(screen.getByRole("button", { name: "上传文件" }));
    await waitFor(() => expect(provider.uploadFile).toHaveBeenCalledWith("/upload.txt", "/tmp/upload.txt"));
    await waitFor(() => expect(screen.getByRole("button", { name: "上传文件" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "下载 report.pdf" }));
    await waitFor(() => expect(provider.downloadFile).toHaveBeenCalledWith("/report.pdf", "/tmp/report.pdf"));
  });
});
