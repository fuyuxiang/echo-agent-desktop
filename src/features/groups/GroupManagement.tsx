import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, Users } from "lucide-react";
import { agentsList } from "@/lib/agent-client";
import type { AgentEntry } from "@/lib/types";
import { useAppDialog } from "@/components/AppDialog";
import { groupTemplates, groupDeleteTeam, groupSaveTeam, groupMemberChange, groupDecision, groupDecisionChange, terminalWork, type TeamTemplate, type Group } from "./group-client";

function templateSourceLabel(source: string): string {
  if (source === "会话团队") return "来自会话团队";
  if (source === "常用团队") return "专家团模板";
  return source;
}

export function TemplatePicker({ onPick }: { onPick: (team: TeamTemplate) => void }) {
  const [teams, setTeams] = useState<TeamTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void groupTemplates().then(setTeams).catch(error => setError(String(error))); }, []);
  if (!teams.length) return error ? <p className="groups-muted">专家团模板暂不可读，仍可直接选择专家创建专家团。</p> : null;
  return <label>使用专家团模板<select defaultValue="" onChange={event => { const team = teams.find(team => team.id === event.target.value); if (team) onPick(team); }}><option value="">自行选择专家</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {templateSourceLabel(team.source)}</option>)}</select></label>;
}

export function GroupTeams({ onBack, onUse }: { onBack: () => void; onUse: (team: TeamTemplate) => void }) {
  const [teams, setTeams] = useState<TeamTemplate[]>([]), [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const dialog = useAppDialog("group-templates");
  const refresh = async () => {
    const request = ++generation.current;
    setLoading(true);
    try { const teams = await groupTemplates(); if (request === generation.current) { setTeams(teams); setError(null); } }
    catch (error) { if (request === generation.current) setError(String(error)); }
    finally { if (request === generation.current) setLoading(false); }
  };
  useEffect(() => { void refresh(); return () => { generation.current++; }; }, []);
  return <div className="groups-page">
    <button className="groups-back" onClick={onBack}><ArrowLeft size={16} />返回专家团</button>
    <header className="groups-page__header"><div><h1>专家团模板</h1><p>保存成员、分工与模型，用于创建新的专家团。模板不包含聊天记录。</p></div></header>
    {error && <p role="alert" className="groups-error">{error}</p>}
    {loading && <p role="status">正在读取专家团模板…</p>}
    {error && <button className="btn btn--ghost" disabled={loading} onClick={() => void refresh()}>重新读取模板</button>}
    <div className="groups-grid">{teams.map(team => <section className="group-card" key={team.id}>
      <span className="group-card__head"><strong>{team.name}</strong><small>{templateSourceLabel(team.source)}</small></span>
      <p>{team.description || "围绕新目标，复用这组专家。"}</p><span className="group-card__members">{team.members.map(member => member.name).join(" · ")}</span>
      <div className="group-form__actions">
        {team.source === "常用团队" && <button className="btn btn--ghost" onClick={() => dialog.requestConfirmation({ title: `删除专家团模板“${team.name}”？`, description: "已经建立的专家团和专家配置会保留。", danger: true, confirmLabel: "删除模板", action: async () => {
          await groupDeleteTeam(team.id); ++generation.current; setTeams(current => current.filter(item => item.id !== team.id)); await refresh();
        } })}>删除模板</button>}
        <button className="btn btn--primary" onClick={() => onUse(team)}>用此模板创建专家团</button>
      </div>
    </section>)}</div>
    {!loading && !teams.length && !error && <div className="groups-empty"><Users size={32} /><h2>把合适的协作组合留下来</h2><p>在专家团的操作菜单或成员页选择“保存为模板”，下次就可以直接复用。</p></div>}
    {dialog.dialog}
  </div>;
}

export function SaveTeamButton({ group, onError }: { group: Group; onError: (error: string) => void }) {
  const dialog = useAppDialog(group.id);
  const [saved, setSaved] = useState(false);
  return <><button className="groups-text-button" onClick={() => dialog.requestInput({ title: "保存为专家团模板", description: "保存成员、分工和模型选择。同名专家团模板会更新，已有专家团保持自己的配置。", fields: [{ name: "name", label: "模板名称", defaultValue: group.name, required: true, maxLength: 80 }], confirmLabel: "保存模板", onError: error => onError(String(error)), action: async values => { await groupSaveTeam(group.id, values.name); setSaved(true); } })}>保存为模板</button>{saved && <p role="status" className="groups-muted">模板已保存，可从“专家团模板”复用。</p>}{dialog.dialog}</>;
}

export function MemberManager({ group, onChanged, onError }: { group: Group; onChanged: () => void; onError: (error: string) => void }) {
  const [experts, setExperts] = useState<AgentEntry[]>([]), [expert, setExpert] = useState(""), [busy, setBusy] = useState(false);
  const dialog = useAppDialog(group.id);
  useEffect(() => { void agentsList().then(setExperts).catch(error => onError(String(error))); }, []);
  const active = group.works.some(work => !terminalWork(work.status));
  const change = async (action: "add" | "remove" | "refresh", id?: string) => { setBusy(true); try { await groupMemberChange(group.id, action, id, action === "add" ? expert : undefined); setExpert(""); onChanged(); } catch (error) { onError(String(error)); } finally { setBusy(false); } };
  return <details className="group-reference"><summary>管理成员</summary><p className="groups-muted">请在当前工作结束后调整成员，历史发言会保留。</p><label>添加本地专家<select aria-label="添加本地专家" value={expert} disabled={active || busy} onChange={event => setExpert(event.target.value)}><option value="">请选择专家</option>{experts.filter(expert => expert.scope === "user" && !group.members.some(member => !member.removed && member.expert === expert.name)).map(expert => <option key={expert.name} value={expert.name}>{expert.name}</option>)}</select></label><button className="groups-text-button" disabled={active || busy || !expert} onClick={() => void change("add")}><Plus size={12} />添加成员</button>{group.members.filter(member => !member.removed && member.expert).map(member => <div className="group-member-management" key={member.id}><strong>{member.name}</strong><button className="groups-text-button" disabled={active || busy} onClick={() => dialog.requestConfirmation({ title: `更新${member.name}的专家配置？`, description: "采用本地最新专家定义，建立新的执行上下文，并保留原来的成员发言。", confirmLabel: "更新配置", action: () => change("refresh", member.id) })}>更新配置</button><button className="groups-text-button" disabled={active || busy || member.id === group.coordinatorId} onClick={() => dialog.requestConfirmation({ title: `移除${member.name}？`, description: "成员的历史发言和交付物仍会保留。", confirmLabel: "移除成员", action: () => change("remove", member.id) })}>移除</button></div>)}{dialog.dialog}</details>;
}

export function DecisionList({ group, onChanged, onError }: { group: Group; onChanged: () => void; onError: (error: string) => void }) {
  const dialog = useAppDialog(group.id);
  const [count, setCount] = useState(20), [showVoided, setShowVoided] = useState(false);
  const [busy, setBusy] = useState(false);
  const records = [...group.decisions].reverse().filter(decision => showVoided || !decision.voided);
  const change = async (id: string, action: "edit" | "void" | "restore", text?: string) => {
    setBusy(true);
    try { await groupDecisionChange(group.id, id, action, text); onChanged(); }
    finally { setBusy(false); }
  };
  if (!group.decisions.length) return null;
  return <section className="group-decisions"><h3>决定记录</h3><label className="groups-muted"><input type="checkbox" checked={showVoided} onChange={event => { setShowVoided(event.target.checked); setCount(20); }} />显示已作废决定</label>
    {!records.length && <p className="groups-muted">暂无有效决定。</p>}
    {records.slice(0, count).map(decision => <div className={`group-decision${decision.voided ? " is-voided" : ""}`} key={decision.id}><p>{decision.text}</p><small>{decision.voided ? "已作废 · 后续工作不再采用" : decision.confirmed ? "已由你确认" : "待你确认"}</small><div className="group-decision__actions">
      {!decision.confirmed && !decision.voided && <button className="groups-text-button" disabled={busy} onClick={async () => { setBusy(true); try { await groupDecision(group.id, "", "", decision.id); onChanged(); } catch (error) { onError(String(error)); } finally { setBusy(false); } }}>确认为专家团决定</button>}
      {!decision.voided && <><button className="groups-text-button" disabled={busy} onClick={() => dialog.requestInput({ title: "更正决定", description: "更正后用于后续工作，原内容会保留在修改记录中。", fields: [{ name: "text", label: "决定内容", defaultValue: decision.text, multiline: true, required: true, maxLength: 2000 }], confirmLabel: "保存更正", action: values => change(decision.id, "edit", values.text.trim()) })}>更正</button><button className="groups-text-button" disabled={busy} onClick={() => dialog.requestConfirmation({ title: "作废这条决定？", description: "后续工作不再采用，原内容仍保留以便查阅。正在执行的工作不会因此自动停止。", confirmLabel: "作废决定", action: () => change(decision.id, "void") })}>作废</button></>}
      {decision.voided && <button className="groups-text-button" disabled={busy} onClick={() => dialog.requestConfirmation({ title: "恢复这条决定？", description: decision.text, confirmLabel: "确认恢复", action: () => change(decision.id, "restore") })}>恢复决定</button>}
    </div>{!!decision.history?.length && <details className="group-reference"><summary>修改记录（{decision.history.length}）</summary>{decision.history.map((version, index) => <p key={index}><small>{version.action === "void" ? "作废" : version.action === "restore" ? "恢复" : "更正前"} · {new Date(version.changedAt).toLocaleString()}</small><br />{version.text}</p>)}</details>}</div>)}
    {records.length > count && <button className="groups-text-button" onClick={() => setCount(value => value + 20)}>加载更多决定（{Math.min(count, records.length)} / {records.length}）</button>}{dialog.dialog}
  </section>;
}
