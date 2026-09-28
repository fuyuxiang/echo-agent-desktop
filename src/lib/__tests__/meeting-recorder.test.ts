// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const record = {
  id: "meeting-1", title: "产品会议", status: "recording", modelId: "MiniMax", providerId: "personal",
  captureSource: "both", recordedSamples: 0, durationSeconds: 0, transcript: [], chunks: [],
};

describe("native meeting recorder", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "meeting_create") return record;
      if (command === "meeting_capture_start") return { meetingId: record.id, active: true, paused: false, level: 0, recordedSamples: 0 };
      if (command === "meeting_capture_pause") return { ...record, status: "paused" };
      if (command === "meeting_capture_stop") return { ...record, status: "recorded", recordedSamples: 16_000, durationSeconds: 1 };
      return undefined;
    });
  });

  it("starts, pauses and saves a mixed system and microphone recording", async () => {
    const { meetingRecorder } = await import("../meeting-minutes");
    await meetingRecorder.start(record.title, record.modelId, record.providerId, "both");
    expect(mocks.invoke).toHaveBeenCalledWith("meeting_create", expect.objectContaining({ captureSource: "both" }));
    expect(mocks.invoke).toHaveBeenCalledWith("meeting_capture_start", { meetingId: record.id, mode: "both" });
    expect(meetingRecorder.current()).toMatchObject({ active: true, source: "both" });

    await meetingRecorder.setPaused(true);
    expect(mocks.invoke).toHaveBeenCalledWith("meeting_capture_pause", { meetingId: record.id, paused: true });
    expect(meetingRecorder.current().paused).toBe(true);

    const saved = await meetingRecorder.stop();
    expect(saved.status).toBe("recorded");
    expect(meetingRecorder.current()).toMatchObject({ active: false, source: null });
  });

  it("removes an empty record if native capture cannot start", async () => {
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "meeting_create") return record;
      if (command === "meeting_capture_start") throw new Error("未授权系统音频录制");
      return undefined;
    });
    const { meetingRecorder } = await import("../meeting-minutes");
    await expect(meetingRecorder.start(record.title, record.modelId, record.providerId, "both")).rejects.toThrow("未授权系统音频录制");
    expect(mocks.invoke).toHaveBeenCalledWith("meeting_delete", { meetingId: record.id });
    expect(meetingRecorder.current().active).toBe(false);
  });
});
