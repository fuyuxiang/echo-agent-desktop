import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(async () => []),
}));

vi.mock("@/lib/agent-client", () => ({
  codingSearchWorkspace: mocks.search,
}));

import { SearchView } from "../explorer/SearchView";

describe("SearchView", () => {
  beforeEach(() => mocks.search.mockClear());

  it("keeps backend search and replace on the same explicit match contract", async () => {
    const user = userEvent.setup();
    render(
      <SearchView
        root="/repo"
        onOpenHit={vi.fn()}
        onReplaceAll={vi.fn()}
      />,
    );

    await user.type(screen.getByRole("textbox", { name: "搜索代码" }), "Foo");
    await user.click(screen.getByTitle("区分大小写"));
    await user.click(screen.getByTitle("全字匹配"));
    await user.click(screen.getByTitle("使用正则表达式"));
    await user.click(screen.getByTitle("包含与排除文件"));
    await user.type(screen.getByRole("textbox", { name: "包含文件" }), "src/**");
    await user.type(screen.getByRole("textbox", { name: "排除文件" }), "**/*.test.ts");

    await waitFor(() => expect(mocks.search).toHaveBeenLastCalledWith("/repo", "Foo", {
      caseSensitive: true,
      wholeWord: true,
      regex: true,
      includeGlob: "src/**",
      excludeGlob: "**/*.test.ts",
    }));
  });
});
