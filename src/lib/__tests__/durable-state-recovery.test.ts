import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

describe("draft and outbox recovery", () => {
  it("restores text, attachments and queue order; in-flight sends stay uncertain", async () => {
    const { useMessageQueueStore } = await import("@/stores/message-queue-store");
    const { useSessionsStore } = await import("@/stores/sessions-store");
    const { saveDraftAttachments } = await import("../draft-attachments");
    useSessionsStore.getState().setDraft("s1", "尚未发送的长需求");
    saveDraftAttachments("s1", ["/work/image.png"]);
    const id = useMessageQueueStore.getState().enqueue("s1", "修改文件", ["/work/a.txt"]);
    useMessageQueueStore.getState().enqueue("s1", "核对结果");
    useMessageQueueStore.getState().claimById("s1", id, "prompt-1");
    vi.resetModules();
    const recovered = (await import("@/stores/message-queue-store")).useMessageQueueStore;
    expect((await import("@/stores/sessions-store")).useSessionsStore.getState().drafts.s1).toBe("尚未发送的长需求");
    expect((await import("../draft-attachments")).draftAttachments("s1")).toEqual(["/work/image.png"]);
    expect(recovered.getState().getQueue("s1")).toMatchObject([
      { id, status: "paused", recovery: "uncertain", promptId: "prompt-1", attachments: ["/work/a.txt"] },
      { status: "paused", recovery: "queued", text: "核对结果" },
    ]);
    expect(recovered.getState().claimNext("s1", "new")).toBeNull();
    expect(recovered.getState().settleSending("s1", "consume", "other-prompt")).toBeNull();
    recovered.getState().settleSending("s1", "consume", "prompt-1");
    expect(recovered.getState().getQueue("s1").map((item) => item.text)).toEqual(["核对结果"]);
  });

  it("rejects enqueue/admission on storage failure without consuming the draft", async () => {
    const { useMessageQueueStore: queue } = await import("@/stores/message-queue-store");
    queue.getState().enqueue("s1", "already saved");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Full", "QuotaExceededError"); });
    expect(() => queue.getState().enqueue("s1", "new input")).toThrow("队列未能保存");
    expect(queue.getState().claimNext("s1", "prompt")).toBeNull();
    expect(queue.getState().getQueue("s1")).toMatchObject([{ status: "queued", text: "already saved" }]);
    expect(Object.keys((await import("../durable-ui-state")).useStorageHealth.getState().errors)).toContain("echoagent.outbox.v1");
  });

  it("preserves corrupt persisted state instead of replacing it with an empty queue", async () => {
    const raw = "{broken";
    localStorage.setItem("echoagent.outbox.v1", raw);
    const queue = (await import("@/stores/message-queue-store")).useMessageQueueStore;
    expect(() => queue.getState().enqueue("s1", "draft")).toThrow();
    expect(localStorage.getItem("echoagent.outbox.v1")).toBe(raw);
  });
});
