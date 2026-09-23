const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_v2_reconciliation.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const {
    normalizeV2WebSocketFill, normalizeV2RestFill, ingestFill, reconcileRestFills, attachPendingFills, canonicalExecutionId,
} = require('../services/alpaca_day_trade_v2_reconciliation');
const { resolvePlanByClientOrderId } = require('../services/alpaca_day_trade_v2_execution');
const { createTradeUpdatesStream } = require('../services/alpaca_trade_updates_stream');

const NOW = new Date('2026-09-23T15:00:00.000Z');
const EXEC = '2f63ea93-423d-4169-b3f6-3fdafc10c418';

function exec(sql) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.exec(sql, (err) => { sqlite.close(); err ? reject(err) : resolve(); }));
}

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    await exec(`
        DROP TRIGGER IF EXISTS alpaca_dt_v2_events_no_delete;
        DELETE FROM alpaca_dt_v2_events; DELETE FROM alpaca_dt_v2_fills; DELETE FROM alpaca_dt_v2_plans;
        CREATE TRIGGER alpaca_dt_v2_events_no_delete BEFORE DELETE ON alpaca_dt_v2_events BEGIN SELECT RAISE(ABORT, 'alpaca_dt_v2_events is immutable'); END;
    `);
    await store.updateMonitorState({ mode: 'shadow', kill_switch: 0, attention_required: 0, attention_code: null });
});

async function seedPlan({ linked = true, state = 'working' } = {}) {
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 'orb', catalyst: 'earnings', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z', occurred_at: '2026-09-23T14:00:00.000Z',
    });
    if (!linked) return plan;
    return store.updatePlan(plan.id, { state, parent_order_id: 'parent-1', stop_order_id: 'stop-1', target_order_id: 'target-1' });
}

function wsFill(overrides = {}, order = {}) {
    return {
        event: 'fill', execution_id: EXEC, price: '100.40', qty: '10', position_qty: '10', timestamp: '2026-09-23T14:31:00.123Z',
        order: { id: 'parent-1', client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', side: 'buy', ...order },
        ...overrides,
    };
}

function restFill(overrides = {}) {
    return {
        id: `20260923143100123::${EXEC}`, activity_type: 'FILL', order_id: 'parent-1', symbol: 'NVDA', side: 'buy',
        qty: '10', price: '100.40', transaction_time: '2026-09-23T14:31:00.123Z', type: 'fill', ...overrides,
    };
}

function restClient(activities) {
    return { getAccountActivities: async () => activities };
}

async function fillEvents() {
    return (await store.listEvents()).filter((event) => event.event_type === 'fill');
}

test('the documented REST timestamp::UUID id canonicalizes to the WebSocket execution UUID; nothing else is rewritten', () => {
    assert.strictEqual(canonicalExecutionId(`20260923143100123::${EXEC}`), EXEC);
    assert.strictEqual(canonicalExecutionId(EXEC), EXEC);
    assert.strictEqual(canonicalExecutionId('123::abc'), '123::abc');
    assert.strictEqual(canonicalExecutionId(`2026::${EXEC}`), `2026::${EXEC}`);
});

test('WebSocket first, REST second: exactly one fill and one semantic fill event', async () => {
    const plan = await seedPlan();
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill()), now: () => NOW });
    await reconcileRestFills({ store, client: restClient([restFill()]), now: () => NOW });
    assert.strictEqual((await store.listFills()).length, 1);
    assert.strictEqual((await fillEvents()).length, 1);
    const updated = await store.getPlan(plan.id);
    assert.strictEqual(updated.filled_entry_qty, 10);
    assert.strictEqual(updated.avg_entry_price, 100.4);
    assert.strictEqual(updated.state, 'active');
});

test('REST first, WebSocket second: exactly one fill and one event', async () => {
    await seedPlan();
    await reconcileRestFills({ store, client: restClient([restFill()]), now: () => NOW });
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill()), now: () => NOW });
    assert.strictEqual((await store.listFills()).length, 1);
    assert.strictEqual((await fillEvents()).length, 1);
});

