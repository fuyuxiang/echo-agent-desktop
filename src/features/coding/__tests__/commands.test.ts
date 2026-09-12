import { describe, expect, it, vi } from "vitest";

import {
  buildCommands,
  filterCommands,
  filterPaths,
  scoreCommand,
  type CommandContext,
} from "../lib/commands";

function context(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    hasWorkspace: true,
    hasTask: true,
    busy: false,
    taskPhase: "implementing",
    problemCount: 0,
    changedFileCount: 2,
    setActivityView: vi.fn(),
    setBottomView: vi.fn(),
    openDocTab: vi.fn(),
    runAllVerifications: vi.fn(),
    rerunVerification: vi.fn(),
    approvePlan: vi.fn(),
    rollbackTask: vi.fn(),
    newTask: vi.fn(),
    commitChanges: vi.fn(),
    explain: vi.fn(),
    generateComments: vi.fn(),
    toggleBottom: vi.fn(),
    openGoToDefinition: vi.fn(),
    openFindReferences: vi.fn(),
    openImpactAnalysis: vi.fn(),
    rebuildIndex: vi.fn(),
    indexReady: true,
    ...overrides,
  };
}

describe("command registry", () => {
  it("covers every capability group so the palette is a full index", () => {
    const groups = new Set(buildCommands(context()).map((command) => command.group));
    for (const group of ["navigate", "task", "verify", "review", "understand", "deliver", "view"]) {
      expect(groups).toContain(group);
    }
  });

  it("disables task commands when no task exists but still lists them", () => {
    const commands = buildCommands(context({ hasTask: false }));
    const report = commands.find((command) => command.id === "deliver.report");
    expect(report).toBeDefined();
    expect(report?.enabled).toBe(false);
  });

  it("only enables plan approval while the task waits in planning", () => {
    const planning = buildCommands(context({ taskPhase: "planning" }));
    expect(planning.find((c) => c.id === "task.approvePlan")?.enabled).toBe(true);
    const implementing = buildCommands(context({ taskPhase: "implementing" }));
    expect(implementing.find((c) => c.id === "task.approvePlan")?.enabled).toBe(false);
  });

  it("holds back mutating commands while a run is in progress", () => {
    const commands = buildCommands(context({ busy: true }));
    expect(commands.find((c) => c.id === "verify.runAll")?.enabled).toBe(false);
    expect(commands.find((c) => c.id === "task.rollback")?.enabled).toBe(false);
    expect(commands.find((c) => c.id === "review.commit")?.enabled).toBe(false);
    // Read-only navigation stays available.
    expect(commands.find((c) => c.id === "view.changes")?.enabled).toBe(true);
  });

  it("disables rollback and commit when the task changed nothing", () => {
    const commands = buildCommands(context({ changedFileCount: 0 }));
    expect(commands.find((c) => c.id === "task.rollback")?.enabled).toBe(false);
    expect(commands.find((c) => c.id === "review.commit")?.enabled).toBe(false);
  });

  it("surfaces counts as hints", () => {
    const commands = buildCommands(context({ problemCount: 3, changedFileCount: 5 }));
    expect(commands.find((c) => c.id === "verify.problems")?.hint).toBe("3 个");
    expect(commands.find((c) => c.id === "view.changes")?.hint).toBe("5 个文件");
  });

  it("running a command invokes its action", async () => {
    const runAllVerifications = vi.fn();
    const commands = buildCommands(context({ runAllVerifications }));
    await commands.find((c) => c.id === "verify.runAll")?.run();
    expect(runAllVerifications).toHaveBeenCalledOnce();
  });

  it("explain commands pass their scope through", () => {
    const explain = vi.fn();
    const commands = buildCommands(context({ explain }));
    commands.find((c) => c.id === "understand.system")?.run();
    expect(explain).toHaveBeenCalledWith("system");
  });

  it("registers gotoDefinition, findReferences, analyzeImpact and rebuildIndex", () => {
    const commands = buildCommands(context());
    for (const id of [
      "understand.gotoDefinition",
      "understand.findReferences",
      "understand.analyzeImpact",
      "index.rebuild",
    ]) {
      expect(commands.find((c) => c.id === id)).toBeDefined();
    }
  });

  it("disables gotoDefinition/findReferences/analyzeImpact when the index is not ready", () => {
    const commands = buildCommands(context({ indexReady: false }));
    expect(commands.find((c) => c.id === "understand.gotoDefinition")?.enabled).toBe(false);
    expect(commands.find((c) => c.id === "understand.findReferences")?.enabled).toBe(false);
    expect(commands.find((c) => c.id === "understand.analyzeImpact")?.enabled).toBe(false);
    // index.rebuild stays available even when the index has never been built.
    expect(commands.find((c) => c.id === "index.rebuild")?.enabled).toBe(true);
  });

  it("rebuildIndex command invokes the workspace callback", () => {
    const rebuildIndex = vi.fn();
    const commands = buildCommands(context({ rebuildIndex }));
    void commands.find((c) => c.id === "index.rebuild")?.run();
    expect(rebuildIndex).toHaveBeenCalled();
  });
});

describe("command filtering", () => {
  const commands = buildCommands(context());

  it("ranks a title prefix above a mid-title match", () => {
    const prefix = scoreCommand({ ...commands[0], title: "提交变更" }, "提交");
    const middle = scoreCommand({ ...commands[0], title: "准备提交" }, "提交");
    expect(prefix).toBeGreaterThan(middle ?? 0);
  });

  it("matches by keyword when the title does not contain the query", () => {
    const results = filterCommands(commands, "rollback");
    expect(results[0]?.id).toBe("task.rollback");
  });

  it("finds commands by English keyword for Chinese titles", () => {
    expect(filterCommands(commands, "commit")[0]?.id).toBe("review.commit");
    expect(filterCommands(commands, "terminal")[0]?.id).toBe("verify.terminal");
  });

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "").length).toBe(commands.length);
  });

  it("returns nothing when a query matches no command", () => {
    expect(filterCommands(commands, "zzzqqqxxx")).toHaveLength(0);
  });
});

describe("quick open path filtering", () => {
  const paths = [
    "src/auth/login.ts",
    "src/auth/logout.ts",
    "src/components/Button.tsx",
    "tests/auth/login.test.ts",
    "README.md",
  ];

  it("prefers a basename prefix over a path match", () => {
    const results = filterPaths(paths, "login");
    expect(results[0]).toBe("src/auth/login.ts");
  });

  it("matches on directory segments too", () => {
    const results = filterPaths(paths, "components");
    expect(results).toContain("src/components/Button.tsx");
  });

  it("supports subsequence abbreviations of the basename", () => {
    const results = filterPaths(paths, "btn");
    expect(results).toContain("src/components/Button.tsx");
  });

  it("caps the result count", () => {
    const many = Array.from({ length: 200 }, (_, index) => `src/file-${index}.ts`);
    expect(filterPaths(many, "file", 20)).toHaveLength(20);
  });

  it("returns the head of the list for an empty query", () => {
    expect(filterPaths(paths, "", 3)).toEqual(paths.slice(0, 3));
  });
});
