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
    position = { qty: 10, side: 'long' },
} = {}) {
    let orderSeq = 1;
    const ordersMap = new Map();
    const calls = { submitOrder: [], cancelOrder: [], getOrder: [], getPosition: [] };
    return {
        calls,
        ordersMap,
        getPosition: async (symbol) => { calls.getPosition.push(symbol); return typeof position === 'function' ? position(symbol) : position; },
        getOrder: async (id) => {
            calls.getOrder.push(id);
            if (ordersMap.has(id)) return ordersMap.get(id);
            return { id, status: 'filled', legs: [] };
        },
        getOrderByClientOrderId: async (_key) => ({ found: false, order: null }),
        submitOrder: async (order) => {
            calls.submitOrder.push(order);
            if (submitError) throw submitError;
            const res = typeof submitResult === 'function' ? submitResult(order) : { ...submitResult };
            if (ordersMap.has(res.id)) {
                res.id = `broker-mgmt-order-${orderSeq++}`;
            }
            ordersMap.set(res.id, { ...res, legs: res.legs || [] });
            return res;
        },
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
    assert.strictEqual(order.client_order_id, `dt-repair-${plan.id}-a1`);
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

const fastExitPolicy = { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 };
const fastSleep = async () => {};

test('flatten submits a market sell for the exact remaining quantity with a deterministic id', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-flatten-${plan.id}-a1`);
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.type, 'market');
    assert.strictEqual(order.qty, 10);

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].leg_role, 'emergency_flatten');
});

test('submit_time_exit submits a market sell distinct from flatten\'s idempotency key', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'submit_time_exit', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-timeexit-${plan.id}-a1`);
    assert.strictEqual(order.side, 'sell');
    assert.strictEqual(order.type, 'market');

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].leg_role, 'time_exit');
});

test('buy_to_cover submits a market buy to restore zero exposure', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'buy_to_cover', details: { qty: 3 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    const order = client.calls.submitOrder[0];
    assert.strictEqual(order.client_order_id, `dt-cover-${plan.id}-a1`);
    assert.strictEqual(order.side, 'buy');
    assert.strictEqual(order.type, 'market');
    assert.strictEqual(order.qty, 3);
});

test('a matching replay of the same management action does not post a second time', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });
    const second = await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(second.replayed, true);
});

test('a conflicting replay (different quantity) under dt-cover is rejected, not posted', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'buy_to_cover', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    await assert.rejects(
        () => executeManagementAction({ action: 'buy_to_cover', details: { qty: 4 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep }),
        (err) => err.code === 'ALPACA_IDEMPOTENCY_KEY_CONFLICT',
    );
    assert.strictEqual(client.calls.submitOrder.length, 1);
});

test('an unresolved Day Trading order anywhere blocks a new management submission (fail closed)', async () => {
    const planA = await seedPlan({ symbol: 'NVDA' }, { idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1' });
    const planB = await seedPlan({ symbol: 'AMD' }, { symbol: 'AMD', idempotency_key: 'dt-amd-entry-1', client_order_id: 'dt-amd-entry-1' });
    const client = fakeClient({ submitError: Object.assign(new Error('timeout'), { code: 'ALPACA_BROKER_UNAVAILABLE' }) });

    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 10 } }, planA, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep }),
        (err) => err.code === 'ALPACA_SUBMISSION_UNKNOWN',
    );

    const client2 = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'attach_protective_oco', details: { qty: 10 } }, planB, { client: client2, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep }),
        (err) => err.code === 'ALPACA_RECONCILIATION_REQUIRED',
    );
});

test('the durable submission lease is held during a management submission and released after', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'holder-a', exitPolicy: fastExitPolicy, sleep: fastSleep });
    const state = await store.getMonitorState();
    assert.strictEqual(state.submission_lease_holder, null);
});

test('a management submission fails closed when the lease is held by another process', async () => {
    await store.acquireSubmissionLease({ holderId: 'other-process', leaseDurationMs: 30_000, now: new Date() });
    const plan = await seedPlan();
    const client = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep }),
        (err) => err.code === 'ALPACA_LEASE_UNAVAILABLE',
    );
});