test('a WebSocket fill before parent-id linkage attaches through the order client id', async () => {
    const plan = await seedPlan({ linked: false });
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill({}, { id: 'parent-unknown-yet' })), now: () => NOW });
    const [fill] = await store.listFills();
    assert.strictEqual(fill.plan_id, plan.id);
    assert.strictEqual(fill.role, 'entry');
});

test('a fill that arrives before linkage without a client id is held provisionally, then attached once the plan resolves by client id', async () => {
    const plan = await seedPlan({ linked: false });
    await reconcileRestFills({ store, client: restClient([restFill()]), now: () => NOW });
    let [fill] = await store.listFills();
    assert.strictEqual(fill.plan_id, null, 'no linkage yet: provisional');
    assert.strictEqual((await fillEvents()).length, 0);

    await resolvePlanByClientOrderId({
        store, plan, now: () => NOW,
        client: { getOrderByClientOrderId: async () => ({ found: true, order: { id: 'parent-1', symbol: 'NVDA', side: 'buy', status: 'filled', filled_qty: '10', legs: [{ id: 'stop-1', type: 'stop' }, { id: 'target-1', type: 'limit' }] } }) },
    });
    await attachPendingFills({ store, now: () => NOW });
    [fill] = await store.listFills();
    assert.strictEqual(fill.plan_id, plan.id);
    assert.strictEqual((await fillEvents()).length, 1);
    assert.strictEqual((await store.getPlan(plan.id)).filled_entry_qty, 10);
});

test('the same execution identity with divergent material facts latches attention instead of deduplicating', async () => {
    const plan = await seedPlan();
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill()), now: () => NOW });
    const result = await reconcileRestFills({ store, client: restClient([restFill({ qty: '9' })]), now: () => NOW });
    assert.strictEqual(result.conflicts, 1);
    const state = await store.getMonitorState();
    assert.strictEqual(state.attention_required, 1);
    assert.strictEqual(state.attention_code, 'FILL_CONFLICT');
    assert.strictEqual((await store.getPlan(plan.id)).state, 'attention_required');
    assert.strictEqual((await store.listFills())[0].qty, 10);
});

test('restart with fills present but a stale summary repairs the summary without duplicating events', async () => {
    const plan = await seedPlan();
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill()), now: () => NOW });
    // Simulate a crash that lost the derived summary after the fill row committed.
    await store.updatePlan(plan.id, { filled_entry_qty: 0, avg_entry_price: null });
    await reconcileRestFills({ store, client: restClient([restFill()]), now: () => NOW });
    const repaired = await store.getPlan(plan.id);
    assert.strictEqual(repaired.filled_entry_qty, 10);
    assert.strictEqual(repaired.avg_entry_price, 100.4);
    assert.strictEqual((await fillEvents()).length, 1);
});

test('fill, fill event, and plan summary commit together: a failed event write leaves no fill row behind', async () => {
    await seedPlan();
    await exec(`CREATE TRIGGER test_block_fill_events BEFORE INSERT ON alpaca_dt_v2_events WHEN NEW.event_type = 'fill' BEGIN SELECT RAISE(ABORT, 'blocked'); END;`);
    try {
        await assert.rejects(ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill()), now: () => NOW }));
        assert.strictEqual((await store.listFills()).length, 0);
    } finally {
        await exec('DROP TRIGGER IF EXISTS test_block_fill_events');
    }
});

