/**
 * 通知渠道管理面板 —— IM 渠道替代的 UI。
 *
 * 列出已注册通知渠道(Slack/Discord/webhook/desktop),支持添加/移除/测试发送。
 */
import { useEffect, useState } from "react";
import {
  loadNotifyChannels,
  saveNotifyChannel,
  removeNotifyChannel,
  setNotifyChannelEnabled,
  testNotifyChannel,
  type NotifyChannel,
  type ChannelKind,
} from "@/lib/notify-channels";

const KIND_LABELS: Record<ChannelKind, string> = {
  "slack-webhook": "Slack",
  "discord-webhook": "Discord",
  "generic-webhook": "Webhook",
  email: "邮件（旧配置，已停用）",
  desktop: "桌面通知",
};

const ADDABLE_KINDS: ChannelKind[] = [
  "slack-webhook",
  "discord-webhook",
  "generic-webhook",
  "desktop",
];

export function NotifyChannelsPanel({ onToast }: { onToast?: (msg: string) => void }) {
  const [channels, setChannels] = useState<NotifyChannel[]>([]);
  // 新渠道表单。
  const [newKind, setNewKind] = useState<ChannelKind>("slack-webhook");
  const [newLabel, setNewLabel] = useState("");
  const [newEndpoint, setNewEndpoint] = useState("");

  useEffect(() => {
    let cancelled = false;
    void loadNotifyChannels()
      .then((items) => { if (!cancelled) setChannels(items); })
      .catch((error) => onToast?.(`读取通知渠道失败：${String(error).replace(/^Error:\s*/, "")}`));
    return () => { cancelled = true; };
  }, [onToast]);

  const add = async () => {
    const id = `ch_${Date.now()}`;
    const label = newLabel.trim() || KIND_LABELS[newKind];
    const channel: NotifyChannel = {
      id,
      label,
      kind: newKind,
      endpoint: newEndpoint.trim() || undefined,
      enabled: true,
    };
    try {
      await saveNotifyChannel(channel);
      setChannels((items) => [...items.filter((item) => item.id !== id), channel]);
    } catch (error) {
      onToast?.(`添加失败：${String(error).replace(/^Error:\s*/, "")}`);
      return;
    }
    setNewLabel("");
    setNewEndpoint("");
    onToast?.(`已添加渠道 ${label}`);
  };

  const remove = async (id: string) => {
    try {
      await removeNotifyChannel(id);
      setChannels((items) => items.filter((item) => item.id !== id));
      onToast?.("已移除渠道");
    } catch (error) {
      onToast?.(`移除失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const toggle = async (id: string) => {
    const ch = channels.find((c) => c.id === id);
    if (!ch) return;
    try {
      await setNotifyChannelEnabled(id, !ch.enabled);
      setChannels((items) => items.map((item) => item.id === id ? { ...item, enabled: !item.enabled } : item));
    } catch (error) {
      onToast?.(`修改失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  const testSend = async (id: string) => {
    try {
      const result = await testNotifyChannel(id);
      onToast?.(result.ok ? "测试通知已发送" : `发送失败：${result.error ?? "检查 endpoint"}`);
    } catch (error) {
      onToast?.(`发送失败：${String(error).replace(/^Error:\s*/, "")}`);
    }
  };

  return (
    <div className="notify-panel" role="region" aria-label="通知渠道">
      <div className="notify-panel__head">
        <span className="notify-panel__title">通知渠道</span>
        <span className="notify-panel__hint">推送 agent 通知到 Slack、Discord、Webhook 或系统桌面通知</span>
      </div>

      {/* 已注册渠道列表 */}
      {channels.length > 0 ? (
        <ul className="notify-panel__list">
          {channels.map((ch) => (
            <li key={ch.id} className={"notify-panel__row" + (ch.enabled ? "" : " disabled")}>
              <span className="notify-panel__row-kind">{KIND_LABELS[ch.kind]}</span>
              <span className="notify-panel__row-label">{ch.label}</span>
              {ch.endpoint && <span className="notify-panel__row-endpoint" title={ch.endpoint}>{ch.endpoint.slice(0, 40)}{ch.endpoint.length > 40 ? "…" : ""}</span>}
              <div className="notify-panel__row-actions">
                <button type="button" className="notify-panel__btn" onClick={() => void toggle(ch.id)} title={ch.enabled ? "禁用" : "启用"}>
                  <span className={ch.enabled ? "notify-dot notify-dot--on" : "notify-dot"} />
                </button>
                <button type="button" className="notify-panel__btn" onClick={() => void testSend(ch.id)} disabled={!ch.enabled} title="测试发送">
                  测试
                </button>
                <button type="button" className="notify-panel__btn notify-panel__btn--danger" onClick={() => void remove(ch.id)} title="移除">
                  ×
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <div className="notify-panel__empty">暂无通知渠道</div>
      )}

      {/* 添加新渠道 */}
      <div className="notify-panel__add">
        <select value={newKind} onChange={(e) => setNewKind(e.target.value as ChannelKind)}>
          {ADDABLE_KINDS.map((kind) => (
            <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>
          ))}
        </select>
        <input
          type="text"
          placeholder="显示名(可选)"
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
        />
        <input
          type="text"
          placeholder={newKind === "desktop" ? "(桌面通知无需 endpoint)" : "Webhook URL"}
          value={newEndpoint}
          onChange={(e) => setNewEndpoint(e.target.value)}
          disabled={newKind === "desktop"}
        />
        <button type="button" className="notify-panel__add-btn" onClick={() => void add()}>
          + 添加
        </button>
      </div>
    </div>
  );
}
