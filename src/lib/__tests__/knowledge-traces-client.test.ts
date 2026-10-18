import { beforeEach, describe, expect, it, vi } from "vitest";
import { hydrateKnowledgeTraces, persistKnowledgeTrace } from "../knowledge-traces-client";
import { useKnowledgeStore, type KnowledgeTurnTrace } from "@/stores/knowledge-store";
const api = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => api);
vi.mock("../tauri-kb-reader", () => ({ isTauriAvailable: () => true }));
const trace: KnowledgeTurnTrace = {selectedSources:["personal"],personal:{state:"used",resultCount:1,sourceCount:1,titles:["Snapshot"],items:[{title:"Snapshot",path:"/old/source.md",snippet:"original evidence",startLine:3,endLine:4}]}};

describe("durable provenance bridge", () => {
  beforeEach(() => { vi.resetAllMocks(); useKnowledgeStore.setState({ turnTraces: {}, retrievals: {} }); });
  it("saves a snapshot then restores all 115 turns through pages after memory loss", async () => {
    const persisted: Record<string, KnowledgeTurnTrace> = {};
    api.invoke.mockImplementation(async (command: string, args: {sessionId:string;promptId:string;trace:KnowledgeTurnTrace;cursor?:string}) => {
      if (command === "knowledge_trace_save") { persisted[args.promptId] = structuredClone(args.trace); return; }
      const offset = Number(args.cursor ?? 0), entries = Object.entries(persisted).slice(offset, offset + 50);
      return {traces:Object.fromEntries(entries),nextCursor:offset+50<Object.keys(persisted).length?String(offset+50):null};
    });
    for (let i=0;i<115;i++) { useKnowledgeStore.getState().restoreTurnTraces("s", {[`p${i}`]:trace}); await persistKnowledgeTrace("s", `p${i}`); }
    useKnowledgeStore.setState({turnTraces:{}}); // simulate process restart
    await hydrateKnowledgeTraces("s");
    expect(Object.keys(useKnowledgeStore.getState().turnTraces.s)).toHaveLength(115);
    expect(useKnowledgeStore.getState().turnTraces.s.p0).toEqual(trace);
    expect(api.invoke.mock.calls.filter(([command])=>command==="knowledge_traces_load")).toHaveLength(3);
    expect(localStorage.getItem("echoagent.knowledge-preferences.v3") ?? "").not.toContain("original evidence");
  });
  it("rejects corrupt provenance without erasing an existing snapshot", async () => {
    useKnowledgeStore.getState().restoreTurnTraces("s",{original:trace});
    api.invoke.mockResolvedValue({traces:{broken:{selectedSources:["forged"]}},nextCursor:null});
    await expect(hydrateKnowledgeTraces("s")).rejects.toThrow("原记录已保留");
    expect(useKnowledgeStore.getState().turnTraces.s.original).toEqual(trace);
  });
  it("propagates native save errors so a caller can retain its unsent draft", async () => {
    useKnowledgeStore.getState().restoreTurnTraces("s",{p:trace}); api.invoke.mockRejectedValue(new Error("disk full"));
    await expect(persistKnowledgeTrace("s","p")).rejects.toThrow("disk full");
  });
});
