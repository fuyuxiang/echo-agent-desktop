import { describe, expect, it } from "vitest";
import { parseInspirationCards } from "../inspiration";

describe("parseInspirationCards", () => {
  it("接受 JSON fence 与少量前后文，并生成可执行卡片", () => {
    const cards = parseInspirationCards(
      "生成结果：```json\n[{\"title\":\"计划复盘\",\"summary\":\"把本周阻塞按影响排序\",\"takeaway\":\"先处理高影响项\"}]\n```",
      "project_management",
      1_700_000_000_000,
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      title: "计划复盘",
      detail: "先处理高影响项",
      category: "project_management",
      prompt: "计划复盘",
    });
  });

  it("丢弃空卡片并限制最多 10 条", () => {
    const values = [
      { title: "", summary: "invalid" },
      ...Array.from({ length: 12 }, (_, index) => ({ title: `t${index}`, summary: `s${index}` })),
    ];
    const cards = parseInspirationCards(JSON.stringify(values), "general", 1);
    expect(cards).toHaveLength(10);
    expect(cards[0].title).toBe("t0");
  });

  it("非数组结果返回空列表", () => {
    expect(parseInspirationCards('{"title":"x"}', "general")).toEqual([]);
  });
});
