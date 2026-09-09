import { beforeEach, describe, expect, it } from "vitest";
import { knowledgeSourcesForSession, useKnowledgeStore } from "../knowledge-store";

describe("knowledge source preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    useKnowledgeStore.setState({
      defaultSources: [],
      sessionSources: {},
      sourceCount: 0,
      retrievals: {},
      turnTraces: {},
    });
  });

  it("新任务只消费一次首页选择，下一任务恢复默认不选", () => {
    useKnowledgeStore.getState().setDefaultSources(["personal", "organization"]);

    expect(useKnowledgeStore.getState().bindSessionSources("new-session", true)).toEqual([
      "personal",
      "organization",
    ]);
    expect(knowledgeSourcesForSession("new-session")).toEqual(["personal", "organization"]);
    expect(useKnowledgeStore.getState().defaultSources).toEqual([]);
  });

  it("打开没有历史偏好的旧任务时不会套用首页待发送选择", () => {
    useKnowledgeStore.getState().setDefaultSources(["personal"]);

    expect(useKnowledgeStore.getState().bindSessionSources("existing-session")).toEqual([]);
    expect(useKnowledgeStore.getState().defaultSources).toEqual(["personal"]);
  });

  it("来源去重并按稳定顺序保存", () => {
    useKnowledgeStore.getState().setSessionSources("session-1", [
      "organization",
      "personal",
      "organization",
    ]);
    expect(knowledgeSourcesForSession("session-1")).toEqual(["personal", "organization"]);
  });
});
