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

it("restores corrections and minutes after restart without changing the authoritative record", () => {
  const data = new Map<string, string>();
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const source = record([segment(0, "原始转写")]);
  const first = createMeetingDraftStore(storage);
  first.editTranscript(source, [segment(0, "重启后保留的校对")]);
  first.editMinutes(source, "重启后保留的纪要");
  first.ensureDurable();
  const restored = createMeetingDraftStore(storage);
  expect(restored.transcript(source).value[0].text).toBe("重启后保留的校对");
  expect(restored.minutes(source).value).toBe("重启后保留的纪要");
  expect(source.transcript[0].text).toBe("原始转写");
  restored.remove(source.id);
  expect(createMeetingDraftStore(storage).hasMinutes(source.id)).toBe(false);
});

it("keeps failed writes in memory and vetoes exit until durable storage recovers", () => {
  const data = new Map<string, string>();
  let failed = true;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => {
    if (failed) throw new Error("quota exceeded"); data.set(key, value);
  } };
  const source = record([segment(0, "原始转写")]);
  const store = createMeetingDraftStore(storage);
  store.editMinutes(source, "不能丢失");
  expect(store.minutes(source).value).toBe("不能丢失");
  expect(store.persistenceError()).toContain("尚未保存");
  expect(() => store.ensureDurable()).toThrow("quota exceeded");
  failed = false;
  store.ensureDurable();
  expect(store.persistenceError()).toBeNull();
  expect(createMeetingDraftStore(storage).minutes(source).value).toBe("不能丢失");
});

it("preserves corrupt bytes for recovery and requires an explicit reset", () => {
  const data = new Map<string, string>([["echo.meeting-drafts.v1", "corrupt-original-marker"]]);
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const store = createMeetingDraftStore(storage);
  expect(store.recoveryBytes()).toBe("corrupt-original-marker");
  expect(() => store.ensureDurable()).toThrow("读取失败");
  expect(data.get("echo.meeting-drafts.v1")).toBe("corrupt-original-marker");
  store.resetUnreadable();
  expect(data.get("echo.meeting-drafts.v1.recovery")).toBe("corrupt-original-marker");
  expect(() => store.ensureDurable()).not.toThrow();
});

it("allows only explicitly authorized exit without saving, and revokes that on a new edit", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("storage blocked"); } };
  const store = createMeetingDraftStore(storage);
  const source = record([segment(0, "原始转写")]);
  store.editMinutes(source, "当前输入");
  expect(() => store.ensureDurable()).toThrow();
  store.allowExitWithoutSaving();
  expect(() => store.ensureDurable()).not.toThrow();
  store.editMinutes(source, "继续编辑");
  expect(() => store.ensureDurable()).toThrow();
});

it("retries a transient initial read and preserves both recovered and current drafts", () => {
  const data = new Map<string, string>();
  const source = record([segment(0, "原始转写")]);
  const other = { ...source, id: "other" };
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
  const previous = createMeetingDraftStore(storage);
  previous.editMinutes(source, "原有草稿"); previous.editMinutes(other, "另一会议草稿");
  const original = data.get("echo.meeting-drafts.v1");
  let failed = true;
  const current = createMeetingDraftStore({ ...storage, getItem: key => { if (failed) throw new Error("temporary read error"); return storage.getItem(key); } });
  current.editMinutes(source, "当前窗口新编辑");
  expect(() => current.ensureDurable()).toThrow();
  failed = false;
  current.ensureDurable();
  expect(current.persistenceError()).toBeNull();
  expect(current.minutes(source).value).toBe("当前窗口新编辑");
  expect(current.minutes(other).value).toBe("另一会议草稿");
  expect(data.get("echo.meeting-drafts.v1.recovery")).toBe(original);
  expect(createMeetingDraftStore(storage).minutes(source).value).toBe("当前窗口新编辑");
});
