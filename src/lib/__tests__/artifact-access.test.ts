import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  authorizeArtifactFile,
  isUnauthorizedPathError,
} from "../artifact-access";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

describe("artifact-access", () => {
  beforeEach(() => {
    vi.mocked(invoke).mockReset();
  });

  it("recognizes native unauthorized errors", () => {
    expect(isUnauthorizedPathError("拒绝访问未授权的路径：C:\\private\\a.md")).toBe(true);
    expect(isUnauthorizedPathError("路径不存在：a.md")).toBe(false);
  });

  it("returns cancelled without probing a path", async () => {
    vi.mocked(invoke).mockResolvedValueOnce([]);
    await expect(authorizeArtifactFile("C:\\outside\\a.md", "C:\\work"))
      .resolves.toBe("cancelled");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalledWith("path_stat", expect.anything());
  });

  it("accepts only when native authorization now covers the requested path", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(["C:\\outside\\a.md"])
      .mockResolvedValueOnce({ exists: true });
    await expect(authorizeArtifactFile("C:\\outside\\a.md", "C:\\work"))
      .resolves.toBe("authorized");
    expect(invoke).toHaveBeenLastCalledWith("path_stat", {
      path: "C:\\outside\\a.md",
      cwd: "C:\\work",
    });
  });

  it("reports a mismatched selection when the requested path is still unauthorized", async () => {
    vi.mocked(invoke)
      .mockResolvedValueOnce(["C:\\outside\\other.md"])
      .mockRejectedValueOnce("拒绝访问未授权的路径：C:\\outside\\a.md");
    await expect(authorizeArtifactFile("C:\\outside\\a.md"))
      .resolves.toBe("mismatch");
  });
});
