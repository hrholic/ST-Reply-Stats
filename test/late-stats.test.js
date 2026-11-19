import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {JSDOM} from 'jsdom';

for (const mode of ['normal','continue','edit','swipe','chat switch','chat id','reasoning edit']) test('late tokenizer display-only: '+mode,async()=>{
 const dom=new JSDOM('<body><div id="extensionsMenu"></div><div class="mes" mesid="1"><span class="name_text">Assistant</span></div></body>');
 const realTimer=globalThis.setTimeout;
 globalThis.document=dom.window.document;globalThis.requestAnimationFrame=f=>f();
 globalThis.setTimeout=(f,ms,...args)=>realTimer(f,ms===3000?5:ms,...args);
 const handlers=new Map();const resolves=[];let generations=0;
 const previous=mode==='continue'?{totalOutput:400,output:400}:undefined;
 const message={mes:'reply',gen_started:1000,gen_finished:11000,extra:{reply_token_stats:previous}};
 const ctx={chatId:'late-'+mode,characterId:1,chat:[{is_user:true,mes:'hi'},message],
 extensionSettings:{st_reply_stats:{autoRetry:true,showStats:true}},saveChat:async()=>{},generate:()=>generations++,
 getTokenCountAsync:()=>new Promise(resolve=>resolves.push(resolve)),
 eventTypes:{MESSAGE_RECEIVED:'received'},eventSource:{on:(k,f)=>handlers.set(k,f)}};
 globalThis.SillyTavern={getContext:()=>ctx};
 let source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 for(const name of ['auto-retry','stats'])source=source.replace(`'./${name}.js?v=0.2.16'`,JSON.stringify(new URL(`../${name}.js?v=0.2.16`,import.meta.url).href));
 source=source.replace("import('../../../itemized-prompts.js')",'Promise.resolve({itemizedPrompts:[{mesId:1,rawPrompt:"prompt"}]})');
 try{
 await import('data:text/javascript;base64,'+Buffer.from(source+'\n//late '+mode).toString('base64'));
 assert.equal(handlers.get('received')(1,mode==='continue'?'continue':'normal'),undefined);
 await new Promise(r=>realTimer(r,30));
 assert.match(document.querySelector('.reply-token-stats').textContent,/入—.*出—.*流—/);
 if(mode==='edit')message.mes='edited';
 if(mode==='swipe')message.swipe_id=1;
 if(mode==='chat switch')ctx.chat=[{mes:'new chat'}];
 if(mode==='chat id')ctx.chatId='different';
 if(mode==='reasoning edit')message.extra.reasoning='changed';
 resolves[0](1000);resolves[1](2000);
 await new Promise(r=>realTimer(r,5));
 if(['edit','swipe','chat switch','chat id','reasoning edit'].includes(mode))assert.equal(message.extra.reply_token_stats.output,null);
 else{
 assert.equal(message.extra.reply_token_stats.output,mode==='continue'?600:1000);
 assert.equal(message.extra.reply_token_stats.input,2000);
 assert.match(document.querySelector('.reply-token-stats').textContent,/入2k.*流(?:60|100)t\/s/);
 }
 assert.equal(generations,0);
 }finally{globalThis.setTimeout=realTimer;dom.window.close();}
});
