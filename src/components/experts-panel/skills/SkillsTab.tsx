import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Upload } from "lucide-react";
import {
  SearchIcon, InstalledSkillIcon, AddCircleIcon, RefreshCwIcon,
  PuzzlePieceIcon, DeleteIcon, FolderOpenIcon, ChevronLeftIcon, SparklesIcon,
  RestoreIcon,
} from "@/foundation/components/Icon/icons";
import {
  skillsList, skillsRemove, skillsToggle, skillsUninstallPackage,
  skillsCatalogDefaultRoot, skillsCatalogLoad,
} from "@/lib/agent-client";
import type { SkillCatalog, SkillItem, SkillInfo } from "@/lib/types";
import { Chip } from "../shared/ui";
import { SkillCatalogCard } from "./SkillCatalogCard";
import { SkillDetailModal } from "./SkillDetailModal";
import { ImportSkillModal } from "./ImportSkillModal";
import { UploadSkillModal } from "./UploadSkillModal";
import {
  clearCatalogRoot,
  isLegacyWorkBuddyPath,
  readCatalogRoot,
  writeCatalogRoot,
} from "@/lib/catalog-root-storage";
import { listenOrgSkillsChanged, orgSetSkillPreference } from "@/lib/org-client";

const FEATURED_WINDOW = 8;

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
  if (skill.managed) return "EchoAgent 管理";
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

/** 技能 tab — a live catalog scanned from the agents tree + echo-agent
 *  built-ins, plus the existing "我安装的" (runtime-managed) view. */
