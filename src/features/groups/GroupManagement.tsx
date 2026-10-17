import { useEffect, useState } from "react";
import { ArrowLeft, Plus, Users } from "lucide-react";
import { agentsList } from "@/lib/agent-client";
import type { AgentEntry } from "@/lib/types";
import { useAppDialog } from "@/components/AppDialog";
import { groupTemplates, groupDeleteTeam, groupSaveTeam, groupMemberChange, groupDecision, terminalWork, type TeamTemplate, type Group } from "./group-client";

export function TemplatePicker({ onPick }: { onPick: (team: TeamTemplate) => void }) {
  const [teams, setTeams] = useState<TeamTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void groupTemplates().then(setTeams).catch(error => setError(String(error))); }, []);
  if (!teams.length) return error ? <p className="groups-muted">常用团队暂不可读，仍可直接选择专家创建群聊。</p> : null;
  return <label>使用已有团队<select defaultValue="" onChange={event => { const team = teams.find(team => team.id === event.target.value); if (team) onPick(team); }}><option value="">自行选择专家</option>{teams.map(team => <option key={team.id} value={team.id}>{team.name} · {team.source}</option>)}</select></label>;
}

export function GroupTeams({ onBack, onUse }: { onBack: () => void; onUse: (team: TeamTemplate) => void }) {
  const [teams, setTeams] = useState<TeamTemplate[]>([]), [error, setError] = useState<string | null>(null);
  const dialog = useAppDialog("group-teams");
  const refresh = () => { void groupTemplates().then(setTeams).catch(error => setError(String(error))); };
  useEffect(refresh, []);
  return <div className="groups-page"><button className="groups-back" onClick={onBack}><ArrowLeft size={16} />返回群聊</button><header className="groups-page__header"><div><h1>团队编组</h1><p>从已有会话团队或常用编组建立新的群聊。群内调整不会改动其他群。</p></div></header>{error && <p role="alert" className="groups-error">{error}</p>}<div className="groups-grid">{teams.map(team => <section className="group-card" key={team.id}><span className="group-card__head"><strong>{team.name}</strong><small>{team.source}</small></span><p>{team.description || "围绕新目标，复用这组专家。"}</p><span className="group-card__members">{team.members.map(member => member.name).join(" · ")}</span><div className="group-form__actions">{team.source === "常用团队" && <button className="btn btn--ghost" onClick={() => dialog.requestConfirmation({ title: `删除常用团队“${team.name}”？`, description: "已经建立的群聊和专家配置会保留。", danger: true, confirmLabel: "删除编组", action: async () => { await groupDeleteTeam(team.id); refresh(); } })}>删除</button>}<button className="btn btn--primary" onClick={() => onUse(team)}>用此团队建群</button></div></section>)}</div>{!teams.length && !error && <div className="groups-empty"><Users size={32} /><h2>把合适的协作组合留下来</h2><p>在群聊的成员页选择“保存为常用团队”，下次就可以直接复用。</p></div>}{dialog.dialog}</div>;
}

export function SaveTeamButton({ group, onError }: { group: Group; onError: (error: string) => void }) {
  const dialog = useAppDialog(group.id);
  const [saved, setSaved] = useState(false);
  return <><button className="groups-text-button" onClick={() => dialog.requestInput({ title: "保存为常用团队", description: "保存成员、分工和模型选择。同名常用团队会更新，已有群聊保持自己的配置。", fields: [{ name: "name", label: "团队名称", defaultValue: group.name, required: true, maxLength: 80 }], confirmLabel: "保存编组", onError: error => onError(String(error)), action: async values => { await groupSaveTeam(group.id, values.name); setSaved(true); } })}>保存为常用团队</button>{saved && <p role="status" className="groups-muted">编组已保存，可从“团队编组”复用。</p>}{dialog.dialog}</>;
}

export function MemberManager({ group, onChanged, onError }: { group: Group; onChanged: () => void; onError: (error: string) => void }) {
  const [experts, setExperts] = useState<AgentEntry[]>([]), [expert, setExpert] = useState(""), [busy, setBusy] = useState(false);
  const dialog = useAppDialog(group.id);
  useEffect(() => { void agentsList().then(setExperts).catch(error => onError(String(error))); }, []);
  const active = group.works.some(work => !terminalWork(work.status));
  const change = async (action: "add" | "remove" | "refresh", id?: string) => { setBusy(true); try { await groupMemberChange(group.id, action, id, action === "add" ? expert : undefined); setExpert(""); onChanged(); } catch (error) { onError(String(error)); } finally { setBusy(false); } };
  return <details className="group-reference"><summary>管理群成员</summary><p className="groups-muted">调整在当前工作结束后生效，历史发言会保留。</p><label>添加本地专家<select aria-label="添加本地专家" value={expert} disabled={active || busy} onChange={event => setExpert(event.target.value)}><option value="">请选择专家</option>{experts.filter(expert => expert.scope === "user" && !group.members.some(member => !member.removed && member.expert === expert.name)).map(expert => <option key={expert.name} value={expert.name}>{expert.name}</option>)}</select></label><button className="groups-text-button" disabled={active || busy || !expert} onClick={() => void change("add")}><Plus size={12} />添加成员</button>{group.members.filter(member => !member.removed && member.expert).map(member => <div className="group-member-management" key={member.id}><strong>{member.name}</strong><button className="groups-text-button" disabled={active || busy} onClick={() => dialog.requestConfirmation({ title: `更新${member.name}的专家配置？`, description: "采用本地最新专家定义，建立新的执行上下文，并保留原来的群内发言。", confirmLabel: "更新配置", action: () => change("refresh", member.id) })}>更新配置</button><button className="groups-text-button" disabled={active || busy || member.id === group.coordinatorId} onClick={() => dialog.requestConfirmation({ title: `移除${member.name}？`, description: "成员的历史发言和交付物仍会保留。", confirmLabel: "移除成员", action: () => change("remove", member.id) })}>移除</button></div>)}{dialog.dialog}</details>;
}

export function DecisionList({ group, onChanged, onError }: { group: Group; onChanged: () => void; onError: (error: string) => void }) {
  return <>{group.decisions.length > 0 && <section><h3>决定记录</h3>{group.decisions.map(decision => <div key={decision.id}><p>{decision.text}</p>{decision.confirmed ? <small>已由你确认</small> : <button className="groups-text-button" onClick={async () => { try { await groupDecision(group.id, "", "", decision.id); onChanged(); } catch (error) { onError(String(error)); } }}>确认为团队决定</button>}</div>)}</section>}</>;
}
