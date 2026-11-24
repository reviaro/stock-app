'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../database/db');
const baseStore=require('../services/alpaca_paper_long_term_store');
const liveStore=require('../services/alpaca_live_store');
const {createPaperLongTermInvesting,createPaperInvestingClient,configuration,legacyBlockers}=require('../services/alpaca_paper_long_term');
let serial=0;
before(async()=>{await db.initDb();await baseStore.init();});
async function fixture() {
    for (const row of await baseStore.orders()) if (!baseStore.finalStatuses.has(row.status)) await baseStore.updateOrder(row.id,{status:'canceled'});
    const conn=db.getDb();
    await new Promise((resolve,reject)=>conn.run('UPDATE alpaca_paper_long_term_settings SET version=0,sequence=0,policy_json=?,account_key=NULL WHERE id=1',[JSON.stringify(baseStore.DEFAULT_POLICY)],e=>e?reject(e):resolve()));
    await new Promise(resolve=>conn.close(resolve));
    const id='synthetic-paper-'+(++serial);
    const store={...baseStore,orders:async()=>(await baseStore.orders()).filter(o=>o.account_key===baseStore.hash(id)),ownership:async()=>(await baseStore.ownership()).filter(o=>o.account_key===baseStore.hash(id))};
    const env={ALPACA_API_KEY:'synthetic-key',ALPACA_API_SECRET:'synthetic-secret',ALPACA_PAPER_ORDER_ENTRY_ENABLED:'true'};
    const account={id,currency:'USD',status:'ACTIVE',trading_blocked:false,account_blocked:false,cash:'10000',equity:'10000',non_marginable_buying_power:'10000'};
    const state={positions:[],open:[],orders:new Map(),submitted:[],marketOpen:true,unknown:false,legacy:[]};
    const client={getAccount:async()=>({...account}),getClock:async()=>({is_open:state.marketOpen,next_close:new Date(Date.now()+3600000).toISOString()}),
        getPositions:async()=>structuredClone(state.positions),getOrders:async()=>state.open,
        getAsset:async symbol=>({symbol,class:'us_equity',status:'active',tradable:true,fractionable:true,exchange:'NASDAQ'}),
        getLatestQuote:async symbol=>({symbol,quote:{bp:100,ap:100.02,bs:100,as:100,t:new Date(Date.now()-100).toISOString()}}),
        getOrderByClientId:async key=>state.orders.get(key)||null,
        submit:async order=>{state.submitted.push(order);if(state.unknown)throw Error('synthetic unavailable');const result={...order,id:'synthetic-order-'+state.submitted.length,status:'new',filled_qty:'0',filled_avg_price:null};state.orders.set(order.client_order_id,result);return result;},
        cancel:async id=>{for(const order of state.orders.values())if(order.id===id)order.status='canceled';},
    };
    const getFreshResearchPacket=async symbol=>({symbol,id:'fresh-test-evidence',contentHash:'a'.repeat(64),generatedAt:new Date().toISOString(),accountScope:'research_only',eligibleForDecision:true,provenance:{news:{available:true}},data:{info:{price:100},news:[]},...state.research});
    const service=createPaperLongTermInvesting({store,env,getFreshResearchPacket,clientFactory:()=>client,legacyGuard:async()=>state.legacy});
    const policy={...baseStore.DEFAULT_POLICY,budget:10000,paused:false,targets:[{symbol:'AAPL',weightPct:20}]};
    await service.savePolicy(policy,0,'ENABLE PAPER INVESTING');
    return {store,env,account,state,client,service,policy,getFreshResearchPacket};
}
const confirmation=plan=>({confirmation:`${plan.nextOrder.side.toUpperCase()} ${plan.nextOrder.symbol} PAPER`});

