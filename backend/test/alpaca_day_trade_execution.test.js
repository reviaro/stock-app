const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trade_execution.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { DEFAULT_DAY_TRADE_POLICY } = require('../services/alpaca_day_trade_order_policy');
const { executeDayTradeEntry } = require('../services/alpaca_day_trade_execution');

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});

after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

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
    // executeDayTradeEntry re-checks the route's gates inside the lease; open them by default.
    await store.updateMonitorState({
        mode: 'paper_execute', kill_switch: false, block_entries: false,
        last_rest_reconciliation_at: new Date().toISOString(),
    });
});

function baseIntent(overrides = {}) {
    return {
        symbol: 'NVDA',
        qty: 100,
        setup: 'opening_breakout',
        catalyst: 'earnings beat',
        thesis: 'holding above prior day high with volume',
        invalidation: 'loss of VWAP',
        stop_price: 98.00,
        target_price: 104.00,
        exit_deadline: '2026-09-17T19:45:00.000Z',
        ...overrides,
    };
}

function fakeClient({
    quote = { symbol: 'NVDA', quote: { t: '2026-09-17T13:30:00.000000000Z', bp: 99.98, bs: 2, ap: 100.00, as: 1, c: ['R'], z: 'C' } },
    account = {
        cash: 50000, equity: 100000, buying_power: 200000,
        status: 'ACTIVE', trading_blocked: false, account_blocked: false,
    },
    asset = { class: 'us_equity', status: 'active', tradable: true },
    clock = { is_open: true, next_close: '2026-09-17T20:00:00.000Z' },
    openOrders = [],
    submitOrder = async (order) => ({ id: 'broker-order-1', status: 'accepted', ...order }),
} = {}) {
    const calls = { submitOrder: [] };
    return {
        calls,
        getAccount: async () => account,
        getAsset: async () => asset,
        getClock: async () => clock,
        getOrders: async () => openOrders,
        getLatestQuote: async () => quote,
        submitOrder: async (order) => {
            calls.submitOrder.push(order);
            return submitOrder(order);
        },
    };
}

function enabledPolicy(overrides = {}) {
    return { ...DEFAULT_DAY_TRADE_POLICY, entriesEnabled: true, ...overrides };
}

function execute(overrides = {}) {
    return executeDayTradeEntry({
        intent: baseIntent(),
        clientOrderId: 'dt-nvda-entry-1',
        client: fakeClient(),
        policy: enabledPolicy(),
        holderId: 'test-holder',
        leaseDurationMs: 30_000,
        now: new Date('2026-09-17T13:30:01.000Z'),
        ...overrides,
    });
}

test('submits exactly one broker order and persists a matching plan and entry audit row', async () => {
    const client = fakeClient();
    const result = await execute({ client });

    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(client.calls.submitOrder[0].client_order_id, 'dt-nvda-entry-1');
    assert.strictEqual(client.calls.submitOrder[0].order_class, 'bracket');

    assert.strictEqual(result.plan.symbol, 'NVDA');
    assert.strictEqual(result.plan.entry_parent_broker_order_id, 'broker-order-1');
    assert.strictEqual(result.order.broker_order_id, 'broker-order-1');
    assert.strictEqual(result.order.status, 'accepted');

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].idempotency_key, 'dt-nvda-entry-1');
});

test('replays an identical resubmission of a terminal key without a second broker POST', async () => {
    const client = fakeClient();
    const first = await execute({ client });

    const second = await execute({ client });
    assert.strictEqual(client.calls.submitOrder.length, 1, 'a second POST must not occur for a matching replay');
    assert.strictEqual(second.replayed, true);
    assert.strictEqual(second.plan.id, first.plan.id);
});

test('rejects reusing the same client order id for a different order as a conflict, without posting', async () => {
    const client = fakeClient();
    await execute({ client });

    await assert.rejects(
        () => execute({ client, intent: baseIntent({ qty: 50 }) }),
        (err) => err.code === 'ALPACA_IDEMPOTENCY_KEY_CONFLICT',
    );
    assert.strictEqual(client.calls.submitOrder.length, 1, 'a conflicting key must never reach the broker');
});

