// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkConnection: vi.fn(),
  meetingList: vi.fn(),
  captureSupport: vi.fn(),
  recorderStart: vi.fn(),
  meetingGet: vi.fn(),
  meetingUpdate: vi.fn(),
  meetingJobActive: vi.fn(),
  meetingProcess: vi.fn(),
  meetingRegenerateMinutes: vi.fn(),
  listener: null as null | ((snapshot: unknown) => void),
}));

vi.mock("@/lib/agent-client", () => ({ filesystemPickFiles: vi.fn() }));
vi.mock("@/lib/meeting-minutes", () => ({
  meetingCheckConnection: mocks.checkConnection,
  isMiniMaxMeetingModel: (model: { id: string; remoteModelId?: string }) =>
    /minimax/i.test(model.remoteModelId || model.id),
  meetingList: mocks.meetingList,
  meetingCaptureSupport: mocks.captureSupport,
  meetingGet: mocks.meetingGet,
  meetingUpdate: mocks.meetingUpdate,
  meetingJobActive: mocks.meetingJobActive,
  meetingProcess: mocks.meetingProcess,
  meetingRegenerateMinutes: mocks.meetingRegenerateMinutes,
  meetingRecorder: {
    current: () => ({ meeting: null, active: false, paused: false, level: 0, error: null, source: null }),
    subscribe: (listener: (snapshot: unknown) => void) => { mocks.listener = listener; return () => { mocks.listener = null; }; },
    syncNative: vi.fn().mockResolvedValue(undefined),
    start: mocks.recorderStart,
  },
  formatMeetingDuration: () => "00:00:00",
}));

import { MeetingMinutesPanel } from "../MeetingMinutesPanel";

const models = [
  { id: "personal/MiniMax-M3", label: "个人 MiniMax", providerId: "personal", providerKind: "custom", source: "personal" as const },
  { id: "organization/MiniMax-M3", label: "组织 MiniMax", providerId: "echoagent-organization", providerKind: "custom", source: "organization" as const, insecureHttp: true },
  { id: "echoagent-ojlab/MiniMax-M3", label: "内置 MiniMax", providerId: "echoagent-ojlab", providerKind: "custom", source: "builtin" as const },
];

describe("MeetingMinutesPanel connection capability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.meetingList.mockResolvedValue([]);
    mocks.checkConnection.mockResolvedValue(undefined);
    mocks.captureSupport.mockResolvedValue({ systemAudio: true, detail: "首次使用需授权" });
  });

  it("uses the actual transcription check for personal and organization compatible gateways", async () => {
    render(<MeetingMinutesPanel modelId={models[0].id} models={models} />);

    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledWith(models[0].id, "personal"));
    expect(await screen.findByText("转写接口已就绪")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始录音" })).toBeEnabled();
    expect(screen.queryByRole("option", { name: "内置 MiniMax" })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "会议模型" }), { target: { value: models[1].id } });
    await waitFor(() => expect(mocks.checkConnection).toHaveBeenCalledWith(models[1].id, "echoagent-organization"));
    expect(await screen.findByText(/录音和 API Key 将通过明文网络传输/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始录音" })).toBeEnabled();
  });

  it("keeps recording disabled and explains an unavailable speech endpoint", async () => {
    mocks.checkConnection.mockRejectedValue(new Error("当前连接没有 /speech_to_text 转写接口"));
    render(<MeetingMinutesPanel modelId={models[0].id} models={models.slice(0, 1)} />);

    expect(await screen.findByRole("alert")).toHaveTextContent("当前连接没有 /speech_to_text 转写接口");
    expect(screen.getByRole("button", { name: "开始录音" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "重新检测" })).toBeInTheDocument();
  });

  it("passes the selected mixed audio source to the recorder", async () => {
    const record = { id: "record-1", title: "测试会议", status: "recording", transcript: [], chunks: [], recordedSamples: 0, durationSeconds: 0 };
    mocks.recorderStart.mockResolvedValue(record);
    mocks.meetingGet.mockResolvedValue(record);
    render(<MeetingMinutesPanel modelId={models[0].id} models={models.slice(0, 1)} />);

    const both = await screen.findByRole("button", { name: /两者都录/ });
    await waitFor(() => expect(both).toBeEnabled());
    fireEvent.click(both);
    expect(both).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/建议佩戴耳机/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "开始录音" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "开始录音" }));
    await waitFor(() => expect(mocks.recorderStart).toHaveBeenCalledWith(expect.any(String), models[0].id, "personal", "both"));
  });

  it("shows the saved meeting connection instead of the global model and uses a replacement for retry", async () => {
    const record = { id: "failed-model-binding", title: "需要恢复的会议", createdAt: 0, status: "failed", modelId: models[1].id, providerId: models[1].providerId, transcript: [], chunks: [], recordedSamples: 16000, durationSeconds: 1 };
    mocks.meetingList.mockResolvedValue([record]);
    mocks.meetingProcess.mockResolvedValue({ ...record, status: "completed" });
    render(<MeetingMinutesPanel modelId={models[0].id} models={models} />);
    const selector = await screen.findByRole("combobox", { name: "本次处理模型" });
    expect(selector).toHaveValue(models[1].id);
    expect(screen.getByText(/录音和 API Key 将通过明文网络传输/)).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: models[0].id } });
    await waitFor(() => expect(screen.getByText("转写接口已就绪")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "开始转写并生成纪要" }));
    await waitFor(() => expect(mocks.meetingProcess).toHaveBeenCalledWith(record.id, { modelId: models[0].id, providerId: "personal" }));
  });

  it("allows a deleted meeting connection to be replaced when regenerating minutes", async () => {
    const record = { id: "deleted-model-binding", title: "连接删除后的会议", createdAt: 0, status: "completed", modelId: "deleted/MiniMax", providerId: "deleted", minutes: "# 原纪要", transcript: [{ id: 0, start: 0, end: 1, text: "已有转写", speaker: "说话人1" }], chunks: [], recordedSamples: 16000, durationSeconds: 1 };
    mocks.meetingList.mockResolvedValue([record]);
    mocks.meetingRegenerateMinutes.mockResolvedValue(record);
    render(<MeetingMinutesPanel modelId={models[0].id} models={models} />);
    const selector = await screen.findByRole("combobox", { name: "本次处理模型" });
    expect(screen.getByText(/原会议连接已不可用，请确认本次处理模型/)).toBeInTheDocument();
    fireEvent.change(selector, { target: { value: models[1].id } });
    await waitFor(() => expect(screen.getByText("转写接口已就绪")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    await waitFor(() => expect(mocks.meetingRegenerateMinutes).toHaveBeenCalledWith(record.id, { modelId: models[1].id, providerId: "echoagent-organization" }));
  });

  it("can generate minutes from saved text when the speech route is unavailable", async () => {
    const record = { id: "chat-only-minutes", title: "已有转写会议", createdAt: 0, status: "transcribed", modelId: models[0].id, providerId: "personal", transcript: [{ id: 0, start: 0, end: 1, text: "已有转写", speaker: "说话人1" }], chunks: [], recordedSamples: 16000, durationSeconds: 1 };
    mocks.meetingList.mockResolvedValue([record]);
    mocks.meetingRegenerateMinutes.mockResolvedValue(record);
    mocks.checkConnection.mockRejectedValue(new Error("当前连接没有转写接口"));
    render(<MeetingMinutesPanel modelId={models[0].id} models={models.slice(0, 1)} />);
    await screen.findByText(/已有转写仍可用于生成纪要/);
    fireEvent.click(screen.getByRole("button", { name: "生成会议纪要" }));
    await waitFor(() => expect(mocks.meetingRegenerateMinutes).toHaveBeenCalledWith(record.id, { modelId: models[0].id, providerId: "personal" }));
  });
});


