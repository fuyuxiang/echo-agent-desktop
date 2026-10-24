import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeShortcut,nativeBrowserMarkerObserved as observe} from './lib/native-tool-inputs.mjs';
test('audit reads provider array wrappers and rejects extra wrapper fields',()=>{
 assert.equal(nativeShortcut({key:'N',modifiers:{item:['command']}}),'cmd+n');
 assert.equal(nativeShortcut({key:'N',modifiers:{item:['command'],extra:true}}),'');
});
test('native browser marker can be in a snapshot bound to a previously observed Safari window',()=>{
 assert(observe([{output:{identifier:'com.apple.Safari',windowRef:'w'}},{output:{windowRef:'w',nodes:[{role:'AXWebArea',name:'PASS'}]}}],'PASS'));
});
test('typed expected marker and another app window do not verify page success',()=>{
 assert(!observe([{output:{identifier:'com.apple.Safari',nodes:[{role:'AXTextField',value:'PASS'}]}}],'PASS'));
 assert(!observe([{output:{identifier:'other',windowRef:'x',nodes:[{role:'AXStaticText',value:'PASS'}]}}],'PASS'));
});
test('audit decodes the observed nested array wrapper without accepting arbitrary nesting',()=>{
 assert.equal(nativeShortcut({key:'g',modifiers:{item:{item:['cmd','shift']}}}),'cmd+shift+g');
 assert.equal(nativeShortcut({key:'g',modifiers:{item:{item:{item:['cmd']}}}}),'');
});
test('audit follows the validated singleton modifier and key chord aliases',()=>{
 assert.equal(nativeShortcut({key:'down',modifiers:{item:'cmd'}}),'cmd+down');
 assert.equal(nativeShortcut({key:'cmd+down'}),'cmd+down');
 assert.equal(nativeShortcut({key:'cmd+down',modifiers:['cmd']}),'');
 assert.equal(nativeShortcut({key:'shell+down'}),'');
});