async function heldFixture() {
    const f=await fixture();
    await f.service.savePolicy({...f.policy,executionMode:'automatic',targets:[...f.policy.targets,{symbol:'HELD',weightPct:10}]},1,'ENABLE AUTOMATIC PAPER INVESTING');
    f.state.positions=[{symbol:'HELD',qty:'10',current_price:'100',side:'long',unrealized_pl:'0'}];
    f.store.ownership=async()=>[{symbol:'HELD',delta_qty:10,account_key:f.store.hash(f.account.id)}];
    for(const method of ['getAsset','getLatestQuote']) {
        const original=f.client[method];
        f.client[method]=async symbol=>{assert.equal(symbol,'AAPL',method+' requested unrelated holding');return original(symbol);};
    }
    return f;
}

test('selected paper buy uses held snapshot valuation in preview and execution',async()=>{
    const f=await heldFixture();
    const plan=await f.service.preview({symbol:'AAPL',side:'buy'});
    assert.deepEqual(plan.blockers,[]);assert.equal(plan.managedValue,1000);assert.equal(plan.spendableCash,8000);
    await f.service.execute(plan.id,confirmation(plan));assert.equal(f.state.submitted.length,1);
});

for (const [reason,shares,equity] of [['oversized',5,2800],['below drift',18,9600]]) {
    test(`selected paper buy rejects ${reason} reviewed quantity after equity drops, before reservation`,async t=>{
        const f=await fixture();
        await f.service.savePolicy({...f.policy,maxOrderValue:100},1,'ENABLE PAPER INVESTING');
        f.state.positions=[{symbol:'AAPL',qty:String(shares),current_price:'100',side:'long',unrealized_pl:'0'}];
        f.store.ownership=async()=>[{symbol:'AAPL',delta_qty:shares,account_key:f.store.hash(f.account.id)}];
        const plan=await f.service.previewOperatorBuy('AAPL');
        assert.deepEqual(plan.blockers,[]);
        const reserve=t.mock.method(f.store,'reserveOrder');
        f.account.equity=String(equity);
        await assert.rejects(f.service.execute(plan.id,confirmation(plan)),{code:'PAPER_TARGET_CHANGED'});
        assert.equal(reserve.mock.callCount(),0);
        assert.equal(f.state.submitted.length,0);
    });
}

test('operator buys require an approved symbol and manual confirmation; racing previews reserve only once',async()=>{
    const f=await heldFixture();
    for(const invalid of ['',null,'OTHER']) await assert.rejects(f.service.previewOperatorBuy(invalid),{code:'PAPER_INVALID_TARGET'});
    const plans=await Promise.all([f.service.previewOperatorBuy('AAPL'),f.service.previewOperatorBuy('AAPL')]);
    assert.equal(f.state.submitted.length,0);
    await assert.rejects(f.service.execute(plans[0].id,{automatic:true}),{code:'PAPER_CONFIRMATION_REQUIRED'});
    await assert.rejects(f.service.execute(plans[0].id,{}),{code:'PAPER_CONFIRMATION_REQUIRED'});
    const results=await Promise.allSettled(plans.map(p=>f.service.execute(p.id,confirmation(p))));
    const winner=results.findIndex(r=>r.status==='fulfilled');assert.notEqual(winner,-1);
    assert.equal(results[1-winner].reason.code,'PAPER_STATE_CHANGED');
    assert.equal((await f.service.execute(plans[winner].id,confirmation(plans[winner]))).replayed,true);
    assert.equal(f.state.submitted.length,1);
});

test('selected buy fails closed on missing, invalid, overweight or changed held marks and ownership',async()=>{
    const f=await heldFixture(),opts={symbol:'AAPL',side:'buy'};
    const plan=await f.service.preview(opts),held=f.state.positions[0];
    for(const mark of [null,'',0,'bad','1e308']) {
        held.current_price=mark;
        await assert.rejects(f.service.preview(opts));await assert.rejects(f.service.execute(plan.id,confirmation(plan)));
    }
    held.current_price='210';assert.ok((await f.service.preview(opts)).blockers.some(b=>b.includes('sell adjustments')));
    await assert.rejects(f.service.execute(plan.id,confirmation(plan)));
    held.current_price='100';held.qty='9';assert.ok((await f.service.preview(opts)).blockers.some(b=>b.includes('quantity differs')));
    assert.equal(f.state.submitted.length,0);
});

