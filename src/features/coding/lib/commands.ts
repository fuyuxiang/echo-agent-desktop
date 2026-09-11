/**
 * Command registry for the workbench palette.
 *
 * Most of the workbench's capability surface lives here rather than on screen:
 * impact analysis, explanations, verification runs, delivery actions and
 * navigation are all reachable through the palette, which is what keeps the
 * visible UI from growing a button per feature.
 */

import type { ActivityView, BottomView } from "../store/workbench-store";

export type CommandGroup =
  | "navigate"
  | "task"
  | "verify"
  | "review"
  | "understand"
  | "deliver"
  | "view";

export interface WorkbenchCommand {
  id: string;
  title: string;
  group: CommandGroup;
  /** Extra words that should match this command in the palette. */
  keywords?: string[];
  /** Shown right-aligned, e.g. a shortcut hint. */
  hint?: string;
  /** When false the command is listed as unavailable and cannot be run. */
  enabled?: boolean;
  run: () => void | Promise<void>;
}

export const GROUP_LABELS: Record<CommandGroup, string> = {
  navigate: "转到",
  task: "任务",
  verify: "验证",
  review: "变更审阅",
  understand: "理解代码",
  deliver: "交付",
  view: "视图",
};

/** Everything the palette needs from the workbench to build its command list. */
export interface CommandContext {
  hasWorkspace: boolean;
  hasTask: boolean;
  /** A run is in progress, so mutating commands are held back. */
  busy: boolean;
  taskPhase?: string;
  problemCount: number;
  changedFileCount: number;
  setActivityView: (view: ActivityView) => void;
  setBottomView: (view: BottomView) => void;
  openDocTab: (kind: "delivery" | "taskDag" | "profile") => void;
  runAllVerifications: () => void | Promise<void>;
  rerunVerification: () => void | Promise<void>;
  approvePlan: () => void | Promise<void>;
  rollbackTask: () => void | Promise<void>;
  newTask: () => void | Promise<void>;
  commitChanges: () => void | Promise<void>;
  explain: (scope: "function" | "class" | "module" | "system") => void | Promise<void>;
  generateComments: () => void | Promise<void>;
  toggleBottom: () => void;
}

/**
 * Build the command list for the current state. Commands that cannot run yet are
 * still listed but disabled, so the palette doubles as a discoverable index of
 * what the workbench can do.
 */
export function buildCommands(context: CommandContext): WorkbenchCommand[] {
  const {
    hasWorkspace,
    hasTask,
    busy,
    problemCount,
    changedFileCount,
    setActivityView,
    setBottomView,
    openDocTab,
  } = context;

  const commands: WorkbenchCommand[] = [
    // ---- navigate ----
    {
      id: "view.files",
      title: "转到：文件",
      group: "navigate",
      keywords: ["explorer", "文件树", "资源管理器"],
      enabled: hasWorkspace,
      run: () => setActivityView("files"),
    },
    {
      id: "view.search",
      title: "转到：搜索",
      group: "navigate",
      keywords: ["grep", "查找", "替换"],
      enabled: hasWorkspace,
      run: () => setActivityView("search"),
    },
    {
      id: "view.changes",
      title: "转到：变更集",
      group: "navigate",
      keywords: ["diff", "git", "改动"],
      hint: changedFileCount > 0 ? `${changedFileCount} 个文件` : undefined,
      enabled: hasWorkspace,
      run: () => setActivityView("changes"),
    },
    {
      id: "view.symbols",
      title: "转到：符号",
      group: "navigate",
      keywords: ["symbol", "函数", "类"],
      enabled: hasWorkspace,
      run: () => setActivityView("symbols"),
    },
    {
      id: "view.context",
      title: "转到：上下文包",
      group: "navigate",
      keywords: ["context", "token"],
      enabled: hasWorkspace,
      run: () => setActivityView("context"),
    },

    // ---- task ----
    {
      id: "task.new",
      title: "新建开发任务",
      group: "task",
      keywords: ["new", "创建"],
      enabled: hasWorkspace,
      run: context.newTask,
    },
    {
      id: "task.progress",
      title: "查看当前任务进度",
      group: "task",
      keywords: ["dag", "计划", "进度"],
      enabled: hasTask,
      run: () => openDocTab("taskDag"),
    },
    {
      id: "task.approvePlan",
      title: "批准计划",
      group: "task",
      keywords: ["approve", "plan"],
      enabled: hasTask && context.taskPhase === "planning",
      run: context.approvePlan,
    },
    {
      id: "task.rollback",
      title: "回滚本次任务的全部改动",
      group: "task",
      keywords: ["rollback", "撤销", "还原"],
      enabled: hasTask && changedFileCount > 0 && !busy,
      run: context.rollbackTask,
    },

    // ---- verify ----
    {
      id: "verify.runAll",
      title: "运行全部验证",
      group: "verify",
      keywords: ["build", "test", "lint", "构建", "测试"],
      enabled: hasTask && !busy,
      run: context.runAllVerifications,
    },
    {
      id: "verify.rerun",
      title: "重跑验证",
      group: "verify",
      keywords: ["rerun", "重试"],
      enabled: hasTask && !busy,
      run: context.rerunVerification,
    },
    {
      id: "verify.problems",
      title: "查看问题",
      group: "verify",
      keywords: ["problems", "诊断", "错误"],
      hint: problemCount > 0 ? `${problemCount} 个` : undefined,
      enabled: hasTask,
      run: () => setBottomView("problems"),
    },
    {
      id: "verify.tests",
      title: "查看验证记录",
      group: "verify",
      keywords: ["tests", "结果"],
      enabled: hasTask,
      run: () => setBottomView("tests"),
    },
    {
      id: "verify.terminal",
      title: "打开集成终端",
      group: "verify",
      keywords: ["terminal", "shell", "命令行"],
      enabled: hasWorkspace,
      run: () => setBottomView("terminal"),
    },
    {
      id: "verify.trace",
      title: "查看工具调用轨迹",
      group: "verify",
      keywords: ["trace", "tool", "调用"],
      enabled: hasTask,
      run: () => setBottomView("trace"),
    },

    // ---- review ----
    {
      id: "review.commit",
      title: "提交本次任务的变更",
      group: "review",
      keywords: ["commit", "git", "提交"],
      enabled: hasTask && changedFileCount > 0 && !busy,
      run: context.commitChanges,
    },

    // ---- understand ----
    {
      id: "understand.function",
      title: "解释：当前函数",
      group: "understand",
      keywords: ["explain", "function", "函数"],
      enabled: hasWorkspace,
      run: () => context.explain("function"),
    },
    {
      id: "understand.class",
      title: "解释：当前类",
      group: "understand",
      keywords: ["explain", "class", "类"],
      enabled: hasWorkspace,
      run: () => context.explain("class"),
    },
    {
      id: "understand.module",
      title: "解释：当前模块",
      group: "understand",
      keywords: ["explain", "module", "模块"],
      enabled: hasWorkspace,
      run: () => context.explain("module"),
    },
    {
      id: "understand.system",
      title: "解释：整个系统架构",
      group: "understand",
      keywords: ["explain", "architecture", "架构", "系统"],
      enabled: hasWorkspace,
      run: () => context.explain("system"),
    },
    {
      id: "understand.comments",
      title: "生成代码注释",
      group: "understand",
      keywords: ["comment", "注释", "文档"],
      enabled: hasTask && !busy,
      run: context.generateComments,
    },
    {
      id: "understand.profile",
      title: "打开工程画像",
      group: "understand",
      keywords: ["profile", "分析", "技术栈"],
      enabled: hasWorkspace,
      run: () => openDocTab("profile"),
    },

    // ---- deliver ----
    {
      id: "deliver.report",
      title: "打开交付报告",
      group: "deliver",
      keywords: ["report", "gate", "门禁", "验收"],
      enabled: hasTask,
      run: () => openDocTab("delivery"),
    },

    // ---- view ----
    {
      id: "layout.toggleBottom",
      title: "切换底部面板",
      group: "view",
      keywords: ["panel", "bottom", "面板"],
      hint: "⌘J",
      enabled: hasWorkspace,
      run: context.toggleBottom,
    },
  ];

  return commands.map((command) => ({ ...command, enabled: command.enabled ?? true }));
}

