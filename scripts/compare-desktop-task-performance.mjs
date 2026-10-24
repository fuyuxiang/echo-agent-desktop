// Compare full Runtime tool journals, including failed calls. No task execution.
import assert from 'node:assert/strict';
import {nativeShortcut} from './lib/native-tool-inputs.mjs';
import {desktopToolCalls} from './lib/desktop-tool-journal.mjs';
import {readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
const homes=process.argv.slice(2);assert.equal(homes.length,2,'Pass baseline and candidate acceptance homes');
function metrics(path){
 const home=realpathSync(resolve(path));
 const r=JSON.parse(readFileSync(join(home,'workspaces/default/native-control-fixtures/task-flow-progress.json'),'utf8'));
 assert(r.finishedAt,'primary model turn must finish');
 const journal=readFileSync(join(home,'sessions',encodeURIComponent(r.cwd),r.sessionId,'updates.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const inputs=new Map(),searches=new Set();
 for(const event of journal){const u=event.params?.update;if(u?.rawInput?.tool_input)inputs.set(u.toolCallId,u.rawInput.tool_input);if(event.timestamp*1000<=Date.parse(r.finishedAt)&&u?.rawInput?.variant==='SearchTool')searches.add(u.toolCallId);}
 const all=desktopToolCalls(journal,r.tools);
 const tools=all.filter(t=>t.at>=r.startedAt&&t.at<=r.finishedAt),counts={};
 for(const t of tools)counts[t.tool]=(counts[t.tool]||0)+1;
 const shortcuts=tools.filter(t=>t.tool==='computer_key_window'&&t.output?.keyDispatched===true).map(t=>nativeShortcut(inputs.get(t.id)||{}));
 const ms=(a,b)=>(Date.parse(a)-Date.parse(b))/1000;
 const secondary=r.crossApp?.finishedAt?stage(all.filter(t=>t.at>=r.crossApp.startedAt&&t.at<=r.crossApp.finishedAt),r.crossApp.startedAt,r.crossApp.finishedAt,inputs):undefined;
 return {...stage(tools,r.startedAt,r.finishedAt,inputs),secondary,home,sessionId:r.sessionId,model:r.model,elapsedSeconds:ms(r.finishedAt,r.startedAt),inputReadbackSeconds:ms(r.bodyReadback.at,r.startedAt),saveAfterResumeSeconds:ms(r.finishedAt,r.resumedAt),pauseQuietSeconds:r.pauseQuiet.durationMs/1000,
  returnedToolCalls:tools.length,toolSchemaSearchCalls:searches.size,failedToolCalls:tools.filter(t=>t.status==='failed'||t.error).length,discoveryCalls:(counts.computer_list_apps||0)+(counts.computer_list_windows||0),contextCalls:counts.computer_context||0,screenshots:counts.computer_screenshot||0,standaloneObservations:['computer_snapshot','computer_find','computer_read'].reduce((n,k)=>n+(counts[k]||0),0),saveDialogOpenShortcuts:shortcuts.filter(k=>['cmd+s','cmd+alt+shift+s'].includes(k)).length,saveShortcutDispatches:shortcuts.filter(k=>k==='cmd+s').length,cmdShiftSDispatches:shortcuts.filter(k=>k==='cmd+shift+s').length,ordinaryConfirmations:r.approvals.length,runtimePermissions:r.runtimePermissions.length,counts};
}
function stage(tools,startedAt,finishedAt,inputs){
 const counts={};for(const t of tools)counts[t.tool]=(counts[t.tool]||0)+1;
 const keys=tools.filter(t=>t.tool==='computer_key_window'&&t.output?.keyDispatched===true).map(t=>nativeShortcut(inputs.get(t.id)||{}));
 return {elapsedSeconds:(Date.parse(finishedAt)-Date.parse(startedAt))/1000,returnedToolCalls:tools.length,
  failedToolCalls:tools.filter(t=>t.status==='failed'||t.error).length,
  clientOrTransportRejections:tools.filter(t=>t.transportOnly&&t.status==='failed').length,
  staleReferences:tools.filter(t=>(t.error||t.output?.error||'').includes('stale_reference')).length,
  unknownActionResults:tools.filter(t=>t.output?.status==='result_unknown').length,
  unverifiedTextWrites:tools.filter(t=>t.tool==='computer_set_value'&&t.output?.executed===true&&t.output?.verified===false).length,
  actionStateErrors:tools.filter(t=>t.output?.stateError).length,
  fileDialogPreparationCalls:counts.computer_file_dialog||0,
  fileDialogPreparations:tools.filter(t=>t.tool==='computer_file_dialog'&&t.output?.prepared===true).length,
  saveDialogOpenShortcuts:keys.filter(k=>['cmd+s','cmd+alt+shift+s'].includes(k)).length,
  screenshots:counts.computer_screenshot||0,continuationPages:counts.computer_continue||0,
  standaloneObservations:['computer_snapshot','computer_find','computer_read'].reduce((n,k)=>n+(counts[k]||0),0),counts};
}
const [baseline,candidate]=homes.map(metrics);
const percentage=(a,b)=>Math.round((a-b)/a*1000)/10;
const report={version:2,kind:'desktop-task-performance-comparison',baseline,candidate,reductions:{elapsedPercent:percentage(baseline.elapsedSeconds,candidate.elapsedSeconds),callsPercent:percentage(baseline.returnedToolCalls,candidate.returnedToolCalls),...(baseline.secondary&&candidate.secondary?{secondaryElapsedPercent:percentage(baseline.secondary.elapsedSeconds,candidate.secondary.elapsedSeconds),secondaryCallsPercent:percentage(baseline.secondary.returnedToolCalls,candidate.secondary.returnedToolCalls)}:{})},verifiedAt:new Date().toISOString()};
writeFileSync(join(candidate.home,'task-performance-comparison.json'),JSON.stringify(report,null,2),{mode:0o600});
console.log(JSON.stringify(report,null,2));
