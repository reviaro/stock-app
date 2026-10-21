'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../database/db');
const baseStore=require('../services/alpaca_live_store');
const {createLiveInvesting}=require('../services/alpaca_live_investing');
const {configuration,createLiveClient}=require('../services/alpaca_live_client');
const {authorizeApiRequest}=require('../services/api_capabilities');
const {createAuth}=require('../services/auth');
let serial=0;
before(()=>db.initDb());

async function fixture(mode='confirm') {
    const conn=db.getDb();
    await new Promise((resolve,reject)=>conn.run('UPDATE alpaca_live_settings SET version=0,policy_json=?,account_key=NULL WHERE id=1',[JSON.stringify(baseStore.DEFAULT_POLICY)],e=>e?reject(e):resolve()));
    await new Promise(r=>conn.close(r));
    // Real persistent store, isolated by account-specific order readers in this test file.
    const prefix='test-account-'+(++serial);
    const allOrders=baseStore.orders;
    const store={...baseStore,orders:async()=>(await allOrders()).filter(o=>o.account_key===baseStore.hash(prefix)),ownership:async()=>(await baseStore.ownership()).filter(o=>o.account_key===baseStore.hash(prefix))};
    // Reserve uses the real database-wide pending gate. Resolve fixture-owned outstanding
    // rows at setup, never bypassing that gate in the implementation.
    for (const row of await allOrders()) if (!baseStore.finalStatuses.has(row.status)) await baseStore.updateOrder(row.id,{status:'canceled'});
    const env={ALPACA_LIVE_API_KEY:'synthetic-live-key',ALPACA_LIVE_SECRET_KEY:'synthetic-live-secret',ALPACA_LIVE_ACCOUNT_ID:prefix,ALPACA_LIVE_TRADING_ENABLED:'true'};
    const account={id:prefix,currency:'USD',status:'ACTIVE',trading_blocked:false,account_blocked:false,cash:'10000',equity:'10000',non_marginable_buying_power:'10000'};
    const state={positions:[],open:[],orders:new Map(),submitted:[],clockOpen:true,price:100,badQuote:false,unknown:false,reject:false,cancelPending:false};
    const client={
        getAccount:async()=>({...account}),getClock:async()=>({is_open:state.clockOpen}),
        getPositions:async()=>structuredClone(state.positions),getOrders:async()=>structuredClone(state.open),
        getAsset:async symbol=>({symbol,class:'us_equity',status:'active',tradable:true,fractionable:true,exchange:'NASDAQ'}),
        getLatestQuote:async symbol=>({symbol,quote:{bp:state.price,ap:state.price+0.02,bs:100,as:100,t:state.badQuote?'2020-01-01T00:00:00Z':new Date(Date.now()-100).toISOString()}}),
        getOrderByClientId:async id=>state.orders.get(id)||null,
        submit:async order=>{
            state.submitted.push(order);
            if (state.unknown) throw new Error('synthetic transport failure');
            if (state.reject) throw Object.assign(new Error('synthetic refusal'),{code:'LIVE_BROKER_REFUSED',brokerStatus:403});
            const result={...order,id:'synthetic-order-'+state.submitted.length,status:'new',filled_qty:'0',filled_avg_price:null};
            state.orders.set(order.client_order_id,result); return result;
        },
        cancel:async id=>{for (const remote of state.orders.values()) if (remote.id===id) remote.status=state.cancelPending?'pending_cancel':'canceled';},
    };
    const policy={...baseStore.DEFAULT_POLICY,budget:10000,maxOrderValue:500,paused:false,executionMode:mode,targets:[{symbol:'AAPL',weightPct:20}]};
    await store.savePolicy(policy,0,mode==='automatic'?'ENABLE AUTOMATIC LIVE INVESTING':'ENABLE LIVE INVESTING');
    const service=createLiveInvesting({store,env,clientFactory:()=>client});
    return {store,env,account,state,client,policy,service};
}
const confirms=p=>({confirmation:p.nextOrder.side.toUpperCase()+' '+p.nextOrder.symbol+' LIVE'});

