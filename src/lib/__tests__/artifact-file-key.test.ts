import { describe, expect, it } from "vitest";
import { artifactFileKey } from "../artifact-file-key";
import { collectSessionArtifacts, mergeSessionArtifacts } from "../session-artifacts";
import type { ChatMessage } from "@/stores/session-store";

const tool = (kind: string, input: object, status = "completed"): ChatMessage => ({
  id: kind, role: "assistant", complete: true, parts: [{kind: "tool_call", toolCall: {
    toolCallId: kind, kind, title: kind, status, rawInput: input, content: [],
  }}],
} as ChatMessage);

describe("artifact file identity", () => {
  it("resolves relative, dotted and absolute outputs under the session cwd", () => {
    expect(["./output/summary.txt", "output/./summary.txt", "/work/output/summary.txt"]
      .map(path => artifactFileKey(path, "/work"))).toEqual(Array(3).fill("/work/output/summary.txt"));
    expect(artifactFileKey(".\\output\\summary.txt", "c:\\work")).toBe("C:/work/output/summary.txt");
    expect(artifactFileKey("C:summary.txt", "/work")).toBe("C:summary.txt");
    expect(artifactFileKey("\\\\server\\share\\..\\file.txt")).toBe("//server/share/../file.txt");
  });
  it("preserves case and directory identity without merging basenames", () => {
    expect(new Set(["A/report.txt", "a/report.txt", "B/report.txt"].map(p => artifactFileKey(p,"/work"))).size).toBe(3);
  });
  it("deduplicates catalog and transcript while honoring later deletion and moves", () => {
    const catalog = mergeSessionArtifacts([{id:"legacy",path:"./output/a.txt",kind:"document_export",title:"a",toolCallId:"receipt",status:"completed"}], "/work");
    const written = tool("write", {path:"/work/output/a.txt"});
    expect(collectSessionArtifacts([written], "/work", catalog)).toHaveLength(1);
    expect(collectSessionArtifacts([written,tool("delete",{path:"output/a.txt"})], "/work", catalog)).toEqual([]);
    expect(collectSessionArtifacts([written,tool("move",{source:"output/a.txt",target:"output/b.txt"})], "/work", catalog).map(a=>a.path)).toEqual(["/work/output/b.txt"]);
    expect(collectSessionArtifacts([tool("write",{path:"failed.txt"},"failed")], "/work")).toEqual([]);
  });
});


it("does not collapse parent segments through a possible symbolic link", () => {
  const path = "/work/linked-dir/../report.txt";
  expect(artifactFileKey(path)).not.toBe(artifactFileKey("/work/report.txt"));
  const [artifact] = collectSessionArtifacts([tool("write", {path})], "/work");
  expect(artifact.path).toBe(path);
  expect(mergeSessionArtifacts([artifact], "/work")[0].path).toBe(path);
});

it("orders durable exports against historical and later native tool operations", () => {
  const exported = {id:"native",path:"/work/report.docx",kind:"document_export",title:"报告",toolCallId:"document-export:hash",status:"completed" as const,producedAt:200};
  const operation = (kind: string, completedAt?: number) => ({...tool(kind,{path:exported.path}),completedAt});
  expect(collectSessionArtifacts([operation("delete",100)],"/work",[exported])).toEqual([expect.objectContaining({kind:"document_export"})]);
  expect(collectSessionArtifacts([operation("delete")],"/work",[exported])).toHaveLength(1);
  expect(collectSessionArtifacts([operation("write",100)],"/work",[exported])[0].toolCallId).toBe(exported.toolCallId);
  expect(collectSessionArtifacts([operation("delete",300)],"/work",[exported])).toEqual([]);
  expect(collectSessionArtifacts([operation("write",300)],"/work",[exported])[0].kind).toBe("write");
});
