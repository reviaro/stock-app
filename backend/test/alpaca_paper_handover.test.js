'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const db=require('../database/db');
const store=require('../services/alpaca_paper_long_term_store');
const {createPaperLongTermInvesting,legacyBlockers}=require('../services/alpaca_paper_long_term');
let serial=0;
const remoteOrders=new Map();
const all=(sql,args=[])=>{const c=db.getDb();return new Promise((resolve,reject)=>c.all(sql,args,(e,rows)=>c.close(()=>e?reject(e):resolve(rows))));};
const run=(sql,args=[])=>{const c=db.getDb();return new Promise((resolve,reject)=>c.run(sql,args,function(e){const id=this.lastID;c.close(()=>e?reject(e):resolve(id));}));};
before(()=>db.initDb());
async function fixture(version) {
    const symbol='SYN'+String.fromCharCode(65+serial++),parent='synthetic-parent-'+symbol,stop='synthetic-stop-'+symbol,target='synthetic-target-'+symbol;
    let id;
    if(version==='v1') {
        id=await run(`INSERT INTO alpaca_day_trade_plans(symbol,setup,catalyst,thesis,invalidation,planned_entry_low,planned_entry_high,planned_stop,planned_target,planned_qty,planned_risk_dollars,planned_reward_risk,planned_account_risk_pct,exit_deadline,state,filled_entry_qty,avg_entry_price,entry_parent_broker_order_id,protective_stop_broker_order_id,protective_target_broker_order_id) VALUES (?,'synthetic','synthetic','synthetic','synthetic',99,101,95,110,2,10,2,1,'2025-01-01','active',2,100,?,?,?)`,[symbol,parent,stop,target]);
        await run("INSERT INTO alpaca_paper_fills(activity_id,broker_order_id,plan_id,symbol,side,qty,price,executed_at,fill_type,source) VALUES (?,?,?,?,'buy',2,100,'2025-01-01','fill','rest_reconciliation')",['synthetic-fill-'+symbol,parent,id,symbol]);
    } else {
        id=await run(`INSERT INTO alpaca_dt_v2_plans(client_order_id,symbol,setup,catalyst,thesis,invalidation,planned_qty,planned_entry_price,planned_stop,planned_target,planned_risk_dollars,exit_deadline,state,filled_entry_qty,avg_entry_price,parent_order_id,stop_order_id,target_order_id) VALUES (?,?,'synthetic','synthetic','synthetic','synthetic',2,100,95,110,10,'2025-01-01','active',2,100,?,?,?)`,['synthetic-client-'+symbol,symbol,parent,stop,target]);
        await run("INSERT INTO alpaca_dt_v2_fills(execution_id,order_id,plan_id,symbol,side,qty,price,role,executed_at,source) VALUES (?,?,?,?,'buy',2,100,'entry','2025-01-01','rest')",['synthetic-fill-'+symbol,parent,id,symbol]);
    }
    remoteOrders.set(parent,{id:parent,symbol,side:'buy',status:'filled',filled_qty:'2',legs:[{id:stop,symbol,side:'sell',status:'canceled',filled_qty:'0'},{id:target,symbol,side:'sell',status:'canceled',filled_qty:'0'}]});
    for(const leg of remoteOrders.get(parent).legs)remoteOrders.set(leg.id,leg);
    const state={accountId:'synthetic-paper-account',open:[],qty:2,elapsed:0};
    const client={getAccount:async()=>({id:state.accountId,currency:'USD',status:'ACTIVE',trading_blocked:false,account_blocked:false}),
        getPositions:async()=>[{symbol,qty:String(state.qty),side:'long'}],getOrders:async()=>state.open,
        getAsset:async()=>({symbol,class:'us_equity',status:'active',tradable:true,exchange:'NASDAQ'}),
        getOrder:async id=>structuredClone(remoteOrders.get(id)),getOrderByClientOrderId:async key=>({found:remoteOrders.has(key),order:remoteOrders.get(key)||null})};
    const env={ALPACA_API_KEY:'synthetic-paper-key',ALPACA_API_SECRET:'synthetic-paper-secret'};
    const service=createPaperLongTermInvesting({env,clientFactory:()=>client,now:()=>new Date(Date.now()+state.elapsed)});
    return {symbol,parent,stop,target,version,id,state,client,env,service,input:{symbol,qty:2,reason:'Transfer these existing holdings to the long-term strategy.',confirmation:`TRANSFER ${symbol} 2 PAPER`},
        planTable:version==='v1'?'alpaca_day_trade_plans':'alpaca_dt_v2_plans',fillTable:version==='v1'?'alpaca_paper_fills':'alpaca_dt_v2_fills'};
}
for(const version of ['v1','v2'])test(`${version} ownership transfer preserves fills and P&L, requires settled matching broker evidence and commits atomically`,async()=>{
    const f=await fixture(version);
    const plansBefore=await all(`SELECT * FROM ${f.planTable} WHERE id=?`,[f.id]);
    const fillsBefore=await all(`SELECT * FROM ${f.fillTable} WHERE plan_id=?`,[f.id]);
    const ownershipBefore=await store.ownership();
    await assert.rejects(f.service.legacyHandover({...f.input,confirmation:'MANAGE'}),{code:'PAPER_CONFIRMATION_REQUIRED'});
    f.state.open=[{id:'synthetic-open'}];await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});f.state.open=[];
    remoteOrders.get(f.stop).status='new';await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});remoteOrders.get(f.stop).status='canceled';
    remoteOrders.get(f.parent).filled_qty='1';await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});remoteOrders.get(f.parent).filled_qty='2';
    remoteOrders.get(f.parent).status='pending_cancel';await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});remoteOrders.get(f.parent).status='filled';
    const originalOrder=f.client.getOrder;f.client.getOrder=async id=>{f.state.elapsed=11000;return originalOrder(id);};
    await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});f.client.getOrder=originalOrder;f.state.elapsed=0;
    let reads=0;const originalPositions=f.client.getPositions;
    f.client.getPositions=async()=>{if(++reads>1)return [{symbol:f.symbol,qty:'3',side:'long'}];return originalPositions();};
    await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});f.client.getPositions=originalPositions;
    await run("CREATE TRIGGER synthetic_abort_transfer BEFORE INSERT ON alpaca_paper_long_term_legacy_handovers BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    await assert.rejects(f.service.legacyHandover(f.input),/synthetic failure/);
    assert.deepEqual(await store.ownership(),ownershipBefore);await run('DROP TRIGGER synthetic_abort_transfer');
    const result=await f.service.legacyHandover(f.input);assert.equal(result.ownedQty,2);assert.deepEqual(result.transferredPlans,[{version,id:f.id}]);
    assert.deepEqual(await all(`SELECT * FROM ${f.planTable} WHERE id=?`,[f.id]),plansBefore);
    assert.deepEqual(await all(`SELECT * FROM ${f.fillTable} WHERE plan_id=?`,[f.id]),fillsBefore);
    assert.equal((await store.orders()).length,0);assert.deepEqual(await legacyBlockers(),[]);
    const unrelated={...plansBefore[0],state:'closed'};delete unrelated.id;
    if(version==='v2')unrelated.client_order_id='unrelated-synthetic-'+f.symbol;
    await run(`INSERT INTO ${f.planTable} (${Object.keys(unrelated).join(',')}) VALUES (${Object.keys(unrelated).map(()=>'?').join(',')})`,Object.values(unrelated));
    assert.deepEqual(await legacyBlockers(),[]);
    await assert.rejects(run('UPDATE alpaca_paper_long_term_legacy_handovers SET transferred_qty=1 WHERE symbol=?',[f.symbol]),/immutable/);
    const stateValue=version==='v1'?'exit_pending':'attention_required';
    await run(`UPDATE ${f.planTable} SET state=? WHERE id=?`,[stateValue,f.id]);assert.deepEqual(await legacyBlockers(),[]);
    await run(`UPDATE ${f.fillTable} SET price=101 WHERE plan_id=?`,[f.id]);assert.ok((await legacyBlockers()).some(x=>x.includes('changed after ownership transfer')));
    await run(`UPDATE ${f.fillTable} SET price=100 WHERE plan_id=?`,[f.id]);assert.deepEqual(await legacyBlockers(),[]);
    await run(`UPDATE ${f.planTable} SET state='closed' WHERE id=?`,[f.id]);
    await run(`UPDATE ${f.fillTable} SET price=101 WHERE plan_id=?`,[f.id]);assert.ok((await legacyBlockers()).some(x=>x.includes('changed after ownership transfer')));
    await run(`UPDATE ${f.fillTable} SET price=100 WHERE plan_id=?`,[f.id]);assert.deepEqual(await legacyBlockers(),[]);
    await assert.rejects(f.service.legacyHandover(f.input),{code:'PAPER_HANDOVER_BLOCKED'});
});
test('legacy reconciliation refreshes settled raw audits and refuses a changed bound account before mutation',async()=>{
    const f=await fixture('v2');
    await db.createAlpacaPaperOrderAudit({idempotency_key:f.parent,symbol:f.symbol,side:'buy',qty:2,order_type:'limit',time_in_force:'day',limit_price:100,status:'accepted'});
    f.state.accountId='wrong-synthetic-account';
    await assert.rejects(f.service.legacyReconcile(),{code:'PAPER_ACCOUNT_MISMATCH'});
    assert.equal((await db.getAlpacaPaperOrderAuditByIdempotencyKey(f.parent)).status,'accepted');
    f.state.accountId='synthetic-paper-account';
    const result=await f.service.legacyHandover(f.input);assert.equal(result.ownedQty,2);
    assert.equal((await db.getAlpacaPaperOrderAuditByIdempotencyKey(f.parent)).status,'filled');
    assert.deepEqual(await legacyBlockers(),[]);
});
