'use strict';

// Alpaca Day Trading v2 persistence. Deliberately independent of every v1 helper: short local
// transactions only (BEGIN IMMEDIATE), never a distributed transaction with Alpaca. Broker
// identifiers live in plan/fill columns so the monitor can resolve broker truth, but they are
// never written into the journal and never returned by reader routes.
const db = require('../database/db');

const PLAN_STATES = ['pending_submission', 'submission_unknown', 'working', 'active', 'time_exit_pending', 'attention_required', 'closed', 'cancelled', 'rejected'];
const TERMINAL_STATES = ['closed', 'cancelled', 'rejected'];
const NONTERMINAL_STATES = PLAN_STATES.filter((state) => !TERMINAL_STATES.includes(state));

const PLAN_UPDATE_FIELDS = new Set([
    'state', 'attention_code', 'parent_order_id', 'stop_order_id', 'target_order_id', 'exit_order_id',
    'filled_entry_qty', 'avg_entry_price', 'filled_exit_qty', 'avg_exit_price', 'exit_reason',
    'realized_pnl', 'realized_r', 'opened_at', 'closed_at',
]);
const MONITOR_UPDATE_FIELDS = new Set(['mode', 'kill_switch', 'attention_required', 'attention_code', 'last_reconciled_at', 'last_websocket_at', 'session_date']);

// Journal detail is an allowlist of user-meaningful primitives. Anything else -- account ids,
// broker/client order ids, raw bodies, URLs, credentials, exception text -- is dropped by key.
const DETAIL_KEYS = new Set([
    'symbol', 'qty', 'price', 'side', 'stop', 'target', 'entry_price', 'exit_price', 'exit_deadline',
    'planned_qty', 'filled_qty', 'remaining_qty', 'position_qty', 'avg_entry_price', 'avg_exit_price',
    'realized_pnl', 'realized_r', 'from', 'to', 'mode', 'state', 'role', 'source', 'setup', 'catalyst',
    'thesis_valid', 'notes', 'note', 'mfe', 'mae', 'broker_status', 'count', 'window', 'session_date', 'reason', 'exit_reason',
]);
// ...and allowed string values are still scrubbed of anything identifier- or endpoint-shaped.
const REDACTIONS = [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, // broker UUIDs
    /\bhttps?:\/\/\S+/gi,
    /\bwss?:\/\/\S+/gi,
    /\b[\w.-]*alpaca\.markets\S*/gi,
    /\bdt2?-[A-Za-z0-9-]+/g, // v1/v2 client order ids
    /\b[A-Za-z0-9_]{24,}\b/g, // credential/token-shaped runs
];
const MAX_DETAIL_STRING = 500;

function storeError(code, message) {
    return Object.assign(new Error(message), { code });
}

function redactString(value) {
    let text = String(value).slice(0, MAX_DETAIL_STRING);
    for (const pattern of REDACTIONS) text = text.replace(pattern, '[redacted]');
    return text;
}

function sanitizeDetail(detail) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return {};
    const clean = {};
    for (const key of Object.keys(detail).sort()) {
        if (!DETAIL_KEYS.has(key)) continue;
        const value = detail[key];
        if (value === null || typeof value === 'boolean') clean[key] = value;
        else if (typeof value === 'number') { if (Number.isFinite(value)) clean[key] = value; }
        else if (typeof value === 'string') clean[key] = redactString(value);
    }
    return clean;
}

function connect() {
    const sqlite = db.getDb();
    return {
        run: (sql, params = []) => new Promise((resolve, reject) => sqlite.run(sql, params, function onRun(err) {
            err ? reject(err) : resolve({ changes: this.changes, lastID: this.lastID });
        })),
        get: (sql, params = []) => new Promise((resolve, reject) => sqlite.get(sql, params, (err, row) => (err ? reject(err) : resolve(row || null)))),
        all: (sql, params = []) => new Promise((resolve, reject) => sqlite.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])))),
        close: () => new Promise((resolve) => sqlite.close(() => resolve())),
    };
}

async function withConnection(fn) {
    const c = connect();
    try { return await fn(c); } finally { await c.close(); }
}