test('rejects a non-integer quantity rather than sending a malformed order to the broker', async () => {
    const plan = await seedPlan();
    const client = fakeClient();
    await assert.rejects(
        () => executeManagementAction({ action: 'flatten', details: { qty: 4.5 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep }),
        (err) => err.code === 'ALPACA_QTY_INVALID',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

function createStatefulClient({
    orders = [],
    positions = {},
    rejectSellIfOpenOrders = true,
} = {}) {
    const ordersMap = new Map();
    for (const o of orders) {
        ordersMap.set(o.id, { ...o });
    }
    const positionsMap = new Map();
    for (const [sym, pos] of Object.entries(positions)) {
        positionsMap.set(sym, pos ? { ...pos } : null);
    }
    const calls = {
        cancelOrder: [],
        getOrder: [],
        getPosition: [],
        submitOrder: [],
        getOrderByClientOrderId: [],
    };
    let orderSeq = 100;

    return {
        calls,
        ordersMap,
        positionsMap,
        getPosition: async (symbol) => {
            calls.getPosition.push(symbol);
            return positionsMap.get(symbol) || null;
        },
        getOrder: async (id, options = {}) => {
            calls.getOrder.push({ id, options });
            const o = ordersMap.get(id);
            if (!o) {
                const err = new Error(`Alpaca paper request failed (404): order not found`);
                err.status = 404;
                throw err;
            }
            return { ...o };
        },
        getOrderByClientOrderId: async (clientOrderId) => {
            calls.getOrderByClientOrderId.push(clientOrderId);
            for (const o of ordersMap.values()) {
                if (o.client_order_id === clientOrderId) {
                    return { found: true, order: { ...o } };
                }
            }
            return { found: false, order: null };
        },
        cancelOrder: async (id) => {
            calls.cancelOrder.push(id);
            const o = ordersMap.get(id);
            if (!o) return { canceled: false, reason: 'not_found' };
            o.status = 'canceled';
            return { canceled: true };
        },
        submitOrder: async (order) => {
            calls.submitOrder.push(order);
            if (rejectSellIfOpenOrders && order.side === 'sell') {
                for (const o of ordersMap.values()) {
                    if (o.symbol === order.symbol && o.side === 'sell' && ['new', 'accepted', 'held', 'open'].includes(o.status)) {
                        const err = new Error('Alpaca paper request failed (403): insufficient qty available for order (requested: 10, available: 0)');
                        err.status = 403;
                        err.code = 'ALPACA_BROKER_REJECTED';
                        err.brokerCode = 40310000;
                        err.brokerMessage = 'insufficient qty available for order (requested: 10, available: 0)';
                        throw err;
                    }
                }
            }
            orderSeq += 1;
            const id = `broker-ord-${orderSeq}`;
            const submitted = {
                id,
                ...order,
                status: 'accepted',
            };
            ordersMap.set(id, submitted);
            if (order.type === 'market' && order.side === 'sell') {
                positionsMap.set(order.symbol, null);
                submitted.status = 'filled';
            }
            return { ...submitted };
        },
    };
}

test('R1: time exit with open bracket legs cancels legs, verifies final, refreshes position, submits market sell, verifies flat', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        protective_stop_broker_order_id: 'stop-1',
        protective_target_broker_order_id: 'target-1',
    });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-1', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
            { id: 'target-1', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        { ...plan, protective_stop_broker_order_id: 'stop-1', protective_target_broker_order_id: 'target-1' },
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(result.flatVerified, true);
    assert.ok(client.calls.cancelOrder.includes('stop-1'));
    assert.ok(client.calls.cancelOrder.includes('target-1'));
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].qty, 10);
    assert.strictEqual(client.calls.submitOrder[0].type, 'market');
    assert.strictEqual(client.calls.submitOrder[0].side, 'sell');
});

