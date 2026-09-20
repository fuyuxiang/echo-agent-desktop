import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImportSkillModal } from "../ImportSkillModal";
import type { SkillPackageInspection, SkillInstallResult } from "@/lib/types";

// 把整个 agent-client 抽成 hoisted 对象,这样每个测试都能精确控制 inspect / install 行为,
// 同时 filesystemPickFiles 也能返回我们构造好的多文件路径数组。
const api = vi.hoisted(() => ({
  filesystemPickFiles: vi.fn(),
  filesystemPickDirectory: vi.fn(),
  skillsInspectPackages: vi.fn(),
  skillsInstallPackage: vi.fn(),
}));

vi.mock("@/lib/agent-client", () => api);

function makeInspection(
  overrides: Partial<SkillPackageInspection> = {},
): SkillPackageInspection {
  return {
    sourcePath: "/path/to/pkg",
    name: "demo-skill",
    description: "demo description",
    fileCount: 3,
    totalBytes: 1024,
    riskLevel: "low",
    findings: [],
    warnings: [],
    sourceHash: "hash-" + Math.random().toString(36).slice(2),
    alreadyInstalled: false,
    ...overrides,
  };
}

function makeInstallResult(inspection: SkillPackageInspection): SkillInstallResult {
  return {
    installedPath: `/installed/${inspection.name}`,
    updated: inspection.alreadyInstalled,
    inspection,
  };
}

function inspected(inspection: SkillPackageInspection, label?: string) {
  return [{
    label: label ?? inspection.sourcePath.split("/").pop() ?? inspection.name,
    packageRoot: inspection.packageRoot,
    inspection,
  }];
}

