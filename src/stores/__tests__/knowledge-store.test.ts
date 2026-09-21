import { beforeEach, describe, expect, it } from "vitest";
import {
  knowledgeSourcesForSession,
  organizationScopeIdsForSession,
  useKnowledgeStore,
} from "../knowledge-store";

describe("knowledge source preferences", () => {
  beforeEach(() => {
    localStorage.clear();
    useKnowledgeStore.setState({
      defaultSources: [],
      defaultOrganizationScopeIds: [],
      sessionSources: {},
      sessionOrganizationScopeIds: {},
      sourceCount: 0,
      retrievals: {},
      turnTraces: {},
    });
  });

  it("新任务只消费一次首页选择，下一任务恢复默认不选", () => {
    useKnowledgeStore.getState().setDefaultSources(["personal", "organization"]);
    useKnowledgeStore.getState().setDefaultOrganizationScopeIds(["team-1"]);

    expect(useKnowledgeStore.getState().bindSessionSources("new-session", true)).toEqual([
      "personal",
      "organization",
    ]);
    expect(knowledgeSourcesForSession("new-session")).toEqual(["personal", "organization"]);
    expect(organizationScopeIdsForSession("new-session")).toEqual(["team-1"]);
    expect(useKnowledgeStore.getState().defaultSources).toEqual([]);
    expect(useKnowledgeStore.getState().defaultOrganizationScopeIds).toEqual([]);
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

  it("移除组织知识时同步清理任务的组织范围", () => {
    useKnowledgeStore.getState().setSessionSources("session-1", ["organization"]);
    useKnowledgeStore.getState().setSessionOrganizationScopeIds("session-1", [
      "team-1",
      "team-1",
      "invalid,scope",
    ]);
    expect(organizationScopeIdsForSession("session-1")).toEqual(["team-1"]);

    useKnowledgeStore.getState().setSessionSources("session-1", ["personal"]);
    expect(organizationScopeIdsForSession("session-1")).toEqual([]);
  });
});
