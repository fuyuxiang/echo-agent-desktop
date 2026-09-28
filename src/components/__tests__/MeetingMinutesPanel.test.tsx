// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkConnection: vi.fn(),
  meetingList: vi.fn(),
  captureSupport: vi.fn(),
  recorderStart: vi.fn(),
  meetingGet: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => ({ filesystemPickFiles: vi.fn() }));
vi.mock("@/lib/meeting-minutes", () => ({
  meetingCheckConnection: mocks.checkConnection,
  isMiniMaxMeetingModel: (model: { id: string; remoteModelId?: string }) =>
    /minimax/i.test(model.remoteModelId || model.id),
  meetingList: mocks.meetingList,
  meetingCaptureSupport: mocks.captureSupport,
  meetingGet: mocks.meetingGet,
  meetingRecorder: {
    current: () => ({ meeting: null, active: false, paused: false, level: 0, error: null, source: null }),
    subscribe: () => () => {},
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
});
