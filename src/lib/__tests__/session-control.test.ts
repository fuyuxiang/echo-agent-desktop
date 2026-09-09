import { beforeEach, describe, expect, it } from "vitest";
import {
  parseSessionControlIntent,
  persistSessionControl,
  readPersistedSessionControl,
} from "../session-control";

describe("session control", () => {
  beforeEach(() => localStorage.removeItem("echoagent.session-controls.v1"));

  it("只把明确、完整的控制短语识别为本地动作", () => {
    expect(parseSessionControlIntent("暂停")).toBe("pause");
    expect(parseSessionControlIntent("/pause")).toBe("pause");
    expect(parseSessionControlIntent("中止")).toBe("stop");
    expect(parseSessionControlIntent("停止任务")).toBe("stop");
    expect(parseSessionControlIntent("请解释“中止”是什么意思")).toBeNull();
  });

  it("只持久化稳定状态并能按 session 恢复", () => {
    persistSessionControl("s1", {
      action: "pause",
      phase: "paused",
      promptId: "p1",
      requestedAt: 10,
    });
    expect(readPersistedSessionControl("s1")).toEqual({
      action: "pause",
      phase: "paused",
      promptId: "p1",
      requestedAt: 10,
    });
    persistSessionControl("s1");
    expect(readPersistedSessionControl("s1")).toBeUndefined();
  });
});
