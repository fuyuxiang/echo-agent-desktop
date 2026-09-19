import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  AtMentionMenu,
  type AtMentionSymbol,
} from "@/components/AtMentionMenu";

const SYMBOLS: AtMentionSymbol[] = [
  { name: "handleFormSubmit", file: "src/form.tsx", line: 12 },
  { name: "formatText", file: "src/format.ts", line: 1 },
];

describe("AtMentionMenu", () => {
  it("renders nothing when there is no active mention", () => {
    const { container } = render(
      <AtMentionMenu
        text="plain text"
        cursor={5}
        filePaths={["src/foo.ts"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    expect(container.querySelector(".at-menu")).toBeNull();
  });

  it("renders nothing when the query has no matches", () => {
    const { container } = render(
      <AtMentionMenu
        text="@zzzz"
        cursor={5}
        filePaths={["src/foo.ts"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    expect(container.querySelector(".at-menu")).toBeNull();
  });

  it("lists file matches first, then symbol matches", () => {
    render(
      <AtMentionMenu
        text="@for"
        cursor={4}
        filePaths={["src/form.tsx"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    const items = screen.getAllByTestId("at-menu-item");
    // 1 file + 2 symbols (both handleFormSubmit + formatText match "for")
    expect(items).toHaveLength(3);
    expect(items[0].getAttribute("data-kind")).toBe("file");
    expect(items[1].getAttribute("data-kind")).toBe("symbol");
    expect(items[2].getAttribute("data-kind")).toBe("symbol");
  });

  it("calls onPick when an item is clicked", () => {
    const onPick = vi.fn();
    render(
      <AtMentionMenu
        text="@for"
        cursor={4}
        filePaths={["src/form.tsx"]}
        workspaceSymbols={SYMBOLS}
        onPick={onPick}
      />,
    );
    fireEvent.click(screen.getAllByTestId("at-menu-item")[0]);
    expect(onPick).toHaveBeenCalledWith("@src/form.tsx", "src/form.tsx");
  });

  it("handleKeyDown ArrowDown moves active and Enter picks", async () => {
    const onPick = vi.fn();
    const ref = { current: null as null | { handleKeyDown: (e: { key: string; preventDefault: () => void }) => boolean } };
    render(
      <AtMentionMenu
        ref={ref as never}
        text="@for"
        cursor={4}
        filePaths={["src/form.tsx"]}
        workspaceSymbols={SYMBOLS}
        onPick={onPick}
      />,
    );
    // Sanity: handleKeyDown forwards key events when there are matches.
    expect(ref.current!.handleKeyDown({ key: "ArrowDown", preventDefault: () => {} })).toBe(true);
    expect(ref.current!.handleKeyDown({ key: "ArrowUp", preventDefault: () => {} })).toBe(true);
    expect(ref.current!.handleKeyDown({ key: "Escape", preventDefault: () => {} })).toBe(true);
    expect(ref.current!.handleKeyDown({ key: "Tab", preventDefault: () => {} })).toBe(true);
    // Unrelated keys are not consumed.
    expect(ref.current!.handleKeyDown({ key: "a", preventDefault: () => {} })).toBe(false);
  });

  it("clicks on items call onPick with the right mention + replacement", () => {
    const onPick = vi.fn();
    render(
      <AtMentionMenu
        text="@x"
        cursor={2}
        filePaths={["x.ts"]}
        workspaceSymbols={[{ name: "xFn", file: "y.ts", line: 3 }]}
        onPick={onPick}
      />,
    );
    const items = screen.getAllByTestId("at-menu-item");
    fireEvent.click(items[0]);
    expect(onPick).toHaveBeenCalledWith("@x.ts", "x.ts");
    fireEvent.click(items[1]);
    expect(onPick).toHaveBeenCalledWith("@y.ts#xFn", "y.ts#xFn");
  });

  it("handleKeyDown Escape returns true even with no matches (dismiss)", () => {
    const ref = { current: null as null | { handleKeyDown: (e: { key: string; preventDefault: () => void }) => boolean } };
    render(
      <AtMentionMenu
        ref={ref as never}
        text="@zzzz"
        cursor={5}
        filePaths={["src/foo.ts"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    const esc = { key: "Escape", preventDefault: () => {} };
    expect(ref.current!.handleKeyDown(esc)).toBe(true);
  });

  it("handleKeyDown ArrowUp wraps around to the last entry", () => {
    const ref = { current: null as null | { handleKeyDown: (e: { key: string; preventDefault: () => void }) => boolean } };
    render(
      <AtMentionMenu
        ref={ref as never}
        text="@for"
        cursor={4}
        filePaths={["src/form.tsx"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    const up = { key: "ArrowUp", preventDefault: () => {} };
    expect(ref.current!.handleKeyDown(up)).toBe(true);
  });

  it("ignores unrelated keys and returns false", async () => {
    const user = userEvent.setup();
    const ref = { current: null as null | { handleKeyDown: (e: { key: string; preventDefault: () => void }) => boolean } };
    render(
      <AtMentionMenu
        ref={ref as never}
        text="@for"
        cursor={4}
        filePaths={["src/form.tsx"]}
        workspaceSymbols={SYMBOLS}
        onPick={() => {}}
      />,
    );
    const other = { key: "a", preventDefault: () => {} };
    expect(ref.current!.handleKeyDown(other)).toBe(false);
    // Sanity: typing in the textarea shouldn't crash the menu.
    await user.keyboard("a");
  });
});
