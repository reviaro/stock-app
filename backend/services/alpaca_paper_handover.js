'use strict';
const crypto=require('node:crypto');
const {effectiveV1HistoryFills,canonicalHistoryExecutionId}=require('./alpaca_day_trade_history_audit');
const all=(c,sql,args=[])=>new Promise((resolve,reject)=>c.all(sql,args,(error,rows)=>error?reject(error):resolve(rows)));
const fail=message=>Object.assign(Error(message),{code:'PAPER_HANDOVER_BLOCKED',status:409});
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const terminalAudit=new Set(['filled','canceled','cancelled','rejected','expired','suspended','stopped','submission_rejected','submission_not_found']);

function evidenceFor(version,plan,fills) {
    const canonical=version==='v1'?effectiveV1HistoryFills(fills):fills;
    const entries=canonical.filter(f=>version==='v1'?f.side==='buy':f.role==='entry');
    const exits=canonical.filter(f=>version==='v1'?f.side==='sell':['bracket_exit','time_exit'].includes(f.role));
    if(canonical.length!==entries.length+exits.length || entries.some(f=>f.side!=='buy') || exits.some(f=>f.side!=='sell') || canonical.some(f=>f.symbol!==plan.symbol || !Number.isFinite(f.qty) || f.qty<=0 || !(f.price>0)))throw fail('Legacy fill evidence is incomplete or inconsistent. Reconcile it first.');
    const entryQty=entries.reduce((n,f)=>n+f.qty,0),exitQty=exits.reduce((n,f)=>n+f.qty,0);
    if(entryQty!==plan.filled_entry_qty || exitQty!==plan.filled_exit_qty || exitQty>entryQty)throw fail('Legacy fill totals do not match the retained plan. Reconcile it first.');
    const parentId=version==='v1'?plan.entry_parent_broker_order_id:plan.parent_order_id;
    const orderIds=version==='v1'?[parentId,plan.protective_stop_broker_order_id,plan.protective_target_broker_order_id]:[parentId,plan.stop_order_id,plan.target_order_id,plan.exit_order_id];
    const records=canonical.map(f=>({key:canonicalHistoryExecutionId(version==='v1'?f.activity_id:f.execution_id),orderId:version==='v1'?f.broker_order_id:f.order_id,side:f.side,qty:f.qty,price:f.price})).sort((a,b)=>a.key.localeCompare(b.key));
    const material={version,id:plan.id,symbol:plan.symbol,parentId,orderIds:[...new Set([...orderIds,...records.map(f=>f.orderId)].filter(Boolean))].sort(),entryQty,exitQty,records};
    return {...material,state:plan.state,remainingQty:entryQty-exitQty,hash:digest(material)};
}
async function readEvidence(c,symbol,{includeTerminal=false}={}) {
    const result=[];
    for(const [version,table,fillTable,terminal] of [['v1','alpaca_day_trade_plans','alpaca_paper_fills',"'closed','cancelled','error'"],['v2','alpaca_dt_v2_plans','alpaca_dt_v2_fills',"'closed','cancelled','rejected'"]]) {
        const plans=await all(c,`SELECT * FROM ${table} WHERE symbol=? ${includeTerminal?'':`AND state NOT IN (${terminal})`} ORDER BY id`,[symbol]);
        for(const plan of plans)result.push(evidenceFor(version,plan,await all(c,`SELECT * FROM ${fillTable} WHERE plan_id=? ORDER BY id`,[plan.id])));
    }
    return result;
}
async function connection(fn) {
    const c=require('../database/db').getDb();
    try{return await fn(c);}finally{await new Promise(resolve=>c.close(resolve));}
}
const getEvidence=symbol=>connection(c=>readEvidence(c,symbol));
async function transferredPlans(records,accountKey) {
    const accepted=new Set();
    await connection(async c=>{
        for(const record of records) {
            if(record.account_key!==accountKey)throw fail('Legacy transfer records belong to a different paper account.');
            const tables={v1:['alpaca_day_trade_plans','alpaca_paper_fills'],v2:['alpaca_dt_v2_plans','alpaca_dt_v2_fills']}[record.legacy_version];
            if(!tables)throw fail('The retained legacy transfer has an invalid source.');
            const plan=(await all(c,`SELECT * FROM ${tables[0]} WHERE id=?`,[record.plan_id]))[0];
            const current=plan?evidenceFor(record.legacy_version,plan,await all(c,`SELECT * FROM ${tables[1]} WHERE plan_id=? ORDER BY id`,[record.plan_id])):null;
            if(!current || current.hash!==record.evidence_hash)throw fail('Legacy fill evidence changed after ownership transfer. Review broker holdings before continuing.');
            accepted.add(record.legacy_version+':'+record.plan_id);
        }
    });
    return accepted;
}
async function validateTransfer(c,input) {
    const [first,second,admissions,audits,handovers]=await Promise.all([
        all(c,'SELECT * FROM alpaca_monitor_state WHERE id=1'),all(c,'SELECT * FROM alpaca_dt_v2_monitor_state WHERE id=1'),
        all(c,"SELECT e.plan_id FROM alpaca_dt_v2_events e WHERE e.event_type='submission' AND e.action='entry_admitted' AND NOT EXISTS (SELECT 1 FROM alpaca_dt_v2_events s WHERE s.event_key='plan:'||e.plan_id||':entry_settled')"),
        all(c,'SELECT status FROM alpaca_paper_orders'),all(c,'SELECT legacy_version,plan_id FROM alpaca_paper_long_term_legacy_handovers'),
    ]);
    const lease=first[0];const expiry=Date.parse(lease?.submission_lease_expires_at);
    if(first[0]?.mode!=='disabled'||second[0]?.mode!=='disabled'||admissions.length||(lease?.submission_lease_holder&&(!Number.isFinite(expiry)||expiry>input.now)))throw fail('Disable legacy monitors and reconcile in-flight submissions before transferring holdings.');
    if(audits.some(row=>!terminalAudit.has(String(row.status).toLowerCase())))throw fail('Reconcile outstanding legacy paper orders before transferring holdings.');
    const current=await readEvidence(c,input.symbol);
    const existing=new Set(handovers.map(row=>row.legacy_version+':'+row.plan_id));
    if(current.length!==input.plans.length || current.some(plan=>existing.has(plan.version+':'+plan.id) || !input.plans.some(p=>p.version===plan.version&&p.id===plan.id&&p.hash===plan.hash)))throw fail('Legacy ownership evidence changed during review. Refresh before transferring.');
    if(!current.length || current.some(plan=>!(plan.remainingQty>0)))throw fail('Only reconciled legacy plans with remaining holdings can be transferred.');
    const keys=current.flatMap(p=>p.records.map(f=>f.key));
    if(new Set(keys).size!==keys.length)throw fail('Legacy plans contain overlapping fill identities. Resolve duplicate ownership before transferring.');
    const quantity=current.reduce((n,p)=>n+p.remainingQty,0);
    if(Math.abs(quantity+input.expectedOwned-input.brokerQty)>1e-8)throw fail('The reviewed broker quantity must equal all legacy holdings plus existing paper ownership.');
}
module.exports={getEvidence,transferredPlans,validateTransfer};
