import test from 'node:test';
import assert from 'node:assert/strict';
import { AutoRetry, retryLimit, outputThreshold } from '../auto-retry.js';
function fixture() {
    let ctx={characterId:1,chatId:'a',chat:[{is_user:true,mes:'hi'},{is_user:false,mes:'fast',swipes:['old','fast'],swipe_id:1}],printMessages:async()=>{},saveChat:async()=>{}};
    const data=new Map(), tasks=[]; let calls=0, busy=false, enabled=true, limit=1;
    const storage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
    const retry=new AutoRetry({context:()=>ctx,enabled:()=>enabled,limit:()=>limit,storage,busy:()=>busy,regenerate:()=>{calls++;retry.start('regenerate',false);},notify:()=>{},schedule:fn=>tasks.push(fn)});
    const propose=(rate=81)=>{retry.start('normal',false);retry.consider(retry.run,1,ctx.chat[1],rate);retry.end();};
    return {retry,storage,data,tasks,propose,get ctx(){return ctx;},set ctx(v){ctx=v;},get calls(){return calls;},set limit(v){limit=v;},set busy(v){busy=v;},set enabled(v){enabled=v;},flush:()=>tasks.splice(0).forEach(f=>f())};
}
test('strictly above 80, completion only, duplicate events only once',()=>{const f=fixture();f.propose(80);f.flush();assert.equal(f.calls,0);f.propose();f.retry.end();f.flush();assert.equal(f.calls,1);assert.deepEqual(JSON.parse([...f.data.values()][0])[0].message.swipes,['old','fast']);});
test('generated retry cannot loop',()=>{const f=fixture();f.propose();f.flush();f.retry.consider(f.retry.run,1,f.ctx.chat[1],100);f.retry.end();f.flush();assert.equal(f.calls,1);});
test('new manual generation may retry again, previous backups retained',()=>{const f=fixture();f.propose();f.flush();f.propose();f.flush();assert.equal(f.calls,2);assert.equal(JSON.parse([...f.data.values()][0]).length,2);});
for(const [name,change] of Object.entries({chat:f=>{f.ctx={...f.ctx,chatId:'b'};},latest:f=>f.ctx.chat.push({is_user:true,mes:'new'}),edited:f=>{f.ctx.chat[1].mes='edited';},stopped:f=>f.retry.cancel(),busy:f=>{f.busy=true;},disabled:f=>{f.enabled=false;},replaced:f=>{f.ctx.chat[1]={...f.ctx.chat[1]};}})) test(`no deletion when ${name}`,()=>{const f=fixture();f.propose();change(f);f.flush();assert.equal(f.calls,0);assert.equal(f.data.size,0);});
test('storage failure never deletes',()=>{const f=fixture();f.storage.setItem=()=>{throw Error('full');};f.propose();f.flush();assert.equal(f.calls,0);});
test('storage readback mismatch never deletes',()=>{const f=fixture();f.storage.setItem=()=>{};f.propose();f.flush();assert.equal(f.calls,0);});
test('restoring preserves replacement and old swipes',async()=>{const f=fixture();f.propose();f.flush();f.ctx.chat[1]={is_user:false,mes:'replacement'};await f.retry.restore();assert.equal(f.ctx.chat[1].mes,'fast');assert.deepEqual(f.ctx.chat[1].swipes,['old','fast']);assert.equal(JSON.parse([...f.data.values()][0]).at(-1).message.mes,'replacement');});
test('restore refuses to overwrite later conversation',async()=>{const f=fixture();f.propose();f.flush();f.ctx.chat.push({is_user:true,mes:'next'});await assert.rejects(()=>f.retry.restore());assert.equal(f.ctx.chat.at(-1).mes,'next');});
test('restore works after generation failed and left missing last reply',async()=>{const f=fixture();f.propose();f.flush();f.ctx.chat.pop();await f.retry.restore();assert.equal(f.ctx.chat.at(-1).mes,'fast');});
test('ignores continuation, quiet, dry-run, group and unknown rates',()=>{const f=fixture();for(const type of ['continue','quiet','impersonate']){f.retry.start(type,false);assert.equal(f.retry.run,null);}f.retry.start('normal',true);assert.equal(f.retry.run,null);f.ctx.groupId='g';f.retry.start('normal',false);assert.equal(f.retry.run,null);delete f.ctx.groupId;f.propose(NaN);f.flush();assert.equal(f.calls,0);});
test('late token estimation cannot act on another generation',()=>{const f=fixture();f.retry.start('normal',false);const old=f.retry.run;f.retry.start('normal',false);f.retry.consider(old,1,f.ctx.chat[1],90);f.retry.end();f.flush();assert.equal(f.calls,0);});

