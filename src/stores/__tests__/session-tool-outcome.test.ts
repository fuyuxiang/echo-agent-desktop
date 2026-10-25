import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSessionStore } from "../session-store";
import { summarizeExecutionProcess } from "@/lib/execution-process";

const update = (fields: Record<string,unknown>) => useSessionStore.getState().applyUpdate({__sessionId:"outcome-session",...fields} as never);
const meta = (time?: number, replay = false) => ({isReplay:replay,...(time == null ? {} : {agentTimestampMs:time}),"echo.agent/tool":{version:1,name:"Shell"}});
const tool = (id: string, time?: number, replay = false) => update({sessionUpdate:"tool_call",toolCallId:id,kind:"execute",title:"查询天气",rawInput:{command:"fetch-weather"},status:"in_progress",content:[],_meta:meta(time,replay)});
const finish = (id: string, status: string, time?: number, replay = false) => update({sessionUpdate:"tool_call_update",toolCallId:id,status,content:[{type:"text",text:status === "failed" ? "连接超时" : "查询结果"}],_meta:meta(time,replay)});
const lastMessage = () => {
  const messages = useSessionStore.getState().messages;
  return messages[messages.length-1];
};
const summary = () => summarizeExecutionProcess(lastMessage().parts,false,"end_turn");

describe("tool outcome evidence ingestion", () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(100);
    useSessionStore.setState(useSessionStore.getInitialState());
    useSessionStore.getState().setSession("outcome-session");
  });
  afterEach(() => vi.useRealTimers());

  it.each([false,true])("实时和持久回放均保留身份、顺序和原始失败（回放=%s）", replay => {
    tool("failed",1_000,replay); finish("failed","failed",2_000,replay);
    tool("retry",3_000,replay); finish("retry","completed",4_000,replay);
    expect(summary()).toMatchObject({state:"complete",failedToolCount:1,unresolvedToolCount:0});
    expect(lastMessage().parts).toEqual([
      expect.objectContaining({toolCall:expect.objectContaining({toolCallId:"failed",toolName:"Shell",startedAt:1_000,finishedAt:2_000,status:"failed",content:[{type:"text",text:"连接超时"}]})}),
      expect.objectContaining({toolCall:expect.objectContaining({toolCallId:"retry",toolName:"Shell",startedAt:3_000,finishedAt:4_000,status:"completed"})}),
    ]);
  });
  it("并行调用的失败结束晚于另一个调用开始时不能算恢复", () => {
    tool("failed",1_000); tool("parallel",1_500);
    finish("failed","failed",2_000); finish("parallel","completed",3_000);
    expect(summary().state).toBe("partial");
  });
  it("旧回放不补造本地时间或自动恢复证据", () => {
    tool("failed",undefined,true); finish("failed","failed",undefined,true);
    tool("retry",undefined,true); finish("retry","completed",undefined,true);
    expect(summary().state).toBe("partial");
    expect(lastMessage().parts[0]).toMatchObject({toolCall:{startedAt:undefined,finishedAt:undefined}});
  });
  it("完整工具快照更新不能重写最初开始时间", () => {
    tool("failed",1_000); finish("failed","failed",2_000);
    tool("retry",3_000); tool("retry",3_500); finish("retry","completed",4_000);
    expect(lastMessage().parts[1]).toMatchObject({toolCall:{startedAt:3_000}});
    expect(summary().state).toBe("complete");
  });
  it("正常结束后的迟到工具失败会重新计算结果", () => {
    useSessionStore.getState().startStreaming("outcome-session","outcome-prompt");
    tool("first",1_000); finish("first","completed",2_000);
    tool("second",3_000); finish("second","completed",4_000);
    useSessionStore.getState().markComplete({sessionId:"outcome-session",promptId:"outcome-prompt",stopReason:"end_turn"});
    expect(summary().state).toBe("complete");
    finish("second","failed",4_500);
    expect(summary().state).toBe("partial");
  });
});
