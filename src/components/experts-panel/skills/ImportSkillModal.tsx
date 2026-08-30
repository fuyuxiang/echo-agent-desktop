import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { XCloseIcon, FolderOpenIcon } from "@/foundation/components/Icon/icons";
import { skillsInspectPackage, skillsInstallPackage } from "@/lib/agent-client";
import type { SkillPackageInspection, SkillRiskLevel } from "@/lib/types";

const RISK_LABEL: Record<SkillRiskLevel, string> = {
  low: "低风险",
  medium: "中风险",
  high: "高风险",
};

/** Managed local Skill installer: inspect first, then copy/update atomically. */
export function ImportSkillModal({
  onClose, onToast, onInstalled,
}: {
  onClose: () => void;
  onToast?: (m: string) => void;
  onInstalled?: () => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [autoInstall, setAutoInstall] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedPath, setSelectedPath] = useState("");
  const [inspection, setInspection] = useState<SkillPackageInspection | null>(null);
  const [acceptedHighRisk, setAcceptedHighRisk] = useState(false);
  const [error, setError] = useState("");

  const commitInstall = async (path: string, report: SkillPackageInspection, approved = false) => {
    setBusy(true);
    setError("");
    try {
      const result = await skillsInstallPackage(path, approved);
      onToast?.(`${result.updated ? "已更新" : "已安装"}技能「${result.inspection.name}」`);
      onInstalled?.();
      onClose();
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setInspection(report);
    } finally {
      setBusy(false);
    }
  };

  const inspect = async (path: string) => {
    setBusy(true);
    setError("");
    setInspection(null);
    setSelectedPath(path);
    setAcceptedHighRisk(false);
    try {
      const report = await skillsInspectPackage(path);
      setInspection(report);
      if (autoInstall && report.riskLevel === "low") {
        await commitInstall(path, report);
      }
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setBusy(false);
    }
  };

  const pickFile = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: "选择技能文件（Markdown 或 ZIP）",
        filters: [{ name: "技能包", extensions: ["md", "markdown", "zip"] }],
      });
      if (selected && !Array.isArray(selected)) await inspect(selected);
    } catch { /* cancelled */ }
  };

  const pickFolder = async () => {
    try {
      const selected = await openDialog({ directory: true, multiple: false, title: "选择技能文件夹" });
      if (selected && !Array.isArray(selected)) await inspect(selected);
    } catch { /* cancelled */ }
  };

  const onDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const files = Array.from(event.dataTransfer.files) as (File & { path?: string })[];
    const path = files[0]?.path;
    if (path) await inspect(path);
    else setError("无法读取拖入文件的本地路径，请点击选择文件或文件夹");
  };

  const canInstall = inspection
    && (inspection.riskLevel !== "high" || acceptedHighRisk)
    && !busy;

  return (
    <div className="modal-overlay sk-import-overlay" onClick={onClose}>
      <div className="sk-import sk-import--managed" onClick={(e) => e.stopPropagation()}>
        <div className="sk-import-head">
          <div>
            <h3>安装本地技能</h3>
            <p>安装前检查内容，并复制到 EchoAgent 管理目录</p>
          </div>
          <button type="button" className="sk-import-close" onClick={onClose} disabled={busy}>
            <XCloseIcon size="md" />
          </button>
        </div>
        <div className="sk-import-body">
          <div
            className={`sk-drop${dragging ? " sk-drop--drag" : ""}${busy ? " sk-drop--busy" : ""}`}
            onClick={() => { if (!busy) void pickFile(); }}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <FolderOpenIcon size="xl" className="sk-drop-icon" />
            <div className="sk-drop-title">
              {dragging ? "松开以检查" : busy ? "正在检查技能包…" : "拖入 Markdown / ZIP，或点击选择"}
            </div>
            {selectedPath && <div className="sk-drop-path" title={selectedPath}>{selectedPath}</div>}
          </div>
          <button type="button" className="sk-import-folder" onClick={pickFolder} disabled={busy}>
            或选择一个包含 SKILL.md 的文件夹
          </button>

          <label className="sk-import-check">
            <input type="checkbox" checked={autoInstall} disabled={busy}
              onChange={(e) => setAutoInstall(e.target.checked)} />
            <span>仅在检查结果为低风险时自动安装</span>
          </label>

          {error && <div className="sk-install-error">{error}</div>}

          {inspection && (
            <div className="sk-inspection">
              <div className="sk-inspection-head">
                <div>
                  <strong>{inspection.name}</strong>
                  {inspection.version && <span>v{inspection.version}</span>}
                </div>
                <span className={`sk-risk sk-risk--${inspection.riskLevel}`}>
                  {RISK_LABEL[inspection.riskLevel]}
                </span>
              </div>
              <p className="sk-inspection-desc">{inspection.description}</p>
              <div className="sk-inspection-meta">
                <span>{inspection.fileCount} 个文件</span>
                <span>{formatBytes(inspection.totalBytes)}</span>
                <span>{inspection.alreadyInstalled ? "将更新现有版本" : "全新安装"}</span>
              </div>

              {inspection.findings.length > 0 && (
                <div className="sk-findings">
                  {inspection.findings.map((finding, index) => (
                    <div key={`${finding.code}-${finding.path ?? index}`} className={`sk-finding sk-finding--${finding.level}`}>
                      <span>{finding.message}</span>
                      {finding.path && <code>{finding.path}</code>}
                    </div>
                  ))}
                </div>
              )}
              {inspection.warnings.map((warning) => (
                <div key={warning} className="sk-install-warning">{warning}</div>
              ))}

              {inspection.riskLevel === "high" && (
                <label className="sk-high-risk-confirm">
                  <input type="checkbox" checked={acceptedHighRisk}
                    onChange={(e) => setAcceptedHighRisk(e.target.checked)} />
                  <span>我已查看上述风险，确认仍要安装并允许 Agent 使用该技能</span>
                </label>
              )}

              <button type="button" className="um-btn um-btn--primary sk-install-submit"
                disabled={!canInstall}
                onClick={() => inspection && void commitInstall(selectedPath, inspection, acceptedHighRisk)}>
                {busy ? "安装中…" : inspection.alreadyInstalled ? "更新技能" : "安装技能"}
              </button>
            </div>
          )}

          {!inspection && !error && (
            <div className="sk-import-req">
              <div className="sk-import-req-title">安装检查</div>
              <ul className="sk-import-req-list">
                <li>验证 SKILL.md、文件数量、大小和目录安全</li>
                <li>扫描脚本、敏感文件访问、网络和依赖安装风险</li>
                <li>生成内容指纹，并支持后续原子更新和安全卸载</li>
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