test('R2: legs never become final within legTerminalTimeoutMs throws ALPACA_EXIT_LEGS_NOT_TERMINAL and NO sell submitted', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        protective_stop_broker_order_id: 'stop-stuck',
    });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-stuck', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.cancelOrder = async () => ({ canceled: false, reason: 'stuck' });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-stuck' },
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('R3: a leg fills during cancellation leaving a smaller position -> sell uses the refreshed smaller qty; if 0 -> outcome already_flat and no sell', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        protective_target_broker_order_id: 'target-filling',
    });
    const client = createStatefulClient({
        orders: [
            { id: 'target-filling', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.cancelOrder = async (id) => {
        client.ordersMap.get(id).status = 'canceled';
        client.positionsMap.set('NVDA', { qty: 4, side: 'long' });
        return { canceled: true };
    };

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        { ...plan, protective_target_broker_order_id: 'target-filling' },
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].qty, 4, 'must use refreshed qty 4, not decision qty 10');

    const client2 = createStatefulClient({
        orders: [
            { id: 'target-filling', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client2.cancelOrder = async (id) => {
        client2.ordersMap.get(id).status = 'filled';
        client2.positionsMap.set('NVDA', null);
        return { canceled: false, reason: 'already_filled' };
    };
    const result2 = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        { ...plan, protective_target_broker_order_id: 'target-filling' },
        { client: client2, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );
    assert.strictEqual(result2.outcome, 'already_flat');
    assert.strictEqual(result2.flatVerified, true);
    assert.strictEqual(client2.calls.submitOrder.length, 0);
});

test('R4: rejected then retried: first attempt gets dt-timeexit-<id>-a1 submission_rejected with broker_message persisted; second call submits under -a2', async () => {
    const plan = await seedPlan();
    const rejectError = new Error('Alpaca paper request failed (403): insufficient qty available');
    rejectError.status = 403;
    rejectError.code = 'ALPACA_BROKER_REJECTED';
    rejectError.brokerCode = 40310000;
    rejectError.brokerMessage = 'insufficient qty available';

    const clientFailing = fakeClient({ submitError: rejectError });
    clientFailing.getPosition = async () => ({ qty: 10, side: 'long' });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            plan,
            { client: clientFailing, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_BROKER_REJECTED',
    );

    const audits = await store.listOrderAudits();
    const a1 = audits.find((a) => a.idempotency_key === `dt-timeexit-${plan.id}-a1`);
    assert.ok(a1, 'must have dt-timeexit-<id>-a1 audit');
    assert.strictEqual(a1.status, 'submission_rejected');
    const payload = JSON.parse(a1.broker_payload);
    assert.strictEqual(payload.broker_message, 'insufficient qty available');

    const clientSuccess = fakeClient({ submitResult: { id: 'ord-2', status: 'accepted' } });
    let posCountR4 = 0;
    clientSuccess.getPosition = async () => {
        posCountR4++;
        return posCountR4 === 1 ? { qty: 10, side: 'long' } : null;
    };
    const result2 = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client: clientSuccess, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );
    assert.strictEqual(clientSuccess.calls.submitOrder.length, 1);
    assert.strictEqual(clientSuccess.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan.id}-a2`);
    assert.notStrictEqual(result2.replayed, true);
});

test('R5: legacy key dt-timeexit-<id> without suffix status submission_rejected leads to next attempt under -a2', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}`,
        client_order_id: `dt-timeexit-${plan.id}`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'submission_rejected',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });

    const client = fakeClient({ submitResult: { id: 'ord-legacy-2', status: 'accepted' } });
    let posCountR5 = 0;
    client.getPosition = async () => {
        posCountR5++;
        return posCountR5 === 1 ? { qty: 10, side: 'long' } : null;
    };

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan.id}-a2`);
});

test('R6: live exit order already open (audit status accepted, getOrder returns accepted) -> outcome replayed_live_order, not cancelled in C2', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-timeexit-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'live-exit-order-1',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'live-exit-order-1', symbol: 'NVDA', side: 'sell', status: 'accepted', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );
    assert.ok(!client.calls.cancelOrder.includes('live-exit-order-1'), 'live exit order must not be cancelled in C2');
    assert.strictEqual(client.calls.submitOrder.length, 0, 'must not submit a new sell order');
    assert.strictEqual(result.replayed, true);
    assert.strictEqual(result.outcome, 'replayed_live_order');
});

test('R7: stale audit refresh: audit says accepted but getOrder says canceled -> audit updated to canceled and a new attempt is submitted', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-timeexit-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'broker-canceled-ord-1',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'broker-canceled-ord-1', symbol: 'NVDA', side: 'sell', status: 'canceled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    const refreshedAudit = await store.getOrderAuditByIdempotencyKey(`dt-timeexit-${plan.id}-a1`);
    assert.strictEqual(refreshedAudit.status, 'canceled', 'audit should have been refreshed to canceled');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan.id}-a2`);
});

