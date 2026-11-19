import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoRetry} from '../auto-retry.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
function fixture({stream=true,settleOnStop=true}={}){
 const ctx={chatId:'watchdog',characterId:1,chat:[{is_user:true,mes:'hi'},{is_user:false,mes:'old good'}]};
 const timers=new Map(),scheduled=[],data=new Map(),notes=[];let next=0,stopCalls=0,resolve;
 const retry=new AutoRetry({context:()=>ctx,enabled:()=>true,minOutput:()=>0,limit:()=>3,
  storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},busy:()=>false,
  notify:s=>notes.push(s),schedule:f=>scheduled.push(f),
  inactivityMs:90000,watchdogSchedule:(f,ms)=>{const id=++next;timers.set(id,{f,ms});return id;},watchdogCancel:id=>timers.delete(id),
  regenerate:()=>{retry.start('regenerate');ctx.chat[1]={is_user:false,mes:'fragment'};
   if(stream)ctx.streamingProcessor={type:'regenerate',messageId:1,isFinished:false,isStopped:false,abortController:{signal:{aborted:false}}};
   return new Promise(r=>resolve=r);},
  stopGeneration:()=>{stopCalls++;ctx.streamingProcessor.abortController.signal.aborted=true;ctx.streamingProcessor.isFinished=true;retry.stop();if(settleOnStop)resolve();return true;}
 });
 const launch=()=>{retry.start('normal');retry.consider(retry.run,1,ctx.chat[1],100,4000);scheduled.shift()();};
 const fire=()=>{const [id,t]=timers.entries().next().value;timers.delete(id);t.f();};
 return{ctx,retry,timers,launch,fire,data,notes,get stopCalls(){return stopCalls;},settle:()=>resolve?.()};
}
test('initial/manual generation has no watchdog; owned automatic hung stream stops then restores',async()=>{
 const f=fixture();f.retry.start('normal');assert.equal(f.timers.size,0);
 f.launch();assert.equal(f.timers.size,1);assert.equal([...f.timers.values()][0].ms,90000);
 f.fire();await tick();assert.equal(f.stopCalls,1);assert.equal(f.ctx.chat[1].mes,'old good');
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'timed_out');
 assert.equal(f.retry.run,null);assert.equal(f.timers.size,0);
});
test('reasoning-only stream events reset only the matching owned timer',async()=>{
 const f=fixture();f.launch();const first=[...f.timers.keys()][0];
 f.retry.progress(f.ctx.streamingProcessor);assert.equal(f.timers.size,1);assert.notEqual([...f.timers.keys()][0],first);
 const second=[...f.timers.keys()][0];f.retry.progress({messageId:999});assert.equal([...f.timers.keys()][0],second);
 f.settle();await tick();assert.equal(f.timers.size,0);
});
for(const kind of ['new generation','chat change','edit','background quiet','different processor','nonstream','already finished'])test('watchdog never stops '+kind,async()=>{
 const f=fixture({stream:kind!=='nonstream'});f.launch();
 if(kind==='new generation')f.retry.start('normal');
 if(kind==='chat change')f.ctx.chatId='other';
 if(kind==='edit')f.retry.edited(1);
 if(kind==='background quiet')f.retry.start('quiet');
 if(kind==='different processor')f.ctx.streamingProcessor={type:'quiet',messageId:1};
 if(kind==='already finished')f.ctx.streamingProcessor.isFinished=true;
 if(f.timers.size)f.fire();
 assert.equal(f.stopCalls,0);f.settle();await tick();
});
test('native stop not settling never overwrites live fragment and preserves recoverable outcome',async()=>{
 const f=fixture({settleOnStop:false});f.launch();f.fire();await tick();
 assert.equal(f.stopCalls,1);assert.equal(f.ctx.chat[1].mes,'fragment');
 assert.equal(JSON.parse([...f.data.values()][0])[0].message.mes,'old good');
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'timed_out');
 assert.match(f.notes.at(-1),/等待原生结束后恢复/);
 f.settle();await tick();assert.equal(f.ctx.chat[1].mes,'old good');
});
test('async native STARTED arms watchdog even before first streaming chunk',async()=>{
 const f=fixture();let begin,resolve;
 f.retry.regenerate=()=>new Promise(r=>{resolve=r;begin=()=>f.retry.start('regenerate');});
 f.launch();assert.equal(f.timers.size,0);
 begin();assert.equal(f.timers.size,1);
 f.fire();assert.equal(f.stopCalls,0);assert.match(f.notes.at(-1),/手动点停止/);
 resolve();await tick();
});
test('different manual start cannot inherit pending automatic count or watchdog',async()=>{
 const f=fixture();let resolve;
 f.retry.regenerate=()=>new Promise(r=>resolve=r);
 f.launch();f.retry.start('normal');
 assert.equal(f.retry.run.retries,0);assert.equal(f.retry.activeAttempt.superseded,true);
 assert.equal(f.timers.size,0);resolve();await tick();assert.equal(f.stopCalls,0);
});