test('credentials and live endpoint are isolated from paper and sample mode never connects',async()=>{
    assert.equal(configuration({ALPACA_API_KEY:'paper',ALPACA_API_SECRET:'paper'}).configured,false);
    assert.throws(()=>createLiveClient({env:{ALPACA_API_KEY:'paper',ALPACA_API_SECRET:'paper'}}),{code:'LIVE_NOT_CONFIGURED'});
    assert.throws(()=>configuration({ALPACA_LIVE_TRADING_BASE_URL:'https://paper-api.alpaca.markets'}),{code:'LIVE_ENDPOINT_INVALID'});
    assert.equal(configuration({SAMPLE_DATA:'1',ALPACA_LIVE_API_KEY:'x',ALPACA_LIVE_SECRET_KEY:'x',ALPACA_LIVE_TRADING_ENABLED:'true'}).configured,false);
});
test('live client sends credentials only to fixed HTTPS hosts, rejects redirects and redacts broker errors',async()=>{
    const calls=[];const client=createLiveClient({env:{ALPACA_LIVE_API_KEY:'fake-live',ALPACA_LIVE_SECRET_KEY:'fake-secret'},fetchImpl:async(url,options)=>{calls.push({url,options});return {ok:false,status:403,json:async()=>({private:'never return raw body'})};}});
    await assert.rejects(client.getAccount(),e=>e.code==='LIVE_BROKER_REFUSED'&&!e.message.includes('never return'));
    assert.equal(calls[0].url,'https://api.alpaca.markets/v2/account');assert.equal(calls[0].options.redirect,'error');
});
test('new live store starts paused, unfunded, with confirmation required',async()=>{
    const f=await fixture();
    assert.equal(baseStore.DEFAULT_POLICY.paused,true);assert.equal(baseStore.DEFAULT_POLICY.budget,0);assert.equal(baseStore.DEFAULT_POLICY.executionMode,'confirm');
    assert.equal((await f.service.overview()).configuration.environment,'live');
});
test('reviewed DAY limit order is durable, retry-safe and contains no caller-supplied order fields',async()=>{
    const f=await fixture();const plan=await f.service.preview();assert.deepEqual(plan.blockers,[]);assert.equal(plan.accountKey,undefined);
    const first=await f.service.execute(plan.id,confirms(plan));const second=await f.service.execute(plan.id,confirms(plan));
    assert.equal(second.replayed,true);assert.equal(first.order.id,second.order.id);assert.equal(f.state.submitted.length,1);
    assert.equal(f.state.submitted[0].time_in_force,'day');assert.equal(f.state.submitted[0].extended_hours,false);assert.equal(first.order.filledQty,0);
    assert.equal(first.order.broker_id,undefined);assert.equal(first.order.client_order_id,undefined);
});
test('concurrent confirmations reserve at most one broker submission',async()=>{
    const f=await fixture();const p=await f.service.preview();await Promise.allSettled([f.service.execute(p.id,confirms(p)),f.service.execute(p.id,confirms(p))]);assert.equal(f.state.submitted.length,1);
});
test('two different previews cannot both trade a stale snapshot even if the first order fills immediately',async()=>{
    const f=await fixture();const first=await f.service.preview();const second=await f.service.preview();
    const submit=f.client.submit;
    f.client.submit=async order=>{const remote=await submit(order);remote.status='filled';remote.filled_qty=order.qty;remote.filled_avg_price=order.limit_price;return remote;};
    await Promise.allSettled([f.service.execute(first.id,confirms(first)),f.service.execute(second.id,confirms(second))]);
    assert.equal(f.state.submitted.length,1);
});
test('a pause between broker validation and reservation prevents the broker write',async()=>{
    const f=await fixture();const p=await f.service.preview();const reserve=f.store.reserveOrder;
    f.store.reserveOrder=async(...args)=>{await f.store.savePolicy({...f.policy,paused:true},1,'');return reserve(...args);};
    await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_GATE_CLOSED'});assert.equal(f.state.submitted.length,0);
});
test('expired previews cannot submit even if account and quotes remain valid',async()=>{
    const f=await fixture();let offset=0;const service=createLiveInvesting({store:f.store,env:f.env,clientFactory:()=>f.client,now:()=>new Date(Date.now()+offset)});
    const p=await service.preview();offset=61000;await assert.rejects(service.execute(p.id,confirms(p)),{code:'LIVE_PLAN_EXPIRED'});assert.equal(f.state.submitted.length,0);
});
test('a market close during final validation prevents a queued after-hours order',async()=>{
    const f=await fixture();const p=await f.service.preview();let clocks=0;
    f.client.getClock=async()=>({is_open:++clocks===1});
    await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_MARKET_CLOSED'});assert.equal(f.state.submitted.length,0);
});
test('unknown submission persists and blocks every new order without retrying',async()=>{
    const f=await fixture();f.state.unknown=true;const p=await f.service.preview();await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_ORDER_UNKNOWN'});
    assert.equal((await f.store.orders())[0].status,'unknown');const next=await f.service.preview();assert.ok(next.blockers.some(s=>s.includes('uncertain')));
    await f.service.execute(p.id,confirms(p));assert.equal(f.state.submitted.length,1);
});
test('an acknowledgement lost after acceptance is recovered by the same client order ID',async()=>{
    const f=await fixture();const submit=f.client.submit;f.client.submit=async order=>{await submit(order);throw new Error('lost response');};
    const p=await f.service.preview();const result=await f.service.execute(p.id,confirms(p));assert.equal(result.order.status,'new');assert.equal(f.state.submitted.length,1);
});
test('a definitive broker rejection is recorded rather than represented as submitted',async()=>{
    const f=await fixture();f.state.reject=true;const p=await f.service.preview();await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_ORDER_REJECTED'});assert.equal((await f.store.orders())[0].status,'rejected');
});
test('partial fills are reconciled, pending cancel is not terminal, unrelated shares stay protected',async()=>{
    const f=await fixture();const p=await f.service.preview();const result=await f.service.execute(p.id,confirms(p));
    const remote=[...f.state.orders.values()][0];remote.status='partially_filled';remote.filled_qty='2';remote.filled_avg_price='100';
    f.state.positions=[{symbol:'AAPL',qty:'2',side:'long',current_price:'100',unrealized_pl:'0'}];
    let view=await f.service.overview();assert.equal(view.positions[0].managedQty,2);assert.equal(view.orders[0].filledQty,2);
    f.state.cancelPending=true;await f.service.cancel(result.order.id);view=await f.service.overview();assert.equal(view.orders[0].status,'pending_cancel');
    assert.ok((await f.service.preview()).blockers.some(s=>s.includes('reconciliation')));
    f.state.cancelPending=false;await f.service.cancel(result.order.id);assert.equal((await f.service.overview()).orders[0].status,'canceled');
});
test('external holdings cannot be acquired as owned shares or sold by copying simulator targets',async()=>{
    const f=await fixture();f.state.positions=[{symbol:'AAPL',qty:'10',side:'long',current_price:'100',unrealized_pl:'0'}];const p=await f.service.preview();assert.equal(p.nextOrder,null);assert.ok(p.blockers.some(s=>s.includes('not fully owned')));assert.equal(f.state.submitted.length,0);
});
test('closed market, stale or crossed quotes and existing broker orders block execution',async()=>{
    const f=await fixture();f.state.clockOpen=false;assert.ok((await f.service.preview()).blockers.some(s=>s.includes('closed')));
    f.state.clockOpen=true;f.state.badQuote=true;assert.ok((await f.service.preview()).blockers.some(s=>s.includes('fresh')));
    f.state.badQuote=false;f.state.open=[{id:'unrelated'}];assert.ok((await f.service.preview()).blockers.some(s=>s.includes('open broker orders')));
});
test('target allocation follows funded capital below the ceiling and excludes external holdings',async()=>{
    const f=await fixture();f.account.equity='9000';f.account.cash='8000';
    let p=await f.service.preview();assert.equal(p.allocationCapital,9000);assert.equal(p.rows[0].targetValue,1800);assert.deepEqual(p.blockers,[]);
    f.state.positions=[{symbol:'MSFT',qty:'10',side:'long',current_price:'100',unrealized_pl:'0'}];
    p=await f.service.preview();assert.equal(p.unmanagedValue,1000);assert.equal(p.allocationCapital,8000);assert.equal(p.rows[0].targetValue,1600);assert.deepEqual(p.blockers,[]);
});
test('confirmation, policy revision, cash, price, server gate and account identity are revalidated',async()=>{
    const f=await fixture();const p=await f.service.preview();await assert.rejects(f.service.execute(p.id,{confirmation:'BUY'}),{code:'LIVE_CONFIRMATION_REQUIRED'});
    f.state.price=110;await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_PRICE_CHANGED'});f.state.price=100;
    f.account.cash='1';await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_CASH_CHANGED'});f.account.cash='10000';
    f.env.ALPACA_LIVE_TRADING_ENABLED='false';await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_GATE_CLOSED'});f.env.ALPACA_LIVE_TRADING_ENABLED='true';
    f.env.ALPACA_LIVE_ACCOUNT_ID='other';await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_ACCOUNT_MISMATCH'});f.env.ALPACA_LIVE_ACCOUNT_ID=f.account.id;
    await f.store.savePolicy({...f.policy,paused:true},1,'');await assert.rejects(f.service.execute(p.id,confirms(p)),{code:'LIVE_STATE_CHANGED'});assert.equal(f.state.submitted.length,0);
});
test('immutable intent and reviewed plans cannot be changed or deleted',async()=>{
    const f=await fixture();const p=await f.service.preview();await f.service.execute(p.id,confirms(p));
    const c=db.getDb();const run=sql=>new Promise((r,j)=>c.run(sql,e=>e?j(e):r()));
    await assert.rejects(run("UPDATE alpaca_live_orders SET qty=qty+1"),/immutable/);await assert.rejects(run('DELETE FROM alpaca_live_plans'),/retained/);await new Promise(r=>c.close(r));
});
test('Strategy-agent confirmation mode records analysis and waits; mode switch never grants policy access',async()=>{
    const f=await fixture();const result=await f.service.decision({account_id:1,policyVersion:1,decisionKey:'confirm-decision-'+serial,symbol:'AAPL',side:'buy',reason:'Synthetic approved allocation analysis.'});
    assert.equal(result.awaitingConfirmation,true);assert.equal(f.state.submitted.length,0);assert.equal((await f.store.decisions()).length>0,true);
    assert.throws(()=>createAuth({username:'operator',passwordHash:'x',sessionSecret:'s'.repeat(32),alpacaLiveInvestingToken:'x'.repeat(32),apiToken:'x'.repeat(32)}),/distinct/);
});
test('Strategy-agent automatic mode executes only approved allocation drift and deduplicates decision keys',async()=>{
    const f=await fixture('automatic');const input={account_id:1,policyVersion:1,decisionKey:'automatic-decision-'+serial,symbol:'AAPL',side:'buy',reason:'Synthetic approved long-term allocation.'};
    const first=await f.service.decision(input);const replay=await f.service.decision(input);assert.ok(first.order);assert.equal(replay.replayed,true);assert.equal(f.state.submitted.length,1);
    await assert.rejects(f.service.decision({...input,reason:'Changed intent must never reuse a key.'}),{code:'LIVE_DECISION_CONFLICT'});
});
test('Your agent cannot request an unapproved symbol, a sell of unowned shares, or another sleeve',async()=>{
    const f=await fixture('automatic');const d={account_id:1,policyVersion:1,decisionKey:'unapproved-'+serial,symbol:'MSFT',side:'buy',reason:'Synthetic unapproved allocation.'};
    const result=await f.service.decision(d);assert.ok(result.plan.blockers.length);assert.equal(f.state.submitted.length,0);
    await assert.rejects(f.service.decision({...d,account_id:2}),{code:'LIVE_INVALID_DECISION'});
});
test('risk policy rejects over-allocation, duplicate symbols, invalid numbers and silent automatic enablement',async()=>{
    const f=await fixture();assert.throws(()=>baseStore.validatePolicy({...f.policy,targets:[{symbol:'AAPL',weightPct:95}]}),{code:'LIVE_INVALID_POLICY'});
    assert.throws(()=>baseStore.validatePolicy({...f.policy,budget:NaN}),{code:'LIVE_INVALID_POLICY'});
    await assert.rejects(f.store.savePolicy({...f.policy,executionMode:'automatic'},1,'ENABLE LIVE INVESTING'),{code:'LIVE_CONFIRMATION_REQUIRED'});
});
test('scoped live agent can request decisions and research, but cannot mutate policy or another broker path',()=>{
    const allowed=(role,method,path,body={},query={})=>{let next=false;authorizeApiRequest({auth:{role,type:'bearer'},method,path,body,query},{status(){return this;},json(){return this;}},()=>{next=true;});return next;};
    assert.equal(allowed('alpaca-long-term-agent','POST','/alpaca-live/decisions',{account_id:1}),true);
    for (const [method,path,body] of [['PUT','/alpaca-live/policy',{}],['POST','/alpaca-live/execute',{}],['POST','/alpaca-paper/orders',{}],['POST','/simulator/trade',{account_id:1}],['POST','/alpaca-live/decisions',{account_id:2}]]) assert.equal(allowed('alpaca-long-term-agent',method,path,body),false);
    assert.equal(allowed('reader','GET','/alpaca-live/overview'),false);assert.equal(allowed('simulator-agent','GET','/alpaca-live/overview'),false);
});
test('ownership adoption requires a paused policy, current broker quantity, and exact confirmation',async()=>{
    const f=await fixture();f.state.positions=[{symbol:'AAPL',qty:'3',side:'long',current_price:'100',unrealized_pl:'0'}];
    const input={symbol:'AAPL',qty:3,reason:'Synthetic review of pre-existing holdings.',confirmation:'MANAGE AAPL 3 LIVE'};
    await assert.rejects(f.service.adopt(input),{code:'LIVE_STATE_CHANGED'});
    await f.store.savePolicy({...f.policy,paused:true},1,'');
    await assert.rejects(f.service.adopt({...input,qty:4,confirmation:'MANAGE AAPL 4 LIVE'}),{code:'LIVE_STATE_CHANGED'});
    await assert.rejects(f.service.adopt({...input,confirmation:'MANAGE'}),{code:'LIVE_CONFIRMATION_REQUIRED'});
    await f.service.adopt(input);assert.equal((await f.service.overview()).positions[0].managedQty,3);
    const replay=await f.service.adopt(input);assert.equal(replay.replayed,true);
    assert.equal(f.state.submitted.length,0);
});
test('sells use confirmed ownership, include fully removed targets, and precede buys',async()=>{
    const f=await fixture();f.state.positions=[{symbol:'AAPL',qty:'3',side:'long',current_price:'100',unrealized_pl:'0'}];
    await f.store.savePolicy({...f.policy,paused:true},1,'');
    await f.service.adopt({symbol:'AAPL',qty:3,reason:'Synthetic holdings adopted for a rebalance.',confirmation:'MANAGE AAPL 3 LIVE'});
    const current=await f.store.settings();
    await f.store.savePolicy({...f.policy,targets:[{symbol:'MSFT',weightPct:20}]},current.version,'ENABLE LIVE INVESTING');
    const p=await f.service.preview();assert.equal(p.nextOrder.side,'sell');assert.equal(p.nextOrder.symbol,'AAPL');assert.ok(p.nextOrder.qty<=3);
    const buy=await f.service.preview({symbol:'MSFT',side:'buy'});assert.ok(buy.blockers.some(s=>s.includes('sell adjustments')));
    await f.service.execute(p.id,confirms(p));assert.equal(f.state.submitted[0].side,'sell');
});
test('confirmed-order mode is re-read inside the submission transaction',async()=>{
    const f=await fixture('automatic');const p=await f.service.preview();
    await f.store.savePolicy({...f.policy,executionMode:'confirm'},1,'ENABLE LIVE INVESTING');
    await assert.rejects(f.service.execute(p.id,{automatic:true}),{code:'LIVE_STATE_CHANGED'});assert.equal(f.state.submitted.length,0);
});
test('fractional sell sizing never rounds above the actual nine-decimal broker quantity',async()=>{
    const f=await fixture();const qty=1.999999999;
    f.state.positions=[{symbol:'AAPL',qty:String(qty),side:'long',current_price:'100',unrealized_pl:'0'}];
    await f.store.savePolicy({...f.policy,paused:true},1,'');
    await f.service.adopt({symbol:'AAPL',qty,reason:'Synthetic fractional position ownership review.',confirmation:`MANAGE AAPL ${qty} LIVE`});
    const state=await f.store.settings();await f.store.savePolicy({...f.policy,targets:[{symbol:'MSFT',weightPct:20}]},state.version,'ENABLE LIVE INVESTING');
    const p=await f.service.preview();assert.ok(p.nextOrder.qty<=qty);assert.equal(p.nextOrder.qty,1.999999);
    await f.service.execute(p.id,confirms(p));assert.ok(Number(f.state.submitted[0].qty)<=qty);
});
test('simulator import is an editable weights draft with no automatic mutual-fund mapping or live transaction',async()=>{
    const f=await fixture();
    const sourceDb={getSimAccount:async()=>({id:1}),listSimTransactions:async()=>[
        {type:'deposit',amount:1000}, {type:'buy',symbol:'FXAIX',shares:2,price:100,amount:200,fees:0,txn_date:'2026-01-01'},
    ]};
    const service=createLiveInvesting({store:f.store,env:f.env,clientFactory:()=>f.client,sourceDb,getSourceQuote:async symbol=>({symbol,price:100,timestamp:new Date().toISOString(),data_source:'yfinance'})});
    const draft=await service.simulatorDraft();assert.equal(draft.targets[0].symbol,'FXAIX');assert.equal(draft.targets[0].weightPct,20);assert.equal(f.state.submitted.length,0);
    assert.deepEqual((await f.store.settings()).policy.targets,[{symbol:'AAPL',weightPct:20}]);
});
test('additive migration is repeatable and preserves existing simulator history, paper controls and live policy',async()=>{
    const f=await fixture();
    const c=db.getDb();const all=sql=>new Promise((r,j)=>c.all(sql,(e,rows)=>e?j(e):r(rows)));
    const tables=['sim_transactions','alpaca_dt_v2_monitor_state','alpaca_monitor_state','alpaca_live_settings'];
    const before=Object.fromEntries(await Promise.all(tables.map(async t=>[t,await all('SELECT * FROM '+t)])));
    await new Promise(r=>c.close(r));await db.initDb();await db.initDb();
    const after=db.getDb();
    for (const t of tables) {
        const rows=await new Promise((r,j)=>after.all('SELECT * FROM '+t,(e,v)=>e?j(e):r(v)));
        assert.deepEqual(rows,before[t]);
    }
    await new Promise(r=>after.close(r));assert.equal((await f.store.settings()).version,1);
});
