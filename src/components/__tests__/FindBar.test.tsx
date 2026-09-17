import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { FindBar } from "../FindBar";
import type { ChatMessage } from "@/stores/session-store";

function msg(id: string, text: string, role: "user" | "assistant" = "user"): ChatMessage {
  return {
    id,
    role,
    parts: [{ kind: "text", text }],
  } as ChatMessage;
}

const messages: ChatMessage[] = [
  msg("m1", "鸟鸟鸟喜欢站在电线杆上"),
  msg("m2", "小鸟飞过天空,鸟叫声清脆"),
  msg("m3", "没有匹配的动物描述"),
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

/** 受控包装器:把 query 状态托管在测试自己手里,模拟真实使用方式。 */
function ControlledFindBar(props: Omit<React.ComponentProps<typeof FindBar>, "query" | "onQueryChange">) {
  const [q, setQ] = useState("");
  return (
    <>
      <FindBar {...props} query={q} onQueryChange={setQ} />
      {/* 给测试一个访问 input 的稳定锚点 */}
      <input data-testid="q-state" value={q} readOnly />
    </>
  );
}

function openAndType(input: HTMLInputElement, value: string) {
  fireEvent.change(input, { target: { value } });
}

describe("FindBar — 出现处级别计数与导航", () => {
  it("同一消息多次出现应计为多次命中", () => {
    const onHitsChange = vi.fn();
    render(
      <ControlledFindBar
        messages={messages}
        open
        onClose={vi.fn()}
        onHitsChange={onHitsChange}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "鸟"));

    const lastCall = onHitsChange.mock.calls[onHitsChange.mock.calls.length - 1]?.[0];
    expect(lastCall.occurrences).toHaveLength(5); // m1 三次 + m2 两次
    expect(lastCall.occurrences.slice(0, 3)).toEqual([
      { messageId: "m1", localIndex: 0 },
      { messageId: "m1", localIndex: 1 },
      { messageId: "m1", localIndex: 2 },
    ]);
    expect(lastCall.occurrences.slice(3)).toEqual([
      { messageId: "m2", localIndex: 0 },
      { messageId: "m2", localIndex: 1 },
    ]);
    // hitIds 仍是去重的消息集合(供父级沿用)
    expect(lastCall.hitIds).toEqual(["m1", "m2"]);
  });

  it("计数器按出现处总数显示 X/Y", () => {
    render(
      <ControlledFindBar
        messages={messages}
        open
        onClose={vi.fn()}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "鸟"));
    expect(document.querySelector(".findbar__count")?.textContent).toBe("1/5");
  });

  it("Step(1) 在出现处之间移动,跨消息保持索引连贯", () => {
    const onActiveChange = vi.fn();
    render(
      <ControlledFindBar
        messages={messages}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "鸟"));
    act(() => fireEvent.click(document.querySelectorAll(".findbar__btn")[1])); // 下一个

    expect(onActiveChange).toHaveBeenLastCalledWith({
      messageId: "m1",
      localIndex: 1,
    });
  });

  it("Step(-1) 跨消息回退到上一条命中消息的最后一次出现处", () => {
    const onActiveChange = vi.fn();
    render(
      <ControlledFindBar
        messages={messages}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "鸟"));
    // 当前是 m1 localIndex 0;按上一步应循环到最后一位
    act(() => fireEvent.click(document.querySelectorAll(".findbar__btn")[0])); // 上一个
    expect(onActiveChange).toHaveBeenLastCalledWith({
      messageId: "m2",
      localIndex: 1,
    });
  });

  it("无命中时清空计数与高亮回调", () => {
    const onActiveChange = vi.fn();
    const onHitsChange = vi.fn();
    render(
      <ControlledFindBar
        messages={messages}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
        onHitsChange={onHitsChange}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "完全不存在"));
    expect(document.querySelector(".findbar__count")?.textContent).toBe("0/0");
    expect(onActiveChange).toHaveBeenLastCalledWith(null);
    expect(onHitsChange).toHaveBeenLastCalledWith({
      hitIds: [],
      occurrences: [],
    });
  });

  it("大小写不敏感命中", () => {
    const onHitsChange = vi.fn();
    render(
      <ControlledFindBar
        messages={[msg("a", "Hello world HELLO again")]}
        open
        onClose={vi.fn()}
        onHitsChange={onHitsChange}
      />,
    );
    const input = document.querySelector(".findbar__input") as HTMLInputElement;
    act(() => openAndType(input, "hello"));
    expect(onHitsChange.mock.calls[onHitsChange.mock.calls.length - 1]?.[0].occurrences).toHaveLength(2);
  });
});