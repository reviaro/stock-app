const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_v2_execution.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Execution, resolvePlanByClientOrderId, ENTRY_HEARTBEAT_MAX_AGE_MS } = require('../services/alpaca_day_trade_v2_execution');

const NOW = new Date('2026-09-23T15:00:00.000Z');

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
    await store.updateMonitorState({
        mode: 'paper_execute', kill_switch: 0, attention_required: 0, attention_code: null, last_reconciled_at: NOW.toISOString(),
    });
});

function intent(overrides = {}) {
    return {
        account_id: 2, client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', qty: 10,
        setup: 'opening-range breakout', catalyst: 'earnings beat', thesis: 'holds above range', invalidation: 'loses VWAP',
        stop: 98, target: 104, exit_deadline: '2026-09-23T19:30:00.000Z', ...overrides,
    };
}

const ACK = {
    id: 'parent-uuid-1', client_order_id: 'dt2-20260923-nvda-orb', status: 'accepted', symbol: 'NVDA', side: 'buy', qty: '10', filled_qty: '0',
    legs: [
        { id: 'target-uuid-1', type: 'limit', side: 'sell', status: 'held' },
        { id: 'stop-uuid-1', type: 'stop', side: 'sell', status: 'held' },
    ],
};

function fakeClient(overrides = {}) {
    const calls = { submit: [], byClientId: [], reads: 0 };
    const client = {
        getAccount: async () => { calls.reads += 1; return { status: 'ACTIVE', cash: '50000', equity: '100000', buying_power: '400000' }; },
        getClock: async () => ({ is_open: true, next_close: '2026-09-23T20:00:00.000Z' }),
        getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
        getLatestQuote: async () => ({ symbol: 'NVDA', quote: { t: '2026-09-23T14:59:59.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } }),
        getOrders: async () => [],
        submitOrder: async (order) => { calls.submit.push(order); return ACK; },
        getOrderByClientOrderId: async (id) => { calls.byClientId.push(id); return { found: false, order: null }; },
        ...overrides,
    };
    return { client, calls };
}

function brokerError(status, code) {
    return Object.assign(new Error(`Alpaca paper request failed (${status}) secret-body`), { status, code });
}

test('healthy entry: pending plan and event first, exactly one submit, parent and leg ids persisted, acknowledged event', async () => {
    const { client, calls } = fakeClient({
        submitOrder: async (order) => {
            // The plan must already exist, with its deterministic client id, before the broker POST.
            const pending = await store.getPlanByClientOrderId(order.client_order_id);
            assert.strictEqual(pending.state, 'pending_submission');
            calls.submit.push(order);
            return ACK;
        },
    });
    const execution = createV2Execution({ store, client, now: () => NOW });
    const result = await execution.submitEntry(intent());
    assert.strictEqual(result.outcome, 'acknowledged');
    assert.strictEqual(calls.submit.length, 1);
    assert.strictEqual(calls.submit[0].order_class, 'bracket');
    const plan = await store.getPlan(result.plan.id);
    assert.strictEqual(plan.state, 'working');
    assert.strictEqual(plan.parent_order_id, 'parent-uuid-1');
    assert.strictEqual(plan.stop_order_id, 'stop-uuid-1');
    assert.strictEqual(plan.target_order_id, 'target-uuid-1');
    const events = (await store.listEvents(plan.id)).map((e) => e.action);
    assert.deepStrictEqual(events, ['submission_started', 'submission_acknowledged']);
});

test('a definite 4xx rejection persists rejected with a sanitized reason and never retries', async () => {
    const { client, calls } = fakeClient({ submitOrder: async (order) => { calls.submit.push(order); throw brokerError(422, 'ALPACA_BROKER_REJECTED'); } });
    const execution = createV2Execution({ store, client, now: () => NOW });
    const result = await execution.submitEntry(intent());
    assert.strictEqual(result.outcome, 'rejected');
    assert.strictEqual(calls.submit.length, 1);
    const plan = await store.getPlan(result.plan.id);
    assert.strictEqual(plan.state, 'rejected');
    const events = await store.listEvents(plan.id);
    assert.doesNotMatch(JSON.stringify(events), /secret-body|request failed/);
    assert.strictEqual((await store.getMonitorState()).attention_required, 0);
});

for (const [label, failure] of [
    ['timeout', Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })],
    ['5xx', brokerError(503, 'ALPACA_BROKER_UNAVAILABLE')],
    ['disconnect', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } })],
    ['429', brokerError(429, 'ALPACA_BROKER_REJECTED')],
]) {
    test(`an uncertain submission (${label}) persists submission_unknown, latches attention, and never re-posts`, async () => {
        const { client, calls } = fakeClient({ submitOrder: async (order) => { calls.submit.push(order); throw failure; } });
        const execution = createV2Execution({ store, client, now: () => NOW });
        const result = await execution.submitEntry(intent());
        assert.strictEqual(result.outcome, 'submission_unknown');
        assert.strictEqual(calls.submit.length, 1);
        const plan = await store.getPlan(result.plan.id);
        assert.strictEqual(plan.state, 'attention_required');
        assert.strictEqual(plan.attention_code, 'SUBMISSION_UNKNOWN');
        const state = await store.getMonitorState();
        assert.strictEqual(state.attention_required, 1);
    });
}

