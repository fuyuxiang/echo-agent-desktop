import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { useWorkspaceMentions } from "../use-workspace-mentions";
import { buildFileIndex } from "@/features/coding/lib/file-index";
import { getSymbolIndexClient } from "@/features/coding/lib/symbol-index";

vi.mock("@/lib/tauri-kb-reader", () => ({isTauriAvailable: () => true}));
vi.mock("@/features/coding/lib/file-index", () => ({buildFileIndex:vi.fn()}));
vi.mock("@/features/coding/lib/symbol-index", () => ({getSymbolIndexClient:vi.fn()}));
beforeEach(() => {
  vi.mocked(buildFileIndex).mockReset().mockResolvedValue({paths:["note.md"]} as never);
  vi.mocked(getSymbolIndexClient).mockReset().mockReturnValue({subscribe:() => () => {},symbols:() => []} as never);
});
it("ordinary drafts do not scan a workspace; requesting mentions loads candidates", async () => {
  const view = renderHook(({enabled}) => useWorkspaceMentions("/original", enabled), {initialProps:{enabled:false}});
  expect(buildFileIndex).not.toHaveBeenCalled();
  expect(getSymbolIndexClient).not.toHaveBeenCalled();
  view.rerender({enabled:true});
  await waitFor(() => expect(view.result.current.filePaths).toEqual(["note.md"]));
  expect(buildFileIndex).toHaveBeenCalledWith("/original", expect.any(Object));
  view.rerender({enabled:false});
  expect(view.result.current.filePaths).toEqual([]);
});
it("a previous folder's late index cannot leak into another task", async () => {
  let resolve!: (value: {paths:string[];truncated:boolean}) => void;
  vi.mocked(buildFileIndex).mockImplementationOnce(() => new Promise(accept => { resolve = accept; }));
  const view = renderHook(({cwd}) => useWorkspaceMentions(cwd, true), {initialProps:{cwd:"/first"}});
  view.rerender({cwd:"/second"});
  await waitFor(() => expect(view.result.current.filePaths).toEqual(["note.md"]));
  await act(async () => resolve({paths:["first-only.md"],truncated:false}));
  expect(view.result.current.filePaths).toEqual(["note.md"]);
});