test('reserves cash committed by other open Day Trading orders before checking affordability', async () => {
    // cash 6000, equity 100000; an existing open DT buy order already commits 5980 (100 * 59.80).
    // The new order (100 * 100.00-ish bounded entry) would fit in raw cash alone but not after
    // that reservation is subtracted, so it must be rejected as insufficient cash.
    const client = fakeClient({
        account: {
            cash: 6000, equity: 100000, buying_power: 200000,
            status: 'ACTIVE', trading_blocked: false, account_blocked: false,
        },
        openOrders: [{
            side: 'buy', qty: 100, filled_qty: 0, limit_price: 59.80, client_order_id: 'dt-other-open-order',
        }],
    });

    await assert.rejects(
        () => execute({ client }),
        (err) => err.code === 'ALPACA_INSUFFICIENT_CASH',
    );
    assert.strictEqual(client.calls.submitOrder.length, 0);
});

test('classifies a timeout/5xx broker outcome as ambiguous and blocks further entries until reconciled', async () => {
    const client = fakeClient({
        submitOrder: async () => { const e = new Error('gateway timeout'); e.code = 'ALPACA_BROKER_UNAVAILABLE'; e.status = 504; throw e; },
    });

    await assert.rejects(
        () => execute({ client }),
        (err) => err.code === 'ALPACA_SUBMISSION_UNKNOWN',
    );

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].status, 'submission_unknown');

    await assert.rejects(
        () => execute({ client, intent: baseIntent({ symbol: 'AMD' }), clientOrderId: 'dt-amd-entry-1' }),
        (err) => err.code === 'ALPACA_RECONCILIATION_REQUIRED',
    );
});

test('classifies a synchronous broker rejection as definite, moving the plan to a terminal error state', async () => {
    const client = fakeClient({
        submitOrder: async () => { const e = new Error('insufficient buying power'); e.code = 'ALPACA_BROKER_REJECTED'; e.status = 403; throw e; },
    });

    await assert.rejects(
        () => execute({ client }),
        (err) => err.code === 'ALPACA_BROKER_REJECTED',
    );

    const audits = await store.listOrderAudits();
    assert.strictEqual(audits[0].status, 'submission_rejected');

    const plan = await store.getPlan(audits[0].plan_id);
    assert.strictEqual(plan.state, 'error');

    // a definite rejection must not permanently block the symbol or the account
    const retry = await execute({ client: fakeClient(), clientOrderId: 'dt-nvda-entry-2' });
    assert.strictEqual(retry.plan.symbol, 'NVDA');
});

test('fails closed on a crash-left pending submission, even for an unrelated symbol', async () => {
    const client = fakeClient({
        submitOrder: async () => { const e = new Error('crashed mid-flight'); e.code = 'ALPACA_BROKER_UNAVAILABLE'; throw e; },
    });
    await assert.rejects(() => execute({ client }), (err) => err.code === 'ALPACA_SUBMISSION_UNKNOWN');

    await assert.rejects(
        () => execute({ client: fakeClient(), intent: baseIntent({ symbol: 'AMD' }), clientOrderId: 'dt-amd-entry-1' }),
        (err) => err.code === 'ALPACA_RECONCILIATION_REQUIRED',
    );
});

test('acquires and releases the durable cross-process lease around a submission', async () => {
    const client = fakeClient();
    await execute({ client, holderId: 'holder-a' });
    const state = await store.getMonitorState();
    assert.strictEqual(state.submission_lease_holder, null, 'the lease must be released after the attempt completes');
});

test('fails closed when the durable lease is already held by another process', async () => {
    // Lease timing runs on the real clock, so the competing lease must be live right now.
    await store.acquireSubmissionLease({ holderId: 'other-process', leaseDurationMs: 30_000, now: new Date() });

    await assert.rejects(
        () => execute({ client: fakeClient(), now: new Date('2026-09-17T13:30:05.000Z') }),
        (err) => err.code === 'ALPACA_LEASE_UNAVAILABLE',
    );
});