test('paper configuration never consumes live keys, rejects live endpoints and disables sample trading',()=>{
    assert.equal(configuration({ALPACA_LIVE_API_KEY:'synthetic',ALPACA_LIVE_SECRET_KEY:'synthetic'}).configured,false);
    assert.throws(()=>configuration({ALPACA_TRADING_BASE_URL:'https://api.alpaca.markets'}),{code:'PAPER_ENDPOINT_INVALID'});
    assert.equal(configuration({SAMPLE_DATA:'1',ALPACA_API_KEY:'synthetic',ALPACA_API_SECRET:'synthetic',ALPACA_PAPER_ORDER_ENTRY_ENABLED:'true'}).tradingEnabled,false);
});
test('paper broker adapter uses only fixed paper/data hosts and server-side paper credentials',async()=>{
    const calls=[];
    const client=createPaperInvestingClient({env:{ALPACA_API_KEY:'synthetic-paper-key',ALPACA_API_SECRET:'synthetic-paper-secret',ALPACA_LIVE_API_KEY:'synthetic-live-key'},fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:true,status:200,json:async()=>({})};}});
    await client.getAccount();await client.getLatestQuote('AAPL');
    assert.equal(calls[0].url,'https://paper-api.alpaca.markets/v2/account');
    assert.equal(calls[1].url,'https://data.alpaca.markets/v2/stocks/AAPL/quotes/latest?feed=iex');
    assert.ok(calls.every(c=>c.options.headers['APCA-API-KEY-ID']==='synthetic-paper-key' && c.options.redirect==='error'));
});
test('long-term paper orders use reviewed allocation, durable identities and isolated ledgers',async()=>{
    const f=await fixture();const liveBefore=await liveStore.settings();const simBefore=await db.listSimTransactions(1);
    const plan=await f.service.preview();assert.deepEqual(plan.blockers,[]);assert.equal(plan.nextOrder.side,'buy');
    const [first,second]=await Promise.all([f.service.execute(plan.id,confirmation(plan)),f.service.execute(plan.id,confirmation(plan))]);
    assert.equal(first.order.id,second.order.id);assert.equal(f.state.submitted.length,1);
    assert.match(f.state.submitted[0].client_order_id,/^lt-paper-/);
    assert.equal(f.state.submitted[0].order_class,'simple');assert.equal(f.state.submitted[0].time_in_force,'day');
    assert.equal(f.state.submitted[0].stop_loss,undefined);assert.equal(f.state.submitted[0].take_profit,undefined);
    assert.deepEqual(await liveStore.settings(),liveBefore);assert.deepEqual(await db.listSimTransactions(1),simBefore);
    assert.equal((await f.service.overview()).configuration.accountBound,true);
    f.account.id='different-synthetic-account';assert.equal((await f.service.overview()).connected,false);
});
test('paper partial fills reconcile and long-term holdings are retained after market close',async()=>{
    const f=await fixture();const p=await f.service.preview();await f.service.execute(p.id,confirmation(p));
    const remote=[...f.state.orders.values()][0];remote.status='partially_filled';remote.filled_qty='2';remote.filled_avg_price='100';
    f.state.positions=[{symbol:'AAPL',qty:'2',side:'long',current_price:'100',unrealized_pl:'0'}];
    let view=await f.service.overview();assert.equal(view.positions[0].managedQty,2);assert.equal(view.orders[0].filledQty,2);
    remote.status='canceled';f.state.marketOpen=false;
    view=await f.service.overview();assert.equal(view.positions[0].managedQty,2);assert.ok(view.blockers.some(x=>x.includes('closed')));
    assert.equal(f.state.submitted.length,1);assert.equal(f.state.submitted[0].side,'buy');
});
test('unknown submissions remain reserved and retries never create another broker order',async()=>{
    const f=await fixture();f.state.unknown=true;const p=await f.service.preview();
    await assert.rejects(f.service.execute(p.id,confirmation(p)),{code:'PAPER_ORDER_UNKNOWN'});
    assert.equal((await f.store.orders())[0].status,'unknown');assert.ok((await f.service.preview()).blockers.some(x=>x.includes('uncertain')));
    await f.service.execute(p.id,confirmation(p));assert.equal(f.state.submitted.length,1);
});
test('legacy conflicts block previews, stale execution, ownership adoption and activation',async()=>{
    const f=await fixture();const plan=await f.service.preview();f.state.legacy=['Legacy paper positions need reconciliation.'];
    assert.deepEqual((await f.service.preview()).blockers,f.state.legacy);
    await assert.rejects(f.service.execute(plan.id,confirmation(plan)),{code:'PAPER_STATE_CHANGED'});
    await assert.rejects(f.service.adopt({}),{code:'PAPER_LEGACY_RECONCILIATION_REQUIRED'});
    await assert.rejects(f.service.savePolicy(f.policy,1,'ENABLE PAPER INVESTING'),{code:'PAPER_LEGACY_RECONCILIATION_REQUIRED'});
    assert.equal(f.state.submitted.length,0);await f.service.pause(1);assert.equal((await f.store.settings()).policy.paused,true);
});
test('paper confirms exact environment, cash constraints and explicit server gate',async()=>{
    const f=await fixture();const p=await f.service.preview();
    await assert.rejects(f.service.execute(p.id,{confirmation:'BUY AAPL LIVE'}),{code:'PAPER_CONFIRMATION_REQUIRED'});
    f.account.cash='1';await assert.rejects(f.service.execute(p.id,confirmation(p)),{code:'PAPER_CASH_CHANGED'});
    f.account.cash='10000';f.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED='false';
    await assert.rejects(f.service.execute(p.id,confirmation(p)),{code:'PAPER_GATE_CLOSED'});assert.equal(f.state.submitted.length,0);
});
test('simulator allocation import returns editable weights without copying trades',async()=>{
    const f=await fixture();const before=await f.store.orders();
    const sourceDb={getSimAccount:async id=>({id}),listSimTransactions:async()=>[{id:1,type:'deposit',amount:1000,date:'2025-01-01'},{id:2,type:'buy',symbol:'AAPL',shares:2,price:100,amount:200,fees:0,txn_date:'2025-01-02'}]};
    const service=createPaperLongTermInvesting({store:f.store,env:f.env,sourceDb,getSourceQuote:async symbol=>({symbol,price:100,timestamp:new Date().toISOString(),data_source:'yfinance'}),legacyGuard:async()=>[]});
    const draft=await service.simulatorDraft();assert.equal(draft.sourceAccountId,1);assert.deepEqual(draft.targets,[{symbol:'AAPL',weightPct:20}]);
    assert.deepEqual(await f.store.orders(),before);
});
test('legacy transition checks all execution owners and uncertain submissions',async()=>{
    const data={first:{mode:'disabled'},second:{mode:'disabled'},plans:[],v2plans:[],audits:[],submissions:[]};
    const deps={legacyV1:{getMonitorState:async()=>data.first,listPlans:async()=>data.plans},legacyV2:{getMonitorState:async()=>data.second,listNonterminalPlans:async()=>data.v2plans,listEntrySubmissions:async()=>data.submissions},auditStore:{listAlpacaPaperOrderAudits:async()=>data.audits}};
    assert.deepEqual(await legacyBlockers(deps),[]);
    data.first.mode='paper_execute';assert.equal((await legacyBlockers(deps)).length,1);data.first.mode='disabled';
    data.plans=[{state:'active'}];assert.equal((await legacyBlockers(deps)).length,1);data.plans=[];
    data.submissions=[{plan_id:1,event_key:'synthetic'}];assert.equal((await legacyBlockers(deps)).length,1);data.submissions=[];
    data.audits=[{status:'submission_unknown'}];assert.equal((await legacyBlockers(deps)).length,1);
    data.audits=[{status:'submission_not_found'}];assert.deepEqual(await legacyBlockers(deps),[]);
});
test('paper research evidence cannot collide with live decisions and automatic mode remains scoped',async()=>{
    const f=await fixture();const research=require('../services/research_store');
    const packet=await research.savePacket({symbol:'AAPL',generatedAt:new Date().toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}}});
    const analysis={packetId:packet.id,contentHash:packet.contentHash,strategyVersion:'synthetic-paper-v1',analyzedAt:new Date().toISOString(),model:'synthetic-model',
        claims:[{path:'data.info.price',value:100}],assumptions:['Synthetic allocation remains valid'],alternatives:['Wait and retain cash'],invalidation:'The thesis fails the next review.'};
    const key='shared-synthetic-decision';
    const liveAnalysis={...analysis,strategyVersion:'synthetic-live-v1'};
    await research.saveDecisionEvidence(key,liveAnalysis);
    const input={account_id:1,policyVersion:1,decisionKey:key,symbol:'AAPL',side:'buy',reason:'Synthetic investment thesis within approved targets.',analysis};
    const decision=await f.service.decision(input);assert.equal(decision.awaitingConfirmation,true);assert.equal(f.state.submitted.length,0);
    assert.equal((await f.store.decisions()).find(d=>d.decision_key===key).analysis.strategyVersion,'synthetic-paper-v1');
    const retained=await research.connection(c=>research.all(c,'SELECT analysis_json FROM research_decision_evidence WHERE decision_key=?',[key]));
    assert.equal(JSON.parse(retained[0].analysis_json).strategyVersion,'synthetic-live-v1');
    await assert.rejects(f.service.decision({...input,analysis:{...analysis,claims:[{path:'data.info.price',value:1}]}}),{code:'PAPER_RESEARCH_REQUIRED'});
    await f.service.savePolicy({...f.policy,executionMode:'automatic'},1,'ENABLE AUTOMATIC PAPER INVESTING');
    const result=await f.service.decision({...input,policyVersion:2,decisionKey:'automatic-paper-decision'});
    assert.ok(result.order);assert.equal(f.state.submitted.length,1);
    await f.service.decision({...input,policyVersion:2,decisionKey:'automatic-paper-decision'});assert.equal(f.state.submitted.length,1);
    await assert.rejects(f.service.decision({...input,account_id:2}),{code:'PAPER_INVALID_DECISION'});
});

