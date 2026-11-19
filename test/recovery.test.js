import test from 'node:test';
import assert from 'node:assert/strict';
import {AutoRetry,isCompletedReply} from '../auto-retry.js';
const tick=()=>new Promise(r=>setTimeout(r,0));
function setup(generate){
 const chat=[{is_user:true,mes:'hi'},{is_user:false,mes:'original',gen_started:1000,gen_finished:2000}];
 let ctx={chat,chatId:'x',characterId:1,printMessages:async()=>{},saveChat:async()=>{}};
 const tasks=[],notices=[],data=new Map();
 const retry=new AutoRetry({context:()=>ctx,enabled:()=>true,limit:()=>3,
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
 const f=setup(chat=>{chat[1]={is_user:false,mes:'new'};return Promise.resolve('new');});await tick();
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
 const retry=new AutoRetry({context:()=>ctx,enabled:()=>true,limit:()=>3,
 storage:{getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)},busy:()=>false,schedule:f=>tasks.push(f),notify:s=>notices.push(s),
 regenerate:async()=>{calls++;retry.start('regenerate');chat.pop();chat.push({is_user:false,mes:'reply'+calls});retry.consider(retry.run,1,chat[1],100);}});
 retry.start('normal');retry.consider(retry.run,1,chat[1],100);
 for(let n=0;n<6;n++){tasks.splice(0).forEach(f=>f());await tick();}
 assert.equal(calls,3);assert.equal(chat[1].mes,'reply3');assert.equal(JSON.parse([...data.values()][0]).length,3);
 assert.deepEqual(notices.map(s=>s.match(/第 (\d) 条/g)),[['第 1 条','第 2 条'],['第 2 条','第 3 条'],['第 3 条','第 4 条']]);
});
