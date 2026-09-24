const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_v2_store.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');

function exec(sql) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.exec(sql, (err) => { sqlite.close(); err ? reject(err) : resolve(); }));
}

function count(table) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.get(`SELECT COUNT(*) AS n FROM ${table}`, (err, row) => {
        sqlite.close(); err ? reject(err) : resolve(row.n);
    }));
}

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    await exec(`
        DROP TRIGGER IF EXISTS test_block_v2_events;
        DROP TRIGGER IF EXISTS alpaca_dt_v2_events_no_delete;
        DELETE FROM alpaca_dt_v2_events;
        DELETE FROM alpaca_dt_v2_fills;
        DELETE FROM alpaca_dt_v2_plans;
        UPDATE alpaca_dt_v2_monitor_state SET mode = 'disabled', kill_switch = 0, attention_required = 0, attention_code = NULL, last_reconciled_at = NULL, last_websocket_at = NULL, session_date = NULL WHERE id = 1;
        CREATE TRIGGER IF NOT EXISTS alpaca_dt_v2_events_no_delete BEFORE DELETE ON alpaca_dt_v2_events BEGIN SELECT RAISE(ABORT, 'alpaca_dt_v2_events is immutable'); END;
    `);
});

function planInput(overrides = {}) {
    return {
        client_order_id: 'dt2-20260923-nvda-orb',
        symbol: 'NVDA',
        setup: 'opening-range breakout',
        catalyst: 'earnings beat',
        thesis: 'holds above opening range',
        invalidation: 'loses VWAP',
        planned_qty: 10,
        planned_entry_price: 100.5,
        planned_stop: 98,
        planned_target: 104,
        planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:45:00.000Z',
        ...overrides,
    };
}