test('configurable 3 retries stop exactly at cap and preserve every deleted reply',()=>{
 const f=fixture();f.limit=3;f.propose();f.flush();
 for(let i=0;i<3;i++){f.ctx.chat[1]={is_user:false,mes:'retry'+i};f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.retry.end();f.flush();}
 assert.equal(f.calls,3);assert.equal(JSON.parse([...f.data.values()][0]).length,3);
});
test('chain stops when rate is acceptable',()=>{const f=fixture();f.limit=3;f.propose();f.flush();f.retry.consider(f.retry.run,1,f.ctx.chat[1],80);f.retry.end();f.flush();assert.equal(f.calls,1);});
test('changed cap and stop cancel queued repeated retries',()=>{const f=fixture();f.limit=3;f.propose();f.flush();f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.retry.end();f.limit=1;f.flush();assert.equal(f.calls,1);});
test('manual start resets retry budget',()=>{const f=fixture();f.limit=2;f.propose();f.flush();f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.retry.end();f.flush();assert.equal(f.calls,2);f.propose();f.flush();assert.equal(f.calls,3);});

test('retry count defaults to 3 and accepts configurable positive integers',()=>{for(const value of [undefined,null,'',0,-1,1.5,Infinity,'bad'])assert.equal(retryLimit(value),3);assert.equal(retryLimit('5'),5);assert.equal(retryLimit(1),1);});
test('stop during a repeat prevents the next retry',()=>{const f=fixture();f.limit=3;f.propose();f.flush();f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.retry.end();f.retry.cancel();f.flush();assert.equal(f.calls,1);});
test('native MESSAGE_RECEIVED then swipe metadata finalization must still regenerate',()=>{
 const f=fixture();f.propose();
 // SillyTavern saveReply/addOneMessage/updateSwipeCounter finalize this after MESSAGE_RECEIVED.
 const m=f.ctx.chat[1];m.extra={...(m.extra||{}),token_count:1000};
 m.swipe_info=[{extra:{}},{send_date:'now',extra:structuredClone(m.extra)}];
 f.flush();assert.equal(f.calls,1);
});
test('waits for native busy state to clear after ended event',()=>{const f=fixture();f.propose();f.busy=true;f.flush();assert.equal(f.calls,0);f.busy=false;f.flush();assert.equal(f.calls,1);});
test('stop while waiting for native cleanup cancels queued retry',()=>{const f=fixture();f.propose();f.busy=true;f.flush();f.retry.cancel();f.busy=false;f.flush();assert.equal(f.calls,0);});
test('streaming order: generation ended before message received',()=>{const f=fixture();f.retry.start('normal',false);f.retry.end();f.retry.consider(f.retry.run,1,f.ctx.chat[1],90);f.flush();assert.equal(f.calls,1);});
test('selected alternative changed: do not regenerate',()=>{const f=fixture();f.propose();f.ctx.chat[1].swipe_id=0;f.flush();assert.equal(f.calls,0);});
test('new generation identity: do not regenerate',()=>{const f=fixture();f.propose();f.ctx.chat[1].gen_started='new';f.flush();assert.equal(f.calls,0);});
test('native API rejection is handled without a retry storm',async()=>{const f=fixture();f.retry.regenerate=()=>Promise.reject(Error('offline'));f.propose();f.flush();await new Promise(r=>setTimeout(r,0));assert.equal(f.calls,0);assert.equal(f.data.size,1);assert.equal(f.tasks.length,0);});
test('hidden native stop button: completion without GENERATION_ENDED still retries',()=>{const f=fixture();f.retry.start('normal',false);f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.flush();assert.equal(f.calls,1);});
test('quiet and dry-run events do not destroy main generation tracking',()=>{const f=fixture();f.retry.start('normal',false);const main=f.retry.run;f.retry.start('quiet',false);f.retry.start('normal',true);assert.equal(f.retry.run,main);f.retry.consider(main,1,f.ctx.chat[1],99);f.flush();assert.equal(f.calls,1);});
test('legacy undefined generation type is normal',()=>{const f=fixture();f.retry.start(undefined,false);f.retry.consider(f.retry.run,1,f.ctx.chat[1],99);f.flush();assert.equal(f.calls,1);});
test('HTTP mobile environment without structuredClone still backs up and restores',async()=>{const f=fixture();const clone=globalThis.structuredClone;globalThis.structuredClone=undefined;try{f.propose();f.flush();assert.equal(f.calls,1);f.ctx.chat[1]={is_user:false,mes:'replacement'};await f.retry.restore();assert.equal(f.ctx.chat[1].mes,'fast');}finally{globalThis.structuredClone=clone;}});

