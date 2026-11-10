'use strict';
const crypto = require('node:crypto');

const DEFAULT_POLICY = Object.freeze({ budget: 0, reservePct: 10, maxPositionPct: 25, maxOrderValue: 500,
    minTradeValue: 25, driftPct: 2, maxSpreadBps: 50, fractional: true, paused: true, executionMode: 'confirm', targets: [] });
function createLongTermStore({ environment = 'live' } = {}) {
    if (!['live', 'paper'].includes(environment)) throw new Error('Unsupported investing environment');
    const tablePrefix = environment === 'live' ? 'alpaca_live_' : 'alpaca_paper_long_term_';
    // SQL is shared, but the namespace is selected only from these fixed names.
    // Parameters never select tables, and paper cannot touch the live ledger.
    const namespaceSql = sql => sql.replaceAll('alpaca_investing_', tablePrefix);
    const fail = (code, message, status = 409) => Object.assign(new Error(message), { code: environment.toUpperCase() + '_' + code, status });
const all = (c, sql, args = []) => new Promise((resolve, reject) => c.all(namespaceSql(sql), args, (e, rows) => e ? reject(e) : resolve(rows)));
const run = (c, sql, args = []) => new Promise((resolve, reject) => c.run(namespaceSql(sql), args, function(e) { e ? reject(e) : resolve({ id: this.lastID, changes: this.changes }); }));
async function connection(fn) {
    const c = require('../database/db').getDb();
    try { return await fn(c); } finally { await new Promise(resolve => c.close(resolve)); }
}
async function transaction(fn) {
    return connection(async c => {
        await run(c, 'BEGIN IMMEDIATE');
        try { const value = await fn(c); await run(c, 'COMMIT'); return value; }
        catch (e) { await run(c, 'ROLLBACK'); throw e; }
    });
}
const hash = value => crypto.createHash('sha256').update(String(value)).digest('hex');
const finalStatuses = new Set(['filled', 'canceled', 'expired', 'rejected']);
function validatePolicy(input) {
    const p = {};
    for (const [key, min, max] of [['budget',0,1e9],['reservePct',0,100],['maxPositionPct',1,100],['maxOrderValue',1,1e7],['minTradeValue',1,1e6],['driftPct',0.1,20],['maxSpreadBps',1,100]]) {
        if (typeof input?.[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw fail('INVALID_POLICY', 'Invalid ' + key + '.', 400);
        p[key] = input[key];
    }
    if (typeof input.paused !== 'boolean' || typeof input.fractional !== 'boolean' || !Array.isArray(input.targets) || input.targets.length > 30) throw fail('INVALID_POLICY', 'Provide targets, pause state and fractional-share preference.', 400);
    p.paused = input.paused; p.fractional = input.fractional;
    if (!['confirm','automatic'].includes(input.executionMode)) throw fail('INVALID_POLICY','Choose confirmation or automatic execution.',400);
    p.executionMode = input.executionMode;
    p.targets = input.targets.map(t => {
        if (typeof t?.symbol !== 'string' || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t.symbol) || typeof t.weightPct !== 'number' || !Number.isFinite(t.weightPct) || t.weightPct <= 0 || t.weightPct > p.maxPositionPct) throw fail('INVALID_POLICY', 'Each target needs a broker symbol and a weight within the position limit.', 400);
        return { symbol: t.symbol, weightPct: t.weightPct };
    }).sort((a,b) => a.symbol.localeCompare(b.symbol));
    if (new Set(p.targets.map(t => t.symbol)).size !== p.targets.length || p.targets.reduce((n,t) => n+t.weightPct,0) > 100-p.reservePct+1e-8 || p.minTradeValue > p.maxOrderValue) throw fail('INVALID_POLICY', 'Targets must be unique and leave the configured cash reserve; minimum trade cannot exceed the order limit.', 400);
    if (!p.paused && (!p.budget || !p.targets.length)) throw fail('INVALID_POLICY', 'Set a funded budget and targets before unpausing.', 400);
    return p;
}
async function init() {
    await transaction(async c => {
        for (const sql of [
            `CREATE TABLE IF NOT EXISTS alpaca_investing_settings (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL, policy_json TEXT NOT NULL, account_key TEXT, sequence INTEGER NOT NULL DEFAULT 0)`,
            `CREATE TABLE IF NOT EXISTS alpaca_investing_plans (id TEXT PRIMARY KEY, account_key TEXT NOT NULL, policy_version INTEGER NOT NULL, expires_at TEXT NOT NULL, plan_json TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS alpaca_investing_decisions (decision_key TEXT PRIMARY KEY, symbol TEXT NOT NULL, side TEXT NOT NULL, reason TEXT NOT NULL, policy_version INTEGER NOT NULL, created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS alpaca_investing_ownership (id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT NOT NULL, symbol TEXT NOT NULL, delta_qty REAL NOT NULL, broker_qty REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS alpaca_investing_orders (id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE, decision_key TEXT UNIQUE, account_key TEXT NOT NULL, client_order_id TEXT NOT NULL UNIQUE, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL, limit_price REAL NOT NULL, status TEXT NOT NULL, broker_id TEXT, filled_qty REAL NOT NULL DEFAULT 0, filled_avg_price REAL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
            `CREATE TABLE IF NOT EXISTS alpaca_investing_events (id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
            `CREATE INDEX IF NOT EXISTS alpaca_investing_decision_checks ON alpaca_investing_events(action,json_extract(detail_json,'$.decisionKey'),id)`,
            `CREATE INDEX IF NOT EXISTS alpaca_investing_decision_plans ON alpaca_investing_plans(json_extract(plan_json,'$.decisionKey'))`,
            `CREATE TRIGGER IF NOT EXISTS alpaca_investing_order_intent_immutable BEFORE UPDATE ON alpaca_investing_orders WHEN NEW.id IS NOT OLD.id OR NEW.plan_id IS NOT OLD.plan_id OR NEW.decision_key IS NOT OLD.decision_key OR NEW.account_key IS NOT OLD.account_key OR NEW.client_order_id IS NOT OLD.client_order_id OR NEW.symbol IS NOT OLD.symbol OR NEW.side IS NOT OLD.side OR NEW.qty IS NOT OLD.qty OR NEW.limit_price IS NOT OLD.limit_price OR NEW.created_at IS NOT OLD.created_at BEGIN SELECT RAISE(ABORT,'long-term order intent is immutable'); END`,
            ...['alpaca_investing_orders','alpaca_investing_plans','alpaca_investing_events','alpaca_investing_decisions','alpaca_investing_ownership'].map(t => `CREATE TRIGGER IF NOT EXISTS ${t}_no_delete BEFORE DELETE ON ${t} BEGIN SELECT RAISE(ABORT,'long-term history is retained'); END`),
            ...['alpaca_investing_plans','alpaca_investing_events','alpaca_investing_decisions','alpaca_investing_ownership'].map(t => `CREATE TRIGGER IF NOT EXISTS ${t}_no_update BEFORE UPDATE ON ${t} BEGIN SELECT RAISE(ABORT,'long-term history is immutable'); END`),
        ]) await run(c, sql);
        if (environment === 'paper') {
            await run(c, `CREATE TABLE IF NOT EXISTS alpaca_investing_legacy_handovers (id INTEGER PRIMARY KEY AUTOINCREMENT, account_key TEXT NOT NULL, symbol TEXT NOT NULL, legacy_version TEXT NOT NULL, plan_id INTEGER NOT NULL, plan_state TEXT NOT NULL, evidence_hash TEXT NOT NULL, evidence_json TEXT NOT NULL, transferred_qty REAL NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(legacy_version,plan_id))`);
            for (const action of ['UPDATE','DELETE']) await run(c, `CREATE TRIGGER IF NOT EXISTS alpaca_investing_legacy_handovers_no_${action.toLowerCase()} BEFORE ${action} ON alpaca_investing_legacy_handovers BEGIN SELECT RAISE(ABORT,'legacy handover history is immutable'); END`);
        }
        await run(c, 'INSERT OR IGNORE INTO alpaca_investing_settings(id,version,policy_json,account_key) VALUES (1,0,?,NULL)', [JSON.stringify(DEFAULT_POLICY)]);
        for (const [table,required] of Object.entries({
            alpaca_investing_settings:['id','version','policy_json','account_key','sequence'],
            alpaca_investing_plans:['id','account_key','policy_version','expires_at','plan_json'],
            alpaca_investing_orders:['id','plan_id','decision_key','account_key','client_order_id','symbol','side','qty','limit_price','status','broker_id','filled_qty','filled_avg_price','created_at','updated_at'],
            alpaca_investing_decisions:['decision_key','symbol','side','reason','policy_version','created_at'],
            alpaca_investing_ownership:['id','account_key','symbol','delta_qty','broker_qty','reason','created_at'],
            alpaca_investing_events:['id','action','detail_json','created_at'],
            ...(environment === 'paper' ? {alpaca_investing_legacy_handovers:['id','account_key','symbol','legacy_version','plan_id','plan_state','evidence_hash','evidence_json','transferred_qty','reason','created_at']} : {}),
        })) {
            const columns=new Set((await all(c,'PRAGMA table_info('+table+')')).map(row=>row.name));
            if (required.some(name=>!columns.has(name))) throw fail('SCHEMA_UNAVAILABLE','The long-term investing schema is incomplete. Initialization stopped.',503);
        }
    });
}
async function state(c) {
    const row = (await all(c, 'SELECT * FROM alpaca_investing_settings WHERE id=1'))[0];
    if (!row) throw fail('SCHEMA_UNAVAILABLE', 'Long-term investing needs database initialization.', 503);
    return { version: row.version, policy: JSON.parse(row.policy_json), accountKey: row.account_key, sequence:row.sequence };
}
const event = (c, action, detail) => run(c, 'INSERT INTO alpaca_investing_events(action,detail_json,created_at) VALUES(?,?,?)', [action, JSON.stringify(detail), new Date().toISOString()]);
async function savePolicy(input, expectedVersion, confirmation) {
    const policy = validatePolicy(input);
    const expected = `ENABLE ${policy.executionMode === 'automatic' ? 'AUTOMATIC ' : ''}${environment.toUpperCase()} INVESTING`;
    if (!policy.paused && confirmation !== expected) throw fail('CONFIRMATION_REQUIRED', 'Type '+expected+' to unpause.', 400);
    return transaction(async c => {
        const old = await state(c);
        if (old.version !== expectedVersion) throw fail('POLICY_CHANGED', 'Settings changed. Reload before saving.');
        await run(c, 'UPDATE alpaca_investing_settings SET version=version+1,policy_json=? WHERE id=1', [JSON.stringify(policy)]);
        await event(c, 'policy_saved', { version: old.version+1, policy });
        return { version: old.version+1, policy };
    });
}
const settings = () => connection(state);
const orders = () => connection(c => all(c, 'SELECT * FROM alpaca_investing_orders ORDER BY created_at DESC,id DESC'));
const getPlan = id => connection(async c => (await all(c, 'SELECT * FROM alpaca_investing_plans WHERE id=?',[id]))[0] || null);
const savePlan = plan => connection(c => run(c,'INSERT INTO alpaca_investing_plans VALUES(?,?,?,?,?)',[plan.id,plan.accountKey,plan.policyVersion,plan.expiresAt,JSON.stringify(plan)]));
async function reserveOrder(plan, order, { enabled, automatic = false, now = () => new Date() }) {
    return transaction(async c => {
        const existing = (await all(c,'SELECT * FROM alpaca_investing_orders WHERE plan_id=? OR (? IS NOT NULL AND decision_key=?)',[plan.id,plan.decisionKey,plan.decisionKey]))[0];
        if (existing) return { order: existing, replayed: true };
        const current = await state(c);
        if (!enabled() || current.policy.paused || current.version !== plan.policyVersion || Date.parse(plan.expiresAt) <= now().getTime()) throw fail('GATE_CLOSED', 'Trading is paused, disabled, or the plan expired.');
        if (current.sequence!==plan.stateSequence) throw fail('STATE_CHANGED','Order evidence changed after the preview. Refresh before submitting.');
        if (automatic && current.policy.executionMode !== 'automatic') throw fail('CONFIRMATION_REQUIRED','Operator confirmation is required for this decision.');
        if (current.accountKey && current.accountKey !== plan.accountKey) throw fail('ACCOUNT_CHANGED', 'This installation is bound to a different broker account.');
        const pending = await all(c,"SELECT status FROM alpaca_investing_orders WHERE status NOT IN ('filled','canceled','expired','rejected')");
        if (pending.length) throw fail('RECONCILIATION_REQUIRED', 'Reconcile the outstanding long-term order first.');
        const stamp = new Date().toISOString();
        const id = crypto.randomUUID(); const clientId = 'lt-' + environment + '-' + crypto.randomUUID();
        await run(c,'UPDATE alpaca_investing_settings SET account_key=?,sequence=sequence+1 WHERE id=1',[plan.accountKey]);
        await run(c,'INSERT INTO alpaca_investing_orders(id,plan_id,decision_key,account_key,client_order_id,symbol,side,qty,limit_price,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', [id,plan.id,plan.decisionKey||null,plan.accountKey,clientId,order.symbol,order.side,order.qty,order.limitPrice,'submitting',stamp,stamp]);
        await event(c,'order_reserved',{ id, planId:plan.id, order });
        return { order: (await all(c,'SELECT * FROM alpaca_investing_orders WHERE id=?',[id]))[0], replayed:false };
    });
}
// Serialize the final check and the *start* of dispatch with policy/ownership
// writes, even in another process. The durable reservation already exists before
// this transaction. Never await a broker response while holding SQLite's write
// lock: that would delay an emergency pause and the paper monitor's writes.
async function dispatchOrder(plan, reserved, { automatic = false, assertFresh, submit }) {
    let started = false;
    try {
        return await transaction(async c => {
            const local = (await all(c, 'SELECT * FROM alpaca_investing_orders WHERE id=?', [reserved.id]))[0];
            if (!local) throw fail('ORDER_NOT_FOUND', 'The reserved long-term order is missing.', 503);
            const claimed = (await all(c, "SELECT id FROM alpaca_investing_events WHERE action='order_dispatch_claimed' AND json_extract(detail_json,'$.id')=? LIMIT 1", [local.id])).length > 0;
            if (claimed || local.status !== 'submitting' || local.broker_id || local.filled_qty !== 0) {
                return { replayed: true, order: local };
            }
            let refusal;
            try {
                const current = await state(c);
                const intent = plan.nextOrder;
                if (local.plan_id !== plan.id || local.account_key !== plan.accountKey || local.decision_key !== (plan.decisionKey || null)
                    || local.client_order_id !== reserved.client_order_id || local.symbol !== intent?.symbol || local.side !== intent?.side
                    || local.qty !== intent?.qty || local.limit_price !== intent?.limitPrice) {
                    throw fail('DISPATCH_INTENT_CHANGED', 'The reserved order no longer matches its reviewed intent.');
                }
                if (current.policy.paused || current.version !== plan.policyVersion || current.accountKey !== plan.accountKey
                    || current.sequence !== plan.stateSequence + 1 || (automatic && current.policy.executionMode !== 'automatic')) {
                    throw fail('DISPATCH_STATE_CHANGED', 'The investing policy or execution evidence changed before dispatch.');
                }
                const other = await all(c, "SELECT id FROM alpaca_investing_orders WHERE id<>? AND status NOT IN ('filled','canceled','expired','rejected') LIMIT 1", [local.id]);
                if (other.length) throw fail('RECONCILIATION_REQUIRED', 'Reconcile the outstanding long-term order first.');
                // This claim means the final gate is being checked, not that a
                // broker accepted the order. A subsequent refusal records no send.
                await event(c, 'order_dispatch_claimed', { id: local.id, planId: plan.id });
                const result = assertFresh();
                if (result && typeof result.then === 'function') throw new Error('The final dispatch check must be synchronous');
            } catch (e) {
                refusal = typeof e.code === 'string' && e.code.startsWith(environment.toUpperCase() + '_') ? e.code : environment.toUpperCase() + '_DISPATCH_CHECK_FAILED';
            }
            if (refusal) {
                await run(c, "UPDATE alpaca_investing_orders SET status='canceled',updated_at=? WHERE id=? AND status='submitting' AND broker_id IS NULL AND filled_qty=0", [new Date().toISOString(), local.id]);
                await run(c, 'UPDATE alpaca_investing_settings SET sequence=sequence+1 WHERE id=1');
                await event(c, 'order_not_sent', { id: local.id, planId: plan.id, code: refusal });
                return { refused: true, reason: refusal };
            }
            // No await is allowed between the final check above and invoking
            // submit. While the write fence is held, a pause cannot commit here.
            // From this point any exception is an uncertain broker outcome.
            started = true;
            let settlement;
            try {
                settlement = Promise.resolve(submit(local)).then(value => ({ value }), error => ({ error }));
            } catch (error) { settlement = Promise.resolve({ error }); }
            return { replayed: false, order: local, settlement };
        });
    } catch (e) {
        if (started) throw fail('ORDER_UNKNOWN', 'Dispatch started but its record could not be completed. Reconcile the existing order before retrying.', 503);
        throw e;
    }
}
async function updateOrder(id, patch) {
    const fields = ['status','broker_id','filled_qty','filled_avg_price'];
    const selected = fields.filter(key => Object.hasOwn(patch,key));
    return transaction(async c => {
        const previous=(await all(c,'SELECT * FROM alpaca_investing_orders WHERE id=?',[id]))[0];
        if (!previous) throw fail('ORDER_NOT_FOUND','Investing order not found.',404);
        if ((patch.filled_qty!==undefined && patch.filled_qty<previous.filled_qty) || (finalStatuses.has(previous.status) && patch.status && !finalStatuses.has(patch.status))) throw fail('EVIDENCE_REGRESSED','Broker evidence regressed. Review this order before continuing.',503);
        if (selected.every(key=>patch[key]===previous[key])) return;
        await run(c,'UPDATE alpaca_investing_orders SET '+selected.map(k => k+'=?').join(',')+',updated_at=? WHERE id=?', [...selected.map(k=>patch[k]),new Date().toISOString(),id]);
        await run(c,'UPDATE alpaca_investing_settings SET sequence=sequence+1 WHERE id=1');
        await event(c,'order_observed',{ id, ...patch });
    });
}
async function saveDecision(input) {
    if (typeof input?.decisionKey !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(input.decisionKey) || typeof input.symbol !== 'string' || !/^[A-Z][A-Z0-9.\-]{0,9}$/.test(input.symbol) || !['buy','sell'].includes(input.side) || typeof input.reason !== 'string' || input.reason.trim().length < 10 || input.reason.length > 1000 || !Number.isSafeInteger(input.policyVersion) || input.policyVersion<0) throw fail('INVALID_DECISION','Provide a unique decisionKey, current policyVersion, symbol, side and analysis reason (10–1000 characters).',400);
    return transaction(async c => {
        const existing = (await all(c,'SELECT * FROM alpaca_investing_decisions WHERE decision_key=?',[input.decisionKey]))[0];
        if (existing) {
            if (existing.symbol !== input.symbol || existing.side !== input.side || existing.reason !== input.reason || existing.policy_version!==input.policyVersion) throw fail('DECISION_CONFLICT','A decision key cannot be reused with different analysis.');
            return existing;
        }
        await run(c,'INSERT INTO alpaca_investing_decisions VALUES(?,?,?,?,?,?)',[input.decisionKey,input.symbol,input.side,input.reason,input.policyVersion,new Date().toISOString()]);
        return (await all(c,'SELECT * FROM alpaca_investing_decisions WHERE decision_key=?',[input.decisionKey]))[0];
    });
}
async function readDecisions(key) {
    return connection(async c=>(await all(c,`SELECT d.*,r.analysis_json,json_extract(p.packet_json,'$.generatedAt') AS packet_generated_at,
        (SELECT plan_json FROM alpaca_investing_plans WHERE json_extract(plan_json,'$.decisionKey')=d.decision_key ORDER BY rowid DESC LIMIT 1) AS last_plan,
        (SELECT detail_json FROM alpaca_investing_events WHERE action='decision_checked' AND json_extract(detail_json,'$.decisionKey')=d.decision_key ORDER BY id DESC LIMIT 1) AS last_check
        FROM alpaca_investing_decisions d LEFT JOIN research_decision_evidence r ON r.decision_key=?||d.decision_key
        LEFT JOIN research_packets p ON p.id=r.packet_id ${key===undefined?'':'WHERE d.decision_key=?'} ORDER BY d.created_at DESC LIMIT 100`,
        [environment === 'paper' ? 'paper:' : '',...(key===undefined?[]:[key])])).map(({analysis_json,last_plan,last_check,...row})=>({...row,
            analysis:analysis_json?JSON.parse(analysis_json):null,lastPlan:last_plan?JSON.parse(last_plan):null,lastCheck:last_check?JSON.parse(last_check):null})));
}
const decisions = () => readDecisions();
const getDecision = async key => (await readDecisions(key))[0] || null;
const recordDecisionCheck = (decisionKey,detail) => connection(c=>event(c,'decision_checked',{...detail,decisionKey}));
const ownership = () => connection(c=>all(c,'SELECT * FROM alpaca_investing_ownership ORDER BY id'));
async function adoptWithin(c,{accountKey,symbol,brokerQty,expectedOwned,policyVersion,reason}) {
        const current=await state(c);
        if (!current.policy.paused || current.version!==policyVersion || (current.accountKey && current.accountKey!==accountKey)) throw fail('STATE_CHANGED','Pause long-term orders and refresh before reviewing ownership.');
        const rows=await all(c,'SELECT * FROM alpaca_investing_orders');
        if (rows.some(o=>!finalStatuses.has(o.status))) throw fail('RECONCILIATION_REQUIRED','Outstanding orders must be reconciled first.');
        const adjustments=await all(c,'SELECT * FROM alpaca_investing_ownership WHERE account_key=? AND symbol=?',[accountKey,symbol]);
        const net=rows.filter(o=>o.account_key===accountKey && o.symbol===symbol).reduce((n,o)=>n+(o.side==='buy'?1:-1)*o.filled_qty,0)+adjustments.reduce((n,a)=>n+a.delta_qty,0);
        if (Math.abs(net-expectedOwned)>1e-7) throw fail('STATE_CHANGED','Ownership evidence changed. Refresh before reviewing.');
        if (Math.abs(brokerQty-net)<1e-7) return {symbol,ownedQty:net,replayed:true};
        await run(c,'UPDATE alpaca_investing_settings SET account_key=?,version=version+1 WHERE id=1',[accountKey]);
        await run(c,'INSERT INTO alpaca_investing_ownership(account_key,symbol,delta_qty,broker_qty,reason,created_at) VALUES(?,?,?,?,?,?)',[accountKey,symbol,brokerQty-net,brokerQty,reason,new Date().toISOString()]);
        await event(c,'ownership_reviewed',{symbol,previousQty:net,brokerQty,reason});
        return {symbol,ownedQty:brokerQty,replayed:false};
}
const adopt = input => transaction(c => adoptWithin(c,input));
const handovers = () => environment === 'paper' ? connection(c => all(c,'SELECT * FROM alpaca_investing_legacy_handovers ORDER BY id')) : Promise.resolve([]);
async function transferLegacy(input) {
    if (environment !== 'paper') throw fail('HANDOVER_UNAVAILABLE','Legacy paper holdings cannot be transferred to live investing.');
    return transaction(async c => {
        const {validateTransfer} = require('./alpaca_paper_handover');
        await validateTransfer(c,input);
        input.assertFresh();
        const result = await adoptWithin(c,input);
        for (const evidence of input.plans) await run(c,'INSERT INTO alpaca_investing_legacy_handovers(account_key,symbol,legacy_version,plan_id,plan_state,evidence_hash,evidence_json,transferred_qty,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
            [input.accountKey,input.symbol,evidence.version,evidence.id,evidence.state,evidence.hash,JSON.stringify(evidence),evidence.remainingQty,input.reason,new Date().toISOString()]);
        await event(c,'legacy_holdings_transferred',{symbol:input.symbol,qty:input.brokerQty,plans:input.plans.map(p=>({version:p.version,id:p.id})),reason:input.reason});
        return {...result,transferredPlans:input.plans.map(p=>({version:p.version,id:p.id}))};
    });
}
return { init, settings, savePolicy, orders, getPlan, savePlan, reserveOrder, dispatchOrder, updateOrder, hash, finalStatuses, DEFAULT_POLICY, validatePolicy, saveDecision, decisions, getDecision, recordDecisionCheck, ownership, adopt, handovers, transferLegacy };

}
module.exports = { createLongTermStore, DEFAULT_POLICY };
