'use strict';

// Operator-requested cleanup of retired V1 plans. Broker reads prove only that
// exposure is flat; they do not manufacture missing execution or P&L history.
const crypto = require('node:crypto');
const db = require('../database/db');
const {getPaperConfiguration,getPaperCredentials} = require('./alpaca_paper_service');
const {effectiveV1HistoryFills} = require('./alpaca_day_trade_history_audit');
const TERMINAL = new Set(['filled','canceled','expired','rejected']);
const ORDER_STATUSES = new Set([...TERMINAL,'new','accepted','pending_new','accepted_for_bidding','partially_filled','held','calculated','pending_replace','pending_cancel','replaced','done_for_day','stopped','suspended']);
const PLAN_TERMINAL = new Set(['closed','cancelled','error']);
const MESSAGES = Object.freeze({
    LEGACY_PAUSE_REQUIRED:'Pause long-term paper investing before reconciling legacy plans.',
    LEGACY_MONITORS_ENABLED:'Retire both day-trading monitors before reconciling legacy plans.',
    LEGACY_SUBMISSION_PENDING:'Reconcile pending or uncertain submissions before resolving legacy plans.',
    LEGACY_ACCOUNT_MISMATCH:'The paper account does not match the configured or previously bound account.',
    LEGACY_BROKER_UNAVAILABLE:'Broker evidence could not be read. Retry reconciliation when the paper broker is available.',
    LEGACY_BROKER_DATA_INVALID:'The broker account, holdings or open-order evidence is incomplete. No plan was changed.',
    LEGACY_POSITION_OPEN:'This symbol still has a broker position. Review or transfer its holdings instead.',
    LEGACY_ORDERS_OPEN:'This symbol still has broker orders. Wait for settlement before reconciling its plan.',
    LEGACY_ORDER_UNVERIFIED:'A linked broker order or protective leg is missing, unsettled or inconsistent. No plan was changed.',
    LEGACY_HISTORY_UNVERIFIED:'The retained plan and order identities need review before reconciliation.',
    LEGACY_STATE_CHANGED:'Local settings or execution evidence changed during reconciliation. Refresh and retry.',
    LEGACY_EVIDENCE_STALE:'Broker evidence expired before reconciliation could commit. Refresh and retry.',
});
const fail = code => Object.assign(new Error(MESSAGES[code]),{code});
const all = (c,sql,args=[]) => new Promise((resolve,reject)=>c.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
const run = (c,sql,args=[]) => new Promise((resolve,reject)=>c.run(sql,args,function(error){error?reject(error):resolve(this.changes);}));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validText = value => typeof value === 'string' && value.trim().length > 0;
const validSymbol = value => typeof value === 'string' && /^[A-Z][A-Z0-9.\-]{0,31}$/.test(value);
const number = value => ['number','string'].includes(typeof value) && String(value).trim()!=='' && Number.isFinite(Number(value)) ? Number(value) : NaN;

async function withConnection(getDb,fn,write=false) {
    const c=getDb();let begun=false;
    try {
        await run(c,write?'BEGIN IMMEDIATE':'BEGIN');begun=true;
        const value=await fn(c);await run(c,'COMMIT');begun=false;return value;
    } catch(error) {if(begun)await run(c,'ROLLBACK');throw error;}
    finally {await new Promise(resolve=>c.close(resolve));}
}
async function localSnapshot(c,id) {
    const [plans,fills,audits,settings,v1,v2,admissions,paperOrders,handovers]=await Promise.all([
        all(c,'SELECT * FROM alpaca_day_trade_plans WHERE id=?',[id]),
        all(c,'SELECT * FROM alpaca_paper_fills WHERE plan_id=? OR symbol=(SELECT symbol FROM alpaca_day_trade_plans WHERE id=?) ORDER BY id',[id,id]),
        all(c,'SELECT * FROM alpaca_paper_orders ORDER BY id'),
        all(c,'SELECT * FROM alpaca_paper_long_term_settings WHERE id=1'),
        all(c,'SELECT * FROM alpaca_monitor_state WHERE id=1'),all(c,'SELECT * FROM alpaca_dt_v2_monitor_state WHERE id=1'),
        all(c,"SELECT e.* FROM alpaca_dt_v2_events e WHERE e.event_type='submission' AND e.action='entry_admitted' AND NOT EXISTS (SELECT 1 FROM alpaca_dt_v2_events s WHERE s.event_key='plan:'||e.plan_id||':entry_settled') ORDER BY id"),
        all(c,"SELECT * FROM alpaca_paper_long_term_orders WHERE status NOT IN ('filled','canceled','expired','rejected') ORDER BY id"),
        all(c,"SELECT * FROM alpaca_paper_long_term_legacy_handovers WHERE legacy_version='v1' AND plan_id=? ORDER BY id",[id]),
    ]);
    return {plan:plans[0],fills,audits,settings:settings[0],v1:v1[0],v2:v2[0],admissions,paperOrders,handovers};
}
function guardLocal(local,stamp) {
    let policy;
    try {policy=JSON.parse(local.settings?.policy_json);} catch {throw fail('LEGACY_PAUSE_REQUIRED');}
    if(policy?.paused!==true)throw fail('LEGACY_PAUSE_REQUIRED');
    if(local.v1?.mode!=='disabled'||local.v2?.mode!=='disabled')throw fail('LEGACY_MONITORS_ENABLED');
    const expiry=Date.parse(local.v1.submission_lease_expires_at);
    if((local.v1.submission_lease_holder&&(!Number.isFinite(expiry)||expiry>stamp))||local.admissions.length||local.paperOrders.length
        ||local.audits.some(row=>['pending_submission','submission_unknown','submission_failed'].includes(row.status)))throw fail('LEGACY_SUBMISSION_PENDING');
}
function gateSnapshot(env) {
    // Credentials are compared in memory only, never persisted in audit output.
    const credentials=getPaperCredentials(env);
    const config=getPaperConfiguration(env);
    if(!config.configured||env.SAMPLE_DATA==='1')throw fail('LEGACY_ACCOUNT_MISMATCH');
    return JSON.stringify([credentials.key,credentials.secret,env.ALPACA_PAPER_ACCOUNT_ID,env.ALPACA_TRADING_BASE_URL,env.SAMPLE_DATA,
        env.ALPACA_PAPER_ORDER_ENTRY_ENABLED,env.ALPACA_DAY_TRADING_ENTRY_ENABLED]);
}
function verifyAccount(account,local,env,expectedId) {
    if(!validText(account?.id)||(expectedId&&account.id!==expectedId)||(env.ALPACA_PAPER_ACCOUNT_ID&&account.id!==env.ALPACA_PAPER_ACCOUNT_ID)
        ||(local.settings.account_key&&local.settings.account_key!==crypto.createHash('sha256').update(account.id).digest('hex')))throw fail('LEGACY_ACCOUNT_MISMATCH');
    if(account.currency!=='USD'||account.status!=='ACTIVE'||account.trading_blocked!==false||account.account_blocked!==false)throw fail('LEGACY_BROKER_DATA_INVALID');
}
function verifyFlat(positions,orders,symbol) {
    if(!Array.isArray(positions)||!Array.isArray(orders)||orders.length>=50)throw fail('LEGACY_BROKER_DATA_INVALID');
    // The existing client requests Alpaca's default 50-row page. A full page
    // cannot establish absence; do not infer flatness from truncated evidence.
    const seen=new Set();
    for(const position of positions) {
        const qty=number(position?.qty);
        if(!validSymbol(position?.symbol)||seen.has(position.symbol)||!['long','short'].includes(position.side)||!Number.isFinite(qty)
            ||(position.side==='long'?qty<=0:qty>=0))throw fail('LEGACY_BROKER_DATA_INVALID');
        seen.add(position.symbol);
        if(position.symbol===symbol)throw fail('LEGACY_POSITION_OPEN');
    }
    const inspect=(order,depth=0)=>{
        if(depth>5||!validText(order?.id)||!validSymbol(order.symbol)||!ORDER_STATUSES.has(order.status)||!['buy','sell'].includes(order.side)
            ||!(number(order.qty)>0)||!(number(order.filled_qty)>=0)||number(order.filled_qty)>number(order.qty))throw fail('LEGACY_BROKER_DATA_INVALID');
        if(order.symbol===symbol)throw fail('LEGACY_ORDERS_OPEN');
        if(order.legs!=null&&!Array.isArray(order.legs))throw fail('LEGACY_BROKER_DATA_INVALID');
        for(const leg of order.legs||[])inspect(leg,depth+1);
    };
    for(const order of orders)inspect(order);
}
async function verifyLinkedOrders(client,local) {
    const plan=local.plan;
    if(!validSymbol(plan.symbol)||!Number.isSafeInteger(plan.id))throw fail('LEGACY_HISTORY_UNVERIFIED');
    const entryAudits=local.audits.filter(row=>row.plan_id===plan.id&&row.execution_epoch==='day_trading'&&row.leg_role==='entry');
    if(entryAudits.length!==1||entryAudits[0].side!=='buy')throw fail('LEGACY_HISTORY_UNVERIFIED');
    const entry=entryAudits[0],parentId=plan.entry_parent_broker_order_id||entry.broker_order_id;
    if(plan.entry_parent_broker_order_id&&entry.broker_order_id&&plan.entry_parent_broker_order_id!==entry.broker_order_id)throw fail('LEGACY_HISTORY_UNVERIFIED');
    const knownIds=new Set([parentId,plan.protective_stop_broker_order_id,plan.protective_target_broker_order_id].filter(Boolean));
    const ownedFills=local.fills.filter(fill=>fill.plan_id===plan.id);
    for(const fill of ownedFills) {
        if(!validText(fill.broker_order_id))throw fail('LEGACY_HISTORY_UNVERIFIED');
        knownIds.add(fill.broker_order_id);
    }
    const linkedAudits=local.audits.filter(row=>row.plan_id===plan.id||knownIds.has(row.broker_order_id)||(parentId&&row.parent_broker_order_id===parentId));
    for(const audit of linkedAudits) {
        if(audit.symbol!==plan.symbol||audit.execution_epoch!=='day_trading'||(audit.plan_id!=null&&audit.plan_id!==plan.id))throw fail('LEGACY_HISTORY_UNVERIFIED');
        if(audit!==entry&&(audit.side!=='sell'||!['take_profit','stop_loss','time_exit','repair_exit','emergency_flatten'].includes(audit.leg_role)))throw fail('LEGACY_HISTORY_UNVERIFIED');
        if(parentId&&audit.parent_broker_order_id&&audit.parent_broker_order_id!==parentId)throw fail('LEGACY_HISTORY_UNVERIFIED');
        if(audit.broker_order_id)knownIds.add(audit.broker_order_id);
        if(audit.parent_broker_order_id)knownIds.add(audit.parent_broker_order_id);
    }
    const linkedFills=local.fills.filter(fill=>fill.plan_id===plan.id||knownIds.has(fill.broker_order_id));
    if(linkedFills.some(fill=>fill.symbol!==plan.symbol||(fill.plan_id!=null&&fill.plan_id!==plan.id)))throw fail('LEGACY_HISTORY_UNVERIFIED');
    let effective;
    try {effective=effectiveV1HistoryFills(linkedFills);}catch{throw fail('LEGACY_HISTORY_UNVERIFIED');}
    if(effective.some(fill=>!['buy','sell'].includes(fill.side)||!(number(fill.qty)>0)||!(number(fill.price)>0)))throw fail('LEGACY_HISTORY_UNVERIFIED');
    const observed=new Map();
    const inspect=(remote,expectedSide,depth=0)=>{
        if(depth>5||observed.size>1000||!validText(remote?.id)||remote.symbol!==plan.symbol||!TERMINAL.has(remote.status)||!['buy','sell'].includes(remote.side)
            ||(expectedSide&&remote.side!==expectedSide)||!(number(remote.qty)>0)||!(number(remote.filled_qty)>=0)||number(remote.filled_qty)>number(remote.qty)
            ||(remote.status==='filled'&&number(remote.filled_qty)!==number(remote.qty))||(number(remote.filled_qty)>0&&!(number(remote.filled_avg_price)>0))
            ||remote.replaced_by||(remote.legs!=null&&!Array.isArray(remote.legs)))throw fail('LEGACY_ORDER_UNVERIFIED');
        const material={id:remote.id,symbol:remote.symbol,side:remote.side,status:remote.status,qty:number(remote.qty),filledQty:number(remote.filled_qty),average:number(remote.filled_avg_price),clientId:remote.client_order_id,
            type:remote.type,timeInForce:remote.time_in_force,orderClass:remote.order_class,legs:(remote.legs||[]).map(leg=>leg.id).sort()};
        const old=observed.get(remote.id);
        if(old&&hash(old)!==hash(material))throw fail('LEGACY_ORDER_UNVERIFIED');
        observed.set(remote.id,material);
        for(const leg of remote.legs||[])inspect(leg,'sell',depth+1);
        return material;
    };
    const readById=async(id,side)=>{
        const remote=await client.getOrder(id);
        if(remote?.id!==id)throw fail('LEGACY_ORDER_UNVERIFIED');
        inspect(remote,side);return remote;
    };
    const readAudit=async audit=>{
        const expectedClient=audit.client_order_id||audit.idempotency_key;
        if(!validText(expectedClient))throw fail('LEGACY_HISTORY_UNVERIFIED');
        let remote;
        if(audit.broker_order_id)remote=await readById(audit.broker_order_id,audit.side);
        else {
            const lookup=await client.getOrderByClientOrderId(expectedClient);
            // A definitively rejected, never-acknowledged exit intent is not a
            // missing submitted order. Verify its absence by the retained ID;
            // never extend this exception to entries or uncertain submissions.
            if(lookup?.found===false&&lookup.order===null&&audit!==entry&&audit.side==='sell'
                &&['time_exit','repair_exit','emergency_flatten'].includes(audit.leg_role)
                &&audit.status==='submission_rejected'&&audit.unresolved===0&&audit.filled_qty===0)return null;
            if(lookup?.found!==true||!lookup.order)throw fail('LEGACY_ORDER_UNVERIFIED');
            remote=lookup.order;inspect(remote,audit.side);
        }
        if(remote.client_order_id!==expectedClient||number(remote.qty)!==number(audit.qty)||remote.type!==audit.order_type||remote.time_in_force!==audit.time_in_force
            ||remote.order_class!==audit.order_class)throw fail('LEGACY_ORDER_UNVERIFIED');
        return remote;
    };
    const parent=await readAudit(entry);
    if(parentId&&parent.id!==parentId)throw fail('LEGACY_ORDER_UNVERIFIED');
    if(entry.order_class==='bracket'&&(!Array.isArray(parent.legs)||parent.legs.length!==2
        ||parent.legs.filter(leg=>leg.type==='limit').length!==1||parent.legs.filter(leg=>['stop','stop_limit'].includes(leg.type)).length!==1))throw fail('LEGACY_ORDER_UNVERIFIED');
    if((plan.protective_stop_broker_order_id&&!parent.legs?.some(leg=>leg.id===plan.protective_stop_broker_order_id&&['stop','stop_limit'].includes(leg.type)))
        ||(plan.protective_target_broker_order_id&&!parent.legs?.some(leg=>leg.id===plan.protective_target_broker_order_id&&leg.type==='limit')))throw fail('LEGACY_ORDER_UNVERIFIED');
    for(const audit of linkedAudits)if(audit!==entry)await readAudit(audit);
    for(const id of knownIds)await readById(id,id===parent.id?'buy':id===plan.protective_stop_broker_order_id||id===plan.protective_target_broker_order_id?'sell':undefined);
    for(const fill of effective) {
        const remote=observed.get(fill.broker_order_id);
        if(!remote||remote.side!==fill.side)throw fail('LEGACY_ORDER_UNVERIFIED');
    }
    const entryQty=effective.filter(fill=>fill.side==='buy').reduce((sum,fill)=>sum+fill.qty,0);
    const exitQty=effective.filter(fill=>fill.side==='sell').reduce((sum,fill)=>sum+fill.qty,0);
    const complete=entryQty>0&&entryQty===exitQty&&plan.filled_entry_qty===entryQty&&plan.filled_exit_qty===exitQty
        &&[...observed.values()].every(order=>{
            const rows=effective.filter(fill=>fill.broker_order_id===order.id),qty=rows.reduce((sum,fill)=>sum+fill.qty,0);
            return qty===order.filledQty&&(!qty||Math.abs(rows.reduce((sum,fill)=>sum+fill.qty*fill.price,0)/qty-order.average)<1e-6);
        });
    const neverFilled=[...observed.values()].every(order=>order.filledQty===0)&&entryQty===0&&exitQty===0&&plan.filled_entry_qty===0&&plan.filled_exit_qty===0;
    return {nextState:neverFilled?'cancelled':'closed',historyComplete:complete,brokerEntryQty:number(parent.filled_qty)};
}

async function reconcileLegacyV1Plans({client,env=process.env,now=()=>new Date(),getDb=db.getDb,planIds}={}) {
    if(planIds!==undefined&&(!Array.isArray(planIds)||planIds.some(id=>!Number.isSafeInteger(id)||id<=0)))throw new Error('Invalid internal legacy plan selection');
    const candidates=await withConnection(getDb,c=>all(c,"SELECT id,symbol FROM alpaca_day_trade_plans WHERE state NOT IN ('closed','cancelled','error') ORDER BY id"));
    const selected=planIds===undefined?candidates:candidates.filter(plan=>planIds.includes(plan.id));
    const summary={checked:0,reconciled:0,closed:0,cancelled:0,blocked:0,skipped:0,blockers:[]};
    for(const candidate of selected) {
        summary.checked++;
        try {
            const local=await withConnection(getDb,c=>localSnapshot(c,candidate.id));
            if(!local.plan||PLAN_TERMINAL.has(local.plan.state)||local.handovers.length){summary.checked--;summary.skipped++;continue;}
            const started=now().getTime(),gates=gateSnapshot(env),sourceHash=hash(local);
            guardLocal(local,started);
            const [account,positions,openOrders]=await Promise.all([client.getAccount(),client.getPositions(),client.getOrders()]);
            verifyAccount(account,local,env);verifyFlat(positions,openOrders,local.plan.symbol);
            const result=await verifyLinkedOrders(client,local);
            const [finalAccount,finalPositions,finalOrders]=await Promise.all([client.getAccount(),client.getPositions(),client.getOrders()]);
            verifyAccount(finalAccount,local,env,account.id);verifyFlat(finalPositions,finalOrders,local.plan.symbol);
            const assertFresh=()=>{
                const age=now().getTime()-started;
                if(!Number.isFinite(age)||age<0||age>10000)throw fail('LEGACY_EVIDENCE_STALE');
                if(gateSnapshot(env)!==gates)throw fail('LEGACY_STATE_CHANGED');
            };
            await withConnection(getDb,async c=>{
                const current=await localSnapshot(c,local.plan.id);
                if(hash(current)!==sourceHash)throw fail('LEGACY_STATE_CHANGED');
                guardLocal(current,now().getTime());assertFresh();
                const stamp=now().toISOString();
                const changed=await run(c,'UPDATE alpaca_day_trade_plans SET state=?,closed_at=?,realized_pnl=?,realized_r=? WHERE id=? AND state=?',
                    [result.nextState,stamp,null,null,local.plan.id,local.plan.state]);
                if(changed!==1)throw fail('LEGACY_STATE_CHANGED');
                await run(c,"INSERT INTO alpaca_day_trade_events(event_key,plan_id,event_type,action,outcome,reason,detail_json,occurred_at) VALUES (?,?,'reconciliation','operator_resolved',?,'broker_verified_flat',?,?)",
                    [`legacy-flat:${local.plan.id}:${sourceHash}`,local.plan.id,result.nextState,JSON.stringify({symbol:local.plan.symbol,from:local.plan.state,to:result.nextState,verifiedFlat:true,historyComplete:result.historyComplete,performanceVerified:false,brokerEntryQty:result.brokerEntryQty,
                        priorRealizedPnl:local.plan.realized_pnl,priorRealizedR:local.plan.realized_r,priorClosedAt:local.plan.closed_at}),stamp]);
                assertFresh();
            },true);
            summary.reconciled++;summary[result.nextState]++;
        } catch(error) {
            const code=Object.hasOwn(MESSAGES,error.code)?error.code:'LEGACY_BROKER_UNAVAILABLE';
            summary.blocked++;summary.blockers.push({planId:candidate.id,symbol:candidate.symbol,code,message:MESSAGES[code]});
        }
    }
    return summary;
}
module.exports={reconcileLegacyV1Plans};
