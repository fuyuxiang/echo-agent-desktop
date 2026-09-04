/**
 * Skill detail view — shown when clicking a skill card, mirrors EchoAgent's
 * SkillDetailView: a header (icon + name + description + install/try buttons),
 * a preview/source toggle, and the rendered SKILL.md markdown body.
 *
 * Unlike EchoAgent (which inlines the view), we use a full-screen overlay so
 * the back button returns to the skill grid without disturbing the grid state.
 */
import { useEffect, useId, useMemo, useState } from "react";
import type { SkillItem, SkillInfo, SkillPackageInspection } from "@/lib/types";
import {
  skillsCatalogReadSkill,
  skillsInspectPackage,
  skillsInstallPackage,
} from "@/lib/agent-client";
import { Markdown } from "@/components/markdown/Markdown";
import { ConnectorIcon } from "../shared/ConnectorIcon";
import { LetterAvatar } from "../shared/LetterAvatar";
import {
  ChevronLeftIcon, AddIcon, CheckIcon, FileTextIcon, Code2Icon,
} from "@/foundation/components/Icon/icons";
import { useModalFocus } from "@/lib/use-modal-focus";

interface Props {
  skill: SkillItem;
  onClose: () => void;
  /** Installed skills (from EchoAgent), to show install state + toggle. */
  installed?: SkillInfo[];
  onInstalled?: () => void;
  onToast?: (m: string) => void;
}

export function SkillDetailModal({ skill, installed = [], onClose, onInstalled, onToast }: Props) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [rawMd, setRawMd] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [installing, setInstalling] = useState(false);
  const [pendingInspection, setPendingInspection] = useState<SkillPackageInspection | null>(null);
  const dialogRef = useModalFocus<HTMLDivElement>(true, onClose);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setRawMd("");
    setLoadError(null);
    skillsCatalogReadSkill(skill.sourceDir)
      .then((txt) => { if (!disposed) setRawMd(txt); })
      .catch((reason) => {
        if (!disposed) {
          setRawMd("");
          setLoadError(String(reason).replace(/^Error:\s*/, ""));
        }
      })
      .finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [skill.sourceDir, reloadKey]);

  // Parse frontmatter + body from the raw markdown.
  const { meta, body } = useMemo(() => parseFrontmatter(rawMd), [rawMd]);

  // Is this skill already installed in EchoAgent?
  const installedEntry = useMemo(
    () => installed.find((s) => (s.displayName || s.name).toLowerCase() === skill.name.toLowerCase()
      || s.name.toLowerCase() === skill.id.toLowerCase()),
    [installed, skill.name, skill.id],
  );
  const canUpdate = Boolean(installedEntry && skill.version && installedEntry.version !== skill.version);

  const handleInstall = async () => {
    if (installing || loading || loadError || (installedEntry && !canUpdate)) return;
    setInstalling(true);
    try {
      const report = await skillsInspectPackage(skill.sourceDir);
      if (report.riskLevel === "high" || report.riskLevel === "medium") {
        setPendingInspection(report);
        return;
      }
      const result = await skillsInstallPackage(skill.sourceDir, report.sourceHash, false);
      onToast?.(`${result.updated ? "已更新" : "已安装"}技能「${skill.name}」`);
      onInstalled?.();
    } catch (e) {
      onToast?.(`导入失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setInstalling(false);
    }
  };

  const confirmRiskInstall = async () => {
    const report = pendingInspection;
    if (!report || installing) return;
    setInstalling(true);
    try {
      const result = await skillsInstallPackage(
        skill.sourceDir,
        report.sourceHash,
        report.riskLevel === "high",
      );
      setPendingInspection(null);
      onToast?.(`${result.updated ? "已更新" : "已安装"}技能「${skill.name}」`);
      onInstalled?.();
    } catch (reason) {
      onToast?.(`导入失败：${String(reason).replace(/^Error:\s*/, "")}`);
    } finally {
      setInstalling(false);
    }
  };

  const displayName = meta.name || skill.name;
  const description = skill.desc || meta.description || "";

  return (
    <div className="sk-detail-overlay" onClick={onClose}>
      <div ref={dialogRef} className="sk-detail" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${displayName} 技能详情`} tabIndex={-1}>
        {/* Header bar with back button */}
        <div className="sk-detail-bar">
          <button type="button" className="um-back" onClick={onClose} data-modal-initial-focus>
            <ChevronLeftIcon size="sm" /><span>技能市场</span>
          </button>
        </div>

        <div className="sk-detail-scroll">
          {/* Header: icon + name + description + actions */}
          <div className="sk-detail-header">
            {skill.iconLocal ? (
              <ConnectorIcon local={skill.iconLocal} name={displayName} size={56} shape="square" />
            ) : (
              <LetterAvatar name={displayName} size={56} shape="square" />
            )}
            <div className="sk-detail-headinfo">
              <h2 className="sk-detail-title">{displayName}</h2>
              {description && <p className="sk-detail-sub">{description}</p>}
              <div className="sk-detail-actions">
                {installedEntry && !canUpdate ? (
                  <>
                    <span className="sk-detail-installed">
                      <CheckIcon size="sm" /><span>已安装</span>
                    </span>
                    <label className="sk-toggle" title={installedEntry.enabled ? "已启用" : "已禁用"}>
                      <input type="checkbox" checked={installedEntry.enabled} readOnly />
                      <span className="sk-toggle-track"><span className="sk-toggle-thumb" /></span>
                    </label>
                  </>
                ) : (
                  <button type="button" className="sk-detail-install-btn" onClick={handleInstall} disabled={installing || loading || Boolean(loadError)}>
                    <AddIcon size="sm" /><span>{installing ? "安装中…" : canUpdate ? "更新技能" : "安装技能"}</span>
                  </button>
                )}
                {meta.version && <span className="sk-detail-ver">v{meta.version}</span>}
              </div>
            </div>
          </div>

          {/* Toolbar: preview / source toggle */}
          <div className="sk-detail-toolbar">
            <button type="button"
              className={`sk-detail-tab${mode === "preview" ? " sk-detail-tab--active" : ""}`}
              onClick={() => setMode("preview")}>
              <FileTextIcon size="sm" /><span>预览</span>
            </button>
            <button type="button"
              className={`sk-detail-tab${mode === "code" ? " sk-detail-tab--active" : ""}`}
              onClick={() => setMode("code")}>
              <Code2Icon size="sm" /><span>源码</span>
            </button>
          </div>

          {/* Content */}
          {loading ? (
            <div className="sk-detail-loading">加载技能详情…</div>
          ) : loadError ? (
            <div className="sk-detail-empty" role="alert">
              <p>技能预览加载失败：{loadError}</p>
              <button type="button" className="um-btn um-btn--grey" onClick={() => setReloadKey((value) => value + 1)}>
                重试加载预览
              </button>
            </div>
          ) : mode === "code" ? (
            <pre className="sk-detail-code"><code>{rawMd}</code></pre>
          ) : (
            <div className="sk-detail-content">
              {/* Meta grid (frontmatter key-values, excluding slug/name/description) */}
              {Object.keys(meta).length > 0 && (
                <div className="sk-detail-meta-grid">
                  {Object.entries(meta)
                    .filter(([k]) => !["slug", "name", "description", "description_zh", "description_en"].includes(k))
                    .map(([k, v]) => (
                      <div key={k} className="sk-detail-meta-item">
                        <span className="sk-detail-meta-label">{k}</span>
                        <span className="sk-detail-meta-value">{v}</span>
                      </div>
                    ))}
                </div>
              )}
              {body ? (
                <Markdown complete>{body}</Markdown>
              ) : (
                <p className="sk-detail-empty">该技能暂无详细说明</p>
              )}
            </div>
          )}
        </div>
      </div>
      {pendingInspection && (
        <SkillRiskConfirmDialog
          skillName={displayName}
          inspection={pendingInspection}
          busy={installing}
          onCancel={() => {
            if (!installing) setPendingInspection(null);
          }}
          onConfirm={() => void confirmRiskInstall()}
        />
      )}
    </div>
  );
}

