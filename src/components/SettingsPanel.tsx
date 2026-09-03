import { useEffect, useState } from "react";
import {
  Mail,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Keyboard,
  Brain,
  Cpu,
  Palette,
  Database,
  BarChart3,
  Shield,
  HelpCircle,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  AgentSettingsPanel,
  DataSettingsPanel,
  GeneralSettingsPanel,
  HelpSettingsPanel,
  MemorySettingsPanel,
  NotificationCenterSettingsPanel,
  PersonalizeSettingsPanel,
  SecuritySettingsPanel,
  ShortcutsSettingsPanel,
} from "./SettingsSections";
import { UsageQuotaPanel } from "./UsageQuotaPanel";
import { ModelConnectionsPanel } from "./ModelConnectionsPanel";

/**
 * EchoAgent-style Settings dialog.
 *
 * Full-screen overlay → centered `.settings-modal` with grouped navigation and
 * a right panel backed by real runtime, config,
 * notification, memory, security, data and appearance settings.
 *
 * The 模型 section delegates to a source-aware connection manager that keeps
 * organization-managed configuration separate from personal API connections.
 */

export type SettingsSectionId =
  | "agent-mail"
  | "general"
  | "agent-settings"
  | "shortcuts"
  | "memory"
  | "model"
  | "personalize"
  | "data"
  | "usage"
  | "security"
  | "help";

interface NavItem {
  id: SettingsSectionId;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  {
    label: "通知",
    items: [
      { id: "agent-mail", label: "通知中心", icon: Mail },
    ],
  },
  {
    label: "智能体",
    items: [
      { id: "model", label: "模型", icon: Cpu },
      { id: "agent-settings", label: "智能体设置", icon: SlidersHorizontal },
      { id: "memory", label: "记忆", icon: Brain },
    ],
  },
  {
    label: "应用",
    items: [
      { id: "general", label: "系统设置", icon: SettingsIcon },
      { id: "personalize", label: "个性化", icon: Palette },
      { id: "shortcuts", label: "快捷键", icon: Keyboard },
    ],
  },
  {
    label: "数据与支持",
    items: [
      { id: "usage", label: "Token 用量", icon: BarChart3 },
      { id: "data", label: "数据管理", icon: Database },
      { id: "security", label: "安全中心", icon: Shield },
      { id: "help", label: "帮助与反馈", icon: HelpCircle },
    ],
  },
];

export function SettingsPanel({
  open,
  onClose,
  onModelsChanged,
  sessionId,
  initialSection = "model",
}: {
  open: boolean;
  onClose: () => void;
  /** Called after a provider is saved/deleted so the app can refresh its
   *  model picker without a restart. */
  onModelsChanged?: () => void | Promise<void>;
  /** Current live session, required by memory flush/consolidation actions. */
  sessionId?: string;
  /** Section selected whenever the dialog is opened. */
  initialSection?: SettingsSectionId;
}) {
  const [active, setActive] = useState<SettingsSectionId>(initialSection);

  // Select the caller-requested section every time the dialog opens.
  useEffect(() => {
    if (open) setActive(initialSection);
  }, [initialSection, open]);

  // Esc closes the dialog.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="settings-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
      onClick={(e) => {
        // 仅当点击遮罩本身(而非弹窗内容)时关闭,与 EchoAgent 一致。
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-modal">
        <nav className="settings-modal__nav">
          <div className="settings-navigation">
            {NAV_GROUPS.map((group) => (
              <section className="settings-navigation__group" key={group.label}>
                <h2 className="settings-navigation__group-label">{group.label}</h2>
                <ul className="settings-navigation__list">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.id}>
                        <button
                          className={
                            "settings-navigation__item" +
                            (active === item.id ? " settings-navigation__item--active" : "")
                          }
                          onClick={() => setActive(item.id)}
                          aria-current={active === item.id ? "page" : undefined}
                        >
                          <span className="settings-navigation__icon">
                            <Icon size={17} strokeWidth={1.75} />
                          </span>
                          <span className="settings-navigation__label">{item.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </nav>

        <div className="settings-modal__content">
          <button
            className="settings-modal__close"
            onClick={onClose}
            aria-label="关闭设置"
            title="关闭 (Esc)"
          >
            <X size={16} strokeWidth={1.75} />
          </button>
          <div className="settings-modal__panel">
            {active === "model" ? (
              <ModelConnectionsPanel onModelsChanged={onModelsChanged} />
            ) : active === "personalize" ? (
              <PersonalizeSettingsPanel />
            ) : active === "shortcuts" ? (
              <ShortcutsSettingsPanel />
            ) : active === "memory" ? (
              <MemorySettingsPanel sessionId={sessionId} />
            ) : active === "help" ? (
              <HelpSettingsPanel />
            ) : active === "security" ? (
              <SecuritySettingsPanel />
            ) : active === "data" ? (
              <DataSettingsPanel />
            ) : active === "usage" ? (
              <UsageQuotaPanel />
            ) : active === "general" ? (
              <GeneralSettingsPanel />
            ) : active === "agent-settings" ? (
              <AgentSettingsPanel />
            ) : active === "agent-mail" ? (
              <NotificationCenterSettingsPanel />
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
