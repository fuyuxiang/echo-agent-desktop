import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { FooterStatusBar } from "../FooterStatusBar";

describe("FooterStatusBar", () => {
  it("renders placeholders when nothing is open", () => {
    render(
      <FooterStatusBar
        cursor={null}
        eol={null}
        language={null}
        indent={{ kind: "space", size: 2 }}
        onEolChange={() => {}}
        onIndentChange={() => {}}
        onLanguageChange={() => {}}
        taskSummary="就绪"
        problemCount={0}
        indexing={false}
        changeSetMode="ready"
      />,
    );
    const placeholders = screen.getAllByText("——");
    expect(placeholders.length).toBeGreaterThanOrEqual(3);
  });

  it("shows cursor line/column when provided", () => {
    render(
      <FooterStatusBar
        cursor={{ line: 12, column: 5 }}
        eol="LF"
        language="markdown"
        indent={{ kind: "space", size: 2 }}
        onEolChange={() => {}}
        onIndentChange={() => {}}
        onLanguageChange={() => {}}
        taskSummary="就绪"
        problemCount={0}
        indexing={false}
        changeSetMode="ready"
      />,
    );
    expect(screen.getByText(/第 12 行.*第 5 列/)).not.toBeNull();
    expect(screen.getByText("LF")).not.toBeNull();
    expect(screen.getByText("Markdown")).not.toBeNull();
  });

  it("calls onIndentChange when indent button clicked", () => {
    const onIndentChange = vi.fn();
    render(
      <FooterStatusBar
        cursor={null}
        eol={null}
        language={null}
        indent={{ kind: "space", size: 2 }}
        onEolChange={() => {}}
        onIndentChange={onIndentChange}
        onLanguageChange={() => {}}
        taskSummary="就绪"
        problemCount={0}
        indexing={false}
        changeSetMode="ready"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /缩进/ }));
    expect(onIndentChange).toHaveBeenCalledTimes(1);
  });

  it("calls onEolChange when EOL button clicked", () => {
    const onEolChange = vi.fn();
    render(
      <FooterStatusBar
        cursor={null}
        eol={null}
        language={null}
        indent={{ kind: "space", size: 2 }}
        onEolChange={onEolChange}
        onIndentChange={() => {}}
        onLanguageChange={() => {}}
        taskSummary="就绪"
        problemCount={0}
        indexing={false}
        changeSetMode="ready"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /LF|CRLF|换行/ }));
    expect(onEolChange).toHaveBeenCalledTimes(1);
  });

  it("calls onLanguageChange when language button clicked", () => {
    const onLanguageChange = vi.fn();
    render(
      <FooterStatusBar
        cursor={{ line: 1, column: 1 }}
        eol="LF"
        language="typescript"
        indent={{ kind: "space", size: 2 }}
        onEolChange={() => {}}
        onIndentChange={() => {}}
        onLanguageChange={onLanguageChange}
        taskSummary="就绪"
        problemCount={0}
        indexing={false}
        changeSetMode="ready"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /TypeScript|JavaScript|Markdown/ }));
    expect(onLanguageChange).toHaveBeenCalledTimes(1);
  });
});