describe("meeting content preservation", () => {
  const historic = { id: "historic", title: "历史会议", createdAt: 0, status: "completed", minutes: "# 原纪要", transcript: [{ id: 0, start: 0, end: 1, text: "原转写", speaker: "说话人1" }], chunks: [], recordedSamples: 16000, durationSeconds: 1 };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.meetingList.mockResolvedValue([historic]);
    mocks.checkConnection.mockResolvedValue(undefined);
    mocks.captureSupport.mockResolvedValue({ systemAudio: true });
  });
  it("retains historical selection and unsaved transcription during recorder updates", async () => {
    render(<MeetingMinutesPanel models={models.slice(0, 1)} />);
    await screen.findByRole("heading", { name: "历史会议" });
    fireEvent.click(screen.getByRole("button", { name: /完整转写/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "第 1 段转写" }), { target: { value: "校对草稿" } });
    act(() => mocks.listener?.({ meeting: { ...historic, id: "active", title: "活动会议", status: "recording" }, active: true, paused: false, level: 0.8, error: null, source: "microphone" }));
    expect(screen.getByRole("heading", { name: "历史会议" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "第 1 段转写" })).toHaveValue("校对草稿");
  });
  it("keeps processing polls running while another meeting emits frequent recording levels", async () => {
    vi.useFakeTimers();
    const processing = { ...historic, status: "transcribing", minutes: undefined };
    mocks.meetingList.mockResolvedValue([processing]);
    mocks.meetingGet.mockResolvedValue(processing);
    mocks.meetingJobActive.mockResolvedValue(true);
    const view = render(<MeetingMinutesPanel models={models.slice(0, 1)} />);
    try {
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
      for (let index = 0; index < 20; index += 1) {
        await act(async () => {
          mocks.listener?.({ meeting: { ...historic, id: "other-active", status: "recording" }, active: true, paused: false, level: index / 20, error: null, source: "microphone" });
          await vi.advanceTimersByTimeAsync(100);
        });
      }
      expect(mocks.meetingGet).toHaveBeenCalledWith("historic");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  it("preserves a minutes draft after leaving and returning to the page", async () => {
    const view = render(<MeetingMinutesPanel models={models.slice(0, 1)} />);
    await screen.findByRole("heading", { name: "历史会议" });
    fireEvent.click(screen.getByRole("button", { name: "编辑纪要" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑会议纪要" }), { target: { value: "跨页面草稿" } });
    view.unmount();
    render(<MeetingMinutesPanel models={models.slice(0, 1)} />);
    await screen.findByRole("heading", { name: "历史会议" });
    fireEvent.click(screen.getByRole("button", { name: "编辑纪要" }));
    expect(screen.getByRole("textbox", { name: "编辑会议纪要" })).toHaveValue("跨页面草稿");
  });
  it("saves edited minutes through the native persistence command", async () => {
    const edited = { ...historic, minutes: "# 已校对纪要" };
    mocks.meetingUpdate.mockResolvedValue(edited);
    render(<MeetingMinutesPanel models={models.slice(0, 1)} />);
    await screen.findByRole("heading", { name: "历史会议" });
    fireEvent.click(screen.getByRole("button", { name: "编辑纪要" }));
    fireEvent.change(screen.getByRole("textbox", { name: "编辑会议纪要" }), { target: { value: edited.minutes } });
    mocks.meetingList.mockResolvedValue([edited]);
    fireEvent.click(screen.getByRole("button", { name: "保存纪要" }));
    await waitFor(() => expect(mocks.meetingUpdate).toHaveBeenCalledWith("historic", { minutes: edited.minutes }));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "编辑会议纪要" })).toBeNull());
    expect(screen.getByText("已校对纪要")).toBeInTheDocument();
  });
});