test('weighted entry and exit prices come from canonical v2 fills; bracket and time-exit roles are fixed', async () => {
    const plan = await seedPlan();
    await store.updatePlan(plan.id, { exit_order_id: 'exit-1' });
    const fills = [
        restFill({ id: `20260923143100123::${EXEC}`, qty: '4', price: '100.00' }),
        restFill({ id: '20260923143100456::3f63ea93-423d-4169-b3f6-3fdafc10c418', qty: '6', price: '101.00' }),
        restFill({ id: '20260923150000000::4f63ea93-423d-4169-b3f6-3fdafc10c418', order_id: 'target-1', side: 'sell', qty: '5', price: '104.00' }),
        restFill({ id: '20260923193000000::5f63ea93-423d-4169-b3f6-3fdafc10c418', order_id: 'exit-1', side: 'sell', qty: '5', price: '102.00' }),
    ];
    await reconcileRestFills({ store, client: restClient(fills), now: () => NOW });
    const updated = await store.getPlan(plan.id);
    assert.strictEqual(updated.filled_entry_qty, 10);
    assert.strictEqual(updated.avg_entry_price, 100.6);
    assert.strictEqual(updated.filled_exit_qty, 10);
    assert.strictEqual(updated.avg_exit_price, 103);
    const roles = (await store.listFills({ planId: plan.id })).map((fill) => fill.role).sort();
    assert.deepStrictEqual(roles, ['bracket_exit', 'entry', 'entry', 'time_exit']);
});

test('a fill whose side does not match its order role latches attention', async () => {
    await seedPlan();
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill({}, { id: 'stop-1', side: 'buy' })), now: () => NOW });
    const state = await store.getMonitorState();
    assert.strictEqual(state.attention_required, 1);
    assert.strictEqual(state.attention_code, 'FILL_ROLE_MISMATCH');
});

test('exit fills beyond the entered quantity latch attention', async () => {
    await seedPlan();
    await reconcileRestFills({
        store, now: () => NOW,
        client: restClient([restFill(), restFill({ id: '20260923150000000::4f63ea93-423d-4169-b3f6-3fdafc10c418', order_id: 'stop-1', side: 'sell', qty: '11', price: '98' })]),
    });
    assert.strictEqual((await store.getMonitorState()).attention_code, 'FILL_OVERFILL');
});

test('fills unrelated to any v2 plan are ignored rather than stored as v2 orphans', async () => {
    await seedPlan();
    await ingestFill({ store, fill: normalizeV2WebSocketFill(wsFill({}, { id: 'v1-order', client_order_id: 'dt-legacy', symbol: 'AMD' })), now: () => NOW });
    assert.strictEqual((await store.listFills()).length, 0);
});

test('REST reconciliation is skipped entirely when no v2 plan is open', async () => {
    let called = false;
    await reconcileRestFills({ store, client: { getAccountActivities: async () => { called = true; return []; } }, now: () => NOW });
    assert.strictEqual(called, false);
});

test('the trade_updates stream accepts an injected v2 normalizer at its callback boundary', async () => {
    const wss = new WebSocket.Server({ port: 0 });
    await new Promise((resolve) => wss.on('listening', resolve));
    wss.on('connection', (ws) => ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.action === 'auth') ws.send(JSON.stringify({ stream: 'authorization', data: { status: 'authorized' } }));
        if (msg.action === 'listen') {
            ws.send(JSON.stringify({ stream: 'listening', data: { streams: ['trade_updates'] } }));
            ws.send(JSON.stringify({ stream: 'trade_updates', data: wsFill() }));
        }
    }));
    const received = [];
    const stream = createTradeUpdatesStream({
        url: `ws://127.0.0.1:${wss.address().port}`, apiKey: 'k', apiSecret: 's',
        normalize: normalizeV2WebSocketFill, onFill: (fill) => received.push(fill),
    });
    const deadline = Date.now() + 3000;
    while (!received.length && Date.now() < deadline) await new Promise((resolve) => { setTimeout(resolve, 10); });
    stream.close();
    await new Promise((resolve) => wss.close(resolve));
    assert.strictEqual(received.length, 1);
    assert.strictEqual(received[0].execution_id, EXEC);
    assert.strictEqual(received[0].order_client_id, 'dt2-20260923-nvda-orb');
    assert.strictEqual(received[0].source, 'websocket');
});

test('REST normalization maps the activity fields exactly', () => {
    assert.deepStrictEqual(normalizeV2RestFill(restFill()), {
        execution_id: EXEC, order_id: 'parent-1', order_client_id: null, symbol: 'NVDA', side: 'buy', qty: 10, price: 100.4,
        executed_at: '2026-09-23T14:31:00.123Z', source: 'rest',
    });
});
