import { describe, expect, it } from "vitest";
import { displayPath, shortWorkspacePath } from "../display-path";

describe("工作目录显示", () => {
  it("长路径只在显示时移除扩展前缀，保留 UNC 语义", () => {
    const drive = String.raw`\\?\C:\projects\中文`;
    const unc = String.raw`\\?\UNC\server\share\project`;
    expect(displayPath(drive)).toBe(String.raw`C:\projects\中文`);
    expect(displayPath(unc)).toBe(String.raw`\\server\share\project`);
    expect(displayPath(String.raw`\\server\share`)).toBe(String.raw`\\server\share`);
    expect(shortWorkspacePath(drive)).toBe("projects/中文");
    expect(drive).toBe(String.raw`\\?\C:\projects\中文`);
  });
});