test('a retry of an unresolved client id resolves by client id and links the broker order without a second POST', async () => {
    let posts = 0;
    const { client, calls } = fakeClient({ submitOrder: async () => { posts += 1; throw brokerError(504, 'ALPACA_BROKER_UNAVAILABLE'); } });
    const execution = createV2Execution({ store, client, now: () => NOW });
    await execution.submitEntry(intent());
    client.getOrderByClientOrderId = async (id) => { calls.byClientId.push(id); return { found: true, order: { ...ACK, status: 'new' } }; };

    const retry = await execution.submitEntry(intent());
    assert.strictEqual(posts, 1, 'a retry must never POST a second entry');
    assert.deepStrictEqual(calls.byClientId, ['dt2-20260923-nvda-orb']);
    assert.strictEqual(retry.outcome, 'linked');
    const plan = await store.getPlan(retry.plan.id);
    assert.strictEqual(plan.parent_order_id, 'parent-uuid-1');
    assert.strictEqual(plan.state, 'attention_required', 'linking evidence does not clear a latch; an operator does');
});

test('a retry whose client id is not found at the broker stays attention-required with an explicit unresolved result', async () => {
    const { client } = fakeClient({ submitOrder: async () => { throw brokerError(502, 'ALPACA_BROKER_UNAVAILABLE'); } });
    const execution = createV2Execution({ store, client, now: () => NOW });
    await execution.submitEntry(intent());
    let posted = false;
    client.submitOrder = async () => { posted = true; return ACK; };
    const retry = await execution.submitEntry(intent());
    assert.strictEqual(retry.outcome, 'unresolved');
    assert.strictEqual(posted, false);
    assert.strictEqual((await store.getPlan(retry.plan.id)).state, 'attention_required');
});

test('reusing a client id for a different entry is an idempotency conflict, not a replay', async () => {
    const { client } = fakeClient();
    const execution = createV2Execution({ store, client, now: () => NOW });
    await execution.submitEntry(intent());
    await assert.rejects(execution.submitEntry(intent({ qty: 11 })), (err) => err.code === 'ALPACA_V2_IDEMPOTENCY_CONFLICT');
});

for (const [label, patch, code] of [
    ['kill switch', { kill_switch: 1 }, 'ALPACA_V2_KILL_SWITCH_ACTIVE'],
    ['attention latch', { attention_required: 1, attention_code: 'X' }, 'ALPACA_V2_ATTENTION_REQUIRED'],
    ['stale heartbeat', { last_reconciled_at: new Date(NOW.getTime() - ENTRY_HEARTBEAT_MAX_AGE_MS - 1000).toISOString() }, 'ALPACA_V2_MONITOR_STALE'],
    ['missing heartbeat', { last_reconciled_at: null }, 'ALPACA_V2_MONITOR_STALE'],
    ['shadow mode', { mode: 'shadow' }, 'ALPACA_V2_EXECUTION_DISABLED'],
    ['disabled mode', { mode: 'disabled' }, 'ALPACA_V2_EXECUTION_DISABLED'],
]) {
    test(`${label} blocks a new entry before any broker call or plan write`, async () => {
        await store.updateMonitorState(patch);
        const { client, calls } = fakeClient();
        const execution = createV2Execution({ store, client, now: () => NOW });
        await assert.rejects(execution.submitEntry(intent()), (err) => err.code === code);
        assert.strictEqual(calls.reads, 0);
        assert.strictEqual(calls.submit.length, 0);
        assert.strictEqual(await store.getPlanByClientOrderId('dt2-20260923-nvda-orb'), null);
    });
}

