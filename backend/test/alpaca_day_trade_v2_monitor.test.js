const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_v2_monitor.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Monitor } = require('../services/alpaca_day_trade_v2_monitor');
const { createV2MonitorWorker, nextDelayMs, acquireSingletonLock } = require('../workers/alpaca_day_trading_v2_monitor');

const BEFORE_DEADLINE = new Date('2026-09-23T15:00:00.000Z');
const AFTER_DEADLINE = new Date('2026-09-23T19:31:00.000Z');

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
    await store.updateMonitorState({ mode: 'paper_execute', kill_switch: 0, attention_required: 0, attention_code: null, last_reconciled_at: null });
});

const CID = 'dt2-20260923-nvda-orb';
let execSeq = 0;
function execId() {
    execSeq += 1;
    return `${String(execSeq).padStart(8, '0')}-1111-4111-8111-111111111111`;
}

// A small stateful paper broker: enough to express bracket parent/legs, positions, cancels,
// market exits, and the FILL activity feed. Every mutation is recorded.
function fakeBroker({ parentStatus = 'filled', filledQty = 10, legStatus = 'new', positionQty = 10 } = {}) {
    const broker = {
        mutations: [],
        activities: [],
        orders: new Map(),
        positions: new Map(),
        failReads: false,
        cancelBehavior: 'cancel', // 'cancel' | 'stuck' | 'fill_stop'
        exitFills: true,
        clock: { is_open: true, next_close: '2026-09-23T20:00:00.000Z' },
    };
    broker.orders.set('parent-1', {
        id: 'parent-1', client_order_id: CID, symbol: 'NVDA', side: 'buy', type: 'limit', qty: '10', filled_qty: String(filledQty), status: parentStatus,
        legs: [
            { id: 'target-1', symbol: 'NVDA', side: 'sell', type: 'limit', qty: '10', filled_qty: '0', status: legStatus, limit_price: '104' },
            { id: 'stop-1', symbol: 'NVDA', side: 'sell', type: 'stop', qty: '10', filled_qty: '0', status: legStatus, stop_price: '98' },
        ],
    });
    if (positionQty) broker.positions.set('NVDA', { symbol: 'NVDA', qty: String(positionQty), side: 'long' });
    if (filledQty) broker.activities.push({ id: `20260923143100123::${execId()}`, order_id: 'parent-1', symbol: 'NVDA', side: 'buy', qty: String(filledQty), price: '100.40', transaction_time: '2026-09-23T14:31:00.000Z', type: 'fill' });

    const read = (fn) => async (...args) => {
        if (broker.failReads) throw Object.assign(new Error('Alpaca paper request failed (503)'), { status: 503 });
        return fn(...args);
    };
    const leg = (id) => broker.orders.get('parent-1').legs.find((l) => l.id === id);
    const allOrders = () => {
        const out = [];
        for (const order of broker.orders.values()) { out.push(order); for (const l of order.legs || []) out.push(l); }
        return out;
    };
    const OPEN = ['new', 'accepted', 'pending_new', 'partially_filled', 'held'];
    broker.fillLeg = (id, price) => {
        const l = leg(id);
        l.status = 'filled'; l.filled_qty = l.qty;
        const other = broker.orders.get('parent-1').legs.find((x) => x.id !== id);
        other.status = 'canceled';
        broker.positions.delete('NVDA');
        broker.activities.push({ id: `20260923180000000::${execId()}`, order_id: id, symbol: 'NVDA', side: 'sell', qty: l.qty, price: String(price), transaction_time: '2026-09-23T18:00:00.000Z', type: 'fill' });
    };
    broker.client = {
        getClock: read(async () => broker.clock),
        getPosition: read(async (symbol) => broker.positions.get(symbol) || null),
        getPositions: read(async () => [...broker.positions.values()]),
        getOrder: read(async (id) => structuredClone(broker.orders.get(id) || allOrders().find((o) => o.id === id))),
        getOrders: read(async () => structuredClone(allOrders().filter((o) => OPEN.includes(o.status)))),
        getOrderByClientOrderId: read(async (cid) => {
            const order = [...broker.orders.values()].find((o) => o.client_order_id === cid);
            return order ? { found: true, order: structuredClone(order) } : { found: false, order: null };
        }),
        getAccountActivities: read(async () => structuredClone(broker.activities)),
        cancelOrder: async (id) => {
            broker.mutations.push(['cancel', id]);
            if (broker.cancelBehavior === 'stuck') return { canceled: true };
            if (broker.cancelBehavior === 'fill_stop') { broker.fillLeg('stop-1', 97.9); return { canceled: true }; }
            const target = broker.orders.get(id) || allOrders().find((o) => o.id === id);
            if (target.id === 'parent-1' && target.status === 'filled') {
                throw Object.assign(new Error('Alpaca paper request failed (422)'), { status: 422, code: 'ALPACA_BROKER_REJECTED' });
            }
            if (OPEN.includes(target.status)) target.status = 'canceled';
            // Alpaca OCO: cancelling one leg cancels its sibling.
            if (target.id !== 'parent-1') for (const l of broker.orders.get('parent-1').legs) if (OPEN.includes(l.status)) l.status = 'canceled';
            if (target.id === 'parent-1') for (const l of target.legs) if (OPEN.includes(l.status)) l.status = 'canceled';
            return { canceled: true };
        },
        submitOrder: async (order) => {
            broker.mutations.push(['submit', order]);
            const qty = Number(order.qty);
            const placed = { id: 'exit-1', client_order_id: order.client_order_id, symbol: order.symbol, side: order.side, type: order.type, qty: String(qty), filled_qty: '0', status: 'accepted', legs: null };
            broker.orders.set('exit-1', placed);
            if (broker.exitFills) {
                placed.status = 'filled'; placed.filled_qty = String(qty);
                const position = broker.positions.get(order.symbol);
                const remaining = Number(position.qty) - qty;
                if (remaining) position.qty = String(remaining); else broker.positions.delete(order.symbol);
                broker.activities.push({ id: `20260923193100000::${execId()}`, order_id: 'exit-1', symbol: order.symbol, side: 'sell', qty: String(qty), price: '102.00', transaction_time: '2026-09-23T19:31:00.000Z', type: 'fill' });
            }
            return structuredClone(placed);
        },
    };
    return broker;
}