test('R8: attempts cap: 10 final audits -> ALPACA_MANAGEMENT_ATTEMPTS_EXHAUSTED, no submission', async () => {
    const plan = await seedPlan();
    for (let i = 1; i <= 10; i++) {
        await store.createOrderAudit({
            idempotency_key: `dt-timeexit-${plan.id}-a${i}`,
            client_order_id: `dt-timeexit-${plan.id}-a${i}`,
            symbol: plan.symbol,
            side: 'sell',
            qty: 10,
            order_type: 'market',
            time_in_force: 'day',
            status: 'canceled',
            execution_epoch: 'day_trading',
            order_class: 'simple',
            leg_role: 'time_exit',
            plan_id: plan.id,
        });
    }

    const client = fakeClient();
    client.getPosition = async () => ({ qty: 10, side: 'long' });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            plan,
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_MANAGEMENT_ATTEMPTS_EXHAUSTED',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('R9: an open sell order on the same symbol NOT attributable to the plan (legacy) is never cancelled', async () => {
    const plan = await seedPlan();
    const client = createStatefulClient({
        orders: [
            { id: 'unrelated-sell-order', symbol: 'NVDA', side: 'sell', status: 'held', qty: 5 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: false,
    });

    await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.ok(!client.calls.cancelOrder.includes('unrelated-sell-order'));
});

test('R10: family replay: a live (accepted) dt-timeexit audit exists, then a flatten decision -> NO new sell submitted, outcome replayed_live_order', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-timeexit-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'live-timeexit-order',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'live-timeexit-order', symbol: 'NVDA', side: 'sell', status: 'accepted', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'flatten', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.strictEqual(client.calls.submitOrder.length, 0);
    assert.strictEqual(result.replayed, true);
});

test('R11: key isolation: plan with a rejected audit belonging to plan suffix*10 -> first attempt is dt-timeexit-<plan.id>-a1', async () => {
    const plan3 = await seedPlan({ symbol: 'NVDA' });
    const otherPlanId = Number(`${plan3.id}0`);
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${otherPlanId}-a1`,
        client_order_id: `dt-timeexit-${otherPlanId}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'submission_rejected',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: otherPlanId,
    });

    const client = fakeClient({ submitResult: { id: 'ord-p3', status: 'accepted' } });
    let posCountR11 = 0;
    client.getPosition = async () => {
        posCountR11++;
        return posCountR11 === 1 ? { qty: 10, side: 'long' } : null;
    };

    await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan3,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan3.id}-a1`);
    const audit30 = await store.getOrderAuditByIdempotencyKey(`dt-timeexit-${otherPlanId}-a1`);
    assert.strictEqual(audit30.status, 'submission_rejected');
});

test('R12: repair OCO legs: plan has a repair_exit audit whose broker order has open stop+limit legs -> both legs cancelled and verified final before the sell', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-repair-${plan.id}-a1`,
        client_order_id: `dt-repair-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'limit',
        limit_price: 104.00,
        stop_price: 98.00,
        time_in_force: 'day',
        status: 'filled',
        execution_epoch: 'day_trading',
        order_class: 'oco',
        leg_role: 'repair_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-repair-${plan.id}-a1`, {
        status: 'filled',
        broker_order_id: 'broker-repair-oco-1',
    });

    const client = createStatefulClient({
        orders: [
            {
                id: 'broker-repair-oco-1', symbol: 'NVDA', side: 'sell', status: 'open',
                legs: [
                    { id: 'repair-stop-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
                    { id: 'repair-limit-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
                ],
            },
            { id: 'repair-stop-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
            { id: 'repair-limit-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.ok(client.calls.cancelOrder.includes('repair-stop-leg'));
    assert.ok(client.calls.cancelOrder.includes('repair-limit-leg'));
    assert.strictEqual(result.outcome, 'flat_verified');
});

test('R13: ambiguity isolation: another plan has submission_unknown audit whose lookup throws -> this plan exit still proceeds; unresolved audit on THIS plan resolved to filled does not block', async () => {
    const planA = await seedPlan({ id: 101, symbol: 'NVDA' }, { idempotency_key: 'dt-nvda-entry-101', client_order_id: 'dt-nvda-entry-101' });
    const planB = await seedPlan({ id: 102, symbol: 'AMD' }, { symbol: 'AMD', idempotency_key: 'dt-amd-entry-102', client_order_id: 'dt-amd-entry-102' });

    await store.createOrderAudit({
        idempotency_key: `dt-repair-${planB.id}-a1`,
        client_order_id: `dt-repair-${planB.id}-a1`,
        symbol: 'AMD',
        side: 'sell',
        qty: 5,
        order_type: 'limit',
        limit_price: 100.00,
        time_in_force: 'day',
        status: 'submission_unknown',
        execution_epoch: 'day_trading',
        order_class: 'oco',
        leg_role: 'repair_exit',
        plan_id: planB.id,
    });

    await store.createOrderAudit({
        idempotency_key: `dt-repair-${planA.id}-a1`,
        client_order_id: `dt-repair-${planA.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'limit',
        limit_price: 100.00,
        time_in_force: 'day',
        status: 'submission_unknown',
        execution_epoch: 'day_trading',
        order_class: 'oco',
        leg_role: 'repair_exit',
        plan_id: planA.id,
    });

    const client = createStatefulClient({
        orders: [
            { id: 'broker-resolved-a1', client_order_id: `dt-repair-${planA.id}-a1`, symbol: 'NVDA', side: 'sell', status: 'filled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: false,
    });
    const origGetByClient = client.getOrderByClientOrderId;
    client.getOrderByClientOrderId = async (key) => {
        if (key === `dt-repair-${planB.id}-a1`) throw new Error('broker timeout on plan B');
        return origGetByClient(key);
    };

    const result = await executeManagementAction(
        { action: 'flatten', details: { qty: 10 } },
        planA,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.ok(result.outcome === 'flat_verified' || result.outcome === 'exit_submitted_unverified');
    const resolvedAuditA = await store.getOrderAuditByIdempotencyKey(`dt-repair-${planA.id}-a1`);
    assert.strictEqual(resolvedAuditA.status, 'filled');
});

test('Finding 1: executeExitSequence defaults are unchanged (pollIntervalMs=500) when DB_PATH_OVERRIDE is set', async () => {
    const origOverride = process.env.DB_PATH_OVERRIDE;
    process.env.DB_PATH_OVERRIDE = '/tmp/some_override.db';
    try {
        const plan = await seedPlan();
        let sleepCalledWith = null;
        let pollCount = 0;
        const client = fakeClient();
        client.getPosition = async () => {
            pollCount++;
            return pollCount <= 2 ? { qty: 10, side: 'long' } : null;
        };
        const sleepSpy = async (ms) => {
            sleepCalledWith = ms;
        };
        await executeManagementAction(
            { action: 'flatten', details: { qty: 10 } },
            plan,
            { client, holderId: 'test-defaults', sleep: sleepSpy },
        );
        assert.strictEqual(sleepCalledWith, 500, 'must sleep for 500ms default pollIntervalMs even with DB_PATH_OVERRIDE');
    } finally {
        if (origOverride === undefined) delete process.env.DB_PATH_OVERRIDE;
        else process.env.DB_PATH_OVERRIDE = origOverride;
    }
});

test('Finding 2: live dt-timeexit audit qty 10 status accepted (getOrder -> partially_filled), position now 6 -> no throw, no new submit, no leg cancellation, outcome replayed_live_order', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-timeexit-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'live-partial-exit-1',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'live-partial-exit-1', symbol: 'NVDA', side: 'sell', status: 'partially_filled', qty: 10 },
        ],
        positions: { NVDA: { qty: 6, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 6 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.strictEqual(client.calls.cancelOrder.length, 0, 'must not cancel any legs');
    assert.strictEqual(client.calls.submitOrder.length, 0, 'must not submit a new sell order');
    assert.strictEqual(result.replayed, true);
    assert.strictEqual(result.outcome, 'replayed_live_order');
    assert.strictEqual(result.flatVerified, false);
});

test('Finding 3: getOrder throws on refresh of live audit -> executeManagementAction rejects, no submit, no cancel', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        symbol: plan.symbol,
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        plan_id: plan.id,
    });
    await store.updateOrderAudit(`dt-timeexit-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'broker-order-error-1',
    });

    const client = createStatefulClient({
        orders: [],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.getOrder = async (_id) => {
        throw new Error('Alpaca 500 network error');
    };

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            plan,
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
        ),
        /Alpaca 500 network error/,
    );
    assert.strictEqual(client.calls.cancelOrder.length, 0, 'no cancel should be called on refresh throw');
    assert.strictEqual(client.calls.submitOrder.length, 0, 'no submit should be called on refresh throw');
});

test('R14 partially filled entry parent at exit time: parent status partially_filled (qty 10, filled_qty 6), open stop+target legs, position 6 -> the parent AND both legs are cancelled and verified final BEFORE the sell; the sell qty is 6; outcome flat_verified', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-14',
        protective_stop_broker_order_id: 'stop-14',
        protective_target_broker_order_id: 'target-14',
    });
    plan.entry_parent_broker_order_id = 'parent-14';
    plan.protective_stop_broker_order_id = 'stop-14';
    plan.protective_target_broker_order_id = 'target-14';

    const client = createStatefulClient({
        orders: [
            {
                id: 'parent-14', symbol: 'NVDA', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 6,
                legs: [
                    { id: 'stop-14', symbol: 'NVDA', side: 'sell', status: 'held', qty: 6 },
                    { id: 'target-14', symbol: 'NVDA', side: 'sell', status: 'held', qty: 6 },
                ],
            },
            { id: 'stop-14', symbol: 'NVDA', side: 'sell', status: 'held', qty: 6 },
            { id: 'target-14', symbol: 'NVDA', side: 'sell', status: 'held', qty: 6 },
        ],
        positions: { NVDA: { qty: 6, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 6 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.ok(client.calls.cancelOrder.includes('parent-14'), 'entry parent order must be cancelled');
    assert.ok(client.calls.cancelOrder.includes('stop-14'), 'stop leg must be cancelled');
    assert.ok(client.calls.cancelOrder.includes('target-14'), 'target leg must be cancelled');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].qty, 6);
    assert.strictEqual(client.calls.submitOrder[0].side, 'sell');
    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(result.flatVerified, true);
});

test('R15 entry parent already filled -> cancelOrder is NOT called for the parent (only the legs)', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-15',
        protective_stop_broker_order_id: 'stop-15',
        protective_target_broker_order_id: 'target-15',
    });
    plan.entry_parent_broker_order_id = 'parent-15';
    plan.protective_stop_broker_order_id = 'stop-15';
    plan.protective_target_broker_order_id = 'target-15';

    const client = createStatefulClient({
        orders: [
            {
                id: 'parent-15', symbol: 'NVDA', side: 'buy', status: 'filled', qty: 10, filled_qty: 10,
                legs: [
                    { id: 'stop-15', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
                    { id: 'target-15', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
                ],
            },
            { id: 'stop-15', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
            { id: 'target-15', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(client.calls.cancelOrder.includes('parent-15'), false, 'cancelOrder must not be called for filled parent');
    assert.ok(client.calls.cancelOrder.includes('stop-15'), 'stop leg must be cancelled');
    assert.ok(client.calls.cancelOrder.includes('target-15'), 'target leg must be cancelled');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(result.flatVerified, true);
});