test('paper automatic refusals report blockers instead of asking the operator to approve',async()=>{
    const f=await fixture();const research=require('../services/research_store');
    await f.service.savePolicy({...f.policy,executionMode:'automatic',targets:[...f.policy.targets,{symbol:'FXAIX',weightPct:10}]},1,'ENABLE AUTOMATIC PAPER INVESTING');
    const packet=await research.savePacket({symbol:'AAPL',generatedAt:new Date().toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}}});
    const analysis={packetId:packet.id,contentHash:packet.contentHash,strategyVersion:'paper-refusal-v1',analyzedAt:new Date().toISOString(),model:'synthetic-model',
        claims:[{path:'data.info.price',value:100}],assumptions:['Synthetic allocation remains valid'],alternatives:['Wait and retain cash'],invalidation:'The thesis fails the next review.'};
    const seen=[];
    const getAsset=f.client.getAsset;
    f.client.getAsset=async symbol=>{seen.push(symbol);if(symbol==='FXAIX')throw Object.assign(Error('not found'),{brokerStatus:404});return getAsset(symbol);};
    f.client.getLatestQuote=async symbol=>({symbol,quote:{bp:100,ap:102,bs:100,as:100,t:new Date().toISOString()}});
    const result=await f.service.decision({account_id:1,policyVersion:2,decisionKey:'paper-spread-refusal',symbol:'AAPL',side:'buy',reason:'Synthetic paper allocation review.',analysis});
    assert.equal(result.status,'blocked');assert.equal(result.awaitingConfirmation,false);
    assert.ok(result.blockers.some(b=>b.startsWith('AAPL:')));assert.deepEqual(seen,['AAPL']);assert.equal(f.state.submitted.length,0);
    const saved=(await f.service.overview()).decisions.find(d=>d.decision_key==='paper-spread-refusal');
    assert.equal(saved.status,'blocked');assert.deepEqual(saved.blockers,result.blockers);
});

