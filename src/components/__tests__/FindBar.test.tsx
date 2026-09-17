import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { useState } from "react";
import { FindBar, type FindOccurrence } from "../FindBar";

const occurrences: FindOccurrence[] = [
  { messageId: "m1", localIndex: 0 },
  { messageId: "m1", localIndex: 1 },
  { messageId: "m1", localIndex: 2 },
  { messageId: "m2", localIndex: 0 },
  { messageId: "m2", localIndex: 1 },
];

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function ControlledFindBar(
  props: Omit<React.ComponentProps<typeof FindBar>, "query" | "onQueryChange">,
) {
  const [query, setQuery] = useState("");
  return <FindBar {...props} query={query} onQueryChange={setQuery} />;
}

function typeQuery(value: string) {
  fireEvent.change(document.querySelector(".findbar__input") as HTMLInputElement, {
    target: { value },
  });
}

describe("FindBar - occurrence navigation", () => {
  it("按最终渲染层提供的出现处总数显示计数", () => {
    render(<ControlledFindBar occurrences={occurrences} open onClose={vi.fn()} />);
    act(() => typeQuery("鸟"));
    expect(document.querySelector(".findbar__count")?.textContent).toBe("1/5");
  });

  it("下一项在同一消息的实际命中之间移动", () => {
    const onActiveChange = vi.fn();
    render(
      <ControlledFindBar
        occurrences={occurrences}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    act(() => typeQuery("鸟"));
    act(() => fireEvent.click(document.querySelectorAll(".findbar__btn")[1]));

    expect(onActiveChange).toHaveBeenLastCalledWith({
      messageId: "m1",
      localIndex: 1,
    });
  });

  it("上一项从第一处循环到最后一处", () => {
    const onActiveChange = vi.fn();
    render(
      <ControlledFindBar
        occurrences={occurrences}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    act(() => typeQuery("鸟"));
    act(() => fireEvent.click(document.querySelectorAll(".findbar__btn")[0]));
    expect(onActiveChange).toHaveBeenLastCalledWith({
      messageId: "m2",
      localIndex: 1,
    });
  });

  it("无命中时显示 0/0 并禁用导航", () => {
    const onActiveChange = vi.fn();
    render(
      <ControlledFindBar
        occurrences={[]}
        open
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    act(() => typeQuery("完全不存在"));
    expect(document.querySelector(".findbar__count")?.textContent).toBe("0/0");
    expect(onActiveChange).toHaveBeenLastCalledWith(null);
    expect(document.querySelectorAll<HTMLButtonElement>(".findbar__btn")[0]).toBeDisabled();
    expect(document.querySelectorAll<HTMLButtonElement>(".findbar__btn")[1]).toBeDisabled();
  });

  it("命中数量缩小时把当前位置收敛到有效范围", () => {
    const onActiveChange = vi.fn();
    const { rerender } = render(
      <FindBar
        occurrences={occurrences}
        open
        query="鸟"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    act(() => fireEvent.click(document.querySelectorAll(".findbar__btn")[0]));
    rerender(
      <FindBar
        occurrences={[occurrences[0]]}
        open
        query="鸟"
        onQueryChange={vi.fn()}
        onClose={vi.fn()}
        onActiveChange={onActiveChange}
      />,
    );
    expect(document.querySelector(".findbar__count")?.textContent).toBe("1/1");
    expect(onActiveChange).toHaveBeenLastCalledWith(occurrences[0]);
  });
});
