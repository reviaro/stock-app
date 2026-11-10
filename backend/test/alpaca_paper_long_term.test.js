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
