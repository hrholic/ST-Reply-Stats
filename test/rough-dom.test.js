import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';

for (const mode of ['reject','invalid','missing']) test('standalone unavailable tokenizer shows rough metrics only: '+mode,async()=>{
 const dom=new JSDOM('<body><div id="extensionsMenu"></div><div class="mes" mesid="1"><span class="name_text">Assistant</span></div></body>');
 const realTimer=globalThis.setTimeout;
 globalThis.document=dom.window.document;globalThis.requestAnimationFrame=f=>f();
 globalThis.setTimeout=(f,ms,...args)=>realTimer(f,ms===3000?5:ms,...args);
 const handlers=new Map();const resolves=[];let generations=0;
 const previous=mode==='continue'?{totalOutput:400,output:400}:undefined;
 const message={mes:'reply',gen_started:1000,gen_finished:11000,extra:{reply_token_stats:previous}};
 const ctx={chatId:'late-'+mode,characterId:1,chat:[{is_user:true,mes:'hi'},message],
 extensionSettings:{st_reply_stats:{autoRetry:true,showStats:true}},saveChat:async()=>{},generate:()=>generations++,
 getTokenCountAsync: mode==='missing'?undefined:()=>mode==='reject'?Promise.reject(new Error('synthetic failure')):Promise.resolve(NaN),
 eventTypes:{MESSAGE_RECEIVED:'received'},eventSource:{on:(k,f)=>handlers.set(k,f)}};
 globalThis.SillyTavern={getContext:()=>ctx};
 let source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 for(const name of ['auto-retry','stats'])source=source.replace(`'./${name}.js?v=0.2.17'`,JSON.stringify(new URL(`../${name}.js?v=0.2.17`,import.meta.url).href));
 source=source.replace("import('../../../itemized-prompts.js')",'Promise.resolve({itemizedPrompts:[{mesId:1,rawPrompt:"prompt"}]})');
 try{
 source += '\nautoRetry.consider = (...args) => globalThis.retryDecisions.push(args);';
 await import('data:text/javascript;base64,'+Buffer.from(source+'\n//rough '+mode).toString('base64'));
 globalThis.retryDecisions=[];
 assert.equal(handlers.get('received')(1,'normal'),undefined);
 await new Promise(r=>realTimer(r,30));
 assert.match(document.querySelector('.reply-token-stats').textContent,mode==='continue'?/入粗估.*出—.*流—/:/入粗估.*出粗估.*流粗估/);
 assert.equal(message.extra.reply_token_stats.output,null);
 assert.equal(message.extra.reply_token_stats.input,null);
 assert.equal(message.extra.reply_token_stats.tps,null);
 assert.equal(globalThis.retryDecisions.length,1);
 assert.equal(globalThis.retryDecisions[0][3],null);
 assert.equal(globalThis.retryDecisions[0][4],null);
 assert.equal(generations,0);
 }finally{globalThis.setTimeout=realTimer;dom.window.close();}
});
