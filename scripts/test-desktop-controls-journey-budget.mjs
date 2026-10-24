import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the exact fixture clock without launching apps or answering approvals.
const window={};
runInNewContext(readFileSync(new URL('./fixtures/native-desktop-controls-journey.js',import.meta.url),'utf8'),{window});
const clock=()=>window.__echoDesktopControlsActiveBudget(30*60*1000,0);
test('human approval waiting longer than 30 minutes does not pause acceptance',()=>{
  const tick=clock();
  tick(0,true);
  const waiting=tick(2*60*60*1000,true);
  assert.equal(waiting.activeMs,0);
  assert.equal(waiting.expired,false);
  assert.equal(tick(2*60*60*1000+1,false).expired,false);
});
test('separate active intervals accumulate and retain the execution deadline',()=>{
  const tick=clock();
  tick(0,false);
  assert.equal(tick(10*60*1000,false).activeMs,10*60*1000);
  tick(10*60*1000+100,true);
  tick(100*60*1000,true);
  tick(100*60*1000+1,false);
  const active=tick(120*60*1000+1,false);
  assert.equal(active.activeMs,30*60*1000);
  assert.equal(active.expired,true);
});
test('a backward clock sample cannot add or subtract execution time',()=>{
  const tick=clock();
  tick(100,false);
  assert.equal(tick(90,false).activeMs,0);
  assert.equal(tick(200,false).activeMs,100);
});
