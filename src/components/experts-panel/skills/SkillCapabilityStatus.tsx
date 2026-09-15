import type {
  SkillCapabilityCheck,
  SkillCapabilityReport,
} from "@/lib/types";
import { SKILL_CAPABILITY_PRESENTATION } from "@/lib/skill-capability";

export function SkillCapabilityStatus({
  report = PROMPT_ONLY_REPORT,
  compact = false,
}: {
  report?: SkillCapabilityReport;
  compact?: boolean;
}) {
  const actionableChecks = report.checks.filter((check) => (
    check.status !== "ready" && check.kind !== "entrypoint"
  ));
  const accountCount = report.manifest?.requirements.connectors
    .filter((connector) => connector.accountRequired).length ?? 0;
  const presentation = SKILL_CAPABILITY_PRESENTATION[report.state];
  const statusHelp = [
    presentation.help,
    ...actionableChecks.slice(0, 5).map((check) => capabilityCheckText(report, check)),
  ].join("\n");

  if (compact) {
    return (
      <span
        className={`sk-cap-badge sk-cap-badge--${report.state}`}
        title={statusHelp}
      >
        {presentation.label}
      </span>
    );
  }

  return (
    <section className={`sk-capability sk-capability--${report.state}`} aria-label="技能执行能力">
      <div className="sk-capability-head">
        <strong>执行能力</strong>
        <span className={`sk-cap-badge sk-cap-badge--${report.state}`}>
          {presentation.label}
        </span>
      </div>
      <p>{presentation.help}</p>

      {report.capabilities.length > 0 && (
        <div className="sk-capability-tags" aria-label="声明的能力">
          {report.capabilities.map((capability) => <code key={capability}>{capability}</code>)}
        </div>
      )}

      {accountCount > 0 && (
        <div className="sk-capability-account">
          需要 {accountCount} 个外部账号；凭据由对应连接器保管，不会写入 Skill 包。
        </div>
      )}

      {actionableChecks.length > 0 && (
        <ul className="sk-capability-checks">
          {actionableChecks.slice(0, 8).map((check) => (
            <li key={`${check.kind}-${check.key}`} className={`sk-capability-check--${check.status}`}>
              {capabilityCheckText(report, check)}
            </li>
          ))}
        </ul>
      )}

      {report.manifest && (
        <div className="sk-capability-permissions">
          <span>文件：{filesystemLabel(report.manifest.permissions.filesystem)}</span>
          <span>网络：{report.manifest.permissions.network.length
            ? `${report.manifest.permissions.network.length} 个声明来源`
            : "不允许"}</span>
          <span>产物：{report.manifest.artifacts.length
            ? `${report.manifest.artifacts.length} 项验收契约`
            : "未声明"}</span>
        </div>
      )}
    </section>
  );
}

const PROMPT_ONLY_REPORT: SkillCapabilityReport = {
  declared: false,
  state: "instruction_only",
  ready: true,
  capabilities: [],
  checks: [{
    kind: "manifest",
    key: "echo.skill.json",
    status: "declared",
    message: "Prompt-only Skill",
  }],
};

function capabilityCheckText(report: SkillCapabilityReport, check: SkillCapabilityCheck): string {
  if (check.kind === "command") {
    return check.status === "missing" ? `本机缺少命令：${check.key}` : `命令已就绪：${check.key}`;
  }
  if (check.kind === "connector") {
    const requirement = report.manifest?.requirements.connectors
      .find((connector) => connector.id === check.key);
    const label = requirement?.label || check.key;
    if (check.status === "missing") return `未安装连接器：${label}`;
    if (requirement?.accountRequired) return `待连接账号：${label}`;
    return `待配置连接器：${label}`;
  }
  if (check.kind === "os_permission") return `待授予系统权限：${check.key}`;
  if (check.kind === "manifest" && check.status === "declared") return "未声明 echo.skill.json";
  return check.message;
}

function filesystemLabel(permission: "none" | "workspace-read" | "workspace-write"): string {
  if (permission === "workspace-write") return "工作区读写";
  if (permission === "workspace-read") return "工作区只读";
  return "无";
}
