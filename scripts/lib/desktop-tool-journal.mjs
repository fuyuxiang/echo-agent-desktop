// Include client/transport rejections which have no MCP rawOutput. The UI
// observer alone cannot count these failed round trips. Read-only audit code.
export function desktopToolCalls(events,observed=[]) {
 const targets=new Map(),returned=new Map(),actual=new Map(observed.map(t=>[t.id,t]));
 for(const e of events){
  const u=e.params?.update;if(!u?.toolCallId)continue;
  const name=u.rawInput?.tool_name;
  if(typeof name==='string'&&name.startsWith('echoagent-automation__computer_'))targets.set(u.toolCallId,name.slice('echoagent-automation__'.length));
  if(['completed','failed'].includes(u.status))returned.set(u.toolCallId,{status:u.status,at:new Date(e.timestamp*1000).toISOString()});
 }
 return [...targets].flatMap(([id,tool])=>{
  if(!returned.has(id))return [];
  return [actual.get(id)||{id,tool,...returned.get(id),transportOnly:true}];
 }).sort((a,b)=>a.at.localeCompare(b.at));
}
