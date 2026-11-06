'use strict';
const {test,before}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const db=require('../database/db');
const {reconcileLegacyV1Plans}=require('../services/alpaca_paper_legacy_reconciliation');
const {createPaperLongTermInvesting}=require('../services/alpaca_paper_long_term');
const paperStore=require('../services/alpaca_paper_long_term_store');
let serial=0;
const all=(sql,args=[])=>{const c=db.getDb();return new Promise((resolve,reject)=>c.all(sql,args,(error,rows)=>c.close(()=>error?reject(error):resolve(rows))));};
const run=(sql,args=[])=>{const c=db.getDb();return new Promise((resolve,reject)=>c.run(sql,args,function(error){const id=this.lastID;c.close(()=>error?reject(error):resolve(id));}));};
before(()=>db.initDb());
async function fixture({fills=false,entryQty=2}={}) {
    const symbol='SYN'+String.fromCharCode(65+serial++),parent='synthetic-parent-'+symbol,stop='synthetic-stop-'+symbol,target='synthetic-target-'+symbol,key='synthetic-client-'+symbol;
    await run("UPDATE alpaca_monitor_state SET mode='disabled',submission_lease_holder=NULL,submission_lease_expires_at=NULL WHERE id=1");
    await run("UPDATE alpaca_dt_v2_monitor_state SET mode='disabled' WHERE id=1");
    await run('UPDATE alpaca_paper_long_term_settings SET version=0,sequence=0,account_key=NULL,policy_json=? WHERE id=1',[JSON.stringify(paperStore.DEFAULT_POLICY)]);
    const id=await run(`INSERT INTO alpaca_day_trade_plans(symbol,setup,catalyst,thesis,invalidation,planned_entry_low,planned_entry_high,planned_stop,planned_target,planned_qty,planned_risk_dollars,planned_reward_risk,planned_account_risk_pct,exit_deadline,state,filled_entry_qty,filled_exit_qty,entry_parent_broker_order_id,protective_stop_broker_order_id,protective_target_broker_order_id,realized_pnl,realized_r) VALUES (?,'synthetic','synthetic','synthetic','synthetic',99,101,95,110,2,10,2,1,'2025-01-01','entry_pending',0,0,?,?,?,99,9)`,[symbol,parent,stop,target]);
    await db.createAlpacaPaperOrderAudit({idempotency_key:key,client_order_id:key,plan_id:id,symbol,execution_epoch:'day_trading',leg_role:'entry',side:'buy',qty:2,order_class:'bracket',order_type:'limit',time_in_force:'day',limit_price:100,status:'filled'});
    await db.updateAlpacaPaperOrderAudit(key,{status:entryQty?'filled':'canceled',broker_order_id:parent});
    if(fills) {
        for(const [side,order,price] of [['buy',parent,100],['sell',target,110]])await run("INSERT INTO alpaca_paper_fills(activity_id,broker_order_id,plan_id,symbol,side,qty,price,executed_at,fill_type,source) VALUES (?,?,?,?,?,2,?,'2025-01-01','fill','rest_reconciliation')",['synthetic-fill-'+side+'-'+symbol,order,id,symbol,side,price]);
    }
    const leg=(id,type,qty)=>({id,symbol,side:'sell',qty:'2',filled_qty:String(qty),filled_avg_price:qty?'110':null,status:qty?'filled':'canceled',type,time_in_force:'day',order_class:'bracket',client_order_id:'synthetic-'+id,legs:null});
    const orders=new Map([[stop,leg(stop,'stop',0)],[target,leg(target,'limit',fills?2:0)]]);
    orders.set(parent,{id:parent,symbol,side:'buy',qty:'2',filled_qty:String(entryQty),filled_avg_price:entryQty?'100':null,status:entryQty?'filled':'canceled',type:'limit',time_in_force:'day',order_class:'bracket',client_order_id:key,legs:[orders.get(stop),orders.get(target)]});
    const state={positions:[],open:[],offset:0,accountId:'synthetic-paper-account',lookups:0,reads:0};
    const env={ALPACA_API_KEY:'synthetic-paper-key',ALPACA_API_SECRET:'synthetic-paper-secret',ALPACA_PAPER_ORDER_ENTRY_ENABLED:'false'};
    const client={getAccount:async()=>({id:state.accountId,currency:'USD',status:'ACTIVE',trading_blocked:false,account_blocked:false}),
        getPositions:async()=>structuredClone(state.positions),getOrders:async()=>structuredClone(state.open),
        getOrder:async id=>{state.reads++;return structuredClone(orders.get(id));},
        getOrderByClientOrderId:async clientId=>{state.lookups++;const order=[...orders.values()].find(row=>row.client_order_id===clientId);return {found:Boolean(order),order:order?structuredClone(order):null};},
        submit:()=>assert.fail('Reconciliation must never submit'),cancel:()=>assert.fail('Reconciliation must never cancel')};
    const options={client,env,now:()=>new Date(Date.now()+state.offset),planIds:[id]};
    return {id,symbol,parent,stop,target,key,orders,state,env,client,options,reconcile:()=>reconcileLegacyV1Plans(options)};
}
const blocker=(result,code)=>{assert.equal(result.reconciled,0);assert.equal(result.blocked,1);assert.equal(result.blockers[0].code,code);};