test('paper policy keeps agent tags and the agent cap; operator may lower the cap',async()=>{
    const f=await fixture();
    const saved=await f.service.savePolicy({...f.policy,agentPicksMaxPct:20,targets:[{symbol:'AAPL',weightPct:20},{symbol:'QQQ',weightPct:5,source:'agent'}]},1,'ENABLE PAPER INVESTING');
    assert.equal(saved.policy.agentPicksMaxPct,20);
    assert.deepEqual(saved.policy.targets.find(t=>t.symbol==='QQQ'),{symbol:'QQQ',weightPct:5,source:'agent'});
    assert.deepEqual(saved.policy.targets.find(t=>t.symbol==='AAPL'),{symbol:'AAPL',weightPct:20});
    assert.equal((await f.store.settings()).policy.agentPicksMaxPct,20);
    for (const bad of [-1,101,Number.NaN,'5']) await assert.rejects(f.service.savePolicy({...f.policy,agentPicksMaxPct:bad},2,'ENABLE PAPER INVESTING'),{code:'PAPER_INVALID_POLICY'});
    await assert.rejects(f.service.savePolicy({...f.policy,targets:[{symbol:'AAPL',weightPct:20,source:'operator'}]},2,'ENABLE PAPER INVESTING'),{code:'PAPER_INVALID_POLICY'});
    const lowered=await f.service.savePolicy({...saved.policy,agentPicksMaxPct:0},2,'ENABLE PAPER INVESTING');
    assert.equal(lowered.policy.agentPicksMaxPct,0);
    assert.ok(lowered.policy.targets.some(t=>t.source==='agent'));
});

