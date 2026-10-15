import { describe, expect, it } from "vitest";
import { documentProgressFromRawOutput, documentProgressLabel, documentProgressSummary } from "../document-progress";

const progress = { source: "比赛.xlsx", revision: "a".repeat(64), readRecords: 20, totalRecords: 100, checkpointCount: 2, complete: false };
describe("document reading progress", () => {
  it("accepts native typed output and distinguishes reading from analysis", () => {
    const p = documentProgressFromRawOutput({ type: "ReadFile", FileContent: { document_progress: progress } });
    expect(p).toEqual(progress);
    expect(documentProgressLabel(p!)).toBe("比赛.xlsx · 已读取 20 / 100 段内容");
  });
  it("rejects invalid coverage and prose-shaped metadata", () => {
    expect(documentProgressFromRawOutput({ ...progress })).toBeUndefined();
    for (const readRecords of [-1, 101, Infinity, "20"]) {
      expect(documentProgressFromRawOutput({ type: "ReadFile", FileContent: { document_progress: { ...progress, readRecords } } })).toBeUndefined();
    }
  });
  it("accepts PDF image coverage with page units and a safe findings path", () => {
    const p = documentProgressFromRawOutput({ type: "ReadFile", PdfPageImages: { document_progress: {
      ...progress, source: "扫描.pdf", readPages: 1, totalPages: 3, scope: "第 1 页",
      checkpointPath: "/tmp/session/findings.md", updateSequence: 8,
    } } })!;
    expect(documentProgressLabel(p)).toBe("扫描.pdf · 已读取 1 / 3 页");
    expect(p.checkpointPath).toBe("/tmp/session/findings.md");
    expect(documentProgressFromRawOutput({ type: "ReadFile", PdfPageImages: { document_progress: {
      ...progress, readPages: 4, totalPages: 3,
    } } })).toBeUndefined();
    const unsafe = documentProgressFromRawOutput({ type: "ReadFile", FileContent: { document_progress: {
      ...progress, checkpointPath: "javascript:alert(1)",
    } } });
    expect(unsafe?.checkpointPath).toBeUndefined();
  });
  it("does not regress after out-of-order calls and keeps different source paths separate", () => {
    const first = { ...progress, sourcePath: "/a/比赛.xlsx", updateSequence: 5, readRecords: 100, complete: true };
    const late = { ...first, updateSequence: 4, readRecords: 20, complete: false };
    expect(documentProgressSummary([first, late])).toBe("比赛.xlsx · 已读取 100/100 段内容");
    expect(documentProgressSummary([first, late, { ...late, sourcePath: "/b/比赛.xlsx" }]))
      .toBe("2 份资料 · 已读完 1 份");
    expect(documentProgressSummary([first, { ...late, revision: "b".repeat(64), updateSequence: 6 }]))
      .toBe("比赛.xlsx · 已读取 20/100 段内容");
  });
});