for(const [name,rate,output,expected] of [
 ['2999 tokens with normal speed',20,2999,1],
 ['exactly 3000',20,3000,0],
 ['3001',20,3001,0],
 ['short output with unknown speed',null,2999,1],
 ['short output with NaN speed',NaN,2999,1],
 ['zero explicitly measured tokens',null,0,1],
 ['unknown output',20,undefined,0],
 ['null output',20,null,0],
 ['NaN output',20,NaN,0],
 ['negative output',20,-1,0],
 ['fractional output',20,2.5,0],
 ['string output',20,'2000',0],
 ['both conditions',100,2999,1],
 ['fast with unknown output',100,null,1],
])test('OR threshold: '+name,()=>{
 const f=fixture();f.retry.start('normal');f.retry.consider(f.retry.run,1,f.ctx.chat[1],rate,output);f.flush();assert.equal(f.calls,expected);
});
test('both triggers produce one retry and combined numbered notice',()=>{
 const f=fixture(),notices=[];f.retry.notify=s=>notices.push(s);
 f.retry.start('normal');const run=f.retry.run;
 f.retry.consider(run,1,f.ctx.chat[1],100,2000);f.retry.consider(run,1,f.ctx.chat[1],100,2000);f.flush();
 assert.equal(f.calls,1);assert.match(notices[0],/第 1 条.*速率超过 80，且输出 token 少于 3000.*第 2 条/);
});
test('short output respects disabled switch and shared retry cap',()=>{
 const f=fixture();f.enabled=false;f.retry.start('normal');f.retry.consider(f.retry.run,1,f.ctx.chat[1],null,2000);f.flush();assert.equal(f.calls,0);
 f.enabled=true;f.limit=3;f.retry.consider(f.retry.run,1,f.ctx.chat[1],null,2000);f.flush();
 for(let i=0;i<4;i++){f.ctx.chat[1]={is_user:false,mes:'retry'+i};f.retry.consider(f.retry.run,1,f.ctx.chat[1],null,2000);f.flush();}
 assert.equal(f.calls,3);assert.equal(JSON.parse([...f.data.values()][0]).length,3);
});
test('output threshold defaults, validation, and zero disabling',()=>{
 for(const n of [undefined,null,'',-1,1.5,NaN,Infinity,'bad'])assert.equal(outputThreshold(n),3000);
 assert.equal(outputThreshold('1500'),1500);assert.equal(outputThreshold(0),0);
});
test('custom threshold is used in comparison and notice; equality does not trigger',()=>{
 const f=fixture(),notices=[];f.retry.minOutput=()=>1500;f.retry.notify=s=>notices.push(s);
 f.retry.start('normal');f.retry.consider(f.retry.run,1,f.ctx.chat[1],20,1500);f.flush();assert.equal(f.calls,0);
 f.retry.consider(f.retry.run,1,f.ctx.chat[1],20,1499);f.flush();assert.equal(f.calls,1);assert.match(notices[0],/少于 1500/);
});
test('zero threshold disables only short-output reason, not speed',()=>{
 const f=fixture();f.retry.minOutput=()=>0;f.retry.start('normal');
 f.retry.consider(f.retry.run,1,f.ctx.chat[1],20,10);f.flush();assert.equal(f.calls,0);
 f.retry.consider(f.retry.run,1,f.ctx.chat[1],90,10);f.flush();assert.equal(f.calls,1);
});
test('threshold change before scheduled deletion is honored',()=>{
 const f=fixture();f.retry.start('normal');f.retry.consider(f.retry.run,1,f.ctx.chat[1],20,2000);
 f.retry.minOutput=()=>0;f.flush();assert.equal(f.calls,0);assert.equal(f.data.size,0);
});