test('paper policy without the agent cap field reads as 0',async()=>{
    const f=await fixture();
    assert.equal((await f.store.settings()).policy.agentPicksMaxPct,0);
});

test('decision weights are validated, paper-only, stored and part of replay identity',async()=>{
    const f=await fixture();
    const base={decisionKey:'weight-check-0001',symbol:'VTI',side:'buy',reason:'Synthetic thesis for a new holding.',policyVersion:1};
    let n=0;
    for (const bad of ['5',-1,Number.NaN,101,null]) await assert.rejects(f.store.saveDecision({...base,decisionKey:'weight-bad-000'+(++n),targetWeightPct:bad}),{code:'PAPER_INVALID_DECISION'});
    assert.equal((await f.store.getDecision('weight-bad-0001')),null);
    const row=await f.store.saveDecision({...base,targetWeightPct:5});
    assert.equal(row.target_weight_pct,5);
    await assert.rejects(f.store.saveDecision({...base,targetWeightPct:6}),{code:'PAPER_DECISION_CONFLICT'});
    await assert.rejects(f.store.saveDecision({...base}),{code:'PAPER_DECISION_CONFLICT'});
    assert.equal((await f.store.saveDecision({...base,targetWeightPct:5})).target_weight_pct,5);
    assert.equal((await f.store.saveDecision({...base,decisionKey:'weight-none-0001'})).target_weight_pct,null);
    await assert.rejects(liveStore.saveDecision({...base,decisionKey:'live-weight-0001',targetWeightPct:5}),{code:'LIVE_INVALID_DECISION'});
});

async function craftPlan(f,{targetChange,symbol='VTI',side='buy'}){
    const s=await f.store.settings();
    return {id:require('node:crypto').randomUUID(),accountKey:f.store.hash(f.account.id),policyVersion:s.version,stateSequence:s.sequence,
        createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),decisionKey:null,
        nextOrder:{symbol,side,qty:1,limitPrice:100.13},targetChange};
}
async function policyEvents(){
    const conn=db.getDb();
    try { return await new Promise((resolve,reject)=>conn.all("SELECT detail_json FROM alpaca_paper_long_term_events WHERE action='policy_saved' ORDER BY id DESC LIMIT 3",(e,rows)=>e?reject(e):resolve(rows.map(r=>JSON.parse(r.detail_json))))); }
    finally { await new Promise(resolve=>conn.close(resolve)); }
}
const agentVti={symbol:'VTI',weightPct:5,source:'agent',actor:'agent',previous:null};