async function seedPlan(patch = {}) {
    const { plan } = await store.createPlan({
        client_order_id: CID, symbol: 'NVDA', setup: 'orb', catalyst: 'earnings', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z', occurred_at: '2026-09-23T14:00:00.000Z',
    });
    return store.updatePlan(plan.id, { state: 'working', parent_order_id: 'parent-1', stop_order_id: 'stop-1', target_order_id: 'target-1', ...patch });
}

function monitor(broker, now) {
    return createV2Monitor({ store, client: broker.client, now: () => now, sleep: async () => {}, cancelPollAttempts: 5, exitPollAttempts: 5 });
}

const eventsOf = async (type) => (await store.listEvents()).filter((e) => e.event_type === type);

test('healthy active bracket: no broker mutation, plan becomes active, heartbeat recorded after the read pass', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    await monitor(broker, BEFORE_DEADLINE).tick();
    assert.deepStrictEqual(broker.mutations, []);
    assert.strictEqual((await store.getPlan(plan.id)).state, 'active');
    const state = await store.getMonitorState();
    assert.strictEqual(state.last_reconciled_at, BEFORE_DEADLINE.toISOString());
    assert.strictEqual(state.attention_required, 0);
    assert.strictEqual(state.session_date, '2026-09-23');
});

test('a filled target with the broker flat and no executable plan order closes the plan once, with one closure event', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.fillLeg('target-1', 104);
    const m = monitor(broker, BEFORE_DEADLINE);
    await m.tick();
    await m.tick();
    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.exit_reason, 'take_profit');
    assert.strictEqual(closed.realized_pnl, 36);
    assert.strictEqual((await eventsOf('closure')).length, 1);
    assert.deepStrictEqual(broker.mutations, []);
});

