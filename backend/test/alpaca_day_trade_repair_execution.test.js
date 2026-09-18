const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_repair_execution.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { executeManagementAction } = require('../services/alpaca_day_trade_repair_execution');

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('DELETE FROM alpaca_day_trade_plans');
        sqlite.run('DELETE FROM alpaca_paper_orders');
        sqlite.run('DELETE FROM alpaca_paper_fills');
        sqlite.run(
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL WHERE id = 1",
            (err) => { sqlite.close(); err ? reject(err) : resolve(); },
        );
    }));
});

const basePlan = {
    symbol: 'NVDA', setup: 'opening-range breakout', catalyst: 'catalyst', thesis: 'thesis', invalidation: 'invalidation',
    planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
    planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
    exit_deadline: '2026-09-17T19:45:00.000Z',
};
const baseEntryOrder = {
    idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1',
    symbol: 'NVDA', side: 'buy', qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
    status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
};

async function seedPlan(overrides = {}, orderOverrides = {}) {
    const { plan } = await store.createPlanWithEntry({ ...basePlan, ...overrides }, { ...baseEntryOrder, ...orderOverrides });
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });
    return { ...plan, entry_parent_broker_order_id: 'broker-parent-1' };
}

function fakeClient({
    submitResult = { id: 'broker-mgmt-order-1', status: 'accepted' }, submitError = null,
    cancelResult = { canceled: true }, cancelError = null,
} = {}) {
    const calls = { submitOrder: [], cancelOrder: [] };
    return {
        calls,
        submitOrder: async (order) => { calls.submitOrder.push(order); if (submitError) throw submitError; return submitResult; },
        cancelOrder: async (brokerOrderId) => { calls.cancelOrder.push(brokerOrderId); if (cancelError) throw cancelError; return cancelResult; },
    };
}

test('none is a no-op: no broker call, no lease taken', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    const result = await executeManagementAction({ action: 'none' }, plan, { client, holderId: 'test' });
    assert.strictEqual(result.skipped, true);
    assert.strictEqual(client.calls.submitOrder.length, 0);
    assert.strictEqual(client.calls.cancelOrder.length, 0);
});

test('cancel_unfilled_remainder cancels the entry parent order directly, idempotently', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    const result = await executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client, holderId: 'test' });
    assert.deepStrictEqual(client.calls.cancelOrder, ['broker-parent-1']);
    assert.strictEqual(result.result.canceled, true);
});

// Per Alpaca's documented behavior, a cancel racing an order into a terminal state (most
// commonly: it just filled) returns 422, not 404 -- alpaca_paper_service.js's cancelOrder
// throws ALPACA_BROKER_REJECTED for exactly this status, since the generic legacy path treats
// any non-404 cancel failure as worth surfacing. The Day Trading repair action must not inherit
// that: this exact race is the routine case its own poll-based design expects every tick.
test('cancel_unfilled_remainder treats a 422 (order already reached a terminal state) as a benign non-cancelable outcome, not a thrown error', async () => {
    const plan = await seedPlan();
    const client = fakeClient({ cancelError: Object.assign(new Error('Alpaca paper request failed (422)'), { status: 422, code: 'ALPACA_BROKER_REJECTED' }) });
    const result = await executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client, holderId: 'test' });
    assert.deepStrictEqual(result, { action: 'cancel_unfilled_remainder', result: { canceled: false, reason: 'not_cancelable' } });
});

test('cancel_unfilled_remainder still surfaces a genuinely ambiguous broker failure during cancel, rather than swallowing it', async () => {
    const plan = await seedPlan();
    const client = fakeClient({ cancelError: Object.assign(new Error('Alpaca paper request failed (503)'), { status: 503, code: 'ALPACA_BROKER_UNAVAILABLE' }) });
    await assert.rejects(
        executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_BROKER_UNAVAILABLE',
    );
});

// ALPACA_BROKER_REJECTED is doFetch's code for *every* 4xx except 408 -- 401 (revoked
// credentials), 403 (restricted account), and 429 (rate limited) all share it with 422. Keying
// the benign-race conversion on that code alone would silently swallow those as "already
// filled, nothing to do" forever, which is the same shape of fail-open this codebase has hit
// three times before (a coercion or a too-broad match turning an error into a valid-looking
// outcome). Only the specific 422 status may be treated as benign.
test('cancel_unfilled_remainder still surfaces a 403 (a restricted account, not a fill race) even though it shares ALPACA_BROKER_REJECTED with 422', async () => {
    const plan = await seedPlan();
    const client = fakeClient({ cancelError: Object.assign(new Error('Alpaca paper request failed (403)'), { status: 403, code: 'ALPACA_BROKER_REJECTED' }) });
    await assert.rejects(
        executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_BROKER_REJECTED',
    );
});

