import { createRef } from "react";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationNavigator } from "../ConversationNavigator";
import { buildQuestionHistory } from "../QuestionHistoryPopover";
import { buildConversationTurns, readingTurnIndex, type ConversationTurn } from "@/lib/conversation-navigation";
import type { ChatMessage } from "@/stores/session-store";

const turns: ConversationTurn[] = Array.from({length:30}, (_, i) => ({id:`u${i}`,order:i+1,text:`提问 ${i+1}`,preview:`提问 ${i+1}`,answer:`公开回复 ${i+1}`,status:"已完成"}));

describe("conversation turn navigation", () => {
  it("uses stable chronological user ids and only completed public answers", () => {
    const messages: ChatMessage[] = [
      {id:"u1",role:"user",complete:true,parts:[{kind:"text",text:"检查结果<!--EXPERT_PERSONA_BEGIN-->秘密<!--EXPERT_PERSONA_END-->"}]},
      {id:"a1",role:"assistant",complete:true,parts:[{kind:"thought",text:"内部推理"},{kind:"text",text:"<think>隐藏分析</think>可见结果"}]},
      {id:"u2",role:"user",complete:true,parts:[],attachments:["/private/report.pdf"]},
      {id:"a2",role:"assistant",complete:false,parts:[{kind:"text",text:"未完成文本"}]},
    ];
    const result = buildConversationTurns(messages, buildQuestionHistory(messages));
    expect(result.map(turn => turn.id)).toEqual(["u1","u2"]);
    expect(result[0]).toMatchObject({text:"检查结果",answer:"可见结果"});
    expect(result[1]).toMatchObject({text:"附件：report.pdf",answer:""});
    expect(JSON.stringify(result)).not.toMatch(/秘密|内部推理|隐藏分析|未完成文本/);
    expect(buildConversationTurns(messages.slice(0,2),buildQuestionHistory(messages.slice(0,2)))).toHaveLength(1);
  });

  it("keeps long replies in their reading interval", () => {
    expect(readingTurnIndex([-1000,500,1200],120)).toBe(0);
    expect(readingTurnIndex([-1600,-100,600],120)).toBe(1);
    expect(readingTurnIndex([-2000,-900,-100],120)).toBe(2);
  });

  it("windows a long conversation around the reading position; preview does not jump", async () => {
    const scrollRef = createRef<HTMLDivElement>(), contentRef = createRef<HTMLDivElement>();
    const select = vi.fn(), directory = vi.fn();
    render(<><div ref={scrollRef}><div ref={contentRef}>{turns.map(turn => <div key={turn.id} data-msg-id={turn.id}>{turn.text}</div>)}</div></div>
      <ConversationNavigator turns={turns} scrollRef={scrollRef} contentRef={contentRef} onSelect={select} onDirectory={directory} /></>);
    const viewport = scrollRef.current!;
    Object.defineProperty(viewport,"clientHeight",{configurable:true,value:600});
    let offset = 1500;
    for (const [index,row] of Array.from(viewport.querySelectorAll<HTMLElement>("[data-msg-id]")).entries()) {
      row.getBoundingClientRect = () => ({top:index*100-offset} as DOMRect);
    }
    fireEvent.scroll(viewport);
    await waitFor(() => expect(screen.getByRole("button",{name:"第 17 轮：提问 17"})).toHaveAttribute("aria-current","step"));
    const nav = screen.getByRole("navigation",{name:"当前会话轮次导航"});
    expect(nav.querySelectorAll(".conversation-nav__mark")).toHaveLength(11);
    const mark = within(nav).getByRole("button",{name:"第 16 轮：提问 16"});
    fireEvent.mouseEnter(mark);
    expect(screen.getByRole("group",{name:"第 16 轮预览"})).toHaveTextContent("公开回复 16");
    expect(select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"查看该轮"}));
    expect(select).toHaveBeenCalledWith("u15");
    fireEvent.click(within(nav).getByRole("button",{name:"对话目录，共 30 轮"}));
    expect(directory).toHaveBeenCalledWith(expect.any(HTMLButtonElement));
    offset=2500; fireEvent.scroll(viewport);
    await waitFor(() => expect(screen.getByRole("button",{name:"第 27 轮：提问 27"})).toHaveAttribute("aria-current","step"));
  });
});
