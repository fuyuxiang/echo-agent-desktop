import { describe, expect, it } from "vitest";
import { createMeetingDraftStore } from "../meeting-drafts";
import type { MeetingRecord, TranscriptSegment } from "../meeting-minutes";

const segment = (start: number, text: string, id = start): TranscriptSegment => ({ id, start, end: start + 1, speaker: "S1", text });
const record = (transcript: TranscriptSegment[], minutes = "旧纪要"): MeetingRecord => ({
  id: "meeting", title: "会议", createdAt: 0, updatedAt: 0, status: "completed", modelId: "m", providerId: "p",
  durationSeconds: 2, recordedSamples: 32000, audioPath: "audio.wav", chunks: [], transcript, minutes,
});

describe("versioned meeting drafts", () => {
  it("preserves corrections and inserts recovered segments even when IDs are renumbered", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(1, "原文", 0)]);
    store.editTranscript(old, [{ ...old.transcript[0], text: "已校对", speaker: "张三" }]);
    const latest = record([segment(0, "新增段落", 0), segment(1, "原文", 1)]);
    expect(store.transcript(latest).value).toEqual([latest.transcript[0], { ...latest.transcript[1], text: "已校对", speaker: "张三" }]);
    expect(store.transcript(latest).conflict).toBeUndefined();
    expect(store.transcript(latest).value).toHaveLength(2);
  });

  it("keeps a conflict across repeated refreshes until the user chooses", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(0, "原文")]);
    store.editTranscript(old, [segment(0, "人工校对")]);
    const latest = record([segment(0, "服务端修订")]);
    expect(store.transcript(latest).conflict).toMatchObject({ canKeep: true });
    expect(store.transcript(latest).conflict).toBeDefined();
    store.acceptTranscript(latest);
    expect(store.transcript(latest).value).toEqual([segment(0, "人工校对")]);
    expect(store.transcript(latest).conflict).toBeUndefined();
  });

  it("does not append obsolete segments after resegmentation and retains their original text", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(0, "原文")]);
    store.editTranscript(old, [segment(0, "不能丢失的校对")]);
    const latest = record([{ ...segment(0, "重新分段"), end: 2 }]);
    const draft = store.transcript(latest);
    expect(draft.value).toEqual(latest.transcript);
    expect(draft.conflict).toEqual({ canKeep: false, original: "[0–1] S1：不能丢失的校对" });
    store.acceptTranscript(latest);
    expect(store.transcript(latest).conflict).toBeDefined();
    store.discardTranscript(latest.id);
    expect(store.transcript(latest).conflict).toBeUndefined();
  });

  it("does not mistake the temporary empty processing manifest for resegmentation", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(0, "原文")]);
    store.editTranscript(old, [segment(0, "人工校对")]);
    expect(store.transcript({ ...old, transcript: [], status: "transcribing" }).conflict).toBeUndefined();
    expect(store.transcript(record([...old.transcript, segment(1, "新增")])).value).toEqual([segment(0, "人工校对"), segment(1, "新增")]);
  });

  it("requires an explicit choice after minutes or their source transcript changes", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(0, "原文")]);
    store.editMinutes(old, "旧版人工修订");
    const latest = record([segment(0, "原文")], "重新生成的纪要");
    expect(store.minutes(latest).conflict?.original).toBe("旧版人工修订");
    store.discardMinutes(old.id);
    expect(store.minutes(latest).value).toBe(latest.minutes);
    store.editMinutes(latest, "继续校对");
    expect(store.minutes({ ...latest, transcript: [segment(0, "转写也已更新")] }).conflict).toBeDefined();
  });

  it("keeps edits made after a save was submitted and rebases them on the save acknowledgement", () => {
    const store = createMeetingDraftStore();
    const old = record([segment(0, "原文")]);
    const submitted = [segment(0, "第一次校对")];
    store.editTranscript(old, submitted);
    store.editTranscript(old, [segment(0, "保存期间的新校对")]);
    const saved = record(submitted);
    store.savedTranscript(saved, submitted);
    expect(store.transcript(saved).value).toEqual([segment(0, "保存期间的新校对")]);
    expect(store.transcript(saved).conflict).toBeUndefined();
    store.editMinutes(saved, "第一次纪要");
    store.editMinutes(saved, "保存期间的新纪要");
    store.savedMinutes({ ...saved, minutes: "第一次纪要" }, "第一次纪要");
    expect(store.minutes({ ...saved, minutes: "第一次纪要" }).value).toBe("保存期间的新纪要");
    expect(store.minutes({ ...saved, minutes: "第一次纪要" }).conflict).toBeUndefined();
  });
});
