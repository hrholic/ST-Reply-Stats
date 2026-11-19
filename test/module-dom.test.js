import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {JSDOM} from 'jsdom';

test('mixed cached old helper reproduces total plugin failure; versioned imports restore tokens and speed DOM with retry OFF',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'reply-stats-cache-'));
 try{
 const helper=pathToFileURL(path.join(tmp,'auto-retry.mjs')).href;
 await fs.writeFile(path.join(tmp,'auto-retry.mjs'),'export class AutoRetry {}\nexport const retryLimit=()=>3;');
 await import(helper); // Browser/module cache contains pre-v0.2.11 helper.
 await fs.writeFile(path.join(tmp,'auto-retry.mjs'),await fs.readFile(new URL('../auto-retry.js',import.meta.url)));
 const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 const prompt='Promise.resolve({itemizedPrompts:[{mesId:1,oaiTotalTokens:1234}]})';
 const wire=(versioned)=>source
  .replace(/'\.\/auto-retry\.js(?:\?[^']*)?'/,JSON.stringify(helper+(versioned?'?v=0.2.14':'')))
  .replace(/'\.\/stats\.js(?:\?[^']*)?'/,JSON.stringify(new URL('../stats.js?v=0.2.14',import.meta.url).href))
  .replace("import('../../../itemized-prompts.js')",prompt);
 const load=s=>import('data:text/javascript;base64,'+Buffer.from(s).toString('base64'));
 await assert.rejects(load(wire(false)),/does not provide an export named 'isCompletedReply'/);
 const dom=new JSDOM('<body><div id="extensionsMenu"></div><div class="mes" mesid="1"><span class="name_text">Assistant</span><span class="timer">10s</span></div></body>');
 globalThis.document=dom.window.document;
 globalThis.requestAnimationFrame=f=>f();
 const handlers=new Map();let generations=0;
 const ctx={chatId:'dom-test',characterId:1,chat:[{is_user:true,mes:'hello'},{is_user:false,mes:'reply',gen_started:1000,gen_finished:11000,extra:{token_count:1000}}],
 extensionSettings:{st_reply_stats:{autoRetry:false,showStats:true,retryLimit:3}},saveChat:async()=>{},generate:()=>{generations++;},
 eventTypes:Object.fromEntries(['MESSAGE_RECEIVED','GENERATION_STARTED','CHARACTER_MESSAGE_RENDERED','CHAT_CHANGED'].map(x=>[x,x])),eventSource:{on:(k,f)=>handlers.set(k,f)}};
 globalThis.SillyTavern={getContext:()=>ctx};
 await load(wire(true));
 assert.ok(document.querySelector('#reply-token-stats-body-tags'));
 assert.match(document.querySelector('.reply-token-stats').textContent,/入—.*出—.*流—/);
 handlers.get('GENERATION_STARTED')('normal',{},false);
 assert.equal(handlers.get('MESSAGE_RECEIVED')(1,'normal'),undefined);
 await new Promise(r=>setTimeout(r,10));
 const label=document.querySelector('.reply-token-stats');
 assert.match(label.textContent,/入1\.2k.*出1k.*流100t\/s.*总10/);
 assert.ok(label.querySelector('.reply-token-stats-rate-high'));
 assert.equal(ctx.chat[1].extra.reply_token_stats.input,1234);
 assert.equal(generations,0);
 assert.equal(document.querySelector('.reply-token-stats-slot').style.display,'');
 // Redraw/history path retains all recorded metrics and does not trigger generation.
 handlers.get('CHARACTER_MESSAGE_RENDERED')(1);
 assert.equal(document.querySelectorAll('.reply-token-stats-slot').length,1);
 assert.match(label.textContent,/入1\.2k.*出1k.*流100/);
 assert.equal(generations,0);
 dom.window.close();
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});
test('entry and both local dependency URLs carry the published version',async()=>{
 const manifest=JSON.parse(await fs.readFile(new URL('../manifest.json',import.meta.url),'utf8'));
 const source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 assert.equal(manifest.js,`index.js?v=${manifest.version}`);
 for(const name of ['auto-retry','stats'])assert.ok(source.includes(`'./${name}.js?v=${manifest.version}'`));
});

for(const mode of ['legacy fallback','both missing','optional import hangs'])test('optional input source never removes output/speed: '+mode,async()=>{
 const dom=new JSDOM('<body><div id="extensionsMenu"></div><div class="mes" mesid="1"><span class="name_text">Assistant</span></div></body>');
 globalThis.document=dom.window.document;globalThis.requestAnimationFrame=f=>f();
 const handlers=new Map();let generates=0;
 const ctx={chatId:'optional-'+mode,characterId:1,chat:[{is_user:true,mes:'hi'},{is_user:false,mes:'result',gen_started:1000,gen_finished:11000,extra:{token_count:1000}}],
 extensionSettings:{st_reply_stats:{autoRetry:false,showStats:true}},saveChat:async()=>{},generate:()=>generates++,
 eventTypes:{MESSAGE_RECEIVED:'MESSAGE_RECEIVED'},eventSource:{on:(k,f)=>handlers.set(k,f)}};
 globalThis.SillyTavern={getContext:()=>ctx};
 let source=await fs.readFile(new URL('../index.js',import.meta.url),'utf8');
 for(const name of ['auto-retry','stats'])source=source.replace(`'./${name}.js?v=0.2.14'`,JSON.stringify(new URL(`../${name}.js?v=0.2.14`,import.meta.url).href));
 source=source.replace("import('../../../itemized-prompts.js')",mode==='optional import hangs'?'new Promise(()=>{})':"Promise.reject(Error('404 itemized-prompts'))");
 source=source.replace("import('../../../../script.js')",mode==='legacy fallback'?'Promise.resolve({itemizedPrompts:[{mesId:1,oaiTotalTokens:222}]})':"Promise.reject(Error('optional unavailable'))");
 const warn=console.warn;console.warn=()=>{};
 try{
 await import('data:text/javascript;base64,'+Buffer.from(source+'\n//'+mode).toString('base64'));
 await new Promise(r=>setTimeout(r,0));
 assert.ok(document.querySelector('#reply-token-stats-body-tags'));
 assert.equal(handlers.get('MESSAGE_RECEIVED')(1,'normal'),undefined);
 await new Promise(r=>setTimeout(r,10));
 const text=document.querySelector('.reply-token-stats').textContent;
 assert.match(text,/出1k.*流100t\/s/);
 assert.match(text,mode==='legacy fallback'?/入222/:/入—/);
 assert.equal(generates,0);
 }finally{console.warn=warn;dom.window.close();}
});
