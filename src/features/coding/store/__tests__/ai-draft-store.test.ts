import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAFT_TTL_MS,
  useAiDraftStore,
} from "@/features/coding/store/ai-draft-store";

describe("useAiDraftStore", () => {
  beforeEach(() => {
    useAiDraftStore.getState().clear();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("setDraft 后 draft 不为 null", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "解释这段代码",
      contextPaths: ["/repo/src/foo.ts"],
      source: "context-menu",
    });
    const { draft } = useAiDraftStore.getState();
    expect(draft).not.toBeNull();
    expect(draft?.prompt).toBe("解释这段代码");
    expect(draft?.contextPaths).toEqual(["/repo/src/foo.ts"]);
    expect(draft?.source).toBe("context-menu");
  });

  it("consume 返回当前 draft 并清空", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "p",
      contextPaths: ["/a.ts"],
      source: "context-menu",
    });
    const draft = useAiDraftStore.getState().consume();
    expect(draft?.prompt).toBe("p");
    expect(useAiDraftStore.getState().draft).toBeNull();
  });

  it("连续两次 consume 第二次返回 null", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "p",
      contextPaths: [],
      source: "external",
    });
    const first = useAiDraftStore.getState().consume();
    const second = useAiDraftStore.getState().consume();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it("setDraft 写入相同 source 不同 prompt → 后者覆盖前者", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "first",
      contextPaths: [],
      source: "context-menu",
    });
    useAiDraftStore.getState().setDraft({
      prompt: "second",
      contextPaths: [],
      source: "context-menu",
    });
    expect(useAiDraftStore.getState().draft?.prompt).toBe("second");
  });

  it("createdAt 字段自动写入当前时间", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "p",
      contextPaths: [],
      source: "external",
    });
    expect(useAiDraftStore.getState().draft?.createdAt).toBe(Date.now());
  });

  it("contextPaths 自动去重", () => {
    useAiDraftStore.getState().setDraft({
      prompt: "p",
      contextPaths: ["/a.ts", "/a.ts", "/b.ts"],
      source: "external",
    });
    expect(useAiDraftStore.getState().draft?.contextPaths).toEqual([
      "/a.ts",
      "/b.ts",
    ]);
  });

  it("DRAFT_TTL_MS 是 5 分钟", () => {
    expect(DRAFT_TTL_MS).toBe(5 * 60 * 1000);
  });
});