test('a filled stop closes as stop_loss with negative R', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.fillLeg('stop-1', 97.9);
    await monitor(broker, BEFORE_DEADLINE).tick();
    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.exit_reason, 'stop_loss');
    assert.strictEqual(closed.realized_pnl, -25);
    assert.ok(closed.realized_r < -0.99 && closed.realized_r > -1.01);
});

test('deadline: cancels the bracket, verifies non-executable, refreshes exact quantity, submits one market exit, verifies zero, closes', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    await monitor(broker, AFTER_DEADLINE).tick();
    const submits = broker.mutations.filter(([kind]) => kind === 'submit');
    assert.strictEqual(submits.length, 1);
    assert.deepStrictEqual(submits[0][1], { symbol: 'NVDA', qty: 10, side: 'sell', type: 'market', time_in_force: 'day', extended_hours: false, client_order_id: `${CID}-x` });
    const firstSubmit = broker.mutations.findIndex(([kind]) => kind === 'submit');
    const lastCancel = broker.mutations.map(([kind]) => kind).lastIndexOf('cancel');
    assert.ok(lastCancel >= 0 && lastCancel < firstSubmit, 'the exit must never be sent before the bracket is cancelled');
    assert.ok(!broker.mutations.some(([kind, id]) => kind === 'cancel' && id === 'parent-1'), 'a filled parent is not cancellable; its open legs are');
    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.exit_reason, 'time_exit');
    assert.strictEqual(closed.exit_order_id, 'exit-1');
});

test('deadline with a still-working parent cancels the parent itself and closes as cancelled when nothing filled', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker({ parentStatus: 'new', filledQty: 0, legStatus: 'held', positionQty: 0 });
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.deepStrictEqual(broker.mutations, [['cancel', 'parent-1']]);
    assert.strictEqual((await store.getPlan(plan.id)).state, 'cancelled');
});

test('a leg that fills during the time-exit cancel leaves nothing to sell: no market order is sent', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.cancelBehavior = 'fill_stop';
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.ok(!broker.mutations.some(([kind]) => kind === 'submit'));
    const closed = await store.getPlan(plan.id);
    assert.strictEqual(closed.state, 'closed');
    assert.strictEqual(closed.exit_reason, 'stop_loss');
});

test('a cancellation that never becomes non-executable latches attention and sends no substitute order', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.cancelBehavior = 'stuck';
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.ok(!broker.mutations.some(([kind]) => kind === 'submit'));
    assert.strictEqual((await store.getPlan(plan.id)).attention_code, 'CANCEL_TIMEOUT');
    assert.strictEqual((await store.getMonitorState()).attention_required, 1);
});

test('an exit that is not confirmed flat latches attention rather than retrying', async () => {
    await seedPlan();
    const broker = fakeBroker();
    broker.exitFills = false;
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.strictEqual(broker.mutations.filter(([kind]) => kind === 'submit').length, 1);
    assert.strictEqual((await store.getMonitorState()).attention_code, 'TIME_EXIT_UNCONFIRMED');
});

test('restart during time_exit_pending finds the exit by client id and never submits a second one', async () => {
    const plan = await seedPlan({ state: 'time_exit_pending' });
    const broker = fakeBroker();
    // The previous process cancelled the legs and sent the exit, then crashed before persisting it.
    for (const l of broker.orders.get('parent-1').legs) l.status = 'canceled';
    broker.exitFills = false;
    await broker.client.submitOrder({ symbol: 'NVDA', qty: 10, side: 'sell', type: 'market', time_in_force: 'day', client_order_id: `${CID}-x` });
    broker.mutations.length = 0;
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.ok(!broker.mutations.some(([kind]) => kind === 'submit'), 'the exit already at the broker must be found by client id');
    assert.strictEqual((await store.getPlan(plan.id)).exit_order_id, 'exit-1');
});