test('reservation applies the target change atomically and dispatch accepts only that version',async()=>{
    const f=await fixture();
    const plan=await craftPlan(f,{targetChange:agentVti});
    const reserved=await f.store.reserveOrder(plan,plan.nextOrder,{enabled:()=>true});
    const s=await f.store.settings();
    assert.equal(s.version,plan.policyVersion+1);
    assert.deepEqual(s.policy.targets.find(t=>t.symbol==='VTI'),{symbol:'VTI',weightPct:5,source:'agent'});
    const [saved]=await policyEvents(); assert.equal(saved.actor,'agent'); assert.equal(saved.planId,plan.id); assert.equal(saved.version,plan.policyVersion+1);
    const sent=await f.store.dispatchOrder(plan,reserved.order,{assertFresh:()=>{},submit:async()=>({id:'synthetic-broker',status:'new'})});
    assert.equal(sent.replayed,false); assert.ok(sent.settlement);
});

test('a refused dispatch restores the previous target; a newer operator save is never overwritten',async()=>{
    const f=await fixture();
    const plan=await craftPlan(f,{targetChange:agentVti});
    const reserved=await f.store.reserveOrder(plan,plan.nextOrder,{enabled:()=>true});
    const out=await f.store.dispatchOrder(plan,reserved.order,{assertFresh:()=>{throw Object.assign(new Error('expired'),{code:'PAPER_PLAN_EXPIRED'});},submit:async()=>{throw new Error('never sent');}});
    assert.equal(out.refused,true);
    let s=await f.store.settings();
    assert.equal(s.policy.targets.some(t=>t.symbol==='VTI'),false);
    assert.equal(s.version,plan.policyVersion+2);
    const [restored]=await policyEvents(); assert.equal(restored.actor,'system'); assert.equal(restored.reason,'order_not_sent');

    const second=await craftPlan(f,{targetChange:agentVti});
    const held=await f.store.reserveOrder(second,second.nextOrder,{enabled:()=>true});
    const operator={...(await f.store.settings()).policy,targets:[{symbol:'AAPL',weightPct:15}]};
    await f.service.savePolicy(operator,second.policyVersion+1,'ENABLE PAPER INVESTING');
    const refused=await f.store.dispatchOrder(second,held.order,{assertFresh:()=>{},submit:async()=>{throw new Error('never sent');}});
    assert.equal(refused.refused,true); assert.equal(refused.reason,'PAPER_DISPATCH_STATE_CHANGED');
    s=await f.store.settings();
    assert.equal(s.version,second.policyVersion+2);
    assert.deepEqual(s.policy.targets,[{symbol:'AAPL',weightPct:15}]);
});

test('an invalid applied policy rolls back the reservation',async()=>{
    const f=await fixture();
    await f.service.savePolicy({...f.policy,targets:[{symbol:'AAPL',weightPct:25},{symbol:'QQQ',weightPct:25},{symbol:'SPY',weightPct:25}]},1,'ENABLE PAPER INVESTING');
    const plan=await craftPlan(f,{targetChange:{...agentVti,weightPct:20}});
    const before=(await f.store.orders()).length;
    await assert.rejects(f.store.reserveOrder(plan,plan.nextOrder,{enabled:()=>true}),{code:'PAPER_INVALID_POLICY'});
    assert.equal((await f.store.settings()).version,plan.policyVersion);
    assert.equal((await f.store.orders()).length,before);
});

async function agentDecision(f,{key,symbol,side='buy',targetWeightPct,policyVersion}){
    const research=require('../services/research_store');
    const packet=await research.savePacket({symbol,generatedAt:new Date().toISOString(),accountScope:'research_only',eligibleForDecision:true,data:{info:{price:100}}});
    const analysis={packetId:packet.id,contentHash:packet.contentHash,strategyVersion:'synthetic-paper-v1',analyzedAt:new Date().toISOString(),model:'synthetic-model',
        claims:[{path:'data.info.price',value:100}],assumptions:['Synthetic thesis remains valid'],alternatives:['Wait and retain cash'],invalidation:'The thesis fails the next review.'};
    return {account_id:1,policyVersion,decisionKey:key,symbol,side,reason:'Synthetic thesis for an agent-sized holding.',analysis,...(targetWeightPct===undefined?{}:{targetWeightPct})};
}
async function automaticWithCap(f,cap=20){
    const saved=await f.service.savePolicy({...f.policy,executionMode:'automatic',agentPicksMaxPct:cap},1,'ENABLE AUTOMATIC PAPER INVESTING');
    return saved.version;
}

