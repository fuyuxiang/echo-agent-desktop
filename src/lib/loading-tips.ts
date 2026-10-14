/**
 * Companion microcopy for moments where the desktop client is genuinely idle.
 *
 * The primary status always states observable progress. These secondary lines
 * may be useful or playful, but deliberately avoid promises such as “halfway”
 * or “almost done” that the client cannot verify.
 */

export const PRACTICAL_LOADING_TIPS = [
  "需求越具体，结果通常越贴近你的预期",
  "拖入文件或截图，比大段转述更省事",
  "用 @ 引用文件，相关上下文会更清楚",
  "用 / 调用技能与指令，可以少写重复要求",
  "复杂任务先说明目标、约束和交付格式，执行会更稳",
  "处理多份文件时，提前约定目录和命名会更省心",
  "大批量修改可以先抽样，确认规则后再继续",
  "选对工作目录，文件读取和修改会更准确",
  "不同主题分开建任务，上下文更干净",
  "长对话先总结再开新任务，往往更高效",
  "结果不合预期时，直接指出具体段落最有效",
  "关键结论值得人工复核，尤其是要对外发布的内容",
] as const;

export const PLAYFUL_LOADING_TIPS = [
  "说明期望的结果，有助于任务执行",
  "提供资料来源，便于核对结论",
  "涉及文件时，请确认工作目录",
  "需要特定格式时，可在任务中说明",
  "可在执行过程中查看工具操作",
  "收到确认请求时，请检查操作范围",
  "生成文件后，可打开文件检查内容",
  "补充约束条件，有助于减少反复调整",
  "需要修改结果时，可继续补充要求",
  "重要内容请核对来源和依据",
  "复杂任务可使用计划模式确认步骤",
  "对外使用结果前，请检查关键结论",
] as const;

export const LOADING_TIPS: readonly string[] = [
  ...PRACTICAL_LOADING_TIPS,
  ...PLAYFUL_LOADING_TIPS,
];

export const THINKING_COMPANION_TIPS = [
  "先把问题理顺，再给你清楚的结论。",
  "正在从细节里找主线。",
  "复杂一点没关系，我先拆开来看。",
  "让信息先各就各位。",
] as const;

export function pickLoadingTip(random = Math.random): string {
  const value = Math.max(0, Math.min(0.999_999, random()));
  return LOADING_TIPS[Math.floor(value * LOADING_TIPS.length)];
}

export function pickThinkingCompanion(random = Math.random): string {
  const value = Math.max(0, Math.min(0.999_999, random()));
  return THINKING_COMPANION_TIPS[
    Math.floor(value * THINKING_COMPANION_TIPS.length)
  ];
}
