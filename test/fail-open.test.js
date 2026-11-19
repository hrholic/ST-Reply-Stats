import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Reproduce core's await eventSource.emit contract without any server/API.
test('normal sends remain independent of hanging tokenizer, storage and observer errors',async()=>{
 const handlers=new Map();let generated=0, retryCalls=0, tokenizerResolve;
 const types=['GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','STREAM_TOKEN_RECEIVED','MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_UPDATED','CHAT_CHANGED','CHAT_LOADED','MORE_MESSAGES_LOADED','APP_READY'];
 const ctx={chatId:'isolated',characterId:2,chat:[],extensionSettings:{st_reply_stats:{autoRetry:false,retryLimit:3}},eventTypes:Object.fromEntries(types.map(k=>[k,k])),eventSource:{on:(k,f)=>handlers.set(k,f)},saveChat:async()=>{},getTokenCountAsync:()=>new Promise(resolve=>{tokenizerResolve=resolve;}),generate:()=>{retryCalls++;}};
 globalThis.SillyTavern={getContext:()=>ctx};
 globalThis.document={body:{dataset:{generating:'false'}},querySelector:()=>null};
 globalThis.requestAnimationFrame=fn=>fn();
 // Merely loading the extension must not access denied browser storage.
 Object.defineProperty(globalThis,'localStorage',{configurable:true,get:()=>{throw Error('storage denied');}});
 let source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
 assert.ok(!source.includes("from '../../../../script.js'"));
 source=source.replace("import('../../../itemized-prompts.js')",'Promise.resolve({itemizedPrompts:[]})');
 for(const name of ['stats','auto-retry'])source=source.replace(`'./${name}.js?v=0.2.15'`,JSON.stringify(new URL(`../${name}.js`,import.meta.url).href));
 await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 const emit=async(k,...args)=>{await handlers.get(k)?.(...args);};
 async function normal(){await emit('GENERATION_STARTED','normal',{},false);generated++;ctx.chat.push({is_user:false,mes:'result'+generated,gen_started:1000,gen_finished:11000,extra:{}});await emit('MESSAGE_RECEIVED',ctx.chat.length-1,'normal');await emit('GENERATION_ENDED');return 'completed';}
 assert.equal(await Promise.race([normal(),new Promise(r=>setTimeout(()=>r('BLOCKED'),100))]),'completed');
 assert.equal(retryCalls,0);
 // A later generation can start even though the previous tokenizer never resolved.
 assert.equal(await Promise.race([normal(),new Promise(r=>setTimeout(()=>r('BLOCKED'),100))]),'completed');
 assert.equal(generated,2);
 const newest=ctx.chat.at(-1);newest.mes='newer edited content';tokenizerResolve(1000);
 await new Promise(r=>setTimeout(r,10));assert.equal(newest.extra.reply_token_stats,undefined);
 // Synchronous plugin/settings exception does not escape into Generate.
 Object.defineProperty(ctx,'extensionSettings',{configurable:true,get:()=>{throw Error('observer settings failure');}});
 const warn=console.warn;console.warn=()=>{};try {await assert.doesNotReject(()=>emit('GENERATION_STARTED','normal',{},false));} finally {console.warn=warn;}
 assert.equal(retryCalls,0);
});