test('an unreadable broker latches attention, blocks entries, and does not advance the heartbeat', async () => {
    await seedPlan();
    const broker = fakeBroker();
    broker.failReads = true;
    await monitor(broker, BEFORE_DEADLINE).tick();
    const state = await store.getMonitorState();
    assert.strictEqual(state.attention_required, 1);
    assert.strictEqual(state.attention_code, 'BROKER_UNREADABLE');
    assert.strictEqual(state.last_reconciled_at, null);
    assert.deepStrictEqual(broker.mutations, []);
});

test('a position that disagrees with the bracket latches attention and preserves broker state', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.positions.get('NVDA').qty = '15';
    await monitor(broker, BEFORE_DEADLINE).tick();
    assert.strictEqual((await store.getPlan(plan.id)).attention_code, 'POSITION_MISMATCH');
    assert.deepStrictEqual(broker.mutations, []);
});

test('a missing protective leg after entry latches attention', async () => {
    const plan = await seedPlan();
    const broker = fakeBroker();
    broker.orders.get('parent-1').legs = broker.orders.get('parent-1').legs.filter((l) => l.id !== 'stop-1');
    await monitor(broker, BEFORE_DEADLINE).tick();
    assert.strictEqual((await store.getPlan(plan.id)).attention_code, 'MISSING_LEG');
});

test('an unexpected open order latches attention without touching it', async () => {
    await seedPlan();
    const broker = fakeBroker();
    broker.orders.set('stray-1', { id: 'stray-1', client_order_id: 'manual', symbol: 'AMD', side: 'buy', type: 'limit', qty: '1', filled_qty: '0', status: 'new', legs: null });
    await monitor(broker, BEFORE_DEADLINE).tick();
    assert.strictEqual((await store.getMonitorState()).attention_code, 'UNEXPECTED_ORDER');
    assert.deepStrictEqual(broker.mutations, []);
});

test('an unexpected position latches attention even with no v2 plan open', async () => {
    const broker = fakeBroker({ filledQty: 0, positionQty: 0 });
    broker.orders.clear();
    broker.positions.set('TSLA', { symbol: 'TSLA', qty: '3', side: 'long' });
    await monitor(broker, BEFORE_DEADLINE).tick();
    assert.strictEqual((await store.getMonitorState()).attention_code, 'UNEXPECTED_POSITION');
});

test('an attention-latched plan is observed but never acted on, even past its deadline', async () => {
    const plan = await seedPlan();
    await store.latchAttention({ planId: plan.id, code: 'TEST', eventKey: 'test:latch' });
    const broker = fakeBroker();
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.deepStrictEqual(broker.mutations, []);
});

test('shadow mode never mutates the broker at the deadline; it latches TIME_EXIT_SUPPRESSED instead', async () => {
    await seedPlan();
    await store.updateMonitorState({ mode: 'shadow' });
    const broker = fakeBroker();
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.deepStrictEqual(broker.mutations, []);
    assert.strictEqual((await store.getMonitorState()).attention_code, 'TIME_EXIT_SUPPRESSED');
});

test('disabled mode does not touch the broker at all', async () => {
    await seedPlan();
    await store.updateMonitorState({ mode: 'disabled' });
    const broker = fakeBroker();
    let reads = 0;
    for (const key of Object.keys(broker.client)) {
        const fn = broker.client[key];
        broker.client[key] = async (...args) => { reads += 1; return fn(...args); };
    }
    await monitor(broker, AFTER_DEADLINE).tick();
    assert.strictEqual(reads, 0);
});

test('startup resolves a pending_submission plan by client id before classifying it', async () => {
    const { plan } = await store.createPlan({
        client_order_id: CID, symbol: 'NVDA', setup: 'orb', catalyst: 'earnings', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z', occurred_at: '2026-09-23T14:00:00.000Z',
    });
    const broker = fakeBroker();
    const m = monitor(broker, BEFORE_DEADLINE);
    await m.startup();
    const linked = await store.getPlan(plan.id);
    assert.strictEqual(linked.parent_order_id, 'parent-1');
    assert.strictEqual(linked.stop_order_id, 'stop-1');
    assert.strictEqual(linked.state, 'active');
    assert.deepStrictEqual(broker.mutations, []);
    assert.strictEqual((await store.getMonitorState()).attention_required, 0);
});