test('the entry heartbeat threshold tolerates the 300s idle monitor cadence', () => {
    assert.ok(ENTRY_HEARTBEAT_MAX_AGE_MS > 300_000 + 60_000);
    assert.ok(ENTRY_HEARTBEAT_MAX_AGE_MS <= 15 * 60_000);
});

test('a policy refusal writes no plan and never posts', async () => {
    const { client, calls } = fakeClient();
    const execution = createV2Execution({ store, client, now: () => NOW });
    await assert.rejects(execution.submitEntry(intent({ stop: 101 })), (err) => err.code === 'ALPACA_V2_GEOMETRY_INVALID');
    assert.strictEqual(calls.submit.length, 0);
    assert.strictEqual((await store.listPlans()).length, 0);
});

test('a broker read failure before submission writes no plan and never posts', async () => {
    const { client, calls } = fakeClient({ getAccount: async () => { throw brokerError(503, 'ALPACA_BROKER_UNAVAILABLE'); } });
    const execution = createV2Execution({ store, client, now: () => NOW });
    await assert.rejects(execution.submitEntry(intent()), (err) => err.code === 'ALPACA_V2_BROKER_UNAVAILABLE');
    assert.strictEqual(calls.submit.length, 0);
    assert.strictEqual((await store.listPlans()).length, 0);
});

test('concurrent entries are serialized: two different symbols never interleave their broker POSTs', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { client } = fakeClient({
        getLatestQuote: async (symbol) => ({ symbol, quote: { t: '2026-09-23T14:59:59.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } }),
        submitOrder: async (order) => {
            inFlight += 1; maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => { setTimeout(resolve, 30); });
            inFlight -= 1;
            return { ...ACK, id: `parent-${order.symbol}`, client_order_id: order.client_order_id };
        },
    });
    const execution = createV2Execution({ store, client, now: () => NOW });
    await Promise.all([
        execution.submitEntry(intent()),
        execution.submitEntry(intent({ symbol: 'AMD', client_order_id: 'dt2-20260923-amd-orb' })),
    ]);
    assert.strictEqual(maxInFlight, 1);
});

test('crash after broker acknowledgement but before id persistence is recovered by client-id resolution, not a second submit', async () => {
    // Simulate the crash: the plan row exists (written before the POST), the broker accepted
    // the order, but the process died before storing any broker id.
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    let posted = false;
    const { client } = fakeClient({
        submitOrder: async () => { posted = true; return ACK; },
        getOrderByClientOrderId: async () => ({ found: true, order: { ...ACK, status: 'filled', filled_qty: '10' } }),
    });
    const outcome = await resolvePlanByClientOrderId({ store, client, plan, now: () => NOW });
    assert.strictEqual(outcome, 'linked');
    assert.strictEqual(posted, false);
    const linked = await store.getPlan(plan.id);
    assert.strictEqual(linked.parent_order_id, 'parent-uuid-1');
    assert.strictEqual(linked.stop_order_id, 'stop-uuid-1');
    assert.strictEqual(linked.state, 'active');
});

test('client-id resolution that finds nothing keeps the plan attention-required and never assumes rejection', async () => {
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    const { client } = fakeClient();
    const outcome = await resolvePlanByClientOrderId({ store, client, plan, now: () => NOW });
    assert.strictEqual(outcome, 'unresolved');
    const after = await store.getPlan(plan.id);
    assert.strictEqual(after.state, 'attention_required');
    assert.strictEqual(after.attention_code, 'SUBMISSION_NOT_FOUND');
});
