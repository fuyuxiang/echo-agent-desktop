/**
 * Settings 面板的各个真实分区。
 *
 * 这些是 SettingsPanel.tsx 里除了"模型"以外的运行时设置分区。
 * 每个分区对接 EchoAgent 已有的能力：
 *  - personalize: 主题（接 ThemeProvider）+ 字号
 *  - shortcuts: 当前版本真实生效的快捷键说明
 *  - memory: 本地记忆配置、当前会话落盘与整理
 *  - help: 帮助 + 反馈入口（含 EchoAgent 内核信息）
 *  - security: 安全中心（权限规则入口 + folder trust 说明）
 *  - data: 数据管理（清理会话/缓存 + 打开 EchoAgent 目录）
 *  - general: 系统设置（cwd/工作目录 + 重启 EchoAgent）
 *  - agent-settings: 展示当前智能体运行时配置
 */
import { useCallback, useEffect, useState } from "react";
import {
  Sun,
  Moon,
  Type,
  Folder,
  Trash2,
  ExternalLink,
  RefreshCw,
  Shield,
  Database,
  Mail,
  CheckCheck,
  Filter,
  Download,
  CheckCircle2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { useTheme } from "./ThemeProvider";
import {
  commandsList,
  internalReload,
  mcpList,
  memoryConfigGet,
  memoryConfigSave,
  memoryDream,
  memoryFlush,
  notificationClear,
  notificationList,
  notificationMarkAllRead,
  notificationMarkRead,
  permissionList,
  permissionSave,
  skillsList,
  subagentsConfigGet,
  subagentsConfigSave,
  webSearchConfigGet,
  webSearchConfigSave,
  echoAgentDataDir,
  openEchoAgentDataDir,
  type MemoryConfig,
} from "@/lib/agent-client";
import type {
  McpServerEntry,
  NotificationEntry,
  NotificationKind,
  PermissionRule,
  SkillInfo,
  SlashCommand,
} from "@/lib/types";
import { APP_VERSION } from "@/lib/app-version";
import { useUpdateStore } from "@/stores/update-store";

const FONT_KEY = "echoagent.fontSize";
const SHORTCUT_GROUPS: Array<{
  title: string;
  items: Array<{ key: string; action: string }>;
}> = [
  {
    title: "全局导航",
    items: [
      { key: "Ctrl/Cmd + N", action: "新建任务" },
      { key: "Ctrl/Cmd + K", action: "搜索会话" },
      { key: "Ctrl/Cmd + ,", action: "打开设置" },
      { key: "Ctrl/Cmd + B", action: "切换侧栏" },
    ],
  },
  {
    title: "对话与编辑",
    items: [
      { key: "Enter", action: "发送消息" },
      { key: "Shift + Enter", action: "换行" },
      { key: "Ctrl/Cmd + F", action: "查找当前会话" },
      { key: "Esc", action: "关闭当前弹窗" },
    ],
  },
  {
    title: "快捷输入",
    items: [
      { key: "/ ", action: "触发技能/命令补全" },
      { key: "@ ", action: "引用对话文件" },
    ],
  },
];

function SectionShell({
  title,
  desc,
  actions,
  children,
}: {
  title: string;
  desc?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-section">
      <header className="settings-section__header">
        <div className="settings-section__heading">
          <h2 className="settings-section__title">{title}</h2>
          {desc && <p className="settings-section__desc">{desc}</p>}
        </div>
        {actions && <div className="settings-section__actions">{actions}</div>}
      </header>
      <div className="settings-section__body">{children}</div>
    </div>
  );
}

function SettingsGroup({
  title,
  desc,
  meta,
  children,
  className = "",
}: {
  title: string;
  desc?: string;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`settings-group${className ? ` ${className}` : ""}`}>
      <header className="settings-group__header">
        <div>
          <h3 className="settings-group__title">{title}</h3>
          {desc && <p className="settings-group__desc">{desc}</p>}
        </div>
        {meta && <div className="settings-group__meta">{meta}</div>}
      </header>
      <div className="settings-group__content">{children}</div>
    </section>
  );
}

// ---------- 个性化 ----------

