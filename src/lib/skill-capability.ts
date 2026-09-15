import type { SkillCapabilityState } from "./types";

export interface SkillCapabilityPresentation {
  label: string;
  help: string;
}

/** Shared user-facing copy for every capability state. */
export const SKILL_CAPABILITY_PRESENTATION: Record<
  SkillCapabilityState,
  SkillCapabilityPresentation
> = {
  instruction_only: {
    label: "仅工作流",
    help: "这是提示词/工作流 Skill，没有声明可预检的确定性执行入口。",
  },
  ready: {
    label: "可执行 · 就绪",
    help: "执行入口和本机依赖已就绪；运行时仍会经过 Agent 权限审批与沙箱。",
  },
  missing_dependencies: {
    label: "缺少依赖",
    help: "已安装 Skill，但本机缺少其声明的运行命令、工具或连接器。",
  },
  configuration_required: {
    label: "待连接/授权",
    help: "需先连接账号、配置连接器或授予系统权限；EchoAgent 不会把凭据交给模型。",
  },
  invalid: {
    label: "能力清单异常",
    help: "echo.skill.json 格式或声明无效，该包不应执行。",
  },
};