describe("ImportSkillModal — 列表型批量安装", () => {
  beforeEach(() => {
    for (const mock of Object.values(api)) mock.mockReset();
  });

  it("多选文件后并行 inspect,每个文件单独成行", async () => {
    api.filesystemPickFiles.mockResolvedValue([
      "/tmp/a.zip",
      "/tmp/b.zip",
      "/tmp/c.zip",
    ]);
    api.skillsInspectPackages.mockImplementation(async (path: string) =>
      inspected(makeInspection({
        sourcePath: path,
        // 让 inspection.name 与 basename 错开,避免「行名 + 标签」文本重复。
        name: `skill-${path.split("/").pop() ?? "x"}`,
      })),
    );

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    await waitFor(() => {
      expect(api.skillsInspectPackages).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByText("a.zip")).toBeInTheDocument();
    expect(screen.getByText("b.zip")).toBeInTheDocument();
    expect(screen.getByText("c.zip")).toBeInTheDocument();
  });

  it("批量 inspect 最多 3 路并发且立即展示完整队列", async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `/tmp/${index}.zip`);
    api.filesystemPickFiles.mockResolvedValue(paths);
    let active = 0;
    let peak = 0;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    api.skillsInspectPackages.mockImplementation(async (path: string) => {
      active += 1;
      peak = Math.max(peak, active);
      await gate;
      active -= 1;
      return inspected(makeInspection({ sourcePath: path, name: `skill-${path}` }));
    });

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    expect(await screen.findByText("正在识别技能，当前 5 项")).toBeInTheDocument();
    await waitFor(() => expect(api.skillsInspectPackages).toHaveBeenCalledTimes(3));
    expect(peak).toBe(3);
    await act(async () => { release?.(); });
    await waitFor(() => expect(api.skillsInspectPackages).toHaveBeenCalledTimes(5));
    expect(peak).toBeLessThanOrEqual(3);
  });

  it("单个 inspect 失败不会阻塞其它行,失败行展示错误信息", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/tmp/ok.zip", "/tmp/bad.zip"]);
    api.skillsInspectPackages.mockImplementation(async (path: string) => {
      if (path.endsWith("bad.zip")) {
        throw new Error("hash 不匹配");
      }
      return inspected(makeInspection({
        sourcePath: path,
        name: `skill-${path.split("/").pop()!}`,
      }));
    });

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    await waitFor(() => {
      expect(screen.getByText("hash 不匹配")).toBeInTheDocument();
    });
    expect(screen.getByText("ok.zip")).toBeInTheDocument();
    expect(screen.getByText("bad.zip")).toBeInTheDocument();
  });

  it("「安装全部低风险」仅安装低风险行", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/low.zip", "/med.zip", "/high.zip"]);
    api.skillsInspectPackages.mockImplementation(async (path: string) => {
      const name = path.split("/").pop()!;
      const risk =
        name.startsWith("low") ? "low" : name.startsWith("med") ? "medium" : "high";
      return inspected(makeInspection({ sourcePath: path, name, riskLevel: risk }));
    });
    api.skillsInstallPackage.mockImplementation(async (path: string) =>
      makeInstallResult(
        makeInspection({
          sourcePath: path,
          name: `skill-${path.split("/").pop()!}`,
        }),
      ),
    );

    const onInstalled = vi.fn();
    render(<ImportSkillModal onClose={vi.fn()} onInstalled={onInstalled} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    const installAll = await screen.findByRole("button", { name: /安装全部低风险/ });
    fireEvent.click(installAll);

    await waitFor(() => {
      expect(api.skillsInstallPackage).toHaveBeenCalledTimes(1);
    });
    expect(api.skillsInstallPackage).toHaveBeenCalledWith(
      "/low.zip",
      expect.any(String),
      false,
    );
    // 高/中风险不被自动安装
    expect(api.skillsInstallPackage.mock.calls.map((c) => c[0])).toEqual([
      "/low.zip",
    ]);
    expect(onInstalled).toHaveBeenCalled();
  });

  it("勾选自动安装后会安装刚检查完的低风险 Skill", async () => {
    const inspection = makeInspection({ sourcePath: "/auto.zip", name: "auto-skill" });
    api.filesystemPickFiles.mockResolvedValue(["/auto.zip"]);
    api.skillsInspectPackages.mockResolvedValue(inspected(inspection));
    api.skillsInstallPackage.mockResolvedValue(makeInstallResult(inspection));

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("仅在检查结果为低风险时自动安装"));
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    await waitFor(() => {
      expect(api.skillsInstallPackage).toHaveBeenCalledWith(
        "/auto.zip",
        inspection.sourceHash,
        false,
      );
    });
  });

  it("批量安装按 Skill 名忽略大小写去重", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/first.zip", "/second.zip"]);
    api.skillsInspectPackages.mockImplementation(async (path: string) =>
      inspected(makeInspection({
        sourcePath: path,
        name: path === "/first.zip" ? "Demo-Skill" : "demo-skill",
      })),
    );
    api.skillsInstallPackage.mockImplementation(async (path: string) => {
      const inspection = makeInspection({ sourcePath: path, name: "Demo-Skill" });
      return makeInstallResult(inspection);
    });

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));
    fireEvent.click(await screen.findByRole("button", { name: /安装全部低风险/ }));

    await waitFor(() => expect(api.skillsInstallPackage).toHaveBeenCalledTimes(1));
    expect(api.skillsInstallPackage).toHaveBeenCalledWith(
      "/first.zip",
      expect.any(String),
      false,
    );
    expect(await screen.findByText(/同名技能.*只保留一个版本/)).toBeInTheDocument();
  });

  it("批量安装严格串行执行", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/one.zip", "/two.zip"]);
    api.skillsInspectPackages.mockImplementation(async (path: string) =>
      inspected(makeInspection({ sourcePath: path, name: path.slice(1, -4) })),
    );
    let resolveFirst: ((value: SkillInstallResult) => void) | undefined;
    api.skillsInstallPackage.mockImplementation((path: string) => {
      const inspection = makeInspection({ sourcePath: path, name: path.slice(1, -4) });
      if (path === "/one.zip") {
        return new Promise<SkillInstallResult>((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve(makeInstallResult(inspection));
    });

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));
    fireEvent.click(await screen.findByRole("button", { name: /安装全部低风险/ }));

    await waitFor(() => expect(api.skillsInstallPackage).toHaveBeenCalledTimes(1));
    expect(api.skillsInstallPackage).toHaveBeenNthCalledWith(
      1,
      "/one.zip",
      expect.any(String),
      false,
    );
    await act(async () => {
      resolveFirst?.(makeInstallResult(makeInspection({ sourcePath: "/one.zip", name: "one" })));
    });
    await waitFor(() => expect(api.skillsInstallPackage).toHaveBeenCalledTimes(2));
    expect(api.skillsInstallPackage).toHaveBeenNthCalledWith(
      2,
      "/two.zip",
      expect.any(String),
      false,
    );
  });

  it("高风险行安装前需要勾选「我已查看风险」", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/high.zip"]);
    api.skillsInspectPackages.mockResolvedValue(
      inspected(makeInspection({
        sourcePath: "/high.zip",
        name: "danger",
        riskLevel: "high",
      })),
    );
    api.skillsInstallPackage.mockResolvedValue(
      makeInstallResult(
        makeInspection({ sourcePath: "/high.zip", name: "danger", riskLevel: "high" }),
      ),
    );

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    const rowInstall = await screen.findByRole("button", { name: "安装技能" });
    expect(rowInstall).toBeDisabled();
    fireEvent.click(screen.getByLabelText(/我已查看风险/));
    expect(rowInstall).not.toBeDisabled();
    fireEvent.click(rowInstall);

    await waitFor(() => {
      expect(api.skillsInstallPackage).toHaveBeenCalledWith(
        "/high.zip",
        expect.any(String),
        true,
      );
    });
  });

  it("无选中文件时不做任何操作", async () => {
    api.filesystemPickFiles.mockResolvedValue([]);
    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));
    expect(api.skillsInspectPackages).not.toHaveBeenCalled();
    expect(screen.queryByText(/安装全部低风险/)).toBeNull();
  });

  it("选择目录会展开多个独立技能并按子路径安装", async () => {
    api.filesystemPickDirectory.mockResolvedValue("/skills/mine");
    const one = makeInspection({
      sourcePath: "/skills/mine",
      packageRoot: "one",
      name: "dir-skill-one",
    });
    const two = makeInspection({
      sourcePath: "/skills/mine",
      packageRoot: "two",
      name: "dir-skill-two",
    });
    api.skillsInspectPackages.mockResolvedValue([
      { label: "one", packageRoot: "one", inspection: one },
      { label: "two", packageRoot: "two", inspection: two },
    ]);
    api.skillsInstallPackage.mockResolvedValue(makeInstallResult(one));

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByText(/选择技能文件夹/));

    await waitFor(() => {
      expect(api.skillsInspectPackages).toHaveBeenCalledWith("/skills/mine");
    });
    expect(screen.getByText("mine / one")).toBeInTheDocument();
    expect(screen.getByText("mine / two")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: "安装技能" })[0]);
    await waitFor(() => expect(api.skillsInstallPackage).toHaveBeenCalledWith(
      "/skills/mine",
      one.sourceHash,
      false,
      "one",
    ));
  });

  it("批量包中单个技能失败不会隐藏其它技能", async () => {
    api.filesystemPickFiles.mockResolvedValue(["/bundle.zip"]);
    api.skillsInspectPackages.mockResolvedValue([
      {
        label: "valid",
        packageRoot: "valid",
        inspection: makeInspection({
          sourcePath: "/bundle.zip",
          packageRoot: "valid",
          name: "valid-skill",
        }),
      },
      { label: "broken", packageRoot: "broken", error: "SKILL.md 元数据无效" },
    ]);

    render(<ImportSkillModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("选择 Markdown 或 ZIP 技能文件"));

    expect(await screen.findByText("bundle.zip / valid")).toBeInTheDocument();
    expect(screen.getByText("bundle.zip / broken")).toBeInTheDocument();
    expect(screen.getByText("SKILL.md 元数据无效")).toBeInTheDocument();
  });
});