async function transaction(fn) {
    return withConnection(async (c) => {
        await c.run('BEGIN IMMEDIATE');
        try {
            const result = await fn(bind(c));
            await c.run('COMMIT');
            return result;
        } catch (error) {
            await c.run('ROLLBACK').catch(() => {});
            throw error;
        }
    });
}

const nowIso = () => new Date().toISOString();

// ---- operations; every one takes a connection first so they compose inside transaction() ----

async function insertEvent(c, event) {
    const row = {
        event_key: String(event.event_key || '').trim(),
        plan_id: event.plan_id == null ? null : Number(event.plan_id),
        event_type: String(event.event_type || '').trim(),
        action: event.action == null ? null : String(event.action),
        outcome: event.outcome == null ? null : String(event.outcome),
        reason_code: event.reason_code == null ? null : String(event.reason_code),
        detail_json: JSON.stringify(sanitizeDetail(event.detail)),
        occurred_at: String(event.occurred_at || nowIso()),
    };
    if (!row.event_key || !row.event_type) throw new Error('invalid v2 event');
    const result = await c.run(
        `INSERT OR IGNORE INTO alpaca_dt_v2_events (event_key, plan_id, event_type, action, outcome, reason_code, detail_json, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.event_key, row.plan_id, row.event_type, row.action, row.outcome, row.reason_code, row.detail_json, row.occurred_at],
    );
    const stored = await c.get('SELECT * FROM alpaca_dt_v2_events WHERE event_key = ?', [row.event_key]);
    const inserted = result.changes === 1;
    // A replay may carry a later wall-clock time; only the material payload has to agree.
    if (!inserted && ['plan_id', 'event_type', 'action', 'outcome', 'reason_code', 'detail_json'].some((k) => stored[k] !== row[k])) {
        throw storeError('ALPACA_V2_EVENT_KEY_CONFLICT', 'v2 event key already used for a different payload');
    }
    return { inserted, event: stored };
}

async function getPlan(c, id) {
    return c.get('SELECT * FROM alpaca_dt_v2_plans WHERE id = ?', [Number(id)]);
}

async function getPlanByClientOrderId(c, clientOrderId) {
    return c.get('SELECT * FROM alpaca_dt_v2_plans WHERE client_order_id = ?', [String(clientOrderId)]);
}

async function listPlans(c, { states = null } = {}) {
    if (!states) return c.all('SELECT * FROM alpaca_dt_v2_plans ORDER BY id DESC');
    return c.all(`SELECT * FROM alpaca_dt_v2_plans WHERE state IN (${states.map(() => '?').join(',')}) ORDER BY id DESC`, states);
}

async function insertPlan(c, input) {
    const occurredAt = input.occurred_at || nowIso();
    let lastID;
    try {
        ({ lastID } = await c.run(
            `INSERT INTO alpaca_dt_v2_plans (client_order_id, symbol, setup, catalyst, thesis, invalidation, planned_qty,
                planned_entry_price, planned_stop, planned_target, planned_risk_dollars, exit_deadline, state, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_submission', ?, ?)`,
            [input.client_order_id, input.symbol, input.setup, input.catalyst, input.thesis, input.invalidation, input.planned_qty,
                input.planned_entry_price, input.planned_stop, input.planned_target, input.planned_risk_dollars, input.exit_deadline,
                occurredAt, occurredAt],
        ));
    } catch (error) {
        if (/UNIQUE constraint failed: alpaca_dt_v2_plans\.client_order_id/.test(error.message)) {
            throw storeError('ALPACA_V2_DUPLICATE_CLIENT_ORDER_ID', 'this client order id already has a v2 plan');
        }
        if (/UNIQUE constraint failed: alpaca_dt_v2_plans\.symbol/.test(error.message)) {
            throw storeError('ALPACA_V2_DUPLICATE_SYMBOL_PLAN', 'a nonterminal v2 plan already exists for this symbol');
        }
        throw error;
    }
    const plan = await getPlan(c, lastID);
    const { event } = await insertEvent(c, {
        event_key: `plan:${plan.id}:submission_started`, plan_id: plan.id, event_type: 'submission', action: 'submission_started',
        outcome: 'pending', detail: {
            symbol: plan.symbol, planned_qty: plan.planned_qty, entry_price: plan.planned_entry_price, stop: plan.planned_stop,
            target: plan.planned_target, exit_deadline: plan.exit_deadline, setup: plan.setup, catalyst: plan.catalyst,
        },
        occurred_at: occurredAt,
    });
    return { plan, event };
}

