import { useCallback, useEffect, useMemo, useState } from "react";
import { Upload } from "lucide-react";
import {
  SearchIcon, AddCircleIcon, RefreshCwIcon, PuzzlePieceIcon, DeleteIcon,
} from "@/foundation/components/Icon/icons";
import {
  skillsList, skillsRemove, skillsToggle, skillsUninstallPackage,
} from "@/lib/agent-client";
import type { SkillInfo } from "@/lib/types";
import { ImportSkillModal } from "./ImportSkillModal";
import { UploadSkillModal } from "./UploadSkillModal";
import { listenOrgSkillsChanged, orgSetSkillPreference } from "@/lib/org-client";

interface Props {
  pills: React.ReactNode;
  onToast?: (m: string) => void;
}

function organizationScopeLabel(scope: SkillInfo["orgScopeKind"]): string {
  if (scope === "personal") return "个人云 Skill";
  if (scope === "team") return "团队共享";
  if (scope === "org") return "全组织共享";
  return "服务器同步";
}

function skillSourceLabel(skill: SkillInfo): string {
  if (skill.orgManaged || skill.scope === "server") {
    return organizationScopeLabel(skill.orgScopeKind);
  }
  if (skill.managed) return "本地用户";
  const labels: Record<string, string> = {
    local: "当前项目",
    repo: "代码仓库",
    user: "本地用户",
    bundled: "内置技能",
    plugin: "插件技能",
  };
  return skill.scope ? labels[skill.scope] ?? skill.scope : "本地来源";
}

function RuntimeSkillRow({
  skill,
  onToggle,
  onRemove,
  onUpload,
}: {
  skill: SkillInfo;
  onToggle: (skill: SkillInfo, enabled: boolean) => void;
  onRemove?: (skill: SkillInfo) => void;
  onUpload?: (skill: SkillInfo) => void;
}) {
  const name = skill.displayName || skill.name;
  const organizationManaged = skill.orgManaged || skill.scope === "server";
  const mandatory = organizationManaged && skill.orgMandatory === true;
  const removablePath = skill.managed ? skill.path : skill.configuredPath;
  const toggleAction = organizationManaged
    ? skill.enabled ? "卸载" : "安装"
    : skill.enabled ? "停用" : "启用";
  return (
    <div className={`sk-inst-row${organizationManaged ? " sk-inst-row--organization" : ""}`}>
      <div className="sk-card-head" style={{ flex: 1 }}>
        <PuzzlePieceIcon size="md" className="sk-inst-icon" />
        <div className="sk-inst-info">
          <div className="sk-card-name">{name}</div>
          <p className="sk-card-desc">{skill.description || "（无描述）"}</p>
          <div className="sk-inst-meta">
            <span>{skillSourceLabel(skill)}</span>
            {organizationManaged && <span>组织托管</span>}
            {mandatory && <span className="sk-inst-meta--mandatory">组织强制</span>}
            {skill.version && <span>v{skill.version}</span>}
            {skill.compatibility && <span title={skill.compatibility}>{skill.compatibility}</span>}
          </div>
        </div>
      </div>
      <label className={`sk-toggle${mandatory ? " sk-toggle--locked" : ""}`}
        title={mandatory ? "组织强制 Skill 不能卸载" : organizationManaged
          ? skill.enabled ? "已安装" : "未安装"
          : skill.enabled ? "已启用" : "已禁用"}>
        <input
          type="checkbox"
          aria-label={`${toggleAction}${name}`}
          checked={skill.enabled}
          disabled={mandatory}
          onChange={() => onToggle(skill, !skill.enabled)}
        />
        <span className="sk-toggle-track"><span className="sk-toggle-thumb" /></span>
      </label>
      {onUpload && skill.path && !organizationManaged && (
        <button type="button" className="sk-inst-upload" title="上传到组织"
          aria-label={`上传${name}到组织`}
          onClick={() => onUpload(skill)}><Upload size={16} /></button>
      )}
      {onRemove && removablePath && !organizationManaged && (
        <button type="button" className="sk-inst-del" title="移除"
          onClick={() => onRemove(skill)}><DeleteIcon size="sm" /></button>
      )}
    </div>
  );
}

/**
 * 技能页直接展示 EchoAgent Runtime 的技能扫描结果。
 *
 * Runtime 会自动扫描用户全局 `~/.echo-agent/skills`，并合并当前工作区、
 * 内置和插件技能。组织 Skill 也安装在该全局目录下，因此这里不再维护
 * 另一套“来源目录”或市场目录选择状态。
 */
