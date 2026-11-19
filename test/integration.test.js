import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('actual index wiring: setting save, finish event, backed-up native regenerate, restore',async()=>{
 const handlers=new Map(), data=new Map(); let clicks=0, renders=0;
 const ctx={characterId:1,chatId:'fixture',chat:[],extensionSettings:{},
 eventTypes:Object.fromEntries(['GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','STREAM_TOKEN_RECEIVED','MESSAGE_RECEIVED','CHARACTER_MESSAGE_RENDERED','MESSAGE_SWIPED','MESSAGE_UPDATED','CHAT_CHANGED','CHAT_LOADED','MORE_MESSAGES_LOADED','APP_READY'].map(k=>[k,k])),
 eventSource:{on:(key,fn)=>handlers.set(key,fn)},saveChat:async()=>{},saveSettingsDebounced:()=>{},printMessages:async()=>{renders++;},POPUP_TYPE:{INPUT:1}};
 let restore=false;
 ctx.Popup=class {constructor(_a,_b,_c,options){assert.equal(options.customInputs.length,4);this.inputResults=new Map([['reply-token-stats-show',true],['reply-token-stats-auto-retry',true],['reply-token-stats-restore',restore],['reply-token-stats-retry-limit','3']]);}async show(){return 'content context';}};
 globalThis.localStorage={getItem:k=>data.get(k)??null,setItem:(k,v)=>data.set(k,v)};
 globalThis.SillyTavern={getContext:()=>ctx};
 const notices=[];globalThis.toastr={info:text=>notices.push(text),warning:text=>notices.push(text)};
 globalThis.getComputedStyle=()=>({display:'flex'}); // mobile theme must not determine generation state
 globalThis.__tavern={isGenerating:()=>false};
 ctx.generate=(type)=>{assert.equal(type,'regenerate');assert.match(notices.at(-1),/第 1 条回复已生成.*第 2 条回复/);clicks++;handlers.get('GENERATION_STARTED')('regenerate',{},false);};
 globalThis.requestAnimationFrame=fn=>fn();
 globalThis.document={body:{dataset:{generating:'false'}},querySelector:()=>null}; // no menu/stop button required
 let source=fs.readFileSync(new URL('../index.js',import.meta.url),'utf8');
 source=source.replace("import * as Tavern from '../../../../script.js';",'const Tavern = globalThis.__tavern;');
 source=source.replace("import { itemizedPrompts } from '../../../itemized-prompts.js';",'const itemizedPrompts = [];');
 for(const name of ['stats','auto-retry'])source=source.replace(`'./${name}.js?v=0.2.12'`,JSON.stringify(new URL(`../${name}.js`,import.meta.url).href));
 source+='\nexport { editBodyTags };';
 const mod=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 await mod.editBodyTags();assert.equal(ctx.extensionSettings.st_reply_stats.autoRetry,true);assert.equal(ctx.extensionSettings.st_reply_stats.retryLimit,3);
 handlers.get('GENERATION_STARTED')('normal',{},false);
 handlers.get('GENERATION_STARTED')('quiet',{},false);
 handlers.get('GENERATION_STARTED')('normal',{},true);
 ctx.chat.push({is_user:true,mes:'hello'},{is_user:false,mes:'fast',extra:{token_count:1000},gen_started:1000,gen_finished:11000});
 assert.equal(handlers.get('MESSAGE_RECEIVED')(1,'normal'),undefined);
 await new Promise(r=>setTimeout(r,10));
 ctx.streamingProcessor={isFinished:true}; // UI has stopped, but old Generate still owns this pointer
 assert.equal(clicks,0);ctx.chat[1].swipe_id=0;ctx.chat[1].swipes=['fast'];ctx.chat[1].swipe_info=[{extra:structuredClone(ctx.chat[1].extra)}];/* Theme hides native stop button: no GENERATION_ENDED emitted */
 await new Promise(r=>setTimeout(r,350));assert.equal(clicks,0);assert.equal(data.size,0);
 ctx.streamingProcessor=null; // old Generate finally finished cleanup
 await new Promise(r=>setTimeout(r,350));assert.equal(clicks,1);assert.equal(data.size,1);
 ctx.chat[1]={is_user:false,mes:'replacement'};restore=true;await mod.editBodyTags();
 assert.equal(ctx.chat[1].mes,'fast');assert.equal(renders,1);
});
