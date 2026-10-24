import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, realpathSync, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { verifyControlsJournal } from './lib/desktop-controls-evidence.mjs';
assert.equal(process.argv.length,3,'Pass an existing private controls acceptance home');
const home=realpathSync(process.argv[2]);assert(/^\/private\/tmp\/echo-native-review-controls-[A-Za-z0-9]+$/.test(home));
assert.equal(statSync(home).mode&0o077,0);
const driver=JSON.parse(readFileSync(join(home,'driver.json'),'utf8'));
const actual=JSON.parse(readFileSync(join(home,'native-review.json'),'utf8'));
assert.equal(driver.home,home);assert.equal(actual.home,home);assert(actual.context.pid>1);assert.equal(actual.context.pid,driver.actual.context.pid);
assert.equal(actual.completion?.sessionId,actual.sessionId);assert.equal(actual.completion?.stopReason,'end_turn');
const roots=readdirSync(join(home,'sessions'),{withFileTypes:true}).filter(e=>e.isDirectory());
const journals=roots.map(e=>join(home,'sessions',e.name,actual.sessionId,'updates.jsonl')).filter(p=>{try{return statSync(p).isFile();}catch{return false;}});
assert.equal(journals.length,1);
const journal=realpathSync(journals[0]);assert(!relative(home,journal).startsWith('..'));assert(statSync(journal).size<32*1024*1024);
const result={...verifyControlsJournal(readFileSync(journal),actual.sessionId),pid:actual.context.pid,binarySha256:driver.binarySha256,
  rendererReportedVerified:actual.runtimeVerified,gracefulExitVerified:driver.exitCode===0&&!driver.interrupted,journal,verifiedAt:new Date().toISOString()};
writeFileSync(join(home,'runtime-verification.json'),JSON.stringify(result,null,2),{mode:0o600});
console.log(JSON.stringify(result,null,2));process.exitCode=result.runtimeVerified?0:1;