/**
 * Score a command against a query. Returns `null` when it does not match.
 *
 * Ranking favours, in order: a title prefix, a word-start inside the title, any
 * substring, then a keyword hit. Subsequence matching lets "拉取变更" style
 * abbreviations and "vt" for "view tests" both work.
 */
export function scoreCommand(command: WorkbenchCommand, query: string): number | null {
  const needle = query.trim().toLowerCase();
  if (!needle) return 0;

  const title = command.title.toLowerCase();
  if (title.startsWith(needle)) return 100;

  const wordStart = title.split(/[\s：:·/（()]+/).some((word) => word.startsWith(needle));
  if (wordStart) return 80;

  const index = title.indexOf(needle);
  if (index >= 0) return 60 - Math.min(index, 20);

  const keywordHit = (command.keywords ?? []).some((keyword) =>
    keyword.toLowerCase().includes(needle),
  );
  if (keywordHit) return 40;

  if (command.id.toLowerCase().includes(needle)) return 30;

  // Subsequence: every needle character appears in order in the title.
  let cursor = 0;
  for (const character of needle) {
    const found = title.indexOf(character, cursor);
    if (found < 0) return null;
    cursor = found + 1;
  }
  return 10;
}

/** Filter and rank commands for the palette, keeping stable order within ties. */
export function filterCommands(
  commands: WorkbenchCommand[],
  query: string,
): WorkbenchCommand[] {
  return commands
    .map((command, order) => ({ command, order, score: scoreCommand(command, query) }))
    .filter((entry): entry is { command: WorkbenchCommand; order: number; score: number } =>
      entry.score !== null,
    )
    .sort((left, right) => right.score - left.score || left.order - right.order)
    .map((entry) => entry.command);
}

/** Rank file paths for the ⌘P quick-open list. */
export function filterPaths(paths: string[], query: string, limit = 50): string[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return paths.slice(0, limit);

  const scored: Array<{ path: string; score: number }> = [];
  for (const path of paths) {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf("/") + 1);
    let score: number | null = null;

    if (name.startsWith(needle)) score = 100;
    else if (name.includes(needle)) score = 80;
    else if (lower.includes(needle)) score = 60;
    else {
      // Subsequence over the basename, then the full path.
      let cursor = 0;
      let matched = true;
      for (const character of needle) {
        const found = name.indexOf(character, cursor);
        if (found < 0) {
          matched = false;
          break;
        }
        cursor = found + 1;
      }
      if (matched) score = 30;
    }

    if (score !== null) scored.push({ path, score });
  }

  return scored
    .sort((left, right) => right.score - left.score || left.path.length - right.path.length)
    .slice(0, limit)
    .map((entry) => entry.path);
}