test('plan and its submission_started event insert atomically', async () => {
    const { plan, event } = await store.createPlan(planInput());
    assert.strictEqual(plan.state, 'pending_submission');
    assert.strictEqual(plan.client_order_id, 'dt2-20260923-nvda-orb');
    assert.strictEqual(event.plan_id, plan.id);
    assert.strictEqual(event.event_type, 'submission');
    assert.strictEqual(event.action, 'submission_started');

    // If the event cannot be written, the plan must not exist either.
    await exec(`CREATE TRIGGER test_block_v2_events BEFORE INSERT ON alpaca_dt_v2_events BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    await assert.rejects(store.createPlan(planInput({ client_order_id: 'dt2-20260923-amd-orb', symbol: 'AMD' })));
    assert.strictEqual(await store.getPlanByClientOrderId('dt2-20260923-amd-orb'), null);
    assert.strictEqual(await count('alpaca_dt_v2_plans'), 1);
});

test('a duplicate client order id is rejected without creating another plan or event', async () => {
    await store.createPlan(planInput());
    await assert.rejects(
        store.createPlan(planInput({ symbol: 'AMD' })),
        (err) => err.code === 'ALPACA_V2_DUPLICATE_CLIENT_ORDER_ID',
    );
    assert.strictEqual(await count('alpaca_dt_v2_plans'), 1);
    assert.strictEqual(await count('alpaca_dt_v2_events'), 1);
});

test('only one nonterminal v2 plan may exist per symbol', async () => {
    await store.createPlan(planInput());
    await assert.rejects(
        store.createPlan(planInput({ client_order_id: 'dt2-20260923-nvda-second' })),
        (err) => err.code === 'ALPACA_V2_DUPLICATE_SYMBOL_PLAN',
    );
});

test('a fill identity replayed with identical facts is a no-op', async () => {
    const fill = {
        execution_id: 'aaaaaaaa-1111-4111-8111-111111111111', order_id: 'order-1', side: 'buy', qty: 10, price: 100.25,
        executed_at: '2026-09-23T13:31:00.000Z', source: 'websocket', symbol: 'NVDA',
    };
    const first = await store.recordFill(fill);
    const replay = await store.recordFill({ ...fill, source: 'rest' });
    assert.strictEqual(first.inserted, true);
    assert.strictEqual(replay.inserted, false);
    assert.strictEqual(await count('alpaca_dt_v2_fills'), 1);
});

test('the same fill identity with different material facts is an integrity error, not a silent dedupe', async () => {
    const fill = {
        execution_id: 'bbbbbbbb-1111-4111-8111-111111111111', order_id: 'order-1', side: 'buy', qty: 10, price: 100.25,
        executed_at: '2026-09-23T13:31:00.000Z', source: 'websocket', symbol: 'NVDA',
    };
    await store.recordFill(fill);
    for (const divergent of [{ qty: 9 }, { price: 100.3 }, { side: 'sell' }, { order_id: 'order-2' }, { symbol: 'AMD' }]) {
        await assert.rejects(store.recordFill({ ...fill, ...divergent }), (err) => err.code === 'ALPACA_V2_FILL_CONFLICT', JSON.stringify(divergent));
    }
    const stored = await store.listFills();
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].qty, 10);
});

test('event details keep only allowlisted fields and redact forbidden string values', async () => {
    const { event } = await store.appendEvent({
        event_key: 'test:sanitize', plan_id: null, event_type: 'anomaly', action: 'reconcile', outcome: 'attention', reason_code: 'UNEXPECTED_ORDER',
        detail: {
            symbol: 'NVDA', qty: 5, price: 101.2,
            account_id: 'acct-123', order_id: 'ord-1', client_order_id: 'dt2-x', raw: { anything: 1 }, url: 'https://paper-api.alpaca.markets/v2/orders',
            error: 'Alpaca paper request failed', api_key: 'PK123',
            note: 'order 9f1c2d3e-1111-4222-8333-444455556666 via https://paper-api.alpaca.markets for dt2-20260923-nvda-orb',
        },
        occurred_at: '2026-09-23T14:00:00.000Z',
    });
    const detail = JSON.parse(event.detail_json);
    assert.deepStrictEqual(Object.keys(detail).sort(), ['note', 'price', 'qty', 'symbol']);
    assert.doesNotMatch(detail.note, /9f1c2d3e|https?:|alpaca\.markets|dt2-/);
});

test('event keys are immutable and a conflicting payload for an existing key is refused', async () => {
    const base = { event_key: 'test:immutable', plan_id: null, event_type: 'decision', action: 'no_trade', outcome: 'skipped', reason_code: 'NO_SETUP', detail: { symbol: 'NVDA' }, occurred_at: '2026-09-23T14:00:00.000Z' };
    assert.strictEqual((await store.appendEvent(base)).inserted, true);
    assert.strictEqual((await store.appendEvent(base)).inserted, false);
    await assert.rejects(store.appendEvent({ ...base, reason_code: 'OTHER' }), (err) => err.code === 'ALPACA_V2_EVENT_KEY_CONFLICT');
});

test('monitor state is a singleton that defaults to disabled with no attention latch', async () => {
    const state = await store.getMonitorState();
    assert.strictEqual(state.mode, 'disabled');
    assert.strictEqual(state.attention_required, 0);
    assert.strictEqual(state.kill_switch, 0);
    await store.updateMonitorState({ mode: 'shadow', last_reconciled_at: '2026-09-23T14:00:00.000Z' });
    assert.strictEqual((await store.getMonitorState()).mode, 'shadow');
});

test('latching attention marks the plan, blocks the account, and journals one anomaly event', async () => {
    const { plan } = await store.createPlan(planInput());
    await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN`, detail: { symbol: 'NVDA' } });
    await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN`, detail: { symbol: 'NVDA' } });
    const updated = await store.getPlan(plan.id);
    assert.strictEqual(updated.state, 'attention_required');
    assert.strictEqual(updated.attention_code, 'SUBMISSION_UNKNOWN');
    const state = await store.getMonitorState();
    assert.strictEqual(state.attention_required, 1);
    assert.strictEqual(state.attention_code, 'SUBMISSION_UNKNOWN');
    const anomalies = (await store.listEvents()).filter((e) => e.event_type === 'anomaly');
    assert.strictEqual(anomalies.length, 1);
});

test('updatePlan refuses to move a terminal plan and rejects unknown fields', async () => {
    const { plan } = await store.createPlan(planInput());
    await store.updatePlan(plan.id, { state: 'rejected' });
    await assert.rejects(store.updatePlan(plan.id, { state: 'working' }), (err) => err.code === 'ALPACA_V2_PLAN_TERMINAL');
    await assert.rejects(store.updatePlan(plan.id, { nonsense: 1 }), /unknown v2 plan field/);
});