function SkillRiskConfirmDialog({
  skillName,
  inspection,
  busy,
  onCancel,
  onConfirm,
}: {
  skillName: string;
  inspection: SkillPackageInspection;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const dialogRef = useModalFocus<HTMLDivElement>(true, () => {
    if (!busy) onCancel();
  });
  const highRisk = inspection.riskLevel === "high";

  return (
    <div className="modal-overlay" onClick={(event) => {
      event.stopPropagation();
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <div ref={dialogRef} className="atm-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <h3 id={titleId} className="atm-confirm-title">
          {highRisk ? "确认安装高风险技能" : "确认安装需审查技能"}
        </h3>
        <p className="atm-confirm-content">技能「{skillName}」{highRisk ? "被标记为高风险" : "包含需要关注的操作"}：</p>
        {inspection.findings.length > 0 && (
          <ul className="automation-permission-confirm__list">
            {inspection.findings.slice(0, 5).map((finding, index) => (
              <li key={`${finding.code}-${finding.path ?? index}`}>{finding.message}</li>
            ))}
          </ul>
        )}
        <p className="atm-confirm-content">请确认你已检查完整源码和上述风险。</p>
        <div className="atm-confirm-actions">
          <button type="button" className="atm-btn atm-btn--secondary" onClick={onCancel} disabled={busy} data-modal-initial-focus>取消</button>
          <button type="button" className="atm-btn atm-btn--danger" onClick={onConfirm} disabled={busy}>
            {busy ? "安装中…" : highRisk ? "仍要安装" : "确认安装"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Split raw SKILL.md into a frontmatter meta map + body markdown. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const t = raw.trimStart();
  if (!t.startsWith("---")) return { meta: {}, body: raw };
  const afterOpen = t.slice(3);
  const nl = afterOpen.indexOf("\n");
  if (nl === -1) return { meta: {}, body: raw };
  const rest = afterOpen.slice(nl + 1);
  const closeIdx = rest.search(/\n---\s*(\n|$)/);
  if (closeIdx === -1) return { meta: {}, body: raw };
  const fm = rest.slice(0, closeIdx);
  const bodyStart = rest.indexOf("\n", closeIdx + 1);
  const body = bodyStart >= 0 ? rest.slice(bodyStart + 1).trim() : "";

  const meta: Record<string, string> = {};
  let currentKey = "";
  for (const line of fm.split("\n")) {
    // Top-level key: value
    const m = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (m && !line.startsWith(" ")) {
      currentKey = m[1];
      let v = m[2].trim();
      // Strip quotes.
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (v && v !== "|" && v !== "|-" && v !== ">" && v !== ">-") {
        meta[currentKey] = v;
      }
    } else if (currentKey && line.startsWith(" ") && meta[currentKey] !== undefined) {
      // Continuation of a plain multi-line value — append.
      meta[currentKey] += " " + line.trim();
    }
  }
  return { meta, body };
}