export function SkillsTab({ pills, onToast }: Props) {
  // ---- catalog (market) state ----
  const [root, setRoot] = useState<string>(() => readCatalogRoot("skills"));
  const [catalog, setCatalog] = useState<SkillCatalog | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [needPick, setNeedPick] = useState(false);

  const [view, setView] = useState<"center" | "installed">("center");
  const [cat, setCat] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [modalSkill, setModalSkill] = useState<SkillItem | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [uploadSkill, setUploadSkill] = useState<SkillInfo | null>(null);

  // ---- installed (EchoAgent) state ----
  const [locals, setLocals] = useState<SkillInfo[]>([]);
  const [localsLoading, setLocalsLoading] = useState(false);

  const loadCatalog = useCallback(async (
    r: string,
    persistOverride = false,
  ): Promise<boolean> => {
    if (isLegacyWorkBuddyPath(r)) {
      clearCatalogRoot("skills");
      setRoot("");
      setCatalog(null);
      setError("不能使用 WorkBuddy 数据目录，请选择 EchoAgent 数据目录");
      return false;
    }
    setLoading(true); setError(""); setNeedPick(false);
    try {
      const c = await skillsCatalogLoad(r);
      setCatalog(c);
      setRoot(c.root || r);
      if (persistOverride) writeCatalogRoot("skills", c.root || r);
      return true;
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
      setCatalog(null);
      return false;
    } finally {
      setLoading(false);
    }
  }, []);

  // Resolve the data root on first mount.
  useEffect(() => {
    let disposed = false;
    (async () => {
      if (root) {
        const loaded = await loadCatalog(root);
        if (disposed || loaded) return;
        clearCatalogRoot("skills");
        setRoot("");
      }
      try {
        const d = await skillsCatalogDefaultRoot();
        if (disposed) return;
        if (d && !isLegacyWorkBuddyPath(d)) {
          const loaded = await loadCatalog(d);
          if (!disposed && !loaded) setNeedPick(true);
        } else {
          setNeedPick(true);
        }
      } catch {
        if (!disposed) setNeedPick(true);
      }
    })();
    return () => { disposed = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reloadLocals = useCallback(async (silent = false) => {
    setLocalsLoading(true);
    try { setLocals(await skillsList()); }
    catch (e) {
      // On the catalog page a failed EchoAgent skill list is non-fatal (the local
      // installed badges just stay empty) — don't spam a toast. Only surface
      // the error when the user explicitly opened the "我安装的" view.
      if (!silent) onToast?.(`加载技能失败：${String(e).replace(/^Error:\s*/, "")}`);
    }
    finally { setLocalsLoading(false); }
  }, [onToast]);
  // Mount: load silently so the catalog page never shows a EchoAgent error toast.
  useEffect(() => { reloadLocals(true); }, [reloadLocals]);
  // Entering the installed view: reload with feedback.
  useEffect(() => { if (view === "installed") reloadLocals(false); }, [view, reloadLocals]);
  // Native synchronization can happen from login, logout, a preference
  // change, lease enforcement, or the five-minute background poll.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listenOrgSkillsChanged(() => { void reloadLocals(true); }).then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reloadLocals]);

  const installedNames = useMemo(
    () => new Set(locals.map((s) => (s.displayName || s.name).toLowerCase())),
    [locals],
  );

  const featured = useMemo(
    () => (catalog?.skills ?? []).filter((s) => s.featured),
    [catalog],
  );

  const chips = useMemo(() => {
    const present = new Set((catalog?.skills ?? []).map((s) => s.cat));
    const out: { id: string | null; label: string }[] = [{ id: null, label: "全部" }];
    for (const c of catalog?.categories ?? []) {
      if (present.has(c.id)) out.push({ id: c.id, label: c.zh });
    }
    return out;
  }, [catalog]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (catalog?.skills ?? []).filter((s) => {
      if (cat && s.cat !== cat) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.desc.toLowerCase().includes(q) ||
        (s.descEn ?? "").toLowerCase().includes(q)
      );
    });
  }, [catalog, cat, search]);

  const chooseDir = useCallback(async () => {
    try {
      const sel = await openDialog({
        directory: true, multiple: false, title: "选择技能数据目录",
        defaultPath: root || undefined,
      });
      const pick = Array.isArray(sel) ? sel[0] : sel;
      if (!pick) return;
      if (isLegacyWorkBuddyPath(pick)) {
        onToast?.("不能使用 WorkBuddy 数据目录，请选择 EchoAgent 数据目录");
        return;
      }
      if (await loadCatalog(pick, true)) onToast?.(`已切换技能数据目录：${pick}`);
    } catch { /* cancelled */ }
  }, [root, loadCatalog, onToast]);

  const restoreDefault = useCallback(async () => {
    clearCatalogRoot("skills");
    setRoot(""); setCatalog(null); setError("");
    try {
      const d = await skillsCatalogDefaultRoot();
      if (d && !isLegacyWorkBuddyPath(d) && await loadCatalog(d)) {
        onToast?.("已恢复 EchoAgent 默认技能目录");
        return;
      }
    } catch { /* handled by the empty state */ }
    setNeedPick(true);
  }, [loadCatalog, onToast]);

  const handleAdd = (skill: SkillItem) => setModalSkill(skill);

  const handleToggle = useCallback(async (s: SkillInfo, enabled: boolean) => {
    if (s.orgMandatory) return;
    try {
      if ((s.orgManaged || s.scope === "server") && s.orgSkillId) {
        await orgSetSkillPreference(s.orgSkillId, enabled);
        onToast?.(enabled ? "组织 Skill 已安装" : "组织 Skill 已卸载");
      } else {
        await skillsToggle(s.name, enabled);
      }
      await reloadLocals();
    }
    catch (e) { onToast?.(`切换失败：${String(e).replace(/^Error:\s*/, "")}`); }
  }, [onToast, reloadLocals]);

  const handleRemove = useCallback(async (s: SkillInfo) => {
    const removablePath = s.managed ? s.path : s.configuredPath;
    if (!removablePath) { onToast?.("该技能由项目、内置包或插件管理，请在对应来源中修改"); return; }
    const action = s.managed ? "卸载" : "从配置中移除";
    const shared = !s.managed
      ? locals.filter((candidate) => candidate.configuredPath === removablePath).length
      : 1;
    const impact = shared > 1 ? `\n\n该路径共提供 ${shared} 个技能，移除后它们都将不再加载。` : "";
    if (!confirm(`确定${action}技能「${s.displayName || s.name}」？${impact}`)) return;
    try {
      if (s.managed) await skillsUninstallPackage(removablePath);
      else await skillsRemove(removablePath);
      onToast?.(s.managed ? "已安全卸载" : "已从技能路径中移除");
      reloadLocals();
    }
    catch (e) { onToast?.(`移除失败：${String(e).replace(/^Error:\s*/, "")}`); }
  }, [locals, onToast, reloadLocals]);

  // ---- no data dir yet ----
  if (needPick && !catalog && view === "center") {
    return (
      <div className="um-page">
        <header className="um-topbar">
          <div className="um-topbar-left">{pills}</div>
          <div className="um-topbar-right">
            <button type="button" className="um-btn um-btn--grey" onClick={() => setView("installed")}>
              <InstalledSkillIcon size="sm" /><span>我安装的</span>
            </button>
          </div>
        </header>
        <div className="um-scroll">
          <div className="ec-empty">
            <FolderOpenIcon size="xl" className="ec-empty-icon" />
            <p>未找到技能数据目录</p>
            <p className="ec-empty-hint">请选择包含专家技能目录（<code>&lt;plugin&gt;/skills/*/SKILL.md</code>）的数据根</p>
            <button type="button" className="um-btn um-btn--primary" onClick={chooseDir}>
              <FolderOpenIcon size="sm" /><span>选择来源目录</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- 我安装的 sub-page ----
  if (view === "installed") {
    return (
      <div className="um-page">
        <header className="um-topbar">
          <div className="um-topbar-left">
            <button type="button" className="um-back" onClick={() => setView("center")}>
              <ChevronLeftIcon size="sm" /><span>技能市场</span>
            </button>
          </div>
          <div className="um-topbar-right">
            <button type="button" className="um-btn um-btn--grey" onClick={() => setImportOpen(true)}>
              <AddCircleIcon size="sm" /><span>添加技能</span>
            </button>
          </div>
        </header>
        <div className="um-scroll">
          {localsLoading ? (
            <div className="ec-loading">加载中…</div>
          ) : locals.length === 0 ? (
            <div className="ec-empty">
              <PuzzlePieceIcon size="xl" className="ec-empty-icon" />
              <p>还没有安装任何技能</p>
              <p className="ec-empty-hint">点击右上角「添加技能」或从市场导入</p>
            </div>
          ) : (
            <div className="sk-inst-list">
              {locals.map((s) => (
                <RuntimeSkillRow key={s.name + (s.path ?? "")} skill={s}
                  onToggle={handleToggle} onRemove={handleRemove} onUpload={setUploadSkill} />
              ))}
            </div>
          )}
        </div>

        {importOpen && (
          <ImportSkillModal onClose={() => setImportOpen(false)} onToast={onToast}
            onInstalled={reloadLocals} />
        )}
        {uploadSkill && (
          <UploadSkillModal skill={uploadSkill} onClose={() => setUploadSkill(null)} onToast={onToast} />
        )}
      </div>
    );
  }

  // ---- catalog (market) ----
  return (
    <div className="um-page">
      <header className="um-topbar">
        <div className="um-topbar-left">{pills}</div>
        <div className="um-topbar-right">
          <div className="um-search">
            <SearchIcon size="sm" className="um-search-icon" />
            <input className="um-search-input" value={search} placeholder="搜索技能"
              onChange={(e) => setSearch(e.target.value)} />
          </div>
          <button type="button"
            className="um-btn um-btn--grey" onClick={() => setView("installed")}>
            <InstalledSkillIcon size="sm" /><span>我安装的</span>
          </button>
          <button type="button" className="um-btn um-btn--grey" onClick={() => setImportOpen(true)}>
            <AddCircleIcon size="sm" /><span>添加技能</span>
          </button>
        </div>
      </header>

      <div className="um-scroll">
        <div className="ec-source-bar">
          <span className="ec-source-label" title={root}>来源：{root || "—"}</span>
          <button type="button" className="ec-source-btn" onClick={chooseDir} title="切换来源目录">
            <FolderOpenIcon size="sm" /><span>选择目录</span>
          </button>
          <button type="button" className="ec-source-btn" onClick={restoreDefault} title="恢复 EchoAgent 默认目录">
            <RestoreIcon size="sm" /><span>恢复默认</span>
          </button>
          <button type="button" className="ec-source-btn" onClick={() => root && loadCatalog(root)}
            disabled={loading} title="重新加载">
            <RefreshCwIcon size="sm" />
          </button>
        </div>

        {loading && !catalog && <div className="ec-loading">扫描技能目录…</div>}
        {error && (
          <div className="ec-error">
            加载失败：{error}
            <button type="button" className="ec-source-btn" onClick={chooseDir}>选择目录</button>
          </div>
        )}

        {catalog && (
          <>
            {featured.length > 0 && (
              <section className="sk-featured">
                <div className="sk-featured-head">
                  <h3 className="ec-section-title">精选技能</h3>
                  <span className="ec-section-sub">内置技能 · 共 {featured.length} 个</span>
                </div>
                <div className="sk-featured-grid">
                  {featured.slice(0, FEATURED_WINDOW).map((s) => (
                    <SkillCatalogCard key={s.id} skill={s}
                      installed={installedNames.has(s.name.toLowerCase())}
                      onAdd={handleAdd} onOpen={setModalSkill} />
                  ))}
                </div>
              </section>
            )}

            <div className="ec-chips">
              {chips.map((c) => (
                <Chip key={c.id ?? "all"} label={c.label}
                  active={cat === c.id} onClick={() => setCat(c.id)} />
              ))}
            </div>

            {visible.length === 0 ? (
              <div className="ec-empty">
                <SparklesIcon size="xl" className="ec-empty-icon" />
                <p>{search ? `没有找到与「${search}」匹配的技能` : "该分类暂无技能"}</p>
              </div>
            ) : (
              <div className="sk-grid">
                {visible.map((s) => (
                  <SkillCatalogCard key={s.id} skill={s}
                    installed={installedNames.has(s.name.toLowerCase())}
                    onAdd={handleAdd} onOpen={setModalSkill} />
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {modalSkill && (
        <SkillDetailModal
          skill={modalSkill}
          installed={locals}
          onClose={() => setModalSkill(null)}
          onInstalled={reloadLocals}
          onToast={onToast}
        />
      )}

      {importOpen && (
        <ImportSkillModal onClose={() => setImportOpen(false)} onToast={onToast}
          onInstalled={reloadLocals} />
      )}
    </div>
  );
}