test('reclaims a stale (expired) lease left by a crashed process and still submits', async () => {
    await store.acquireSubmissionLease({ holderId: 'crashed-process', leaseDurationMs: 1000, now: new Date(Date.now() - 60_000) });

    const client = fakeClient();
    const result = await execute({ client, now: new Date('2026-09-17T13:30:05.000Z') });
    assert.strictEqual(client.calls.submitOrder.length, 1);
    assert.strictEqual(result.plan.symbol, 'NVDA');
});

test('never treats a colliding legacy (non-Day-Trading) idempotency key as a replay', async () => {
    // idempotency_key is UNIQUE database-wide. A legacy row has NULL stop_price/take_profit_price,
    // which would otherwise coincidentally "match" an intent whose prices are absent/zero -- this
    // must be rejected as a conflict on epoch alone, never treated as a safe replay.
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-collides-with-legacy',
        symbol: 'NVDA',
        side: 'buy',
        qty: 100,
        order_type: 'limit',
        time_in_force: 'day',
        limit_price: 50,
        status: 'filled',
        execution_epoch: 'legacy_unattributed',
    });

    await assert.rejects(
        () => execute({ client: fakeClient(), clientOrderId: 'dt-collides-with-legacy', intent: baseIntent({ stop_price: 0, target_price: 0 }) }),
        (err) => err.code === 'ALPACA_IDEMPOTENCY_KEY_CONFLICT',
    );
});

test('reserves cash for an already-accepted local Day Trading order not yet visible in the broker open-orders view', async () => {
    // cash 15000 alone covers the new order's ~10049 cost; only subtracting the other order's
    // 5980 reservation (15000 - 5980 = 9020) pushes it under, which is what isolates the bug:
    // a filter that fails to count an 'accepted' (not just 'pending') local commitment would
    // leave cash at the full 15000 and let this order through.
    const client = fakeClient({
        account: {
            cash: 15000, equity: 100000, buying_power: 200000,
            status: 'ACTIVE', trading_blocked: false, account_blocked: false,
        },
        openOrders: [], // the broker hasn't surfaced it yet, but it was already accepted locally
    });
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-already-accepted',
        client_order_id: 'dt-already-accepted',
        symbol: 'MSFT',
        side: 'buy',
        qty: 100,
        order_type: 'limit',
        time_in_force: 'day',
        limit_price: 59.80,
        status: 'accepted',
        execution_epoch: 'day_trading',
        order_class: 'bracket',
        leg_role: 'entry',
    });

    await assert.rejects(
        () => execute({ client }),
        (err) => err.code === 'ALPACA_INSUFFICIENT_CASH',
    );
});

test('a concurrent attempt fails on the lease while the first is genuinely still in flight, and never posts', async () => {
    // An all-instant fake client gives Promise.allSettled no real overlap to race against — one
    // call can fully complete, lease release included, before the other even attempts to
    // acquire. Forcing A to block mid-flight (after acquiring, before it submits) and polling
    // for that acquisition tests the actual contended-lease property deterministically, rather
    // than hoping two independently-scheduled instant chains happen to overlap.
    let releaseA;
    const gate = new Promise((resolve) => { releaseA = resolve; });
    const clientA = fakeClient();
    const originalGetAccount = clientA.getAccount;
    clientA.getAccount = async () => { await gate; return originalGetAccount(); };

    const aPromise = execute({ client: clientA, holderId: 'holder-a' });

    let state;
    for (let i = 0; i < 100; i += 1) {
        state = await store.getMonitorState();
        if (state.submission_lease_holder === 'holder-a') break;
        await new Promise((resolve) => { setTimeout(resolve, 5); });
    }
    assert.strictEqual(state.submission_lease_holder, 'holder-a', 'test setup: A must hold the lease before B attempts');

    const clientB = fakeClient();
    await assert.rejects(
        () => execute({ client: clientB, holderId: 'holder-b' }),
        (err) => err.code === 'ALPACA_LEASE_UNAVAILABLE',
    );
    assert.strictEqual(clientB.calls.submitOrder.length, 0);

    releaseA();
    await aPromise;
    assert.strictEqual(clientA.calls.submitOrder.length, 1);
});

test('never writes to the simulator transaction ledger', async () => {
    const before = await db.listTransactions();
    await execute({ client: fakeClient() });
    const after = await db.listTransactions();
    assert.deepStrictEqual(after, before);
});

