import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoRetry,isCompletedReply,isActiveProcessor} from '../auto-retry.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
function setup(generate){
 const chat=[{is_user:true,mes:'hi'},{is_user:false,mes:'original',gen_started:1000,gen_finished:2000}];
 let ctx={chat,chatId:'x',characterId:1,printMessages:async()=>{},saveChat:async()=>{}};
 const tasks=[],notices=[],data=new Map();
 const retry=new AutoRetry({renderReply:(ctx)=>ctx.printMessages?.(),context:()=>ctx,enabled:()=>true,limit:()=>3,
 storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},busy:()=>false,
 schedule:f=>tasks.push(f),notify:s=>notices.push(s),
 regenerate:()=>{assert.match(notices.at(-1),/第 1 条回复已生成.*第 2 条回复/);assert.equal(chat[1].mes,'original');retry.start('regenerate');return generate(chat,retry);}});
 retry.start('normal');retry.consider(retry.run,1,chat[1],100);tasks.shift()();
 return {chat,retry,notices,data,tasks,switchChat:()=>{ctx={...ctx,chatId:'other',chat:[]};}};
}
test('native rejection after deletion restores original without further retry',async()=>{
 const f=setup(chat=>{chat.pop();return Promise.reject(Error('timeout'));});await tick();
 assert.equal(f.chat[1].mes,'original');assert.equal(f.retry.run,null);assert.match(f.notices.at(-1),/已恢复原回复/);
});
test('native handled failure resolving undefined with empty placeholder restores',async()=>{
 const f=setup(chat=>{chat[1]={is_user:false,mes:'...'};return Promise.resolve();});await tick();
 assert.equal(f.chat[1].mes,'original');assert.equal(JSON.parse([...f.data.values()][0]).length,2);
});
test('successful nonempty replacement remains',async()=>{
 const f=setup((chat,retry)=>{chat[1]={is_user:false,mes:'new'};retry.observeCompletion(retry.run,1,chat[1],true);return Promise.resolve('new');});await tick();
 assert.equal(f.chat[1].mes,'new');assert.equal(f.retry.activeAttempt,null);
});
test('failed partial replacement is retained with old reply still backed up',async()=>{
 const f=setup(chat=>{chat[1]={is_user:false,mes:'partial'};return Promise.reject(Error('offline'));});await tick();
 assert.equal(f.chat[1].mes,'partial');assert.match(f.notices.at(-1),/已保留现有内容/);
 assert.equal(JSON.parse([...f.data.values()][0])[0].message.mes,'original');
});
for(const kind of ['chat switch','new user message','new manual generation'])test('rollback does not overwrite '+kind,async()=>{
 let reject;const f=setup(chat=>{chat.pop();return new Promise((_,r)=>{reject=r;});});
 if(kind==='chat switch')f.switchChat();
 if(kind==='new user message')f.chat.push({is_user:true,mes:'new'});
 if(kind==='new manual generation')f.retry.start('normal');
 reject(Error('offline'));await tick();assert.notEqual(f.chat[1]?.mes,'original');
});
test('unchanged native failure preserves original and stops',async()=>{
 const f=setup(()=>Promise.resolve());await tick();assert.equal(f.chat[1].mes,'original');assert.match(f.notices.at(-1),/原回复已保留/);
});
test('ordinary reply completion guard excludes stopped, timed out, incomplete and empty',()=>{
 const good={is_user:false,mes:'reply',gen_started:1000,gen_finished:2000};
 assert.equal(isCompletedReply(good,null),true);
 assert.equal(isCompletedReply(good,{isFinished:true,isStopped:false}),true);
 for(const processor of [{isFinished:false},{isFinished:true,isStopped:true},{isFinished:true,abortController:{signal:{aborted:true}}}])assert.equal(isCompletedReply(good,processor),false);
 for(const change of [{mes:''},{mes:'...'},{gen_finished:undefined},{gen_finished:1000},{is_user:true}])assert.equal(isCompletedReply({...good,...change},null),false);
});
test('promise-based native chain shows 1 to 2 to 3 to 4 and stops after three retries',async()=>{
 const chat=[{is_user:true,mes:'hi'},{is_user:false,mes:'first'}],tasks=[],notices=[],data=new Map();
 const ctx={chat,chatId:'chain',characterId:1};let calls=0;
 const retry=new AutoRetry({renderReply:(ctx)=>ctx.printMessages?.(),context:()=>ctx,enabled:()=>true,limit:()=>3,
 storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},busy:()=>false,schedule:f=>tasks.push(f),notify:s=>notices.push(s),
 regenerate:async()=>{calls++;retry.start('regenerate');chat.pop();chat.push({is_user:false,mes:'reply'+calls});retry.observeCompletion(retry.run,1,chat[1],true);retry.consider(retry.run,1,chat[1],100);}});
 retry.start('normal');retry.consider(retry.run,1,chat[1],100);
 for(let n=0;n<6;n++){tasks.splice(0).forEach(f=>f());await tick();}
 assert.equal(calls,3);assert.equal(chat[1].mes,'reply3');assert.equal(JSON.parse([...data.values()][0]).length,3);
 assert.deepEqual(notices.map(s=>s.match(/第 (\d) 条/g)),[['第 1 条','第 2 条'],['第 2 条','第 3 条'],['第 3 条','第 4 条']]);
});
test('ST swallowed midstream error resolves with fragment but does NOT count as success',async()=>{
 const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'visible incomplete fragment',gen_started:1000,gen_finished:2000};
  const processor={isFinished:false,isStopped:true,abortController:{signal:{aborted:true}}};
  retry.observeCompletion(retry.run,1,chat[1],isCompletedReply(chat[1],processor));
  return Promise.resolve(); // ST catches streaming failure instead of rejecting Generate.
 });
 await tick();
 assert.equal(f.chat[1].mes,'original');assert.equal(f.retry.run,null);
 const copies=JSON.parse([...f.data.values()][0]);
 assert.equal(copies[0].autoRetryOutcome,'failed');
 assert.equal(copies.at(-1).message.mes,'visible incomplete fragment');
 assert.match(f.notices.at(-1),/已恢复原回复/);
});
test('no positive native completion cannot be silently accepted',async()=>{
 const f=setup(chat=>{chat[1]={is_user:false,mes:'unproven fragment'};return Promise.resolve();});
 await tick();assert.equal(f.retry.run,null);
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'failed');
 assert.match(f.notices.at(-1),/没有有效完成记录/);
});
test('completion from unrelated run is not proof and edits after completion are protected',async()=>{
 let resolve;
 const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'fragment'};
  retry.observeCompletion({},1,chat[1],true);
  retry.observeCompletion(retry.run,1,chat[1],false);
  return new Promise(r=>resolve=r);
 });
 f.chat[1].mes='manual edit';resolve();await tick();
 assert.equal(f.chat[1].mes,'manual edit');
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'failed');
});
test('attempt stays persistently pending while request has not settled',async()=>{
 let resolve;const f=setup(()=>new Promise(r=>resolve=r));
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'pending');
 resolve();await tick();assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'failed');
});
test('manual stop restores owned unchanged partial to original',async()=>{
 let resolve;const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'partial user stopped'};
  retry.observeCompletion(retry.run,1,chat[1],false);
  return new Promise(r=>resolve=r);
 });
 f.retry.stop();resolve();await tick();
 assert.equal(f.chat[1].mes,'original');
 assert.equal(JSON.parse([...f.data.values()][0])[0].autoRetryOutcome,'stopped');
});
test('processor aborted after completion observation cannot be accepted',async()=>{
 let resolve;const processor={isFinished:true,abortController:{signal:{aborted:false}}};
 const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'candidate'};
  retry.observeCompletion(retry.run,1,chat[1],true,processor);
  return new Promise(r=>resolve=r);
 });
 processor.abortController.signal.aborted=true;resolve();await tick();assert.equal(f.chat[1].mes,'original');
});
test('outcome remains inspectable after controller is recreated',async()=>{
 let resolve;const f=setup(()=>new Promise(r=>resolve=r));
 const reload=new AutoRetry({renderReply:(ctx)=>ctx.printMessages?.(),context:()=>({chatId:'x',characterId:1}),storage:{getItem:k=>f.data.get(k)}});
 assert.match(reload.lastOutcome(),/未记录完成/);
 resolve();await tick();assert.match(reload.lastOutcome(),/未完整成功/);
});
test('manual stop then editing partial prevents automatic restore',async()=>{
 let resolve;const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'partial'};
  return new Promise(r=>resolve=r);
 });
 f.retry.stop();f.chat[1].mes='user edited';resolve();await tick();
 assert.equal(f.chat[1].mes,'user edited');
});
test('new message during asynchronous recovery render is not saved by old recovery',async()=>{
 let release, saves=0;
 const f=setup((chat,retry)=>{
  const ctx=retry.context();ctx.printMessages=()=>new Promise(r=>release=r);ctx.saveChat=async()=>saves++;
  chat.pop();return Promise.reject(Error('failed'));
 });
 await tick();assert.equal(f.chat[1].mes,'original');
 f.chat.push({is_user:true,mes:'new turn'});release();await tick();assert.equal(saves,0);
});
test('manual restore does not save after user edits during async rendering',async()=>{
 let release,saves=0;
 const f=setup(()=>Promise.resolve());await tick();
 const ctx=f.retry.context();ctx.printMessages=()=>new Promise(r=>release=r);ctx.saveChat=async()=>saves++;
 const restoration=f.retry.restore();await tick();
 f.chat[1].mes='edited during restore';release();
 await assert.rejects(restoration,/变化/);assert.equal(saves,0);
});
test('legacy stopped streaming pointer is terminal but successful cleanup still blocks retry',()=>{
 assert.equal(isActiveProcessor({isStopped:true,isFinished:false}),false);
 assert.equal(isActiveProcessor({isStopped:false,abortController:{signal:{aborted:true}}}),false);
 assert.equal(isActiveProcessor({isFinished:true,isStopped:false}),true);
 assert.equal(isActiveProcessor({isFinished:false}),true);
 assert.equal(isActiveProcessor(null),false);
});
test('outcome-only persistence failure does not block restoring from verified backup',async()=>{
 let resolve;const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'partial'};
  retry.observeCompletion(retry.run,1,chat[1],false);
  return new Promise(r=>resolve=r);
 });
 const set=f.retry.storage.setItem;let failed=false;
 f.retry.storage.setItem=(key,value)=>{
  if(!failed && JSON.parse(value)[0].autoRetryOutcome==='failed'){failed=true;throw Error('outcome write failure');}
  set(key,value);
 };
 const warn=console.warn;console.warn=()=>{};
 try{resolve();await tick();}finally{console.warn=warn;}
 assert.equal(f.chat[1].mes,'original');assert.equal(failed,true);
 assert.equal(JSON.parse([...f.data.values()][0]).at(-1).message.mes,'partial');
});
test('manual recovery prefers original backup over archived failed fragment',async()=>{
 const f=setup((chat,retry)=>{
  chat[1]={is_user:false,mes:'failed fragment'};retry.observeCompletion(retry.run,1,chat[1],false);return Promise.resolve();
 });await tick();
 f.chat[1]={is_user:false,mes:'replacement'};
 await f.retry.restore();assert.equal(f.chat[1].mes,'original');
});