export function PersonalizeSettingsPanel() {
  const { theme, setTheme } = useTheme();
  const [fontSize, setFontSize] = useState<number>(() => {
    const saved = localStorage.getItem(FONT_KEY);
    return saved ? Number(saved) : 13;
  });

  useEffect(() => {
    localStorage.setItem(FONT_KEY, String(fontSize));
    document.documentElement.style.setProperty("--echoagent-font-size", `${fontSize}px`);
    document.body.style.fontSize = `${fontSize}px`;
  }, [fontSize]);

  return (
    <SectionShell
      title="个性化"
      desc="调整外观和字号。主题切换立即生效，字号应用到整个界面。"
    >
      <SettingsGroup title="界面外观" desc="选择适合当前环境的显示主题和阅读字号。">
        <div className="settings-row settings-row--comfortable">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name">
              {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
              主题
            </span>
            <span className="settings-row__description">在浅色和深色界面之间切换</span>
          </div>
          <div className="settings-row__control theme-toggle" role="group" aria-label="界面主题">
            <button
              className={`theme-toggle__btn ${theme === "light" ? "theme-toggle__btn--active" : ""}`}
              onClick={() => setTheme("light")}
              aria-pressed={theme === "light"}
            >
              <Sun size={15} /> 浅色
            </button>
            <button
              className={`theme-toggle__btn ${theme === "dark" ? "theme-toggle__btn--active" : ""}`}
              onClick={() => setTheme("dark")}
              aria-pressed={theme === "dark"}
            >
              <Moon size={15} /> 深色
            </button>
          </div>
        </div>

        <div className="settings-row settings-row--comfortable">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name"><Type size={17} />字号</span>
            <span className="settings-row__description">当前正文大小为 {fontSize}px</span>
          </div>
          <div className="settings-row__control settings-font-control">
            <span className="settings-font-control__sample settings-font-control__sample--small">A</span>
            <input
              type="range"
              min={11}
              max={18}
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
              aria-label="界面字号"
            />
            <span className="settings-font-control__sample settings-font-control__sample--large">A</span>
            <button className="settings-reset" onClick={() => setFontSize(13)}>
              重置
            </button>
          </div>
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}

// ---------- 快捷键 ----------

export function ShortcutsSettingsPanel() {
  return (
    <SectionShell
      title="快捷键"
      desc="以下是当前版本已实际生效的快捷键。"
    >
      <div className="shortcuts-groups">
        {SHORTCUT_GROUPS.map((group) => (
          <SettingsGroup title={group.title} key={group.title}>
            <ul className="shortcuts-list">
              {group.items.map((shortcut) => (
                <li key={shortcut.key} className="shortcuts-list__row">
                  <span className="shortcuts-list__action">{shortcut.action}</span>
                  <kbd className="shortcuts-list__key">{shortcut.key}</kbd>
                </li>
              ))}
            </ul>
          </SettingsGroup>
        ))}
      </div>
    </SectionShell>
  );
}

// ---------- 记忆 ----------

const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  initialInjectionEnabled: true,
  saveOnEnd: true,
  watcherEnabled: true,
  autoFlushEnabled: true,
  dreamEnabled: true,
};

export function MemorySettingsPanel({ sessionId }: { sessionId?: string }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [config, setConfig] = useState<MemoryConfig>(DEFAULT_MEMORY_CONFIG);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void memoryConfigGet()
      .then((value) => {
        if (!cancelled) setConfig(value);
      })
      .catch((error) => {
        if (!cancelled) setMsg(`读取记忆配置失败：${String(error).replace(/^Error:\s*/, "")}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfig = async (key: keyof MemoryConfig, value: boolean) => {
    const previous = config;
    const next = { ...config, [key]: value };
    setConfig(next);
    setBusy(true);
    try {
      setConfig(await memoryConfigSave(next));
      setMsg("记忆配置已保存，重启 Agent 后对新会话生效。");
    } catch (e) {
      setConfig(previous);
      setMsg(`失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  };

  const handleFlush = async () => {
    if (!sessionId) {
      setMsg("立即落盘需要一个已打开的会话。");
      return;
    }
    setBusy(true);
    try {
      await memoryFlush(sessionId);
      setMsg("当前会话记忆已落盘。");
    } catch (e) {
      setMsg(`失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  };

  const handleDream = async () => {
    if (!sessionId) {
      setMsg("整理记忆需要一个已打开的会话。");
      return;
    }
    if (!confirm("将历史会话记录归纳到长期记忆，是否继续？")) return;
    setBusy(true);
    try {
      await memoryDream(sessionId);
      setMsg("长期记忆整理完成。");
    } catch (e) {
      setMsg(`失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  };

  const toggles: Array<{
    key: keyof MemoryConfig;
    name: string;
    description: string;
  }> = [
    { key: "enabled", name: "启用本地记忆", description: "为新会话启用记忆检索、写入和整理能力" },
    { key: "initialInjectionEnabled", name: "会话开始时检索", description: "首轮对话自动注入相关长期记忆" },
    { key: "saveOnEnd", name: "会话结束时保存", description: "将有效会话的摘要保存为可检索记录" },
    { key: "watcherEnabled", name: "监听外部修改", description: "手动编辑记忆文件后自动同步索引" },
    { key: "autoFlushEnabled", name: "自动落盘", description: "空闲或上下文压缩前提取并保存长期信息" },
    { key: "dreamEnabled", name: "自动整理", description: "定期将会话记录合并为结构化长期记忆" },
  ];

  return (
    <SectionShell
      title="记忆"
      desc="本地、可审阅的跨会话记忆，包括全局偏好、工作区上下文和会话记录。"
    >
      <SettingsGroup title="记忆能力" desc="修改后会原子写入本地配置，重启 Agent 后对新会话生效。">
        {toggles.map((toggle) => (
          <div className="settings-row settings-row--comfortable" key={toggle.key}>
            <div className="settings-row__label settings-row__label--stacked">
              <span className="settings-row__name">{toggle.name}</span>
              <span className="settings-row__description">{toggle.description}</span>
            </div>
            <label className="sk-toggle">
              <input
                type="checkbox"
                aria-label={toggle.name}
                checked={config[toggle.key]}
                disabled={loading || busy || (toggle.key !== "enabled" && !config.enabled)}
                onChange={(event) => void updateConfig(toggle.key, event.target.checked)}
              />
              <span className="sk-toggle-track"><span className="sk-toggle-thumb" /></span>
            </label>
          </div>
        ))}
      </SettingsGroup>
      <SettingsGroup title="存储位置" desc="工作区记忆按项目身份存放在此根目录的独立子目录中。">
        <div className="settings-row settings-row--comfortable">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name"><Database size={17} />本地记忆目录</span>
            <span className="settings-row__description">可在侧栏“个人记忆”中查看、编辑和审阅</span>
          </div>
          <code className="settings-path-chip">~/.echo-agent/memory/</code>
        </div>
      </SettingsGroup>
      <SettingsGroup title="当前会话维护" desc={sessionId ? "通常无需手动执行。" : "请先打开一个会话。"}>
        <div className="settings-action-row">
          <div className="settings-action-row__content">
            <strong>立即写入磁盘</strong>
            <span>从当前会话提取长期信息并立即保存。</span>
          </div>
          <button className="settings-btn" onClick={handleFlush} disabled={busy || !sessionId || !config.enabled}>
            <Database size={15} /> 立即落盘
          </button>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-row__content">
            <strong>整理长期记忆</strong>
            <span>将历史会话记录归纳到主题化长期记忆中。</span>
          </div>
          <button className="settings-btn" onClick={handleDream} disabled={busy || !sessionId || !config.enabled}>
            <RefreshCw size={15} /> 立即整理
          </button>
        </div>
      </SettingsGroup>
      {msg && <p className="settings-msg">{msg}</p>}
    </SectionShell>
  );
}

// ---------- 帮助与反馈 ----------

export function HelpSettingsPanel() {
  const updateStatus = useUpdateStore((state) => state.status);
  const update = useUpdateStore((state) => state.update);
  const checkedAt = useUpdateStore((state) => state.checkedAt);
  const updateError = useUpdateStore((state) => state.error);
  const downloaded = useUpdateStore((state) => state.downloaded);
  const total = useUpdateStore((state) => state.total);
  const checkUpdate = useUpdateStore((state) => state.check);
  const installUpdate = useUpdateStore((state) => state.install);
  const updateBusy = updateStatus === "checking" || updateStatus === "downloading" || updateStatus === "installing";
  const updateProgress = total && total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : undefined;

  return (
    <SectionShell title="帮助与反馈" desc="查阅使用文档、协议说明和常见问题排查步骤。">
      <SettingsGroup
        title="版本升级"
        desc="启动时会自动检查 EchoAgent 内网上的签名发布版。"
        meta={<span>v{APP_VERSION}</span>}
      >
        <div className="settings-action-row">
          <div className="settings-action-row__content">
            <strong>
              {updateStatus === "checking" && "正在检查更新…"}
              {updateStatus === "available" && `发现新版本 v${update?.version}`}
              {updateStatus === "downloading" && `正在下载 v${update?.version}`}
              {updateStatus === "installing" && "正在安装，完成后将重启"}
              {updateStatus === "up-to-date" && "当前已是最新版本"}
              {updateStatus === "error" && "检查更新失败"}
              {updateStatus === "idle" && "检查 EchoAgent 更新"}
            </strong>
            <span>
              {updateStatus === "available"
                ? (update?.notes?.trim() || "新版本已准备好，安装前会校验发布签名。")
                : updateStatus === "error"
                  ? updateError
                  : checkedAt
                    ? `上次检查：${new Date(checkedAt).toLocaleString("zh-CN")}`
                    : "更新服务仅在内网或 VPN 环境可访问，断网不影响应用启动。"}
            </span>
            {(updateStatus === "downloading" || updateStatus === "installing") && (
              <div className="settings-update-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateProgress}>
                <span style={updateProgress === undefined ? undefined : { width: `${updateProgress}%` }} />
              </div>
            )}
          </div>
          {updateStatus === "available" ? (
            <button className="settings-btn settings-btn--primary" onClick={() => void installUpdate()}>
              <Download size={15} /> 下载并安装
            </button>
          ) : (
            <button className="settings-btn" onClick={() => void checkUpdate(true)} disabled={updateBusy}>
              {updateStatus === "checking" ? <Loader2 size={15} className="update-dialog__spinner" />
                : updateStatus === "up-to-date" ? <CheckCircle2 size={15} />
                  : updateStatus === "error" ? <AlertTriangle size={15} />
                    : <RefreshCw size={15} />}
              {updateStatus === "checking" ? "检查中" : "检查更新"}
            </button>
          )}
        </div>
      </SettingsGroup>
      <SettingsGroup title="帮助资源">
        <div className="help-grid">
          <a className="help-card" href="https://fuyuxiang.github.io/echo-agent/" target="_blank" rel="noreferrer">
            <ExternalLink size={18} />
            <strong>EchoAgent 文档</strong>
            <span>查看功能说明、配置方法与最佳实践</span>
          </a>
          <a className="help-card" href="https://agentclientprotocol.com/" target="_blank" rel="noreferrer">
            <ExternalLink size={18} />
            <strong>ACP 协议规范</strong>
            <span>了解智能体客户端协议和运行机制</span>
          </a>
          <div className="help-card help-card--static">
            <Database size={18} />
            <strong>内置运行时</strong>
            <span>当前使用 EchoAgent Runtime，无需额外安装</span>
          </div>
        </div>
      </SettingsGroup>
      <SettingsGroup title="快速排查" desc="遇到模型不可用或智能体无法启动时，建议按顺序检查。">
        <ol className="settings-checklist">
          <li><span>1</span><div><strong>确认模型配置</strong><p>在“模型”页面至少配置一个厂商、API Key 和模型。</p></div></li>
          <li><span>2</span><div><strong>检查配置文件</strong><p>确认 <code>~/.echo-agent/config.toml</code> 可以正常读写。</p></div></li>
          <li><span>3</span><div><strong>重新加载或重启</strong><p>先在“系统设置”尝试热重载，仍无效时再重启应用。</p></div></li>
        </ol>
      </SettingsGroup>
    </SectionShell>
  );
}

// ---------- 安全中心 ----------

export function SecuritySettingsPanel() {
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState<PermissionRule>({ action: "ask", tool: "bash", pattern: "" });
  const [feedback, setFeedback] = useState("");
  const [otlpEndpoint, setOtlpEndpoint] = useState(() => {
    try { return localStorage.getItem("echoagent.otlp.endpoint") ?? ""; } catch { return ""; }
  });

  useEffect(() => {
    permissionList()
      .then(setRules)
      .catch(() => setRules([]))
      .finally(() => setLoading(false));
  }, []);

  const addRule = () => {
    if (!draft.tool.trim()) return;
    setRules((items) => [...items, {
      action: draft.action,
      tool: draft.tool.trim().toLowerCase(),
      pattern: draft.pattern?.trim() || undefined,
    }]);
    setDraft({ action: "ask", tool: "bash", pattern: "" });
  };

  const saveRules = async () => {
    setSaving(true);
    setFeedback("");
    try {
      await permissionSave(rules);
      setFeedback("规则已保存；重启 Agent 后对既有会话生效。");
    } catch (error) {
      setFeedback(`保存失败：${String(error).replace(/^Error:\s*/, "")}`);
    } finally {
      setSaving(false);
    }
  };

  const saveOtlp = () => {
    const endpoint = otlpEndpoint.trim();
    if (endpoint) {
      try {
        const parsed = new URL(endpoint);
        if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("仅支持 HTTP/HTTPS");
        localStorage.setItem("echoagent.otlp.endpoint", endpoint);
      } catch (error) {
        setFeedback(`OTLP 地址无效：${String(error).replace(/^Error:\s*/, "")}`);
        return;
      }
    } else {
      localStorage.removeItem("echoagent.otlp.endpoint");
    }
    setFeedback(endpoint ? "OTLP 已启用，重启应用后生效。" : "OTLP 已关闭，重启应用后生效。");
  };

  return (
    <SectionShell
      title="安全中心"
      desc="控制智能体调用工具时的授权规则，并管理本地遥测设置。"
    >
      <SettingsGroup
        title="工具权限规则"
        desc="规则按 deny、ask、allow 的优先级匹配；保存后重启 Agent 生效。"
        meta={<span className="settings-status-badge">{loading ? "加载中…" : `${rules.length} 条规则`}</span>}
      >
        {rules.length > 0 ? (
          <ul className="rules-list">
            {rules.map((rule, index) => (
              <li key={`${rule.action}-${rule.tool}-${rule.pattern ?? ""}-${index}`} className={`rules-list__item rules-list__item--${rule.action}`}>
                <span className="rules-list__action">{rule.action}</span>
                <span className="rules-list__tool">{rule.tool}</span>
                <span className="rules-list__pattern">{rule.pattern || "所有调用"}</span>
                <button
                  type="button"
                  className="rules-list__remove"
                  onClick={() => setRules((items) => items.filter((_, itemIndex) => itemIndex !== index))}
                  aria-label={`删除规则 ${index + 1}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        ) : !loading ? (
          <div className="settings-empty-inline">尚未添加自定义权限规则</div>
        ) : null}

        <div className="permission-rule-builder">
          <label className="permission-rule-builder__field">
            <span>处理方式</span>
            <select className="settings-select" value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} aria-label="规则动作">
              <option value="deny">拒绝 deny</option>
              <option value="ask">询问 ask</option>
              <option value="allow">允许 allow</option>
            </select>
          </label>
          <label className="permission-rule-builder__field">
            <span>工具类型</span>
            <select className="settings-select" value={draft.tool} onChange={(e) => setDraft({ ...draft, tool: e.target.value })} aria-label="工具类型">
              {['bash', 'read', 'edit', 'grep', 'mcp', 'webfetch', 'any'].map((tool) => <option key={tool} value={tool}>{tool}</option>)}
            </select>
          </label>
          <label className="permission-rule-builder__field permission-rule-builder__field--pattern">
            <span>匹配模式（可选）</span>
            <input className="settings-input" value={draft.pattern ?? ""} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} placeholder="例如 git *" />
          </label>
        </div>
        <div className="settings-group__footer">
          <button className="settings-btn" type="button" onClick={addRule}>添加到列表</button>
          <button className="settings-btn settings-btn--primary" type="button" onClick={() => void saveRules()} disabled={saving}>
            {saving ? "保存中…" : "保存全部规则"}
          </button>
        </div>
      </SettingsGroup>
      {feedback && <p className="settings-hint" role="status">{feedback}</p>}
      <SettingsGroup title="遥测与诊断" desc="仅上报运行事件名、级别和技术属性，不包含对话正文。">
        <div className="settings-row settings-row--comfortable">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name"><Shield size={17} />OTLP 遥测端点</span>
            <span className="settings-row__description">留空表示关闭，修改后重启应用生效</span>
          </div>
          <div className="settings-row__control settings-row__control--wide">
            <input
              className="settings-input"
              value={otlpEndpoint}
              onChange={(event) => setOtlpEndpoint(event.target.value)}
              placeholder="http://127.0.0.1:4318/v1/logs"
            />
            <button type="button" className="settings-btn" onClick={saveOtlp}>保存</button>
          </div>
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}

// ---------- 数据管理 ----------

export function DataSettingsPanel() {
  const [agentHome, setAgentHome] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    void echoAgentDataDir()
      .then(setAgentHome)
      .catch((error) => setMessage(`读取数据目录失败：${String(error).replace(/^Error:\s*/, "")}`));
  }, []);

  return (
    <SectionShell title="数据管理" desc="查看 EchoAgent 在本机保存的数据位置和内容范围。">
      <SettingsGroup title="本地数据目录" desc="会话、项目、自动化、通知和配置都保存在此目录。">
        <div className="settings-row settings-row--comfortable settings-row--path">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name"><Folder size={17} />EchoAgent 数据目录</span>
            <span className="settings-row__description">此位置包含应用的重要本地数据</span>
          </div>
          <code className="settings-path-value">{agentHome || "正在读取…"}</code>
        </div>
        <div className="settings-group__footer">
          <button className="settings-btn settings-btn--primary" onClick={() => {
            void openEchoAgentDataDir().catch((error) => setMessage(`打开失败：${String(error).replace(/^Error:\s*/, "")}`));
          }}>
            <Folder size={15} /> 在系统中打开
          </button>
        </div>
      </SettingsGroup>
      {message && <p className="settings-msg">{message}</p>}
      <SettingsGroup title="数据安全" desc="建议通过应用内入口管理数据，避免直接删除目录中的文件。">
        <div className="settings-info-callout">
          删除会话请在侧栏对单个会话操作；直接修改或清理目录可能导致项目、通知或配置无法恢复。
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}

// ---------- 系统设置 ----------

export function GeneralSettingsPanel() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const handleReload = async (kind: "mcp_all" | "skills" | "models") => {
    setBusy(true);
    try {
      await internalReload(kind);
      setMsg(`已触发 ${kind} 热重载`);
    } catch (e) {
      setMsg(`失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <SectionShell
      title="系统设置"
      desc="热重载 EchoAgent 的配置视图。修改 config.toml 后无需重启整个应用。"
    >
      <SettingsGroup title="运行时热重载" desc="只刷新对应配置，不关闭当前窗口或中断其他页面。">
        <div className="settings-action-row">
          <div className="settings-action-row__content"><strong>MCP 连接器</strong><span>重新读取所有 MCP 服务和工具配置。</span></div>
          <button className="settings-btn" onClick={() => handleReload("mcp_all")} disabled={busy}><RefreshCw size={15} />重新加载</button>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-row__content"><strong>技能目录</strong><span>重新扫描本地、项目和组织下发的技能。</span></div>
          <button className="settings-btn" onClick={() => handleReload("skills")} disabled={busy}><RefreshCw size={15} />重新加载</button>
        </div>
        <div className="settings-action-row">
          <div className="settings-action-row__content"><strong>模型配置</strong><span>重新读取厂商、凭据和模型目录。</span></div>
          <button className="settings-btn" onClick={() => handleReload("models")} disabled={busy}><RefreshCw size={15} />重新加载</button>
        </div>
      </SettingsGroup>
      {msg && <p className="settings-msg">{msg}</p>}
    </SectionShell>
  );
}

// ---------- 智能体设置 ----------

/** AgentSettingsPanel — 汇总显示当前智能体配置（skills + MCP + slash 命令）。
 *  数据来自 EchoAgent 的 echo.agent/skills/config、echo.agent/mcp/list、echo.agent/commands/list，
 *  与「专家·技能·连接器」面板的数据源相同，但这里是设置视图：只读 + 刷新 +
 *  跳转到对应管理面板。 */
export function AgentSettingsPanel() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [subagentDepth, setSubagentDepth] = useState<number>(1);
  const [subagentDraft, setSubagentDraft] = useState<string>("1");
  const [webSearchEnabled, setWebSearchEnabled] = useState<boolean>(false);
  const [webSearchModel, setWebSearchModel] = useState<string>("");
  const [webSearchDraftModel, setWebSearchDraftModel] = useState<string>("");
  const [savingRuntime, setSavingRuntime] = useState(false);
  const [runtimeMsg, setRuntimeMsg] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [sk, mc, cmd, sa, ws] = await Promise.all([
        skillsList().catch(() => [] as SkillInfo[]),
        mcpList().catch(() => [] as McpServerEntry[]),
        commandsList().catch(() => [] as SlashCommand[]),
        subagentsConfigGet().catch(() => ({ maxDepth: 1 })),
        webSearchConfigGet().catch(() => ({ enabled: false, model: "" })),
      ]);
      setSkills(sk);
      setServers(mc);
      setCommands(cmd);
      setSubagentDepth(sa.maxDepth);
      setSubagentDraft(String(sa.maxDepth));
      setWebSearchEnabled(ws.enabled);
      setWebSearchModel(ws.model);
      setWebSearchDraftModel(ws.model);
    } catch (e) {
      setError(String(e).replace(/^Error:\s*/, ""));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Save subagent max_depth. Clamped to ≥1 on the backend. */
  const saveSubagentDepth = useCallback(async () => {
    setSavingRuntime(true);
    setRuntimeMsg(null);
    try {
      const clamped = await subagentsConfigSave(Number(subagentDraft) || 1);
      setSubagentDepth(clamped);
      setSubagentDraft(String(clamped));
      setRuntimeMsg(`子代理深度已保存为 ${clamped}（重启 agent 后生效）`);
    } catch (e) {
      setRuntimeMsg(`保存失败：${String(e).replace(/^Error:\s*/, "")}`);
    } finally {
      setSavingRuntime(false);
    }
  }, [subagentDraft]);

  /** Toggle web search on/off. */
  const saveWebSearch = useCallback(
    async (enable: boolean) => {
      setSavingRuntime(true);
      setRuntimeMsg(null);
      try {
        if (enable && !webSearchDraftModel.trim()) {
          setRuntimeMsg("启用 Web 搜索需要指定一个模型 ID");
          setSavingRuntime(false);
          return;
        }
        await webSearchConfigSave(enable, webSearchDraftModel.trim() || undefined);
        setWebSearchEnabled(enable);
        setWebSearchModel(enable ? webSearchDraftModel.trim() : "");
        setRuntimeMsg(
          enable
            ? `Web 搜索已启用（模型 ${webSearchDraftModel.trim()}，重启 agent 后生效）`
            : "Web 搜索已关闭（重启 agent 后生效）",
        );
      } catch (e) {
        setRuntimeMsg(`保存失败：${String(e).replace(/^Error:\s*/, "")}`);
      } finally {
        setSavingRuntime(false);
      }
    },
    [webSearchDraftModel],
  );

  const enabledSkills = skills.filter((s) => s.enabled);
  const disabledSkills = skills.filter((s) => !s.enabled);
  const enabledServers = servers.filter((s) => s.enabled);
  const disabledServers = servers.filter((s) => !s.enabled);
  const builtinCommands = commands.filter((c) => !c.source || c.source === "builtin");
  const skillCommands = commands.filter((c) => c.source === "skill");
  const pluginCommands = commands.filter((c) => c.source === "plugin");

  return (
    <SectionShell
      title="智能体设置"
      desc="查看当前加载的能力，并调整子代理和 Web 搜索等运行时配置。"
      actions={(
        <button className="settings-btn" onClick={reload} disabled={loading}>
          <RefreshCw size={15} /> {loading ? "加载中…" : "刷新状态"}
        </button>
      )}
    >
      {error && <p className="settings-msg settings-msg--warn">加载失败：{error}</p>}

      {/* 汇总统计 */}
      <SettingsGroup title="运行概览" desc="数据来自当前活动的 EchoAgent Runtime。">
        <div className="agent-stats">
          <div className="agent-stats__item">
            <div className="agent-stats__num">{enabledSkills.length}</div>
            <div className="agent-stats__label">启用技能</div>
            {disabledSkills.length > 0 && (
              <div className="agent-stats__sub">另有 {disabledSkills.length} 个已停用</div>
            )}
          </div>
          <div className="agent-stats__item">
            <div className="agent-stats__num">{enabledServers.length}</div>
            <div className="agent-stats__label">已连接 MCP</div>
            {disabledServers.length > 0 && (
              <div className="agent-stats__sub">另有 {disabledServers.length} 个已停用</div>
            )}
          </div>
          <div className="agent-stats__item">
            <div className="agent-stats__num">{commands.length}</div>
            <div className="agent-stats__label">Slash 命令</div>
            <div className="agent-stats__sub">
              {builtinCommands.length} 内置 · {skillCommands.length} 技能 · {pluginCommands.length} 插件
            </div>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup title="已加载能力" desc="展开查看详细清单；启用、停用和安装请前往“专家·技能·连接器”。">
        {/* 技能列表 */}
        <details className="agent-section">
        <summary className="agent-section__title">
          技能（{skills.length}）
        </summary>
        <div className="agent-section__body">
          {skills.length === 0 ? (
            <p className="settings-hint">暂无技能。在「专家·技能·连接器」面板添加。</p>
          ) : (
            <ul className="agent-list">
              {skills.map((s) => (
                <li
                  key={s.name + (s.path ?? "")}
                  className={`agent-list__item ${s.enabled ? "" : "agent-list__item--muted"}`}
                >
                  <span className="agent-list__name">{s.displayName ?? s.name}</span>
                  {s.scope && (
                    <span className="agent-list__badge">{scopeLabel(s.scope)}</span>
                  )}
                  <span
                    className={`agent-list__status ${
                      s.enabled ? "agent-list__status--on" : "agent-list__status--off"
                    }`}
                  >
                    {s.enabled ? "启用" : "禁用"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </details>

      {/* MCP 连接器列表 */}
        <details className="agent-section">
        <summary className="agent-section__title">
          MCP 连接器（{servers.length}）
        </summary>
        <div className="agent-section__body">
          {servers.length === 0 ? (
            <p className="settings-hint">
              暂无连接器。编辑 <code>~/.echo-agent/config.toml</code> 的 <code>[mcp_servers.*]</code> 段。
            </p>
          ) : (
            <ul className="agent-list">
              {servers.map((s) => (
                <li
                  key={s.name}
                  className={`agent-list__item ${s.enabled ? "" : "agent-list__item--muted"}`}
                >
                  <span className="agent-list__name">{s.name}</span>
                  {s.transport && (
                    <span className="agent-list__badge">{s.transport}</span>
                  )}
                  {s.source && (
                    <span className="agent-list__badge">{scopeLabel(s.source)}</span>
                  )}
                  <span
                    className={`agent-list__status ${
                      s.enabled ? "agent-list__status--on" : "agent-list__status--off"
                    }`}
                  >
                    {s.enabled ? "启用" : "禁用"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        </details>

      {/* Slash 命令 */}
        <details className="agent-section">
        <summary className="agent-section__title">
          slash 命令（{commands.length}）
        </summary>
        <div className="agent-section__body">
          {commands.length === 0 ? (
            <p className="settings-hint">暂无命令。</p>
          ) : (
            <ul className="agent-list">
              {commands.map((c) => (
                <li key={c.name} className="agent-list__item">
                  <code className="agent-list__name">/{c.name}</code>
                  {c.source && (
                    <span className="agent-list__badge">{c.source}</span>
                  )}
                  {c.description && (
                    <span className="agent-list__desc">{c.description}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        </details>
      </SettingsGroup>

      {/* 运行时配置：子代理深度 + Web 搜索 */}
      <SettingsGroup title="运行时配置" desc="以下修改需要重启 Agent 后生效。">
          {/* 子代理嵌套深度 */}
          <div className="agent-runtime-row">
            <div className="agent-runtime-row__label">
              <span className="agent-runtime-row__name">子代理嵌套深度</span>
              <span className="agent-runtime-row__hint">
                最大子代理派发层级，当前为 {subagentDepth}。深度 1 表示仅顶层可以派发。
              </span>
            </div>
            <div className="agent-runtime-row__control">
              <input
                type="number"
                min={1}
                max={10}
                className="settings-input settings-input--narrow"
                value={subagentDraft}
                onChange={(e) => setSubagentDraft(e.target.value)}
                disabled={savingRuntime}
              />
              <button
                className="settings-btn"
                onClick={saveSubagentDepth}
                disabled={savingRuntime || subagentDraft === String(subagentDepth)}
              >
                {savingRuntime ? "保存中…" : "保存"}
              </button>
            </div>
          </div>

          {/* Web 搜索开关 */}
          <div className="agent-runtime-row">
            <div className="agent-runtime-row__label">
              <span className="agent-runtime-row__name">Web 搜索</span>
              <span className="agent-runtime-row__hint">
                启用后 Agent 可以联网搜索。请指定搜索模型 ID
                （{webSearchEnabled ? (
                  <span>当前：{webSearchModel || "未设置"}</span>
                ) : (
                  <span>当前：关闭</span>
                )}）。
              </span>
            </div>
            <div className="agent-runtime-row__control">
              <input
                type="text"
                className="settings-input"
                placeholder="搜索模型 ID，如 search-model"
                value={webSearchDraftModel}
                onChange={(e) => setWebSearchDraftModel(e.target.value)}
                disabled={savingRuntime}
              />
              {webSearchEnabled ? (
                <button
                  className="settings-btn settings-btn--danger"
                  onClick={() => saveWebSearch(false)}
                  disabled={savingRuntime}
                >
                  关闭
                </button>
              ) : (
                <button
                  className="settings-btn"
                  onClick={() => saveWebSearch(true)}
                  disabled={savingRuntime || !webSearchDraftModel.trim()}
                >
                  启用
                </button>
              )}
            </div>
          </div>

          {runtimeMsg && (
            <p className="settings-msg settings-msg--info">{runtimeMsg}</p>
          )}
      </SettingsGroup>

      <div className="settings-info-callout">能力清单为只读概览。完成管理操作后，可使用页面右上角“刷新状态”查看最新结果。</div>
    </SectionShell>
  );
}

function scopeLabel(scope: string): string {
  switch (scope) {
    case "user":
      return "用户";
    case "local":
      return "本地";
    case "repo":
    case "project":
      return "项目";
    case "server":
      return "服务器";
    case "bundled":
    case "builtin":
      return "内置";
    case "plugin":
      return "插件";
    default:
      return scope;
  }
}

// ---------- 通知中心 ----------

const KIND_FILTERS: { key: string; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "permission", label: "权限请求" },
  { key: "folder_trust", label: "文件夹信任" },
  { key: "task_update", label: "任务更新" },
  { key: "plan_mode", label: "计划模式" },
  { key: "mcp_status", label: "MCP 状态" },
  { key: "models_update", label: "模型更新" },
  { key: "summary", label: "会话标题" },
  { key: "session_complete", label: "会话完成" },
  { key: "error", label: "错误" },
];

/** NotificationCenterSettingsPanel — EchoAgent 事件通知中心。
 *
 *  EchoAgent 的 agentMail 是腾讯邮箱集成（无 EchoAgent 对应）。EchoAgent 把它
 *  重新定义为 EchoAgent 事件的通知收件箱：权限请求、文件夹信任、任务更新、
 *  plan 模式切换、MCP 状态、模型更新、会话完成等所有事件都会记到这里。
 *  用户可浏览/筛选/标记已读/清空。
 *
 *  数据存在 ~/.echo-agent/echoagent-notifications.json（最多 200 条 FIFO）。
 *  写入由 App.tsx 的事件订阅回调触发（notificationAppend）。 */
export function NotificationCenterSettingsPanel() {
  const [entries, setEntries] = useState<NotificationEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setEntries(await notificationList());
    } catch {
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const handleMarkRead = useCallback(
    async (id: number) => {
      await notificationMarkRead(id);
      reload();
    },
    [reload],
  );

  const handleMarkAllRead = useCallback(async () => {
    await notificationMarkAllRead();
    reload();
  }, [reload]);

  const handleClear = useCallback(async () => {
    if (!confirm("确定清空所有通知？")) return;
    await notificationClear();
    reload();
  }, [reload]);

  const filtered = entries.filter(
    (e) => filter === "all" || String(e.kind) === filter,
  );
  const unreadCount = entries.filter((e) => !e.read).length;

  return (
    <SectionShell
      title="通知中心"
      desc="集中查看权限请求、任务更新、运行状态和会话结果。"
      actions={
        <>
          <button className="settings-btn" onClick={reload} disabled={loading}>
            <RefreshCw size={14} /> {loading ? "加载中…" : "刷新"}
          </button>
          <button
            className="settings-btn"
            onClick={handleMarkAllRead}
            disabled={entries.length === 0}
          >
            <CheckCheck size={14} /> 全部已读
          </button>
          <button
            className="settings-btn settings-btn--danger"
            onClick={handleClear}
            disabled={entries.length === 0}
          >
            <Trash2 size={14} /> 清空
          </button>
        </>
      }
    >
      <SettingsGroup
        title="通知概览"
        desc="通知仅保存在本机，可随时标记已读或清空。"
        meta={
          <span
            className={`settings-status-badge ${
              unreadCount > 0 ? "settings-status-badge--accent" : "settings-status-badge--ready"
            }`}
          >
            {unreadCount > 0 ? `${unreadCount} 条未读` : "全部已读"}
          </span>
        }
      >
        <div className="settings-row settings-row--comfortable">
          <div className="settings-row__label settings-row__label--stacked">
            <span className="settings-row__name">
              <Mail size={16} /> 通知数量
            </span>
            <span className="settings-row__description">
              当前共记录 {entries.length} 条通知，其中 {unreadCount} 条尚未阅读。
            </span>
          </div>
          <div className="settings-row__control">
            <span className="settings-metric">{unreadCount}</span>
            <span className="settings-metric__suffix">未读 / {entries.length} 全部</span>
          </div>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="通知记录"
        desc="按事件类型筛选，快速定位需要处理的信息。"
        meta={<span className="settings-group__count">{filtered.length} 条</span>}
      >
        <div className="notification-filters" aria-label="通知类型筛选">
          <Filter size={13} aria-hidden="true" />
          {KIND_FILTERS.map((f) => (
            <button
              key={f.key}
              className={`notification-filter ${
                filter === f.key ? "notification-filter--active" : ""
              }`}
              onClick={() => setFilter(f.key)}
              aria-pressed={filter === f.key}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="notification-list">
          {filtered.length === 0 && !loading && (
            <div className="notification-empty">
              <Mail size={32} color="var(--echo-text-tertiary)" />
              <p>当前筛选条件下暂无通知。</p>
            </div>
          )}
          {filtered.map((entry) => (
            <div
              key={entry.id}
              className={`notification-row notification-row--${entry.severity} ${
                entry.read ? "notification-row--read" : ""
              }`}
            >
              <div
                className={`notification-row__dot notification-row__dot--${severityToDot(entry.severity)}`}
              />
              <div className="notification-row__body">
                <div className="notification-row__head">
                  <span className="notification-row__kind">
                    {kindLabel(entry.kind as NotificationKind)}
                  </span>
                  <span className="notification-row__title">{entry.title}</span>
                  {!entry.read && <span className="notification-row__unread">未读</span>}
                </div>
                {entry.body && (
                  <pre className="notification-row__body-text">{entry.body}</pre>
                )}
                <div className="notification-row__meta">
                  <span>{formatTime(entry.at)}</span>
                  {entry.sessionId && (
                    <span className="notification-row__session">
                      会话 #{entry.sessionId.slice(0, 8)}
                    </span>
                  )}
                </div>
              </div>
              {!entry.read && (
                <button
                  className="notification-row__mark"
                  onClick={() => handleMarkRead(entry.id)}
                  title="标记已读"
                  aria-label={`将“${entry.title}”标记为已读`}
                >
                  <CheckCheck size={12} />
                </button>
              )}
            </div>
          ))}
          {loading && <div className="notification-empty">正在加载通知…</div>}
        </div>
      </SettingsGroup>
    </SectionShell>
  );
}

function kindLabel(kind: NotificationKind | string): string {
  const map: Record<string, string> = {
    permission: "权限请求",
    folder_trust: "文件夹信任",
    task_update: "任务更新",
    plan_mode: "计划模式",
    mcp_status: "MCP 状态",
    models_update: "模型更新",
    summary: "会话标题",
    session_complete: "会话完成",
    error: "错误",
    info: "信息",
  };
  return map[String(kind)] ?? String(kind);
}

function severityToDot(severity: string): string {
  switch (severity) {
    case "error":
      return "error";
    case "warn":
      return "warn";
    default:
      return "info";
  }
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return iso;
  }
}
