import test from 'node:test';
import assert from 'node:assert/strict';
import {roughTokenCount,statisticsView,messageDisplayKey,makeLabel,makeTitle} from '../stats.js';

test('rough UTF8 estimate is visibly per metric and never replaces decision values',()=>{
 const message={mes:'你好 world',gen_started:1000,gen_finished:11000,extra:{reasoning:'思考'}};
 const stats={requestType:'normal',displayKey:messageDisplayKey(message),input:null,output:null,tps:null,total:10,roughInput:100};
 const unchanged=JSON.stringify(stats);
 const view=statisticsView(stats,message);
 assert.equal(view.output,Math.ceil(new TextEncoder().encode('思考你好 world').length/3.35));
 assert.match(makeLabel(view),/入粗估100.*出粗估.*流粗估/);
 assert.match(makeTitle(view),/仅供显示，不用于自动重生/);
 assert.equal(JSON.stringify(stats),unchanged);
});
test('native late field only fills display with known normal semantics and same reply',()=>{
 const m={mes:'hello',gen_started:1000,gen_finished:11000,extra:{token_count:200}};
 const stats={requestType:'normal',displayKey:messageDisplayKey(m),output:null,tps:null,total:10};
 const v=statisticsView(stats,m);assert.equal(v.output,200);assert.equal(v.tps,20);assert.equal(stats.output,null);
 assert.match(makeLabel(v),/出原生200.*流原生20/);
 for(const requestType of [undefined,'continue','append','appendFinal']){
 const view=statisticsView({...stats,requestType},m);assert.equal(view.output,null);assert.equal(view.tps,null);
 }
 m.mes='edited';assert.equal(statisticsView(stats,m).output,null);
});
test('unknown, empty, invalid and changed variants never become fake zero or stale estimates',()=>{
 assert.equal(roughTokenCount(''),null);assert.equal(roughTokenCount(null),null);
 const m={mes:'hello',swipe_id:0,extra:{}};
 const stats={requestType:'normal',displayKey:messageDisplayKey(m),input:null,output:null,tps:null,roughInput:50};
 m.swipe_id=1;const view=statisticsView(stats,m);assert.equal(view.output,null);assert.equal(view.input,null);
});
test('available native stats stay authoritative, and continuation is never whole-text rough output',()=>{
 const m={mes:'huge'.repeat(1000),extra:{token_count:9000}};
 const stats={requestType:'normal',displayKey:messageDisplayKey(m),input:5,output:8,tps:4,total:2,roughInput:999};
 assert.deepEqual(statisticsView(stats,m),stats);
 assert.equal(statisticsView({...stats,requestType:'continue',output:null,tps:null},m).output,null);
});