test('B1 kill switch latched while the entry waits for or holds the lease blocks it before any plan or broker order', async () => {
    // (a) latched while the request waited for the lease: refused before any broker read.
    await store.updateMonitorState({ kill_switch: true, block_entries: true });
    const waitingClient = fakeClient();
    let brokerReads = 0;
    waitingClient.getAccount = async () => { brokerReads += 1; return {}; };
    await assert.rejects(() => execute({ client: waitingClient }), (err) => err.code === 'ALPACA_KILL_SWITCH_ACTIVE');
    assert.strictEqual(brokerReads, 0);
    assert.strictEqual(waitingClient.calls.submitOrder.length, 0);

    // (b) latched by the monitor after the lease was acquired, during the broker reads.
    await store.updateMonitorState({ kill_switch: false, block_entries: false });
    const client = fakeClient();
    const getAccount = client.getAccount;
    client.getAccount = async () => {
        await store.updateMonitorState({ kill_switch: true, block_entries: true });
        return getAccount();
    };
    await assert.rejects(() => execute({ client }), (err) => err.code === 'ALPACA_KILL_SWITCH_ACTIVE');
    assert.strictEqual(client.calls.submitOrder.length, 0);
    assert.strictEqual((await store.listPlans(null)).length, 0);
    assert.strictEqual((await store.listOrderAudits()).length, 0);
});

test('C1 kill switch latched after the gate check (between insert and broker ack) -> insert is refused atomically, or the submitted entry is cancelled at once', async () => {
    // (a) latched just before the plan insert: the gate is read inside the insert transaction.
    const quoteClient = fakeClient();
    const getLatestQuote = quoteClient.getLatestQuote;
    quoteClient.getLatestQuote = async (...args) => {
        const quote = await getLatestQuote(...args);
        await store.updateMonitorState({ kill_switch: true, block_entries: true });
        return quote;
    };
    await assert.rejects(() => execute({ client: quoteClient }), (err) => err.code === 'ALPACA_KILL_SWITCH_ACTIVE');
    assert.strictEqual(quoteClient.calls.submitOrder.length, 0);
    assert.strictEqual((await store.listPlans(null)).length, 0);

    // (b) latched while the order is in flight at the broker: cancelled immediately after the ack.
    await store.updateMonitorState({ kill_switch: false, block_entries: false });
    const cancelled = [];
    const client = fakeClient({
        submitOrder: async (order) => {
            await store.updateMonitorState({ kill_switch: true, block_entries: true });
            return { id: 'broker-order-c1', status: 'accepted', ...order };
        },
    });
    client.cancelOrder = async (id) => { cancelled.push(id); return { canceled: true }; };
    const result = await execute({ client, clientOrderId: 'dt-nvda-entry-c1' });
    assert.strictEqual(result.order.broker_order_id, 'broker-order-c1');
    assert.deepStrictEqual(cancelled, ['broker-order-c1']);
    const cancelEvent = (await store.listEvents(result.plan.id)).find((e) => e.action === 'cancel_entry');
    assert.ok(cancelEvent, 'the kill-switch cancellation must be journaled');
    assert.strictEqual(cancelEvent.reason, 'kill_switch_active_after_submit');
});

test('C2 entry whose lease is taken over mid-request stops before persisting or submitting anything', async () => {
    const client = fakeClient();
    const getAccount = client.getAccount;
    client.getAccount = async () => {
        // Another holder reclaims the lease (e.g. ours expired during slow broker calls).
        await store.releaseSubmissionLease({ holderId: 'test-holder' });
        await store.acquireSubmissionLease({ holderId: 'other-request', leaseDurationMs: 30_000, now: new Date() });
        return getAccount();
    };
    await assert.rejects(() => execute({ client }), (err) => err.code === 'ALPACA_LEASE_LOST');
    assert.strictEqual(client.calls.submitOrder.length, 0);
    assert.strictEqual((await store.listPlans(null)).length, 0);
    assert.strictEqual((await store.listOrderAudits()).length, 0);
    const state = await store.getMonitorState();
    assert.strictEqual(state.submission_lease_holder, 'other-request', 'the new holder\'s lease must not be released');
});