async function createUnlinkedPlan(occurredAt = '2026-09-23T14:00:00.000Z') {
    const { plan } = await store.createPlan({
        client_order_id: CID, symbol: 'NVDA', setup: 'orb', catalyst: 'earnings', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z', occurred_at: occurredAt,
    });
    return plan;
}

test('a tick links a latched submission once the broker shows it, keeps the original latch, and never re-codes it', async () => {
    const plan = await createUnlinkedPlan();
    await store.updatePlan(plan.id, { state: 'submission_unknown' });
    await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN` });
    const broker = fakeBroker();
    await monitor(broker, BEFORE_DEADLINE).tick();
    const linked = await store.getPlan(plan.id);
    assert.strictEqual(linked.parent_order_id, 'parent-1');
    assert.strictEqual(linked.stop_order_id, 'stop-1');
    assert.strictEqual(linked.state, 'attention_required');
    assert.strictEqual(linked.attention_code, 'SUBMISSION_UNKNOWN');
    assert.strictEqual((await store.getMonitorState()).attention_code, 'SUBMISSION_UNKNOWN');
    const codes = (await eventsOf('anomaly')).map((e) => e.reason_code);
    assert.ok(!codes.includes('UNKNOWN_PLAN_LINKAGE'), codes.join(','));
    assert.ok(!codes.includes('UNEXPECTED_ORDER'), codes.join(','));
    assert.deepStrictEqual(broker.mutations, []);
});

test('a pending_submission plan whose entry POST may still be in flight is left alone by tick and startup', async () => {
    const createdAt = new Date(BEFORE_DEADLINE.getTime() - 5_000);
    const plan = await createUnlinkedPlan(createdAt.toISOString());
    const broker = fakeBroker();
    broker.orders.clear(); // the POST has not reached the broker yet
    broker.positions.clear();
    broker.activities.length = 0;
    let lookups = 0;
    const lookup = broker.client.getOrderByClientOrderId;
    broker.client.getOrderByClientOrderId = async (...args) => { lookups += 1; return lookup(...args); };
    const m = monitor(broker, BEFORE_DEADLINE);
    await m.startup();
    await m.tick();
    assert.strictEqual(lookups, 0);
    assert.strictEqual((await store.getPlan(plan.id)).state, 'pending_submission');
    assert.strictEqual((await store.getMonitorState()).attention_required, 0);
});

test('cadence: 60s while any exposure exists, 300s while flat', () => {
    assert.strictEqual(nextDelayMs({ exposure: true }), 60_000);
    assert.strictEqual(nextDelayMs({ exposure: false }), 300_000);
});

test('the worker holds a singleton lock and runs ticks serially; a WebSocket disconnect never submits anything', async () => {
    const lockPath = path.join(os.tmpdir(), `dt2-monitor-test-${process.pid}-${Date.now()}.lock`);
    const second = acquireSingletonLock(lockPath);
    second.release();

    await seedPlan();
    const broker = fakeBroker();
    let states = null;
    const worker = createV2MonitorWorker({
        store, client: broker.client, lockPath, now: () => BEFORE_DEADLINE, sleep: async () => {},
        streamFactory: (options) => { states = options; return { close: () => {} }; }, wsApiKey: 'k', wsApiSecret: 's',
        delayFor: () => 5,
    });
    try {
        await worker.start();
        assert.strictEqual(acquireSingletonLock(lockPath).acquired, false, 'a second monitor must not start');
        states.onStateChange('disconnected');
        const deadline = Date.now() + 60_000;
        while ((await store.getMonitorState()).last_reconciled_at == null && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        assert.ok((await store.getMonitorState()).last_reconciled_at, 'REST reconciliation continues without the WebSocket');
        assert.deepStrictEqual(broker.mutations, []);
        assert.ok(worker.maxConcurrentTicks() <= 1);
    } finally {
        await worker.stop();
    }
    assert.strictEqual(fs.existsSync(lockPath), false);
});