test('cancel_unfilled_remainder releases the lease even when the cancel call throws', async () => {
    const plan = await seedPlan();
    const client = fakeClient({ cancelError: Object.assign(new Error('Alpaca paper request failed (503)'), { status: 503, code: 'ALPACA_BROKER_UNAVAILABLE' }) });
    await assert.rejects(executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client, holderId: 'test' }));
    const secondClient = fakeClient();
    const second = await executeManagementAction({ action: 'cancel_unfilled_remainder' }, plan, { client: secondClient, holderId: 'a-different-holder' });
    assert.strictEqual(second.result.canceled, true, 'a leaked lease from the first throw would have blocked this second acquire');
});

test('attach_protective_oco submits a stop-market/limit-target OCO for the exact remaining quantity with a deterministic id', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'attach_protective_oco', details: { qty: 6 } }, plan, { client, holderId: 'test' });

    assert.strictEqual(client.calls.submitOrder.length, 1);
    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-repair-${plan.id}`);
    assert.strictEqual(order.symbol, 'NVDA');
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.qty, 6);
    assert.strictEqual(order.order_class, 'oco');
    assert.deepStrictEqual(order.take_profit, { limit_price: 104.00 });
    assert.deepStrictEqual(order.stop_loss, { stop_price: 98.00 }, 'must never include a stop_loss.limit_price (stop-market, not stop-limit)');

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].leg_role, 'repair_exit');
    assert.strictEqual(audits[0].plan_id, plan.id);
});

test('flatten submits a market sell for the exact remaining quantity with a deterministic id', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test' });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-flatten-${plan.id}`);
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.type, 'market');
    assert.strictEqual(order.qty, 10);

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].leg_role, 'emergency_flatten');
});

test('submit_time_exit submits a market sell distinct from flatten\'s idempotency key', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'submit_time_exit', details: { qty: 10 } }, plan, { client, holderId: 'test' });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-timeexit-${plan.id}`);
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.type, 'market');

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].leg_role, 'time_exit');
});

test('buy_to_cover submits a market buy to restore zero exposure', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'buy_to_cover', details: { qty: 3 } }, plan, { client, holderId: 'test' });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-cover-${plan.id}`);
    assert.strictEqual(order.side, 'buy');
    assert.strictEqual(order.type, 'market');
    assert.strictEqual(order.qty, 3);
});

test('a matching replay of the same management action does not post a second time', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test' });
    const second = await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test' });

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(second.replayed, true);
});

test('a conflicting replay (different quantity) under the same deterministic id is rejected, not posted', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test' });

    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 4 } }, plan, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_IDEMPOTENCY_KEY_CONFLICT',
    );
    assert.strictEqual(client.calls.submitOrder.length, 1);
});

test('an unresolved Day Trading order anywhere blocks a new management submission (fail closed)', async () => {
    const planA = await seedPlan({ symbol: 'NVDA' }, { idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1' });
    const planB = await seedPlan({ symbol: 'AMD' }, { symbol: 'AMD', idempotency_key: 'dt-amd-entry-1', client_order_id: 'dt-amd-entry-1' });
    const client = fakeClient({ submitError: Object.assign(new Error('timeout'), { code: 'ALPACA_BROKER_UNAVAILABLE' }) });

    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 10 } }, planA, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_SUBMISSION_UNKNOWN',
    );

    const client2 = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 10 } }, planB, { client: client2, holderId: 'test' }),
        (err) => err.code === 'ALPACA_RECONCILIATION_REQUIRED',
    );
});

test('the durable submission lease is held during a management submission and released after', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'holder-a' });
    const state = await store.getMonitorState();
    assert.strictEqual(state.submission_lease_holder, null);
});

test('a management submission fails closed when the lease is held by another process', async () => {
    await store.acquireSubmissionLease({ holderId: 'other-process', leaseDurationMs: 30_000, now: new Date() });
    const plan = await seedPlan();
    const client = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_LEASE_UNAVAILABLE',
    );
});

test('rejects a non-integer quantity rather than sending a malformed order to the broker', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 4.5 } }, plan, { client, holderId: 'test' }),
        (err) => err.code === 'ALPACA_QTY_INVALID',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});