export function SkillsTab({ pills, onToast }: Props) {
  const [search, setSearch] = useState("");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [uploadSkill, setUploadSkill] = useState<SkillInfo | null>(null);

  const reloadSkills = useCallback(async (silent = false) => {
    setLoading(true);
    setError("");
    try {
      setSkills(await skillsList());
    } catch (e) {
      const message = String(e).replace(/^Error:\s*/, "");
      setError(message);
      if (!silent) onToast?.(`加载技能失败：${message}`);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => { void reloadSkills(true); }, [reloadSkills]);
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenOrgSkillsChanged(() => { void reloadSkills(true); }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reloadSkills]);

  const visible = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return skills;
    return skills.filter((skill) => (
      (skill.displayName || skill.name).toLowerCase().includes(query)
      || skill.name.toLowerCase().includes(query)
      || (skill.description ?? "").toLowerCase().includes(query)
      || skillSourceLabel(skill).toLowerCase().includes(query)
    ));
  }, [search, skills]);

  const handleToggle = useCallback(async (skill: SkillInfo, enabled: boolean) => {
    if (skill.orgMandatory) return;
    try {
      if ((skill.orgManaged || skill.scope === "server") && skill.orgSkillId) {
        await orgSetSkillPreference(skill.orgSkillId, enabled);
        onToast?.(enabled ? "组织 Skill 已安装" : "组织 Skill 已卸载");
      } else {
        await skillsToggle(skill.name, enabled);
      }
      await reloadSkills();
    } catch (e) {
      onToast?.(`切换失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  }, [onToast, reloadSkills]);

  const handleRemove = useCallback(async (skill: SkillInfo) => {
    const removablePath = skill.managed ? skill.path : skill.configuredPath;
    if (!removablePath) {
      onToast?.("该技能由项目、内置包或插件管理，请在对应来源中修改");
      return;
    }
    const action = skill.managed ? "卸载" : "从配置中移除";
    const shared = !skill.managed
      ? skills.filter((candidate) => candidate.configuredPath === removablePath).length
      : 1;
    const impact = shared > 1 ? `\n\n该路径共提供 ${shared} 个技能，移除后它们都将不再加载。` : "";
    if (!confirm(`确定${action}技能「${skill.displayName || skill.name}」？${impact}`)) return;
    try {
      if (skill.managed) await skillsUninstallPackage(removablePath);
      else await skillsRemove(removablePath);
      onToast?.(skill.managed ? "已安全卸载" : "已从技能路径中移除");
      await reloadSkills();
    } catch (e) {
      onToast?.(`移除失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
  }, [skills, onToast, reloadSkills]);

  return (
    <div className="um-page">
      <header className="um-topbar">
        <div className="um-topbar-left">{pills}</div>
        <div className="um-topbar-right">
          <div className="um-search">
            <SearchIcon size="sm" className="um-search-icon" />
            <input className="um-search-input" value={search} placeholder="搜索已安装技能"
              onChange={(event) => setSearch(event.target.value)} />
          </div>
          <button type="button" className="um-btn um-btn--grey" onClick={() => setImportOpen(true)}>
            <AddCircleIcon size="sm" /><span>添加技能</span>
          </button>
        </div>
      </header>

      <div className="um-scroll">
        <div className="ec-source-bar">
          <span className="ec-source-label" title="~/.echo-agent/skills">
            用户全局技能 · ~/.echo-agent/skills
          </span>
          <button type="button" className="ec-source-btn" onClick={() => void reloadSkills()}
            disabled={loading} title="重新扫描全局和当前工作区技能">
            <RefreshCwIcon size="sm" /><span>刷新</span>
          </button>
        </div>

        {error && (
          <div className="ec-error">
            加载失败：{error}
            <button type="button" className="ec-source-btn" onClick={() => void reloadSkills()}>重试</button>
          </div>
        )}

        {loading && skills.length === 0 ? (
          <div className="ec-loading">扫描全局技能目录…</div>
        ) : skills.length === 0 ? (
          <div className="ec-empty">
            <PuzzlePieceIcon size="xl" className="ec-empty-icon" />
            <p>全局目录中还没有技能</p>
            <p className="ec-empty-hint">点击右上角「添加技能」，或从组织记忆安装共享 Skill</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="ec-empty">
            <PuzzlePieceIcon size="xl" className="ec-empty-icon" />
            <p>没有找到与「{search}」匹配的技能</p>
          </div>
        ) : (
          <div className="sk-inst-list">
            {visible.map((skill) => (
              <RuntimeSkillRow key={skill.name + (skill.path ?? "")} skill={skill}
                onToggle={handleToggle} onRemove={handleRemove} onUpload={setUploadSkill} />
            ))}
          </div>
        )}
      </div>

      {importOpen && (
        <ImportSkillModal onClose={() => setImportOpen(false)} onToast={onToast}
          onInstalled={reloadSkills} />
      )}
      {uploadSkill && (
        <UploadSkillModal skill={uploadSkill} onClose={() => setUploadSkill(null)} onToast={onToast} />
      )}
    </div>
  );
}
