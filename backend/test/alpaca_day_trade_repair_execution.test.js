const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_repair_execution.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { executeManagementAction, executeExitSequence } = require('../services/alpaca_day_trade_repair_execution');

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
    ordersMap.set('broker-parent-1', { id: 'broker-parent-1', status: 'accepted', symbol: 'NVDA', qty: 10 });
    const calls = { submitOrder: [], cancelOrder: [], getOrder: [], getPosition: [] };
    return {
        calls,
        ordersMap,
        getPosition: async (symbol) => { calls.getPosition.push(symbol); return typeof position === 'function' ? position(symbol) : position; },
        getOrder: async (id) => {
            calls.getOrder.push(id);
            if (ordersMap.has(id)) return ordersMap.get(id);
            const err = new Error(`Alpaca paper request failed (404): order ${id} not found`);
            err.status = 404;
            throw err;
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
            if (order.type === 'market' && (order.side === 'sell' || order.side === 'buy')) {
                position = null;
            }
            return res;
        },
        cancelOrder: async (brokerOrderId) => {
            calls.cancelOrder.push(brokerOrderId);
            if (cancelError) throw cancelError;
            const o = ordersMap.get(brokerOrderId);
            if (o) o.status = 'canceled';
            return cancelResult;
        },
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
    assert.deepStrictEqual(result.result.canceled_ids, ['broker-parent-1']);
    assert.deepStrictEqual(result.result.chain, ['broker-parent-1']);
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
    assert.deepStrictEqual(result, { action: 'cancel_unfilled_remainder', result: { canceled_ids: ['broker-parent-1'], chain: ['broker-parent-1'] } });
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
    assert.deepStrictEqual(second.result.canceled_ids, ['broker-parent-1'], 'a leaked lease from the first throw would have blocked this second acquire');
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
    const client = fakeClient({ position: { qty: -3, side: 'short' } });
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

test('a replay with different quantity under dt-cover replays live order regardless of qty', async () => {
    const plan = await seedPlan();
    const client = fakeClient({ position: { qty: -10, side: 'short' } });
    await executeManagementAction({ action: 'buy_to_cover', details: { qty: 10 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });
    const second = await executeManagementAction({ action: 'buy_to_cover', details: { qty: 4 } }, plan, { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep });

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(second.replayed, true);
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
    ordersMap.set('broker-parent-1', { id: 'broker-parent-1', symbol: 'NVDA', side: 'buy', status: 'filled', qty: 10 });
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
            if (order.type === 'market' && (order.side === 'sell' || order.side === 'buy')) {
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

test('A1 leg in stopped that never changes -> ALPACA_EXIT_LEGS_NOT_TERMINAL, no sell submitted', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-stopped' });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-stopped', symbol: 'NVDA', side: 'sell', status: 'stopped', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.cancelOrder = async () => ({ canceled: true });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-stopped' },
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('A2 same for suspended', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-suspended' });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-suspended', symbol: 'NVDA', side: 'sell', status: 'suspended', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.cancelOrder = async () => ({ canceled: true });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-suspended' },
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('A3 same for done_for_day', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-dfd' });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-dfd', symbol: 'NVDA', side: 'sell', status: 'done_for_day', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.cancelOrder = async () => ({ canceled: true });

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-dfd' },
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('A4 leg replaced with replaced_by -> successor is cancelled and verified before the sell', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-replaced' });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-replaced', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'stop-successor-1', qty: 10 },
            { id: 'stop-successor-1', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        { ...plan, protective_stop_broker_order_id: 'stop-replaced' },
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 }, sleep: async () => {} },
    );

    assert.ok(client.calls.cancelOrder.includes('stop-successor-1'), 'successor order must be cancelled');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(result.outcome, 'flat_verified');
});

test('A5 getOrder 404 during C3 verification -> not treated as final (times out, no sell)', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-404' });
    const client = createStatefulClient({
        orders: [
            { id: 'stop-404', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    let inC3 = false;
    const origGetOrder = client.getOrder;
    client.getOrder = async (id, options) => {
        if (inC3 && id === 'stop-404') {
            const err = new Error('Alpaca paper request failed (404): order not found');
            err.status = 404;
            throw err;
        }
        return origGetOrder(id, options);
    };
    const origCancelOrder = client.cancelOrder;
    client.cancelOrder = async (id) => {
        inC3 = true;
        return origCancelOrder(id);
    };

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-404' },
            { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('A6 latest exit-family audit status stopped -> no new exit submitted (treated as live)', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        order_type: 'market',
        time_in_force: 'day',
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        status: 'stopped',
        broker_order_id: 'broker-exit-stopped',
    });
    const client = createStatefulClient({
        orders: [
            { id: 'broker-exit-stopped', symbol: 'NVDA', side: 'sell', status: 'stopped', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: { legTerminalTimeoutMs: 10, flatVerifyTimeoutMs: 10, pollIntervalMs: 2 }, sleep: async () => {} },
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
    assert.strictEqual(result.replayed, true);
});

test('B-1 slow broker: fake getOrder/cancel that advance an injected clock past the lease expiry; a second holder acquires the lease in between -> the first sequence throws ALPACA_LEASE_LOST and submitOrder is never called by it', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-b1' });

    let simulatedTime = Date.now();
    const nowFn = () => new Date(simulatedTime);

    const client = createStatefulClient({
        orders: [
            { id: 'stop-b1', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const origCancelOrder = client.cancelOrder;
    client.cancelOrder = async (id) => {
        simulatedTime += 2000;
        await store.acquireSubmissionLease({ holderId: 'holder-2', leaseDurationMs: 60_000, now: nowFn() });
        return origCancelOrder(id);
    };

    await assert.rejects(
        () => executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            { ...plan, protective_stop_broker_order_id: 'stop-b1' },
            {
                client,
                holderId: 'holder-1',
                leaseDurationMs: 500,
                nowFn,
                exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
                sleep: async () => {},
            },
        ),
        (err) => err.code === 'ALPACA_LEASE_LOST',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('B-2 normal long sequence (clock advances 50s per poll but lease renewed) -> completes, one sell', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-b2' });

    let simulatedTime = Date.now();
    const nowFn = () => new Date(simulatedTime);

    let pollCount = 0;
    const client = createStatefulClient({
        orders: [
            { id: 'stop-b2', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const origGetOrder = client.getOrder;
    client.getOrder = async (id, opts) => {
        pollCount++;
        simulatedTime += 50_000;
        if (pollCount >= 2) {
            const o = client.ordersMap.get(id);
            if (o) o.status = 'canceled';
        }
        return origGetOrder(id, opts);
    };

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        { ...plan, protective_stop_broker_order_id: 'stop-b2' },
        {
            client,
            holderId: 'holder-b2',
            leaseDurationMs: 60_000,
            nowFn,
            exitPolicy: { legTerminalTimeoutMs: 200_000, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
            sleep: async () => {},
        },
    );

    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(client.calls.submitOrder.length, 1);
});

test('B-3 db-level: renew succeeds for the current holder before expiry, fails for another holder, fails after expiry', async () => {
    if (typeof db.renewAlpacaMonitorSubmissionLease !== 'function') {
        assert.fail('renewAlpacaMonitorSubmissionLease is not implemented in db.js');
    }
    const t0 = new Date('2026-09-17T14:00:00.000Z');
    await db.acquireAlpacaMonitorSubmissionLease({ holderId: 'holder-b3', leaseDurationMs: 10_000, now: t0 });

    const t1 = new Date('2026-09-17T14:00:05.000Z');
    const r1 = await db.renewAlpacaMonitorSubmissionLease({ holderId: 'holder-b3', leaseDurationMs: 10_000, now: t1 });
    assert.strictEqual(r1.renewed, true);

    const r2 = await db.renewAlpacaMonitorSubmissionLease({ holderId: 'wrong-holder', leaseDurationMs: 10_000, now: t1 });
    assert.strictEqual(r2.renewed, false);

    const t2 = new Date('2026-09-17T14:00:20.000Z');
    const r3 = await db.renewAlpacaMonitorSubmissionLease({ holderId: 'holder-b3', leaseDurationMs: 10_000, now: t2 });
    assert.strictEqual(r3.renewed, false);
});

test('C-1 submission_unknown exit audit; lookup finds it accepted -> no new submit, replayed + flat verification', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        order_type: 'market',
        time_in_force: 'day',
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        status: 'submission_unknown',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'broker-exit-c1', client_order_id: `dt-timeexit-${plan.id}-a1`, symbol: 'NVDA', side: 'sell', status: 'accepted', qty: 10 },
        ],
        positions: { NVDA: { qty: 0 } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(client.calls.submitOrder.length, 0, 'must not submit a new order when live audit replayed');
    assert.strictEqual(result.replayed, true);
    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(result.flatVerified, true);
    const audits = await store.listOrderAudits();
    const audit = audits.find((a) => a.idempotency_key === `dt-timeexit-${plan.id}-a1`);
    assert.strictEqual(audit.status, 'accepted');
    assert.strictEqual(audit.broker_order_id, 'broker-exit-c1');
});

test('C-2 lookup finds it canceled, position still open -> audit updated, a new attempt (-a2) is submitted', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        order_type: 'market',
        time_in_force: 'day',
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        status: 'submission_unknown',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'broker-exit-c2', client_order_id: `dt-timeexit-${plan.id}-a1`, symbol: 'NVDA', side: 'sell', status: 'canceled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan.id}-a2`);
    assert.strictEqual(result.outcome, 'flat_verified');
    const audits = await store.listOrderAudits();
    const a1 = audits.find((a) => a.idempotency_key === `dt-timeexit-${plan.id}-a1`);
    assert.strictEqual(a1.status, 'canceled');
    assert.strictEqual(a1.broker_order_id, 'broker-exit-c2');
});

test('C-3 lookup not found, audit 90s old -> marked submission_not_found, new attempt submitted', async () => {
    const plan = await seedPlan();
    const oldTimestamp = new Date(Date.now() - 90_000).toISOString();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-timeexit-${plan.id}-a1`,
        client_order_id: `dt-timeexit-${plan.id}-a1`,
        execution_epoch: 'day_trading',
        order_class: 'simple',
        leg_role: 'time_exit',
        order_type: 'market',
        time_in_force: 'day',
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        status: 'submission_unknown',
        created_at: oldTimestamp,
    });
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.run(
        'UPDATE alpaca_paper_orders SET created_at = ? WHERE idempotency_key = ?',
        [oldTimestamp, `dt-timeexit-${plan.id}-a1`],
        (err) => { sqlite.close(); err ? reject(err) : resolve(); },
    ));

    const client = createStatefulClient({
        orders: [],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, `dt-timeexit-${plan.id}-a2`);
    assert.strictEqual(result.outcome, 'flat_verified');
    const audits = await store.listOrderAudits();
    const a1 = audits.find((a) => a.idempotency_key === `dt-timeexit-${plan.id}-a1`);
    assert.strictEqual(a1.status, 'submission_not_found');
});

test('Finding 2: executeExitSequence called with a frozen now and NO nowFn uses real clock for lease renewals', async () => {
    const plan = await seedPlan({ symbol: 'NVDA' });
    const frozenNow = new Date('2026-09-22T19:45:00.000Z');
    const renewTimes = [];
    const origRenew = store.renewSubmissionLease;
    store.renewSubmissionLease = async (args) => {
        renewTimes.push(args.now);
        return origRenew(args);
    };
    try {
        const client = createStatefulClient({
            orders: [],
            positions: { NVDA: { qty: 10, side: 'long' } },
        });
        const result = await executeExitSequence(
            { action: 'submit_time_exit', details: { qty: 10 } },
            plan,
            { client, holderId: 'test-holder', now: frozenNow, exitPolicy: fastExitPolicy, sleep: fastSleep },
        );
        assert.strictEqual(result.outcome, 'flat_verified');
        assert.ok(renewTimes.length >= 2, 'renewSubmissionLease was called at least twice');
        for (const t of renewTimes) {
            assert.ok(t instanceof Date, 'renew time must be a Date instance');
            assert.notStrictEqual(t.getTime(), frozenNow.getTime(), 'renew time must differ from frozen now');
            assert.ok(t.getTime() > frozenNow.getTime(), 'renew time must be later than frozen now (real time)');
        }
        for (let i = 1; i < renewTimes.length; i++) {
            assert.ok(renewTimes[i].getTime() >= renewTimes[i - 1].getTime(), 'renew times must be non-decreasing');
        }
    } finally {
        store.renewSubmissionLease = origRenew;
    }
});

test('Finding 3: attach_protective_oco with another plan submission_unknown audit whose lookup throws attaches diagnostics', async () => {
    const planA = await seedPlan({ symbol: 'NVDA' });
    const planB = await seedPlan({ symbol: 'MSFT' }, { client_order_id: 'dt-entry-2', idempotency_key: 'dt-entry-2' });
    await store.createOrderAudit({
        account_id: 2,
        plan_id: planB.id,
        idempotency_key: `dt-repair-${planB.id}-a1`,
        client_order_id: `dt-repair-${planB.id}-a1`,
        execution_epoch: 'day_trading',
        order_class: 'bracket',
        leg_role: 'repair_exit',
        order_type: 'limit',
        limit_price: 100.00,
        time_in_force: 'day',
        symbol: 'MSFT',
        side: 'sell',
        qty: 5,
        status: 'submission_unknown',
    });

    const client = createStatefulClient({
        orders: [],
        positions: { NVDA: { qty: 10, side: 'long' } },
    });
    client.getOrderByClientOrderId = async (_key) => {
        const err = new Error('service unavailable');
        err.status = 503;
        err.brokerCode = 50010000;
        err.brokerMessage = 'service unavailable';
        throw err;
    };

    let caught = null;
    try {
        await executeManagementAction(
            { action: 'attach_protective_oco', details: { qty: 10 } },
            planA,
            { client, holderId: 'test-holder', now: new Date(), exitPolicy: fastExitPolicy, sleep: fastSleep },
        );
    } catch (err) {
        caught = err;
    }

    assert.ok(caught, 'attach_protective_oco must reject with ALPACA_RECONCILIATION_REQUIRED');
    assert.strictEqual(caught.code, 'ALPACA_RECONCILIATION_REQUIRED');
    assert.strictEqual(caught.status, 503);
    assert.strictEqual(caught.brokerCode, 50010000);
    assert.ok(Array.isArray(caught.details), 'caught error must carry details array');
    assert.strictEqual(caught.details.length, 1);
    assert.strictEqual(caught.details[0].reason, 'lookup_failed');
    assert.strictEqual(caught.details[0].status, 503);
    assert.strictEqual(caught.details[0].brokerCode, 50010000);
    assert.strictEqual(caught.details[0].brokerMessage, 'service unavailable');
});

test('T1 entry parent getOrder(nested) throws 404 -> the parent id is still verified; since it never proves non-executable, ALPACA_EXIT_LEGS_NOT_TERMINAL and no sell', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-t1',
        protective_stop_broker_order_id: null,
        protective_target_broker_order_id: null,
    });
    plan.entry_parent_broker_order_id = 'parent-t1';
    delete plan.protective_stop_broker_order_id;
    delete plan.protective_target_broker_order_id;

    const client = createStatefulClient({
        orders: [],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    await assert.rejects(
        executeManagementAction(
            { action: 'flatten', details: { qty: 10 } },
            plan,
            { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0, 'no sell submitted when entry parent cannot prove non-executable');
});

test('T2 same for a repair_exit audit\'s order id', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-repair-${plan.id}-a1`,
        client_order_id: `dt-repair-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'limit',
        limit_price: 104.00,
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        leg_role: 'repair_exit',
    });
    await store.updateOrderAudit(`dt-repair-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'repair-t2',
    });
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: null,
        protective_stop_broker_order_id: null,
        protective_target_broker_order_id: null,
    });
    plan.entry_parent_broker_order_id = null;
    delete plan.protective_stop_broker_order_id;
    delete plan.protective_target_broker_order_id;

    const client = createStatefulClient({
        orders: [],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    await assert.rejects(
        executeManagementAction(
            { action: 'flatten', details: { qty: 10 } },
            plan,
            { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0, 'no sell submitted when repair exit cannot prove non-executable');
});

test('T5 short 2 shares + executable buy entry parent -> entry cancelled and verified before the cover; cover qty equals the refreshed short qty', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'entry-parent-t5',
        protective_stop_broker_order_id: null,
        protective_target_broker_order_id: null,
    });
    plan.entry_parent_broker_order_id = 'entry-parent-t5';
    delete plan.protective_stop_broker_order_id;
    delete plan.protective_target_broker_order_id;

    let positionCallCount = 0;
    const client = createStatefulClient({
        orders: [
            { id: 'entry-parent-t5', symbol: 'NVDA', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 2 },
        ],
        positions: { NVDA: { qty: -2, side: 'short' } },
        rejectSellIfOpenOrders: false,
    });

    const origGetPosition = client.getPosition;
    client.getPosition = async (symbol) => {
        if (client.calls.submitOrder.length === 0) {
            client.positionsMap.set(symbol, { qty: -3, side: 'short' });
        }
        return origGetPosition(symbol);
    };

    const result = await executeManagementAction(
        { action: 'buy_to_cover', details: { qty: 2 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.ok(client.calls.cancelOrder.includes('entry-parent-t5'), 'entry parent must be cancelled before cover');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    const coverOrder = client.calls.submitOrder[0];
    assert.strictEqual(coverOrder.side, 'buy');
    assert.strictEqual(coverOrder.type, 'market');
    assert.strictEqual(coverOrder.qty, 3, 'cover qty must equal the refreshed short qty (3)');
    assert.strictEqual(coverOrder.client_order_id, `dt-cover-${plan.id}-a1`);
    assert.strictEqual(result.outcome, 'flat_verified');
});

test('T6 after cancellation the position is flat -> already_flat, no order', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'entry-parent-t6',
        protective_stop_broker_order_id: null,
        protective_target_broker_order_id: null,
    });
    plan.entry_parent_broker_order_id = 'entry-parent-t6';
    delete plan.protective_stop_broker_order_id;
    delete plan.protective_target_broker_order_id;

    const client = createStatefulClient({
        orders: [
            { id: 'entry-parent-t6', symbol: 'NVDA', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 2 },
        ],
        positions: { NVDA: { qty: 0 } },
        rejectSellIfOpenOrders: false,
    });

    const result = await executeManagementAction(
        { action: 'buy_to_cover', details: { qty: 2 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.ok(client.calls.cancelOrder.includes('entry-parent-t6'), 'entry parent cancelled');
    assert.strictEqual(result.outcome, 'already_flat');
    assert.strictEqual(client.calls.submitOrder.length, 0, 'no order submitted when position is flat');
});

test('T7 entry parent \'replaced\' -> successor \'accepted\': both are cancel-requested (successor definitely), result lists both', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'parent-t7' });
    plan.entry_parent_broker_order_id = 'parent-t7';

    const client = createStatefulClient({
        orders: [
            { id: 'parent-t7', symbol: 'NVDA', side: 'buy', status: 'replaced', replaced_by: 'succ-t7' },
            { id: 'succ-t7', symbol: 'NVDA', side: 'buy', status: 'accepted' },
        ],
    });

    const result = await executeManagementAction(
        { action: 'cancel_unfilled_remainder' },
        plan,
        { client, holderId: 'test' },
    );

    assert.ok(client.calls.cancelOrder.includes('parent-t7'), 'parent must be cancel-requested');
    assert.ok(client.calls.cancelOrder.includes('succ-t7'), 'successor must be cancel-requested');
    assert.ok(result.result?.canceled_ids, 'result must include canceled_ids');
    assert.deepStrictEqual(result.result.canceled_ids.sort(), ['parent-t7', 'succ-t7'].sort());
    assert.deepStrictEqual(result.result.chain, ['parent-t7', 'succ-t7']);
});

test('T8 cycle a->b->a -> ALPACA_REPLACEMENT_CHAIN_UNRESOLVED', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'ord-a' });
    plan.entry_parent_broker_order_id = 'ord-a';

    const client = createStatefulClient({
        orders: [
            { id: 'ord-a', symbol: 'NVDA', side: 'buy', status: 'replaced', replaced_by: 'ord-b' },
            { id: 'ord-b', symbol: 'NVDA', side: 'buy', status: 'replaced', replaced_by: 'ord-a' },
        ],
    });

    await assert.rejects(
        executeManagementAction(
            { action: 'cancel_unfilled_remainder' },
            plan,
            { client, holderId: 'test' },
        ),
        (err) => err.code === 'ALPACA_REPLACEMENT_CHAIN_UNRESOLVED',
    );
});

test('T9 old(replaced) -> r1(replaced) -> r2(canceled): exit proceeds and sells (currently stuck)', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: null,
        protective_stop_broker_order_id: 'old-stop',
    });
    plan.entry_parent_broker_order_id = null;
    plan.protective_stop_broker_order_id = 'old-stop';

    const client = createStatefulClient({
        orders: [
            { id: 'old-stop', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'r1-stop', qty: 10 },
            { id: 'r1-stop', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'r2-stop', qty: 10 },
            { id: 'r2-stop', symbol: 'NVDA', side: 'sell', status: 'canceled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });
    // In Alpaca, cancelOrder on a replaced order does not change its status to canceled
    const origCancel = client.cancelOrder;
    client.cancelOrder = async (id) => {
        const o = client.ordersMap.get(id);
        if (o && o.status === 'replaced') {
            client.calls.cancelOrder.push(id);
            const err = new Error('Alpaca paper request failed (422): order is not cancelable');
            err.status = 422;
            throw err;
        }
        return origCancel(id);
    };

    const result = await executeManagementAction(
        { action: 'submit_time_exit', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].side, 'sell');
});

test('T10 chain of 6 hops -> ALPACA_EXIT_LEGS_NOT_TERMINAL (fail closed), no sell', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'hop-0' });
    plan.protective_stop_broker_order_id = 'hop-0';

    const client = createStatefulClient({
        orders: [
            { id: 'hop-0', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-1', qty: 10 },
            { id: 'hop-1', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-2', qty: 10 },
            { id: 'hop-2', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-3', qty: 10 },
            { id: 'hop-3', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-4', qty: 10 },
            { id: 'hop-4', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-5', qty: 10 },
            { id: 'hop-5', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'hop-6', qty: 10 },
            { id: 'hop-6', symbol: 'NVDA', side: 'sell', status: 'canceled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });
    const origCancelT10 = client.cancelOrder;
    client.cancelOrder = async (id) => {
        const o = client.ordersMap.get(id);
        if (o && o.status === 'replaced') {
            client.calls.cancelOrder.push(id);
            const err = new Error('Alpaca paper request failed (422): order is not cancelable');
            err.status = 422;
            throw err;
        }
        return origCancelT10(id);
    };

    await assert.rejects(
        executeManagementAction(
            { action: 'submit_time_exit', details: { qty: 10 } },
            plan,
            { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
        ),
        (err) => err.code === 'ALPACA_EXIT_LEGS_NOT_TERMINAL',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0, 'no sell submitted when chain exceeds 5 hops');
});

test('N1-t: a repair_exit audit for the plan is submission_unknown with no broker_order_id; lookup finds an accepted OCO with open legs -> that OCO and its legs are cancelled and verified before the sell', async () => {
    const plan = await seedPlan();
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-repair-${plan.id}-a1`,
        client_order_id: `dt-repair-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'limit',
        limit_price: 104.00,
        time_in_force: 'day',
        status: 'submission_unknown',
        execution_epoch: 'day_trading',
        leg_role: 'repair_exit',
    });

    const ocoOrder = {
        id: 'repair-oco-1',
        client_order_id: `dt-repair-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        status: 'accepted',
        qty: 10,
        legs: [
            { id: 'repair-stop-leg', status: 'held', side: 'sell', qty: 10 },
            { id: 'repair-target-leg', status: 'held', side: 'sell', qty: 10 },
        ],
    };

    const client = createStatefulClient({
        orders: [
            ocoOrder,
            { id: 'repair-stop-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
            { id: 'repair-target-leg', symbol: 'NVDA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: true,
    });

    const result = await executeManagementAction(
        { action: 'flatten', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.strictEqual(result.outcome, 'flat_verified');
    assert.strictEqual(result.flatVerified, true);
    assert.ok(client.calls.cancelOrder.includes('repair-stop-leg'), 'stop leg must be cancelled');
    assert.ok(client.calls.cancelOrder.includes('repair-target-leg'), 'target leg must be cancelled');
    assert.strictEqual(client.calls.submitOrder.length, 1, 'market sell submitted');
});

test('N2-t1: live dt-flatten SELL accepted + position short 2 + decision buy_to_cover -> the sell is cancelled and verified, then a BUY for the refreshed short qty is submitted', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: null });
    plan.entry_parent_broker_order_id = null;
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-flatten-${plan.id}-a1`,
        client_order_id: `dt-flatten-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        leg_role: 'emergency_flatten',
    });
    await store.updateOrderAudit(`dt-flatten-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'flatten-sell-order-1',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'flatten-sell-order-1', symbol: 'NVDA', side: 'sell', status: 'accepted', qty: 10 },
        ],
        positions: { NVDA: { qty: -2, side: 'short' } },
        rejectSellIfOpenOrders: false,
    });

    const result = await executeManagementAction(
        { action: 'buy_to_cover', details: { qty: 2 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.ok(client.calls.cancelOrder.includes('flatten-sell-order-1'), 'opposite-side live sell must be cancelled');
    const buySubmission = client.calls.submitOrder.find((o) => o.side === 'buy');
    assert.ok(buySubmission, 'market buy must be submitted');
    assert.strictEqual(buySubmission.qty, 2, 'cover qty equals refreshed short qty');
    assert.strictEqual(buySubmission.client_order_id, `dt-cover-${plan.id}-a1`);
});

test('N2-t2: live dt-cover BUY accepted + position long 5 + decision flatten -> the buy is cancelled and verified, then a SELL for 5', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: null });
    plan.entry_parent_broker_order_id = null;
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-cover-${plan.id}-a1`,
        client_order_id: `dt-cover-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'buy',
        qty: 2,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        leg_role: 'emergency_flatten',
    });
    await store.updateOrderAudit(`dt-cover-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'cover-buy-order-1',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'cover-buy-order-1', symbol: 'NVDA', side: 'buy', status: 'accepted', qty: 2 },
        ],
        positions: { NVDA: { qty: 5, side: 'long' } },
        rejectSellIfOpenOrders: false,
    });

    const result = await executeManagementAction(
        { action: 'flatten', details: { qty: 5 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    assert.ok(client.calls.cancelOrder.includes('cover-buy-order-1'), 'opposite-side live buy must be cancelled');
    const sellSubmission = client.calls.submitOrder.find((o) => o.side === 'sell');
    assert.ok(sellSubmission, 'market sell must be submitted');
    assert.strictEqual(sellSubmission.qty, 5, 'sell qty equals refreshed long qty');
    assert.strictEqual(sellSubmission.client_order_id, `dt-flatten-${plan.id}-a1`);
});

test('N3-t: exit audit A replaced -> B canceled, position still open -> As audit becomes canceled (broker_order_id = B) and a NEW attempt is submitted', async () => {
    const plan = await seedPlan();
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: null });
    plan.entry_parent_broker_order_id = null;
    await store.createOrderAudit({
        plan_id: plan.id,
        idempotency_key: `dt-flatten-${plan.id}-a1`,
        client_order_id: `dt-flatten-${plan.id}-a1`,
        symbol: 'NVDA',
        side: 'sell',
        qty: 10,
        order_type: 'market',
        time_in_force: 'day',
        status: 'accepted',
        execution_epoch: 'day_trading',
        leg_role: 'emergency_flatten',
    });
    await store.updateOrderAudit(`dt-flatten-${plan.id}-a1`, {
        status: 'accepted',
        broker_order_id: 'order-a',
    });

    const client = createStatefulClient({
        orders: [
            { id: 'order-a', symbol: 'NVDA', side: 'sell', status: 'replaced', replaced_by: 'order-b', qty: 10 },
            { id: 'order-b', symbol: 'NVDA', side: 'sell', status: 'canceled', qty: 10 },
        ],
        positions: { NVDA: { qty: 10, side: 'long' } },
        rejectSellIfOpenOrders: false,
    });

    const result = await executeManagementAction(
        { action: 'flatten', details: { qty: 10 } },
        plan,
        { client, holderId: 'test', exitPolicy: fastExitPolicy, sleep: fastSleep },
    );

    const auditA = (await store.listOrderAudits()).find((a) => a.idempotency_key === `dt-flatten-${plan.id}-a1`);
    assert.strictEqual(auditA.status, 'canceled', 'audit A must be updated to terminal status canceled');
    assert.strictEqual(auditA.broker_order_id, 'order-b', 'audit A broker_order_id must be updated to order-b');
    const newAttempt = client.calls.submitOrder.find((o) => o.client_order_id === `dt-flatten-${plan.id}-a2`);
    assert.ok(newAttempt, 'a new attempt -a2 must be submitted');
    assert.strictEqual(newAttempt.qty, 10);
});