async function updatePlanRow(c, id, patch = {}, { expectState = null, events = [] } = {}) {
    const keys = Object.keys(patch);
    const unknown = keys.filter((key) => !PLAN_UPDATE_FIELDS.has(key));
    if (unknown.length) throw new Error(`unknown v2 plan field: ${unknown.join(', ')}`);
    if (patch.state !== undefined && !PLAN_STATES.includes(patch.state)) throw new Error(`invalid v2 plan state: ${patch.state}`);
    const current = await getPlan(c, id);
    if (!current) throw storeError('ALPACA_V2_PLAN_NOT_FOUND', 'v2 plan not found');
    if (expectState && ![].concat(expectState).includes(current.state)) {
        throw storeError('ALPACA_V2_PLAN_STATE_CHANGED', `v2 plan is ${current.state}, not ${expectState}`);
    }
    if (patch.state !== undefined && patch.state !== current.state && TERMINAL_STATES.includes(current.state)) {
        throw storeError('ALPACA_V2_PLAN_TERMINAL', 'a terminal v2 plan cannot change state');
    }
    if (keys.length) {
        await c.run(
            `UPDATE alpaca_dt_v2_plans SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
            [...keys.map((key) => patch[key]), nowIso(), Number(id)],
        );
    }
    for (const event of events) await insertEvent(c, { plan_id: Number(id), ...event });
    return getPlan(c, id);
}

async function getMonitorState(c) {
    return c.get('SELECT * FROM alpaca_dt_v2_monitor_state WHERE id = 1');
}

async function updateMonitorStateRow(c, patch = {}) {
    const keys = Object.keys(patch);
    const unknown = keys.filter((key) => !MONITOR_UPDATE_FIELDS.has(key));
    if (unknown.length) throw new Error(`unknown v2 monitor field: ${unknown.join(', ')}`);
    if (!keys.length) return getMonitorState(c);
    const values = keys.map((key) => (typeof patch[key] === 'boolean' ? Number(patch[key]) : patch[key]));
    await c.run(`UPDATE alpaca_dt_v2_monitor_state SET ${keys.map((key) => `${key} = ?`).join(', ')}, updated_at = ? WHERE id = 1`, [...values, nowIso()]);
    return getMonitorState(c);
}

// The one fail-closed primitive: the plan (if any) and the account both latch, with one
// sanitized anomaly event. Replays of the same eventKey are no-ops.
async function latchAttentionRow(c, { planId = null, code, eventKey, detail = {}, occurredAt = nowIso() }) {
    if (!code || !eventKey) throw new Error('attention latch requires a code and an event key');
    if (planId != null) {
        const plan = await getPlan(c, planId);
        if (plan && !TERMINAL_STATES.includes(plan.state)) {
            await c.run(`UPDATE alpaca_dt_v2_plans SET state = 'attention_required', attention_code = ?, updated_at = ? WHERE id = ?`, [code, nowIso(), plan.id]);
        }
    }
    await updateMonitorStateRow(c, { attention_required: 1, attention_code: code });
    return insertEvent(c, {
        event_key: eventKey, plan_id: planId, event_type: 'anomaly', action: 'latch_attention', outcome: 'attention_required',
        reason_code: code, detail, occurred_at: occurredAt,
    });
}

const FILL_MATERIAL = ['order_id', 'symbol', 'side', 'qty', 'price'];

async function recordFillRow(c, fill) {
    const row = {
        execution_id: String(fill.execution_id || ''),
        plan_id: fill.plan_id == null ? null : Number(fill.plan_id),
        order_id: String(fill.order_id || ''),
        order_client_id: fill.order_client_id == null ? null : String(fill.order_client_id),
        symbol: String(fill.symbol || '').toUpperCase(),
        side: fill.side,
        qty: Number(fill.qty),
        price: Number(fill.price),
        role: fill.role || null,
        executed_at: String(fill.executed_at || ''),
        source: fill.source,
    };
    if (!row.execution_id || !row.order_id || !row.symbol || !['buy', 'sell'].includes(row.side)
        || !Number.isInteger(row.qty) || row.qty <= 0 || !(row.price > 0) || !row.executed_at) {
        throw storeError('ALPACA_V2_FILL_INVALID', 'v2 fill is missing or has malformed material facts');
    }
    const existing = await c.get('SELECT * FROM alpaca_dt_v2_fills WHERE execution_id = ?', [row.execution_id]);
    if (existing) {
        const divergent = FILL_MATERIAL.filter((key) => (key === 'price' || key === 'qty'
            ? Math.abs(Number(existing[key]) - row[key]) > 1e-9 : existing[key] !== row[key]));
        if (divergent.length) {
            throw storeError('ALPACA_V2_FILL_CONFLICT', `fill identity reported with divergent ${divergent.join(', ')}`);
        }
        return { inserted: false, fill: existing };
    }
    const { lastID } = await c.run(
        `INSERT INTO alpaca_dt_v2_fills (execution_id, plan_id, order_id, order_client_id, symbol, side, qty, price, role, executed_at, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.execution_id, row.plan_id, row.order_id, row.order_client_id, row.symbol, row.side, row.qty, row.price, row.role, row.executed_at, row.source],
    );
    return { inserted: true, fill: await c.get('SELECT * FROM alpaca_dt_v2_fills WHERE id = ?', [lastID]) };
}

async function attachFillRow(c, fillId, { planId, role }) {
    await c.run('UPDATE alpaca_dt_v2_fills SET plan_id = ?, role = ? WHERE id = ?', [Number(planId), role, Number(fillId)]);
    return c.get('SELECT * FROM alpaca_dt_v2_fills WHERE id = ?', [Number(fillId)]);
}

const ops = {
    getPlan,
    getPlanByClientOrderId,
    listPlans,
    listNonterminalPlans: (c) => listPlans(c, { states: NONTERMINAL_STATES }),
    createPlan: insertPlan,
    updatePlan: updatePlanRow,
    appendEvent: insertEvent,
    getEventByKey: (c, key) => c.get('SELECT * FROM alpaca_dt_v2_events WHERE event_key = ?', [String(key)]),
    listEvents: (c, planId = null) => (planId == null
        ? c.all('SELECT * FROM alpaca_dt_v2_events ORDER BY occurred_at ASC, id ASC')
        : c.all('SELECT * FROM alpaca_dt_v2_events WHERE plan_id = ? ORDER BY occurred_at ASC, id ASC', [Number(planId)])),
    recordFill: recordFillRow,
    attachFill: attachFillRow,
    listFills: (c, { planId, unattached = false } = {}) => {
        if (unattached) return c.all('SELECT * FROM alpaca_dt_v2_fills WHERE plan_id IS NULL ORDER BY executed_at ASC, id ASC');
        if (planId != null) return c.all('SELECT * FROM alpaca_dt_v2_fills WHERE plan_id = ? ORDER BY executed_at ASC, id ASC', [Number(planId)]);
        return c.all('SELECT * FROM alpaca_dt_v2_fills ORDER BY executed_at ASC, id ASC');
    },
    getMonitorState,
    updateMonitorState: updateMonitorStateRow,
    latchAttention: latchAttentionRow,
};

const READ_OPS = new Set(['getPlan', 'getPlanByClientOrderId', 'listPlans', 'listNonterminalPlans', 'getEventByKey', 'listEvents', 'listFills', 'getMonitorState']);

function bind(c) {
    return Object.fromEntries(Object.entries(ops).map(([name, fn]) => [name, (...args) => fn(c, ...args)]));
}

const api = Object.fromEntries(Object.entries(ops).map(([name, fn]) => [
    name,
    READ_OPS.has(name)
        ? (...args) => withConnection((c) => fn(c, ...args))
        : (...args) => transaction((repo) => repo[name](...args)),
]));

module.exports = {
    ...api,
    transaction,
    sanitizeDetail,
    PLAN_STATES,
    TERMINAL_STATES,
    NONTERMINAL_STATES,
};
