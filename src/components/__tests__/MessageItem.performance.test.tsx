import { Profiler, type ComponentProps } from "react";
import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
const renders = vi.hoisted(() => vi.fn());
vi.mock("../markdown/index", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../markdown/index")>();
  return { ...actual, Markdown: (props: ComponentProps<typeof actual.Markdown>) => { renders(); return <actual.Markdown {...props} />; } };
});
import { ThemeProvider } from "../ThemeProvider";
import { MessageItem } from "../MessageItem";
import type { ChatMessage } from "@/stores/session-store";

it.each([100, 1000])("%i 条历史消息在末条流式更新时只重新渲染变化的正文", (count) => {
  const messages: ChatMessage[] = Array.from({ length: count }, (_, i) => ({ id: String(i), role: "assistant", complete: true, parts: [{ kind: "text", text: `## 历史回复 ${i}\n\n这里包含 **重点**、列表与代码。\n\n- 检查结果\n- 后续工作\n\n正文行内代码：\`result.ok\`。` }] }));
  const durations: number[] = [];
  const list = (items: ChatMessage[]) => <ThemeProvider><Profiler id="history" onRender={(_, __, duration) => durations.push(duration)}>{items.map((message) => <MessageItem key={message.id} message={message} streaming={false} />)}</Profiler></ThemeProvider>;
  renders.mockClear();
  const view = render(list(messages));
  const initial = renders.mock.calls.length;
  const next = [...messages];
  next[count - 1] = { ...next[count - 1], parts: [{ kind: "text", text: "新的流式内容" }] };
  view.rerender(list(next));
  expect(initial).toBe(count);
  expect(renders.mock.calls.length - initial).toBe(1);
  console.info(JSON.stringify({ messages: count, initialCommitMs: durations[0], updateCommitMs: durations[durations.length - 1], rerenderedBodies: 1, environment: "jsdom; real Markdown" }));
  view.unmount();
}, 60_000);
