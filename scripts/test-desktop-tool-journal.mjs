import assert from 'node:assert/strict';
import test from 'node:test';
import {desktopToolCalls} from './lib/desktop-tool-journal.mjs';
const event=(id,update)=>({timestamp:100,params:{update:{toolCallId:id,...update}}});
test('performance includes rejected calls without MCP output and deduplicates native results',()=>{
 const events=[event('a',{rawInput:{tool_name:'echoagent-automation__computer_click'}}),event('a',{status:'failed'}),event('b',{rawInput:{tool_name:'echoagent-automation__computer_context'}}),event('b',{status:'completed'}),event('b',{status:'completed'})];
 const calls=desktopToolCalls(events,[{id:'b',tool:'computer_context',status:'completed',at:new Date(100000).toISOString(),output:{nodes:[]}}]);
 assert.equal(calls.length,2);assert.equal(calls[0].transportOnly,true);assert.equal(calls[0].status,'failed');assert(calls[1].output);
});
test('in-flight calls, search matches and other integrations cannot count as desktop returns',()=>{
 const events=[event('a',{rawInput:{tool_name:'echoagent-automation__computer_click'}}),event('b',{rawInput:{tool_name:'other__computer_click'}}),event('b',{status:'completed'}),event('c',{rawInput:{variant:'SearchTool',query:'computer_click'}}),event('c',{status:'completed'})];
 assert.deepEqual(desktopToolCalls(events),[]);
});