test('operator reconciliation closes a broker-flat V1 plan with missing retained fills and preserves unknown history',async()=>{
    const f=await fixture();f.state.positions=[{symbol:'UNRELATED',side:'long',qty:'4'}];
    const before=(await all('SELECT * FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0];
    const audits=await all('SELECT * FROM alpaca_paper_orders WHERE plan_id=?',[f.id]);
    const result=await f.reconcile();assert.deepEqual({...result,blockers:[]},{checked:1,reconciled:1,closed:1,cancelled:0,blocked:0,skipped:0,blockers:[]});
    const after=(await all('SELECT * FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0];
    assert.equal(after.state,'closed');assert.equal(after.realized_pnl,null);assert.equal(after.realized_r,null);assert.ok(after.closed_at);
    for(const key of Object.keys(before).filter(key=>!['state','closed_at','realized_pnl','realized_r'].includes(key)))assert.deepEqual(after[key],before[key]);
    assert.deepEqual(await all('SELECT * FROM alpaca_paper_fills WHERE plan_id=?',[f.id]),[]);
    assert.deepEqual(await all('SELECT * FROM alpaca_paper_orders WHERE plan_id=?',[f.id]),audits);
    const events=await all('SELECT * FROM alpaca_day_trade_events WHERE plan_id=?',[f.id]);assert.equal(events.length,1);assert.equal(events[0].action,'operator_resolved');
    assert.deepEqual(JSON.parse(events[0].detail_json),{symbol:f.symbol,from:'entry_pending',to:'closed',verifiedFlat:true,historyComplete:false,performanceVerified:false,brokerEntryQty:2,priorRealizedPnl:99,priorRealizedR:9,priorClosedAt:null});
    assert.doesNotMatch(events[0].detail_json,/synthetic-parent|synthetic-client|synthetic-paper-account/);
    await assert.rejects(run('DELETE FROM alpaca_day_trade_events WHERE id=?',[events[0].id]),/immutable/);
    assert.equal((await f.reconcile()).checked,0);
});
test('retained entry and exit fills survive stale zero plan counters without fabricated P&L or cancellation',async()=>{
    const f=await fixture({fills:true});const before=await all('SELECT * FROM alpaca_paper_fills WHERE plan_id=?',[f.id]);
    const result=await f.reconcile();assert.equal(result.closed,1);assert.equal(result.cancelled,0);
    const plan=(await all('SELECT * FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0];
    assert.equal(plan.filled_entry_qty,0);assert.equal(plan.filled_exit_qty,0);assert.equal(plan.realized_pnl,null);assert.deepEqual(await all('SELECT * FROM alpaca_paper_fills WHERE plan_id=?',[f.id]),before);
});
test('closure-only recovery does not preserve unverified cached performance even when retained fill quantities balance',async()=>{
    const f=await fixture({fills:true});
    await run('UPDATE alpaca_day_trade_plans SET filled_entry_qty=2,filled_exit_qty=2,avg_entry_price=77,avg_exit_price=88 WHERE id=?',[f.id]);
    assert.equal((await f.reconcile()).closed,1);
    const plan=(await all('SELECT * FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0];
    assert.equal(plan.realized_pnl,null);assert.equal(plan.realized_r,null);assert.equal(plan.avg_entry_price,77);assert.equal(plan.avg_exit_price,88);
    const event=(await all("SELECT detail_json FROM alpaca_day_trade_events WHERE plan_id=? AND action='operator_resolved'",[f.id]))[0];
    assert.equal(JSON.parse(event.detail_json).performanceVerified,false);
});
test('a terminal entry with no broker or retained fills is cancelled, never represented as a completed trade',async()=>{
    const f=await fixture({entryQty:0});assert.equal((await f.reconcile()).cancelled,1);
    assert.equal((await all('SELECT state FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0].state,'cancelled');
});
test('definitively rejected exit intents require an explicit absent client-ID lookup; unknown submissions never resolve',async()=>{
    const f=await fixture({fills:true}),key='synthetic-rejected-exit-'+f.symbol;
    await db.createAlpacaPaperOrderAudit({idempotency_key:key,client_order_id:key,plan_id:f.id,symbol:f.symbol,execution_epoch:'day_trading',leg_role:'time_exit',side:'sell',qty:2,order_class:'simple',order_type:'market',time_in_force:'day',status:'submission_unknown'});
    blocker(await f.reconcile(),'LEGACY_SUBMISSION_PENDING');assert.equal(f.state.lookups,0);
    await db.updateAlpacaPaperOrderAudit(key,{status:'submission_rejected'});
    const lookup=f.client.getOrderByClientOrderId;f.client.getOrderByClientOrderId=async()=>({found:false});blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');
    f.client.getOrderByClientOrderId=lookup;assert.equal((await f.reconcile()).closed,1);assert.ok(f.state.lookups>0);
});
test('held symbols and live linked orders stay unresolved while unrelated positions and orders are permitted',async()=>{
    const f=await fixture();f.state.positions=[{symbol:f.symbol,side:'long',qty:'2'}];blocker(await f.reconcile(),'LEGACY_POSITION_OPEN');
    f.state.positions=[];f.state.open=[{id:'synthetic-working',symbol:f.symbol,side:'sell',qty:'2',filled_qty:'0',status:'new'}];blocker(await f.reconcile(),'LEGACY_ORDERS_OPEN');
    f.state.open=[];f.orders.get(f.stop).status='pending_cancel';blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');f.orders.get(f.stop).status='canceled';
    f.state.open=[{id:'synthetic-unrelated',symbol:'UNRELATED',side:'buy',qty:'1',filled_qty:'0',status:'new'}];assert.equal((await f.reconcile()).closed,1);
});
test('missing, mismatched and malformed broker orders cannot close a legacy plan',async()=>{
    const f=await fixture(),read=f.client.getOrder;
    f.client.getOrder=async()=>undefined;blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');f.client.getOrder=read;
    for(const [field,value] of [['id','wrong-id'],['client_order_id','wrong-client'],['symbol','WRONG'],['side','sell'],['filled_qty','NaN'],['qty',null],['legs',null]]) {
        const original=f.orders.get(f.parent)[field];f.orders.get(f.parent)[field]=value;
        blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');f.orders.get(f.parent)[field]=original;
    }
    f.orders.get(f.parent).legs[0].symbol='WRONG';blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');
});
test('a terminal order with the same symbol cannot substitute for the parent bracket protective leg',async()=>{
    const f=await fixture();const unrelated='synthetic-unrelated-stop-'+f.symbol;
    f.orders.set(unrelated,{...f.orders.get(f.stop),id:unrelated});
    await run('UPDATE alpaca_day_trade_plans SET protective_stop_broker_order_id=? WHERE id=?',[unrelated,f.id]);
    blocker(await f.reconcile(),'LEGACY_ORDER_UNVERIFIED');
    assert.equal((await all('SELECT state FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0].state,'entry_pending');
});
test('malformed or potentially truncated holdings/order snapshots never prove flatness',async()=>{
    const f=await fixture();
    for(const positions of [null,[{symbol:'OTHER',qty:'bad',side:'long'}],[{symbol:'OTHER',qty:'-1',side:'long'}],[{symbol:f.symbol.toLowerCase(),qty:'2',side:'long'}]]){f.state.positions=positions;blocker(await f.reconcile(),'LEGACY_BROKER_DATA_INVALID');}
    f.state.positions=[];
    for(const open of [null,[{id:'incomplete'}],[{id:'unknown-status',symbol:'OTHER',side:'buy',qty:'2',filled_qty:'0',status:'unknown-status'}],[{id:'lowercase',symbol:f.symbol.toLowerCase(),side:'buy',qty:'2',filled_qty:'0',status:'new'}],Array.from({length:50},(_,i)=>({id:'synthetic-'+i,symbol:'OTHER',side:'buy',qty:'1',filled_qty:'0',status:'new'}))]){f.state.open=open;blocker(await f.reconcile(),'LEGACY_BROKER_DATA_INVALID');}
});
test('paused policy, retired monitors, no active lease and bound paper account are prerequisites',async()=>{
    const f=await fixture();
    await run('UPDATE alpaca_paper_long_term_settings SET policy_json=? WHERE id=1',[JSON.stringify({...paperStore.DEFAULT_POLICY,paused:false})]);blocker(await f.reconcile(),'LEGACY_PAUSE_REQUIRED');
    await run('UPDATE alpaca_paper_long_term_settings SET policy_json=? WHERE id=1',[JSON.stringify(paperStore.DEFAULT_POLICY)]);
    await run("UPDATE alpaca_monitor_state SET mode='shadow' WHERE id=1");blocker(await f.reconcile(),'LEGACY_MONITORS_ENABLED');await run("UPDATE alpaca_monitor_state SET mode='disabled' WHERE id=1");
    await run("UPDATE alpaca_monitor_state SET submission_lease_holder='synthetic-lease',submission_lease_expires_at=? WHERE id=1",[new Date(Date.now()+60000).toISOString()]);blocker(await f.reconcile(),'LEGACY_SUBMISSION_PENDING');await run('UPDATE alpaca_monitor_state SET submission_lease_holder=NULL WHERE id=1');
    await run('UPDATE alpaca_paper_long_term_settings SET account_key=? WHERE id=1',[crypto.createHash('sha256').update('different-synthetic-account').digest('hex')]);blocker(await f.reconcile(),'LEGACY_ACCOUNT_MISMATCH');
    await run('UPDATE alpaca_paper_long_term_settings SET account_key=NULL WHERE id=1');f.env.ALPACA_PAPER_ACCOUNT_ID='different-synthetic-account';blocker(await f.reconcile(),'LEGACY_ACCOUNT_MISMATCH');
    assert.equal(f.state.reads,0);
});
test('immutable handovers are skipped even if the old plan still says active',async()=>{
    const f=await fixture();await run("INSERT INTO alpaca_paper_long_term_legacy_handovers(account_key,symbol,legacy_version,plan_id,plan_state,evidence_hash,evidence_json,transferred_qty,reason,created_at) VALUES (?,?,'v1',?,'active','synthetic-hash','{}',2,'Synthetic reviewed transfer','2025-01-01')",['synthetic-account-hash',f.symbol,f.id]);
    const result=await f.reconcile();assert.equal(result.skipped,1);assert.equal(result.checked,0);assert.equal(f.state.reads,0);
    assert.equal((await all('SELECT state FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0].state,'entry_pending');
});
test('broker evidence expires and changed final account/positions/orders block without local writes',async()=>{
    const f=await fixture(),read=f.client.getOrder;f.client.getOrder=async id=>{f.state.offset=11000;return read(id);};blocker(await f.reconcile(),'LEGACY_EVIDENCE_STALE');f.client.getOrder=read;f.state.offset=0;
    for(const [method,replacement,code] of [['getAccount',{id:'changed-account',currency:'USD',status:'ACTIVE',trading_blocked:false,account_blocked:false},'LEGACY_ACCOUNT_MISMATCH'],['getPositions',[{symbol:f.symbol,side:'long',qty:'1'}],'LEGACY_POSITION_OPEN'],['getOrders',[{id:'new-order',symbol:f.symbol,side:'buy',qty:'1',filled_qty:'0',status:'new'}],'LEGACY_ORDERS_OPEN']]) {
        const original=f.client[method];let calls=0;f.client[method]=async()=>++calls===1?original():replacement;
        blocker(await f.reconcile(),code);f.client[method]=original;
    }
    assert.deepEqual(await all('SELECT * FROM alpaca_day_trade_events WHERE plan_id=?',[f.id]),[]);
});
test('concurrent plan, fill, policy, monitor, audit and gate changes invalidate broker evidence before commit',async()=>{
    const mutations=[
        async f=>run("UPDATE alpaca_day_trade_plans SET state='active' WHERE id=?",[f.id]),
        async f=>run("INSERT INTO alpaca_paper_fills(activity_id,broker_order_id,plan_id,symbol,side,qty,price,executed_at,fill_type,source) VALUES (?,?,?,?,'buy',1,100,'2025-01-01','fill','rest_reconciliation')",['racing-fill-'+f.symbol,f.parent,f.id,f.symbol]),
        async()=>run('UPDATE alpaca_paper_long_term_settings SET version=version+1 WHERE id=1'),
        async()=>run('UPDATE alpaca_monitor_state SET kill_switch=1-kill_switch WHERE id=1'),
        async f=>run('UPDATE alpaca_paper_orders SET filled_qty=1 WHERE plan_id=?',[f.id]),
        async f=>{f.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED='true';},
    ];
    for(const mutate of mutations) {
        const f=await fixture(),getOrders=f.client.getOrders;let reads=0;
        f.client.getOrders=async()=>{if(++reads===2)await mutate(f);return getOrders();};
        blocker(await f.reconcile(),'LEGACY_STATE_CHANGED');assert.deepEqual(await all('SELECT * FROM alpaca_day_trade_events WHERE plan_id=?',[f.id]),[]);
    }
});
test('failed audit-event persistence rolls back the plan state and duplicate concurrent recoveries commit once',async()=>{
    const f=await fixture();await run("CREATE TRIGGER synthetic_fail_resolution BEFORE INSERT ON alpaca_day_trade_events WHEN NEW.action='operator_resolved' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END");
    const failed=await f.reconcile();assert.equal(failed.blocked,1);assert.equal((await all('SELECT state FROM alpaca_day_trade_plans WHERE id=?',[f.id]))[0].state,'entry_pending');
    await run('DROP TRIGGER synthetic_fail_resolution');
    const results=await Promise.all([f.reconcile(),f.reconcile()]);assert.equal(results.reduce((sum,row)=>sum+row.reconciled,0),1);
    assert.equal((await all("SELECT * FROM alpaca_day_trade_events WHERE plan_id=? AND action='operator_resolved'",[f.id])).length,1);
});
test('the public service preserves raw audit counts and forwards the plan summary without broadening handover',async()=>{
    const f=await fixture();let called=0;
    const expected={checked:1,reconciled:1,closed:1,cancelled:0,blocked:0,skipped:0,blockers:[]};
    const service=createPaperLongTermInvesting({env:f.env,clientFactory:()=>f.client,auditStore:{listAlpacaPaperOrderAudits:async()=>[]},reconcileLegacyPlans:async options=>{called++;assert.equal(options.client,f.client);return expected;}});
    const result=await service.legacyReconcile();assert.deepEqual(result,{checked:0,updated:0,unchanged:0,failures:0,plans:expected});assert.equal(called,1);
    f.env.ALPACA_PAPER_ACCOUNT_ID='wrong-synthetic-account';await assert.rejects(service.legacyReconcile(),{code:'PAPER_ACCOUNT_MISMATCH'});assert.equal(called,1);
});
