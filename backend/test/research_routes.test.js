'use strict';
const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {createResearchRouter}=require('../routes/research');
const {authorizeApiRequest}=require('../services/api_capabilities');
const {getChatTools}=require('../services/ai_service');
let server,origin,mutations=0;
before(async()=>{
    const app=express();app.use(express.json());
    app.use((req,res,next)=>{const role=req.get('X-Test-Role')||'reader';req.auth={role,type:role==='operator'?'session':'bearer'};next();});
    app.use('/api',authorizeApiRequest);
    app.use('/api/research',createResearchRouter({service:{packet:async symbol=>({symbol,id:'synthetic'}),invalidate:()=>{}},store:{getPacket:async id=>({id}),listAudit:async()=>[]},funds:{save:async()=>{mutations++;return {symbol:'TEST'};}},evaluation:{list:async()=>[],record:async()=>{mutations++;return {recorded:true};},create:async()=>{mutations++;return {id:'test'};}}}));
    server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;
});
after(()=>new Promise(r=>server.close(r)));
const request=(path,{role='reader',body}={})=>fetch(origin+'/api/research'+path,{method:body?'POST':'GET',headers:{'X-Test-Role':role,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
test('scoped long-term agents can read shared research but cannot attest issuer facts or inspect private AI traces',async()=>{
    assert.equal((await request('/TEST',{role:'alpaca-long-term-agent'})).status,200);
    for(const [path,body]of [['/fund-disclosures',{}],['/evaluations',{}],['/audit',null]])assert.equal((await request(path,{role:'alpaca-long-term-agent',body})).status,403);
    assert.equal(mutations,0);
});
test('long-term shadow decisions require the explicit account-1 capability',async()=>{
    assert.equal((await request('/evaluations/test/decisions',{role:'alpaca-long-term-agent',body:{account_id:2}})).status,403);
    assert.equal((await request('/evaluations/test/decisions',{role:'alpaca-long-term-agent',body:{account_id:1}})).status,200);
    assert.equal(mutations,1);
});
test('generic read tokens and simulator agents cannot mutate research disclosures or evaluations',async()=>{
    for(const role of ['reader','simulator-agent'])assert.equal((await request('/fund-disclosures',{role,body:{}})).status,403);
    assert.equal(mutations,1);
});
test('research chat does not expose paper mutations until the operator opts in',()=>{
    const tools=getChatTools();assert.equal(tools.simulator_buy,undefined);assert.equal(tools.simulator_sell,undefined);assert.ok(tools.getResearchEvidence);
    const approved=getChatTools({allowPaperTrading:true});assert.ok(approved.simulator_buy);assert.ok(approved.simulator_sell);
    assert.equal(Object.keys(approved).some(k=>/live.*(buy|sell|submit)/i.test(k)),false);
});