test('automatic agent pick buys an untargeted symbol and saves it as an agent target',async()=>{
    const f=await fixture();const version=await automaticWithCap(f);
    const r=await f.service.decision(await agentDecision(f,{key:'pick-new-0001',symbol:'VTI',targetWeightPct:10,policyVersion:version}));
    assert.ok(r.order); assert.equal(f.state.submitted.at(-1).symbol,'VTI'); assert.equal(f.state.submitted.at(-1).side,'buy');
    const s=await f.store.settings();
    assert.equal(s.version,version+1);
    assert.deepEqual(s.policy.targets.find(t=>t.symbol==='VTI'),{symbol:'VTI',weightPct:10,source:'agent'});
    const overview=await f.service.overview();
    assert.equal(overview.agentPicksUsedPct,10);
    assert.notEqual(overview.decisions.find(d=>d.decision_key==='pick-new-0001').status,'needs_reanalysis');
});

test('agent picks are refused in confirm mode, over the cap and on operator targets with the policy unchanged',async()=>{
    const f=await fixture();
    await assert.rejects(f.service.decision(await agentDecision(f,{key:'pick-confirm-0001',symbol:'VTI',targetWeightPct:5,policyVersion:1})),{code:'PAPER_AGENT_TARGET_MODE'});
    assert.equal(await f.store.getDecision('pick-confirm-0001'),null);
    const version=await automaticWithCap(f);
    await assert.rejects(f.service.decision(await agentDecision(f,{key:'pick-overcap-0001',symbol:'VTI',targetWeightPct:21,policyVersion:version})),{code:'PAPER_AGENT_TARGET_LIMIT'});
    await assert.rejects(f.service.decision(await agentDecision(f,{key:'pick-operator-001',symbol:'AAPL',targetWeightPct:22,policyVersion:version})),{code:'PAPER_AGENT_TARGET_OPERATOR'});
    assert.equal(await f.store.getDecision('pick-overcap-0001'),null);
    assert.equal((await f.store.settings()).version,version);
    assert.equal(f.state.submitted.length,0);
});

test('a blocked agent pick leaves no target',async()=>{
    const f=await fixture();const version=await automaticWithCap(f);
    const quote=f.client.getLatestQuote;
    f.client.getLatestQuote=async symbol=>symbol==='VTI'?{symbol,quote:{bp:100,ap:101,bs:100,as:100,t:new Date(Date.now()-100).toISOString()}}:quote(symbol);
    const r=await f.service.decision(await agentDecision(f,{key:'pick-blocked-0001',symbol:'VTI',targetWeightPct:10,policyVersion:version}));
    assert.equal(r.status,'blocked'); assert.equal(f.state.submitted.length,0);
    const s=await f.store.settings();
    assert.equal(s.version,version); assert.equal(s.policy.targets.some(t=>t.symbol==='VTI'),false);
});

test('plain decisions without a weight still require a saved target',async()=>{
    const f=await fixture();const version=await automaticWithCap(f);
    await assert.rejects(f.service.decision(await agentDecision(f,{key:'pick-plain-0001',symbol:'VTI',policyVersion:version})),{code:'PAPER_INVALID_TARGET'});
});

test('a stale operator save after an agent pick is refused and the pick survives',async()=>{
    const f=await fixture();const version=await automaticWithCap(f);
    const before=(await f.store.settings()).policy;
    await f.service.decision(await agentDecision(f,{key:'pick-stale-0001',symbol:'VTI',targetWeightPct:10,policyVersion:version}));
    await assert.rejects(f.service.savePolicy({...before,maxOrderValue:400},version,'ENABLE AUTOMATIC PAPER INVESTING'),{code:'PAPER_POLICY_CHANGED'});
    assert.ok((await f.store.settings()).policy.targets.some(t=>t.symbol==='VTI' && t.source==='agent'));
});
