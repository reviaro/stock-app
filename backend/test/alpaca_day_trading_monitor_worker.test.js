const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trading_monitor_worker.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_store');
const { createWorker, acquireInstanceLock } = require('../workers/alpaca_day_trading_monitor');

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('PRAGMA journal_mode = WAL');
        sqlite.run('DROP TRIGGER IF EXISTS alpaca_day_trade_events_no_delete', (err) => {
            sqlite.close();
            err ? reject(err) : resolve();
        });
    }));
});
after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    if (fs.existsSync(`${TEST_DB}-wal`)) fs.unlinkSync(`${TEST_DB}-wal`);
    if (fs.existsSync(`${TEST_DB}-shm`)) fs.unlinkSync(`${TEST_DB}-shm`);
});
beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('BEGIN TRANSACTION');
        sqlite.run('DELETE FROM alpaca_day_trade_plans');
        sqlite.run('DELETE FROM alpaca_paper_orders');
        sqlite.run('DELETE FROM alpaca_paper_fills');
        sqlite.run('DELETE FROM alpaca_day_trade_events');
        sqlite.run(
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, activity_cursor = NULL, mode = 'disabled', kill_switch = 0, block_entries = 0, health_code = NULL, last_rest_reconciliation_at = NULL, session_date = NULL WHERE id = 1"
        );
        sqlite.run('COMMIT', (err) => {
            sqlite.close();
            err ? reject(err) : resolve();
        });
    }));
});

function tempLockPath() {
    return path.join(os.tmpdir(), `dt-monitor-test-${Date.now()}-${Math.random().toString(36).slice(2)}.lock`);
}

// Fixed well inside the trading day, safely before fakeClient's 20:00 next_close cutoffs.
// createWorker's own default `now` is the real wall clock, which makes any test using the
// default spuriously fail for real on this exact hardcoded calendar date after ~19:45 UTC (the
// time-exit window) -- caught when the suite actually ran into that window during this session.
const TEST_NOW = () => new Date('2026-09-17T14:00:00.000Z');

let fakeClientOrderSeq = 1;
function fakeClient(overrides = {}) {
    return {
        getClock: async () => ({ is_open: true, next_close: '2026-09-17T20:00:00.000Z' }),
        getPosition: async () => null,
        getOrder: async () => ({ id: 'broker-parent-1', legs: [] }),
        getOrderByClientOrderId: async () => ({ found: false, order: null }),
        submitOrder: async () => ({ id: `broker-order-${fakeClientOrderSeq++}`, status: 'accepted' }),
        cancelOrder: async () => ({ canceled: true }),
        getAccountActivities: async () => [],
        getCalendar: async () => [{ date: '2026-09-17', open: '09:30', close: '16:00' }],
        ...overrides,
    };
}

test('acquireInstanceLock: a second attempt on the same lock path fails while the first holds it', () => {
    const lockPath = tempLockPath();
    const first = acquireInstanceLock(lockPath);
    try {
        assert.strictEqual(first.acquired, true);
        const second = acquireInstanceLock(lockPath);
        assert.strictEqual(second.acquired, false);
    } finally {
        first.release();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('acquireInstanceLock: a stale lock (owning pid no longer alive) is reclaimed', () => {
    const lockPath = tempLockPath();
    fs.writeFileSync(lockPath, '999999999'); // not a real running pid
    const result = acquireInstanceLock(lockPath);
    try {
        assert.strictEqual(result.acquired, true);
    } finally {
        result.release();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('a second worker instance cannot start while the first holds the lock', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'disabled' });
    const workerA = createWorker({ client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    const workerB = createWorker({ client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await workerA.start();
        await assert.rejects(() => workerB.start(), (err) => err.code === 'ALPACA_MONITOR_ALREADY_RUNNING');
    } finally {
        await workerA.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('reports ready only after startup reconciliation has completed', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    let reconciled = false;
    const client = fakeClient({
        getAccountActivities: async () => { reconciled = true; return []; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        assert.strictEqual(worker.isReady(), false);
        await worker.start();
        assert.strictEqual(reconciled, true, 'startup reconciliation must have run before start() resolves');
        assert.strictEqual(worker.isReady(), true);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('a tick resolves and persists the current NYSE session date from the real trading calendar', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    let calendarCalls = 0;
    const client = fakeClient({
        getCalendar: async () => { calendarCalls += 1; return [{ date: '2026-09-17', open: '09:30', close: '16:00' }]; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        // Poll for the write rather than a fixed sleep-and-hope: under heavy machine load a
        // single 20ms-interval tick can genuinely take longer than a short fixed wait, which is
        // exactly the flakiness this session already saw in the stop()-in-flight-tick test.
        const deadline = Date.now() + 10_000;
        let state = null;
        try { state = await store.getMonitorState(); } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        while (!state?.session_date && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            try { state = await store.getMonitorState(); } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        }
        assert.strictEqual(state?.session_date, '2026-09-17');
        assert.ok(calendarCalls >= 1);
        let noActiveEvents = [];
        try {
            noActiveEvents = (await store.listEvents()).filter((event) => event.event_type === 'monitor_decision' && event.outcome === 'no_active_plans');
        } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        const eventDeadline = Date.now() + 10_000;
        while (noActiveEvents.length === 0 && Date.now() < eventDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            try {
                noActiveEvents = (await store.listEvents()).filter((event) => event.event_type === 'monitor_decision' && event.outcome === 'no_active_plans');
            } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        }
        assert.ok(noActiveEvents.length >= 1);

        const callsAfterFirstTick = calendarCalls;
        await new Promise((resolve) => { setTimeout(resolve, 60); });
        assert.strictEqual(calendarCalls, callsAfterFirstTick, 'the calendar is cached across ticks, not refetched every 20ms poll');

        // Regression: staying idle for several more ticks must not add more no_active_plans
        // rows -- it's a heartbeat on the transition into idle, not a per-tick liveness ping in
        // a table that can never be pruned.
        const noActiveEventsAfterMoreTicks = (await store.listEvents()).filter((event) => event.event_type === 'monitor_decision' && event.outcome === 'no_active_plans');
        assert.strictEqual(noActiveEventsAfterMoreTicks.length, noActiveEvents.length, 'staying idle must not add another no_active_plans row per tick');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

// A transient calendar-fetch failure must not take down the decide/execute loop with it --
// reporting is not worth a management outage. Same fail-closed-per-source shape as
// buildObservation's own broad catch (Task 11): one failing input degrades gracefully, it does
// not propagate out of runTick and get swallowed by scheduleNext's top-level catch, which would
// silently skip plan management for the whole tick while reconciliation keeps succeeding.
test('a calendar-fetch failure does not stop the decide/execute loop from still running', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });

    let getPositionCalls = 0;
    const client = fakeClient({
        getCalendar: async () => { throw new Error('calendar endpoint unavailable'); },
        getPosition: async () => { getPositionCalls += 1; return { qty: 10, side: 'long' }; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        const deadline = Date.now() + 10_000;
        while (getPositionCalls === 0 && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        assert.ok(getPositionCalls > 0, 'the plan loop must still run a tick after a calendar fetch throws');
        const state = await store.getMonitorState();
        assert.strictEqual(state.session_date, null, 'a failed resolve must leave session_date unset, not crash the tick');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

function fakeStreamFactory(calls) {
    return (options) => {
        calls.push(options);
        return { close: () => { calls.closed = (calls.closed || 0) + 1; } };
    };
}

test('start() connects the WebSocket stream when credentials are provided; stop() closes it before releasing the lock', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'disabled' });
    const calls = [];
    const worker = createWorker({
        client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW,
        wsApiKey: 'k', wsApiSecret: 's', streamFactory: fakeStreamFactory(calls),
    });
    try {
        await worker.start();
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].apiKey, 'k');
        assert.strictEqual(calls[0].apiSecret, 's');
        assert.ok(calls[0].url.startsWith('wss://'));
        assert.strictEqual(typeof calls[0].onFill, 'function');
        assert.strictEqual(typeof calls[0].onReconnect, 'function');
    } finally {
        await worker.stop();
        assert.strictEqual(calls.closed, 1, 'stop() must close the stream');
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('start() does not attempt to connect the WebSocket stream when no credentials are configured', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'disabled' });
    const calls = [];
    const worker = createWorker({
        client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW,
        streamFactory: fakeStreamFactory(calls),
    });
    try {
        await worker.start();
        assert.strictEqual(calls.length, 0, 'REST remains a fully sufficient fallback with no WS credentials configured');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('a WebSocket fill delivery is recorded, triggers reconciliation, and updates last_websocket_event_at', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });

    let capturedOnFill = null;
    const client = fakeClient();
    const worker = createWorker({
        client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW,
        wsApiKey: 'k', wsApiSecret: 's',
        streamFactory: (options) => { capturedOnFill = options.onFill; return { close: () => {} }; },
    });
    try {
        await worker.start();
        assert.strictEqual(typeof capturedOnFill, 'function');

        capturedOnFill({
            activity_id: 'ws-execution-1', broker_order_id: 'broker-parent-1', symbol: 'NVDA', side: 'buy',
            qty: 10, price: 100.49, executed_at: '2026-09-17T13:31:00Z', fill_type: 'fill', source: 'websocket',
        });

        const deadline = Date.now() + 10_000;
        let fills = await store.listFillsForPlan(plan.id);
        while (fills.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            fills = await store.listFillsForPlan(plan.id);
        }
        assert.strictEqual(fills.length, 1);
        assert.strictEqual(fills[0].source, 'websocket');

        let state = await store.getMonitorState();
        while (!state?.last_websocket_event_at && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            state = await store.getMonitorState();
        }
        assert.ok(state.last_websocket_event_at);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('a WebSocket reconnect triggers reconciliation and updates last_websocket_reconnect_at', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    let capturedOnReconnect = null;
    let reconciliationCalls = 0;
    const client = fakeClient({
        getAccountActivities: async () => { reconciliationCalls += 1; return []; },
    });
    const worker = createWorker({
        client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW,
        wsApiKey: 'k', wsApiSecret: 's',
        streamFactory: (options) => { capturedOnReconnect = options.onReconnect; return { close: () => {} }; },
    });
    try {
        await worker.start();
        assert.strictEqual(typeof capturedOnReconnect, 'function');
        const callsBeforeReconnect = reconciliationCalls;

        await capturedOnReconnect();

        assert.ok(reconciliationCalls > callsBeforeReconnect, 'a reconnect must trigger a fresh reconciliation pass');
        const state = await store.getMonitorState();
        assert.ok(state.last_websocket_reconnect_at);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

// onFill is called bare by the stream module (never awaited, never .catch()'d at that call
// site) -- if the handler here let a rejection escape, it would surface as an unhandled promise
// rejection, which terminates the process by default on modern Node. This must be impossible
// structurally, not just unlikely.
test('an error while handling a WebSocket fill delivery is logged, not thrown', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    let capturedOnFill = null;
    const logs = [];
    const client = fakeClient();
    const worker = createWorker({
        client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW,
        wsApiKey: 'k', wsApiSecret: 's', log: (entry) => logs.push(entry),
        streamFactory: (options) => { capturedOnFill = options.onFill; return { close: () => {} }; },
    });
    try {
        await worker.start();
        // Deliberately not asserting doesNotThrow here: handleFill returns synchronously by
        // construction (the detached-IIFE guard), so that would pass even with the internal
        // catch removed and the rejection escaping unhandled. Asserting on the log is the
        // assertion that actually fails if the guard is deleted.
        capturedOnFill({ event: 'not-a-real-fill-shape' });

        const deadline = Date.now() + 10_000;
        while (!logs.some((entry) => entry.webSocketFillError) && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        assert.ok(logs.some((entry) => entry.webSocketFillError), 'the handler must log the failure, not swallow it silently');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

// This proves the REST reconcile/decide loop stays fully off in disabled mode -- it does not
// prove zero broker connectivity of any kind. The WebSocket stream (when credentials are
// configured) connects in start() regardless of mode and keeps recording fills passively even
// while disabled, on the same "evidence recording is always safe" reasoning reconcileFills
// itself already relies on elsewhere in this file. This test's fixture never provides WS
// credentials, so that path is simply inert here, not proven absent.
test('disabled mode does not run the reconcile/decide loop at all', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'disabled' });
    let activityCalls = 0;
    const client = fakeClient({ getAccountActivities: async () => { activityCalls += 1; return []; } });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        assert.strictEqual(activityCalls, 0);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

// Unlike kill_switch (a one-way trip), block_entries must be rewritten every tick, true and
// false, so it self-heals once the condition that set it clears -- it is set on nearly every
// non-'none' decision, including transient ones (a broker outage this tick, stale local state).
test('a plan needing repair sets block_entries account-wide; the worker aggregates, it does not require an operator to clear it', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow', block_entries: false });
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });

    const client = fakeClient({
        getPosition: async () => ({ qty: 10, side: 'long' }), // uncovered -> attach_protective_oco, blockEntries: true
        getOrder: async () => ({ id: 'broker-parent-1', status: 'filled', qty: 10, filled_qty: 10, legs: null }),
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        // Poll for the write rather than a fixed sleep-and-hope -- under heavy machine load a
        // single 20ms-interval tick can genuinely take longer than a short fixed wait.
        let stateWhileUncovered = await store.getMonitorState();
        let deadline = Date.now() + 10_000;
        while (!stateWhileUncovered.block_entries && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            stateWhileUncovered = await store.getMonitorState();
        }
        assert.strictEqual(Boolean(stateWhileUncovered.block_entries), true);

        // The condition clears (protective legs now cover the position) -- the very next tick
        // must clear block_entries on its own, with no operator action, unlike kill_switch.
        await db.updateAlpacaDayTradePlan(plan.id, { protective_stop_broker_order_id: 'stop-1', protective_target_broker_order_id: 'target-1' });
        client.getOrder = async () => ({
            id: 'broker-parent-1', status: 'filled', qty: 10, filled_qty: 10,
            legs: [{ id: 'stop-1', type: 'stop', side: 'sell', qty: 10, filled_qty: 0, status: 'held' },
                { id: 'target-1', type: 'limit', side: 'sell', qty: 10, filled_qty: 0, status: 'held' }],
        });
        let stateAfterCovered = await store.getMonitorState();
        deadline = Date.now() + 10_000;
        while (stateAfterCovered.block_entries && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            stateAfterCovered = await store.getMonitorState();
        }
        assert.strictEqual(Boolean(stateAfterCovered.block_entries), false, 'block_entries must self-heal once no plan needs anything, without an operator clearing it');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('shadow mode decides actions but never submits or cancels a broker order', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });

    let submitCalls = 0;
    const client = fakeClient({
        getPosition: async () => ({ qty: 10, side: 'long' }), // uncovered -> would trigger attach_protective_oco
        getOrder: async () => ({ id: 'broker-parent-1', status: 'filled', qty: 10, filled_qty: 10, legs: null }),
        submitOrder: async () => { submitCalls += 1; return { id: 'x', status: 'accepted' }; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        const deadline = Date.now() + 10_000;
        let decisions = [];
        while (decisions.length === 0 && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            decisions = (await store.listEvents(plan.id)).filter((event) => event.event_type === 'monitor_decision');
        }
        assert.strictEqual(submitCalls, 0, 'shadow mode must never actually submit an order');
        assert.ok(decisions.length >= 1, 'each durable cycle records its decision');
        assert.strictEqual(new Set(decisions.map((event) => event.event_key)).size, decisions.length, 'cycle keys prevent duplicate spam');
        assert.ok(decisions.every((event) => event.outcome === 'shadow_observed_only'));

        // Regression: the fixture's decision never changes tick over tick (position and order
        // state are both static), so several more ticks passing must not add more rows -- an
        // unchanged observation is noise in a table that can never be pruned, not history.
        await new Promise((resolve) => { setTimeout(resolve, 200); }); // ~10 more ticks at 20ms
        const decisionsAfterMoreTicks = (await store.listEvents(plan.id)).filter((event) => event.event_type === 'monitor_decision');
        assert.strictEqual(decisionsAfterMoreTicks.length, decisions.length, 'an unchanged decision must be journaled once, not every tick');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('paper_execute mode actually submits the decided repair order', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: TEST_NOW().toISOString() });
    const { plan } = await store.createPlanWithEntry(
        {
            symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
        },
        {
            idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: 'broker-parent-1' });

    const submitted = [];
    const client = fakeClient({
        getPosition: async () => ({ qty: 10, side: 'long' }),
        getOrder: async () => ({ id: 'broker-parent-1', status: 'filled', qty: 10, filled_qty: 10, legs: null }),
        submitOrder: async (order) => { submitted.push(order); return { id: 'x', status: 'accepted' }; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        await new Promise((resolve, reject) => {
            const start = Date.now();
            (function check() {
                if (submitted.length > 0) return resolve();
                if (Date.now() - start > 10_000) return reject(new Error('timed out waiting for a repair submission'));
                setTimeout(check, 10);
            }());
        });
        assert.strictEqual(submitted[0].client_order_id, `dt-repair-${plan.id}-a1`);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

async function seedPlan(symbol, entryKey, { exitDeadline = '2026-09-17T19:45:00.000Z' } = {}) {
    const { plan } = await store.createPlanWithEntry(
        {
            symbol, setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: exitDeadline,
        },
        {
            idempotency_key: entryKey, client_order_id: entryKey, symbol, side: 'buy',
            qty: 10, order_type: 'limit', time_in_force: 'day', limit_price: 100.50,
            status: 'filled', execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
        },
    );
    await db.updateAlpacaDayTradePlan(plan.id, { entry_parent_broker_order_id: `broker-parent-${symbol}` });
    return plan;
}

test('an already-tripped kill switch suppresses the entire decide/execute loop for the whole tick', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: TEST_NOW().toISOString(), kill_switch: true });
    await seedPlan('NVDA', 'dt-nvda-entry-1');

    let submitCalls = 0;
    const client = fakeClient({
        getPosition: async () => ({ qty: 10, side: 'long' }), // would otherwise need repair
        getOrder: async () => ({ id: 'broker-parent-NVDA', status: 'filled', qty: 10, filled_qty: 10, legs: null }),
        submitOrder: async () => { submitCalls += 1; return { id: 'x', status: 'accepted' }; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        assert.strictEqual(submitCalls, 0, 'a pre-tripped kill switch must block the loop before any plan is decided or executed');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('once one plan trips the kill switch mid-tick, a later plan in the same tick is not executed', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: TEST_NOW().toISOString() });
    // listPlans orders by id DESC (most recently created first), so the plan created *second*
    // is the one the loop reaches first -- create the kill-switch-triggering plan last so it is
    // processed before the plan that must end up skipped.
    await seedPlan('NVDA', 'dt-nvda-entry-1');
    await seedPlan('SHRT', 'dt-shrt-entry-1');

    const submitted = [];
    const client = fakeClient({
        getPosition: async (symbol) => (symbol === 'SHRT' ? { qty: -10, side: 'short' } : { qty: 10, side: 'long' }),
        getOrder: async (id) => ({ id, status: 'filled', qty: 10, filled_qty: 10, legs: null }),
        submitOrder: async (order) => { submitted.push(order); return { id: 'x', status: 'accepted' }; },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    try {
        await worker.start();
        await new Promise((resolve, reject) => {
            const start = Date.now();
            (function check() {
                if (submitted.length > 0) return resolve();
                if (Date.now() - start > 10_000) return reject(new Error('timed out waiting for the buy-to-cover submission'));
                setTimeout(check, 10);
            }());
        });
        assert.strictEqual(submitted.length, 1, 'the plan after the kill-switch trip must not also be executed in the same tick');
        assert.strictEqual(submitted[0].client_order_id.startsWith('dt-cover-'), true);

        let state = null;
        try { state = await store.getMonitorState(); } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        const stateDeadline = Date.now() + 10_000;
        while (!state?.kill_switch && Date.now() < stateDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            try { state = await store.getMonitorState(); } catch (e) { if (e.code !== 'SQLITE_BUSY') throw e; }
        }
        assert.strictEqual(state?.kill_switch, 1); // SQLite stores this as an integer, not a JS boolean
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

// Regression for a real bug: a semantic-event append is an audit row, not a lease. Gating the
// decide/execute loop on its insert-or-ignore outcome (or letting a rejection from it escape
// the per-plan loop) previously meant a repeated event_key -- most realistically produced by a
// reconciliation stall pinning the cycle id across ticks -- could silently freeze the *rest of
// the tick*: a later plan's own repair action, and even a pending kill-switch activation, along
// with the terminal block_entries write that lets it self-heal. None of that may depend on
// whether the plan's own decision event happened to write successfully.
test('a semantic-event append failure for one plan does not suppress a later plan\'s management action or the terminal block_entries write', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: TEST_NOW().toISOString() });
    // listPlans orders by id DESC, so the plan created *second* (BBB) is processed *first*.
    const planA = await seedPlan('AAA', 'dt-aaa-append-fail');
    const planB = await seedPlan('BBB', 'dt-bbb-append-fail');

    const submittedSymbols = [];
    // Once a plan's repair order is submitted its legs become "discovered" -- like a real
    // attach succeeding -- so the loop converges in one tick instead of resubmitting forever,
    // which would otherwise hammer the db at the 20ms poll interval for the length of this test.
    const coveredOrderIds = new Set();
    const client = fakeClient({
        getPosition: async () => ({ qty: 10, side: 'long' }), // uncovered -> attach_protective_oco for both, no kill switch
        getOrder: async (id) => ({
            id, status: 'filled', qty: 10, filled_qty: 10,
            legs: coveredOrderIds.has(id)
                ? [{ id: `${id}-stop`, type: 'stop', side: 'sell', qty: 10, filled_qty: 0, status: 'held' },
                    { id: `${id}-target`, type: 'limit', side: 'sell', qty: 10, filled_qty: 0, status: 'held' }]
                : null,
        }),
        submitOrder: async (order) => {
            submittedSymbols.push(order.symbol);
            coveredOrderIds.add(`broker-parent-${order.symbol}`);
            return { id: `x-${order.symbol}`, status: 'accepted' };
        },
    });

    const originalAppendEvent = store.appendEvent;
    let injected = false;
    // Simulates the real conflict shape (same event_key, diverged payload) landing on
    // whichever plan the loop reaches first (BBB), without touching any other append.
    store.appendEvent = (event) => {
        if (!injected && event.event_type === 'monitor_decision' && event.plan_id === planB.id) {
            injected = true;
            return Promise.reject(Object.assign(new Error('simulated event key payload conflict'), { code: 'ALPACA_EVENT_KEY_CONFLICT' }));
        }
        return originalAppendEvent(event);
    };

    // A slower poll interval than this file's usual 20ms -- two plans both perpetually needing
    // repair until the assertions below patch them covered means every tick writes several
    // events for both, and this test doesn't need tick-tight timing to prove its point.
    const worker = createWorker({ client, lockPath, pollIntervalMs: 50, idlePollIntervalMs: 50, now: TEST_NOW });
    try {
        await worker.start();
        const submitDeadline = Date.now() + 15_000;
        while (!(submittedSymbols.includes('AAA') && submittedSymbols.includes('BBB')) && Date.now() < submitDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
        }
        assert.ok(injected, 'the injected failure must actually have fired for this assertion to mean anything');
        assert.ok(submittedSymbols.includes('BBB'), 'the plan whose own decision-event append failed must still have its action executed');
        assert.ok(submittedSymbols.includes('AAA'), 'a later plan in the same tick must still be managed after an earlier plan\'s decision-event append failed');
        const retryOnBusy = async (fn, maxRetries = 10) => {
            for (let i = 0; i < maxRetries; i++) {
                try {
                    return await fn();
                } catch (e) {
                    if (e.code === 'SQLITE_BUSY' && i < maxRetries - 1) {
                        await new Promise((r) => setTimeout(r, 50));
                        continue;
                    }
                    throw e;
                }
            }
        };

        await retryOnBusy(() => db.updateAlpacaDayTradePlan(planA.id, { protective_stop_broker_order_id: 'stop-aaa', protective_target_broker_order_id: 'target-aaa' }));
        await retryOnBusy(() => db.updateAlpacaDayTradePlan(planB.id, { protective_stop_broker_order_id: 'stop-bbb', protective_target_broker_order_id: 'target-bbb' }));

        let state = await retryOnBusy(() => store.getMonitorState());
        const healDeadline = Date.now() + 5_000;
        while (state.block_entries !== 0 && Date.now() < healDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            state = await retryOnBusy(() => store.getMonitorState());
        }
        assert.strictEqual(state.block_entries, 0, 'the terminal block_entries write must still self-heal after a mid-tick decision-event append failure');
    } finally {
        store.appendEvent = originalAppendEvent;
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('stop() shuts down cleanly and releases the instance lock for the next start', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'disabled' });
    const worker = createWorker({ client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    await worker.start();
    await worker.stop();

    const second = createWorker({ client: fakeClient(), lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    await second.start();
    await second.stop();
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
});

// A SIGTERM arriving mid-tick is the realistic systemd shutdown scenario (Task 16 will
// configure exactly this). stop() releasing the instance lock before the in-flight tick's own
// broker calls/decisions finish would let a systemd-restarted second instance start decide/
// execute work while the first is still mid-flight -- deterministic overlap, same technique as
// Task 8's concurrency test: block one call on a manually-released gate, observe the tick is
// genuinely still running, then call stop() and prove it doesn't resolve (or release the lock)
// until the gate opens.
test('stop() waits for an in-flight tick to finish before releasing the instance lock', async () => {
    const lockPath = tempLockPath();
    await store.updateMonitorState({ mode: 'shadow' });
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    let insideTick = false;
    let call = 0;
    const client = fakeClient({
        // Let start()'s own startup reconciliation (Section 8 Startup step 4) pass through
        // immediately; only the first *tick-loop* call blocks, so start() itself can resolve
        // and the test can observe a genuinely in-flight scheduled tick.
        getAccountActivities: async () => {
            call += 1;
            if (call === 1) return [];
            insideTick = true;
            await gate;
            return [];
        },
    });
    const worker = createWorker({ client, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    await worker.start();

    while (!insideTick) { await new Promise((resolve) => setTimeout(resolve, 5)); }
    assert.strictEqual(fs.existsSync(lockPath), true, 'the tick is genuinely in flight before stop() is called');

    let stopped = false;
    const stopPromise = worker.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(stopped, false, 'stop() must not resolve while a tick is still in flight');
    assert.strictEqual(fs.existsSync(lockPath), true, 'the instance lock must not be released while a tick is still in flight');

    releaseGate();
    await stopPromise;
    assert.strictEqual(fs.existsSync(lockPath), false, 'the instance lock is released once the in-flight tick finishes');
});

test('a fatal configuration error (client construction fails) rejects start() without an internal retry loop', async () => {
    const lockPath = tempLockPath();
    const failingClientFactory = () => { const e = new Error('not configured'); e.code = 'ALPACA_NOT_CONFIGURED'; throw e; };
    const worker = createWorker({ createClient: failingClientFactory, lockPath, pollIntervalMs: 20, idlePollIntervalMs: 20, now: TEST_NOW });
    await assert.rejects(() => worker.start(), (err) => err.code === 'ALPACA_NOT_CONFIGURED');
    if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
});

test('the worker module imports no Hermes, LLM, or AI SDK package (Safety Invariant #17)', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'workers', 'alpaca_day_trading_monitor.js'), 'utf8');
    assert.doesNotMatch(source, /require\(['"](@ai-sdk|hermes|openai|@anthropic-ai)/i);
});

function createWorkerStatefulClient({
    orders = [],
    positions = {},
    rejectSellIfOpenOrders = true,
    alwaysRejectSellSymbols = new Set(),
    clock = { is_open: true, next_close: '2026-09-17T20:00:00.000Z' },
} = {}) {
    const ordersMap = new Map();
    for (const o of orders) ordersMap.set(o.id, { ...o });
    const positionsMap = new Map();
    for (const [sym, pos] of Object.entries(positions)) positionsMap.set(sym, pos ? { ...pos } : null);
    const calls = { submitOrder: [], cancelOrder: [], getOrder: [] };
    let orderSeq = 500;

    return {
        calls,
        ordersMap,
        positionsMap,
        getClock: async () => clock,
        getCalendar: async () => [{ date: '2026-09-17', open: '09:30', close: '16:00' }],
        getAccountActivities: async () => [],
        getPosition: async (symbol) => positionsMap.get(symbol) || null,
        getOrder: async (id, options = {}) => {
            calls.getOrder.push({ id, options });
            const o = ordersMap.get(id);
            if (!o) {
                return { id, status: 'filled', qty: 10, filled_qty: 10, legs: [] };
            }
            return { ...o };
        },
        getOrderByClientOrderId: async (key) => {
            for (const o of ordersMap.values()) {
                if (o.client_order_id === key) return { found: true, order: { ...o } };
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
            if (alwaysRejectSellSymbols.has(order.symbol) && order.side === 'sell') {
                const err = new Error('Alpaca paper request failed (403): account restricted');
                err.status = 403;
                err.code = 'ALPACA_BROKER_REJECTED';
                err.brokerCode = 40310001;
                err.brokerMessage = 'account restricted';
                throw err;
            }
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
            const submitted = { id, ...order, status: 'accepted' };
            ordersMap.set(id, submitted);
            if (order.type === 'market' && order.side === 'sell') {
                positionsMap.set(order.symbol, null);
                submitted.status = 'filled';
            }
            return { ...submitted };
        },
    };
}

function waitFor(predicate, timeoutMs = 15000, intervalMs = 20) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const interval = setInterval(() => {
            try {
                if (predicate()) {
                    clearInterval(interval);
                    return resolve();
                }
            } catch (err) {
                clearInterval(interval);
                return reject(err);
            }
            if (Date.now() >= deadline) {
                clearInterval(interval);
                return reject(new Error(`timed out after ${timeoutMs}ms waiting for condition`));
            }
        }, intervalMs);
    });
}

test('W1: TWO plans (MRNA, SNDK) both with open brackets reach the time-exit window in the same tick -> both legs cancelled, both sold, both flat; monitor_action outcomes flat_verified', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const timeExitNow = () => new Date('2026-09-17T19:46:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: timeExitNow().toISOString(), kill_switch: false });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-1');
    const planSndk = await seedPlan('SNDK', 'dt-sndk-entry-1');
    await db.updateAlpacaDayTradePlan(planMrna.id, {
        protective_stop_broker_order_id: 'stop-mrna',
        protective_target_broker_order_id: 'target-mrna',
    });
    await db.updateAlpacaDayTradePlan(planSndk.id, {
        protective_stop_broker_order_id: 'stop-sndk',
        protective_target_broker_order_id: 'target-sndk',
    });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-mrna', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'target-mrna', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'stop-sndk', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
            { id: 'target-sndk', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            SNDK: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: timeExitNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const events = await store.listEvents();
        const actionEvents = events.filter((e) => e.event_type === 'monitor_action' && [planMrna.id, planSndk.id].includes(e.plan_id));
        assert.ok(actionEvents.some((e) => e.plan_id === planMrna.id && e.outcome === 'flat_verified'));
        assert.ok(actionEvents.some((e) => e.plan_id === planSndk.id && e.outcome === 'flat_verified'));
        assert.strictEqual(actionEvents.some((e) => e.outcome === 'submitted'), false, 'no submitted event for rejected attempt');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('W2: TWO plans in the safety-sweep window -> BOTH exits are attempted in the same tick, kill_switch written once, exactly one kill_switch event whose detail.sweep has both plans', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const sweepNow = () => new Date('2026-09-17T19:56:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: sweepNow().toISOString(), kill_switch: false });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-w2');
    const planSndk = await seedPlan('SNDK', 'dt-sndk-entry-w2');
    await db.updateAlpacaDayTradePlan(planMrna.id, { protective_stop_broker_order_id: 'stop-mrna-w2' });
    await db.updateAlpacaDayTradePlan(planSndk.id, { protective_stop_broker_order_id: 'stop-sndk-w2' });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-mrna-w2', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'stop-sndk-w2', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            SNDK: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: sweepNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        const initialKsCount = (await store.listEvents()).filter((e) => e.event_type === 'kill_switch').length;
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const state = await store.getMonitorState();
        assert.strictEqual(state.kill_switch, 1);
        const events = await store.listEvents();
        const ksEvents = events.filter((e) => e.event_type === 'kill_switch');
        assert.strictEqual(ksEvents.length - initialKsCount, 2, 'must have two kill_switch events (activation + sweep_summary)');
        const sweepSummary = ksEvents.find((e) => e.action === 'sweep_summary');
        assert.ok(sweepSummary, 'sweep_summary event must exist');
        const detail = JSON.parse(sweepSummary.detail_json || '{}');
        assert.ok(Array.isArray(detail.sweep), 'detail.sweep must be an array');
        assert.strictEqual(detail.sweep.length, 2, 'detail.sweep must contain both plans');
        for (const item of detail.sweep) {
            assert.strictEqual(item.action, 'flatten');
            assert.strictEqual(item.outcome, 'flat_verified');
            assert.strictEqual(item.flat_verified, true);
        }
        const sweepSymbols = detail.sweep.map((s) => s.symbol).sort();
        assert.deepStrictEqual(sweepSymbols, ['MRNA', 'SNDK']);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('W3: kill_switch already latched, one open position past its exit_deadline, market open -> exit sequence runs (flat_verified); uncovered position attach_protective_oco IS executed (owner decision: RE-PROTECT); kill_switch stays true', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const timeExitNow = () => new Date('2026-09-17T19:46:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: timeExitNow().toISOString(), kill_switch: true });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-w3', { exitDeadline: '2026-09-17T19:45:00.000Z' });
    const planAmd = await seedPlan('AMD', 'dt-amd-entry-w3', { exitDeadline: '2026-09-17T21:45:00.000Z' });
    await db.updateAlpacaDayTradePlan(planMrna.id, { protective_stop_broker_order_id: 'stop-mrna-w3' });

    const client = createWorkerStatefulClient({
        clock: { is_open: true, next_close: '2026-09-17T22:00:00.000Z' },
        orders: [
            { id: 'stop-mrna-w3', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            AMD: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: timeExitNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const state = await store.getMonitorState();
        assert.strictEqual(state.kill_switch, 1, 'kill_switch must stay true');
        const events = await store.listEvents();
        const amdActions = events.filter((e) => e.event_type === 'monitor_action' && e.plan_id === planAmd.id);
        assert.strictEqual(amdActions.length, 1, 'attach_protective_oco IS executed under kill switch (owner decision: RE-PROTECT)');
        assert.strictEqual(amdActions[0].action, 'attach_protective_oco');
        const mrnaAction = events.find((e) => e.event_type === 'monitor_action' && e.plan_id === planMrna.id);
        assert.ok(mrnaAction);
        assert.strictEqual(mrnaAction.outcome, 'flat_verified');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('W4: broker rejects for one plan -> monitor_action outcome failed with detail.broker_message set; other plan still exits', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const timeExitNow = () => new Date('2026-09-17T19:46:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: timeExitNow().toISOString(), kill_switch: false });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-w4');
    const planSndk = await seedPlan('SNDK', 'dt-sndk-entry-w4');
    await db.updateAlpacaDayTradePlan(planMrna.id, { protective_stop_broker_order_id: 'stop-mrna-w4' });
    await db.updateAlpacaDayTradePlan(planSndk.id, { protective_stop_broker_order_id: 'stop-sndk-w4' });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-mrna-w4', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'stop-sndk-w4', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            SNDK: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
        alwaysRejectSellSymbols: new Set(['MRNA']),
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: timeExitNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const events = await store.listEvents();
        const mrnaFailed = events.find((e) => e.event_type === 'monitor_action' && e.plan_id === planMrna.id && e.outcome === 'failed');
        assert.ok(mrnaFailed);
        const detail = JSON.parse(mrnaFailed.detail_json || '{}');
        assert.strictEqual(detail.broker_message, 'account restricted');
        assert.strictEqual(detail.broker_code, 40310001);
        assert.strictEqual(detail.broker_status, 403);
        const sndkOk = events.find((e) => e.event_type === 'monitor_action' && e.plan_id === planSndk.id && e.outcome === 'flat_verified');
        assert.ok(sndkOk);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('W5a: latched switch + a plan whose decision would set blockEntries false -> stored block_entries unchanged', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('AAPL', 'dt-aapl-entry-w5a');
    const client = createWorkerStatefulClient({
        orders: [],
        positions: { AAPL: { qty: 0 } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const state = await store.getMonitorState();
        assert.strictEqual(state.kill_switch, 1, 'kill_switch must remain latched');
        assert.strictEqual(state.block_entries, 1, 'stored block_entries must remain unchanged (true) when kill_switch was already latched');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('E-1 two plans in the sweep window; the fake broker FIRST exit call checks store.getMonitorState() and records kill_switch — it must already be true', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const sweepNow = () => new Date('2026-09-17T19:56:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: sweepNow().toISOString(), kill_switch: false });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-e1');
    const planSndk = await seedPlan('SNDK', 'dt-sndk-entry-e1');
    await db.updateAlpacaDayTradePlan(planMrna.id, { protective_stop_broker_order_id: 'stop-mrna-e1' });
    await db.updateAlpacaDayTradePlan(planSndk.id, { protective_stop_broker_order_id: 'stop-sndk-e1' });

    let firstExitKillSwitch = null;
    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-mrna-e1', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'stop-sndk-e1', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            SNDK: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
    });

    const origSubmitOrder = client.submitOrder;
    client.submitOrder = async (order) => {
        if (firstExitKillSwitch === null && order.side === 'sell') {
            const state = await store.getMonitorState();
            firstExitKillSwitch = Boolean(state.kill_switch);
        }
        return origSubmitOrder(order);
    };

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: sweepNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.strictEqual(firstExitKillSwitch, true, 'kill_switch must already be true when first exit runs');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('E-2 exactly one activation event + one sweep_summary event with both plans', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const sweepNow = () => new Date('2026-09-17T19:56:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: sweepNow().toISOString(), kill_switch: false });
    const planMrna = await seedPlan('MRNA', 'dt-mrna-entry-e2');
    const planSndk = await seedPlan('SNDK', 'dt-sndk-entry-e2');
    await db.updateAlpacaDayTradePlan(planMrna.id, { protective_stop_broker_order_id: 'stop-mrna-e2' });
    await db.updateAlpacaDayTradePlan(planSndk.id, { protective_stop_broker_order_id: 'stop-sndk-e2' });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-mrna-e2', symbol: 'MRNA', side: 'sell', status: 'held', qty: 10 },
            { id: 'stop-sndk-e2', symbol: 'SNDK', side: 'sell', status: 'held', qty: 10 },
        ],
        positions: {
            MRNA: { qty: 10, side: 'long' },
            SNDK: { qty: 10, side: 'long' },
        },
        rejectSellIfOpenOrders: true,
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: sweepNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const events = await store.listEvents();
        const ksEvents = events.filter((e) => e.event_type === 'kill_switch');
        assert.strictEqual(ksEvents.length, 2, 'must have exactly two kill_switch events: 1 activation + 1 sweep_summary');
        const activation = ksEvents.find((e) => e.action !== 'sweep_summary');
        const sweepSummary = ksEvents.find((e) => e.action === 'sweep_summary');
        assert.ok(activation, 'activation event must exist');
        assert.ok(sweepSummary, 'sweep_summary event must exist');
        assert.strictEqual(sweepSummary.outcome, 'recorded');
        const detail = JSON.parse(sweepSummary.detail_json || '{}');
        assert.ok(Array.isArray(detail.sweep), 'sweep must be an array');
        assert.strictEqual(detail.sweep.length, 2, 'sweep must contain both plans');
        const sweepSymbols = detail.sweep.map((s) => s.symbol).sort();
        assert.deepStrictEqual(sweepSymbols, ['MRNA', 'SNDK']);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('F-1 latched switch, entry parent partially_filled within the entry timeout -> cancelOrder called on the parent this tick', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('AAPL', 'dt-aapl-entry-f1');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-f1',
        filled_entry_qty: 4,
    });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'parent-f1', symbol: 'AAPL', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 4 },
        ],
        positions: { AAPL: { qty: 4, side: 'long' } },
    });

    let leaseHolderDuringCancel = null;
    const origCancelOrder = client.cancelOrder;
    client.cancelOrder = async (id) => {
        const state = await store.getMonitorState();
        leaseHolderDuringCancel = state.submission_lease_holder;
        return origCancelOrder(id);
    };

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.ok(leaseHolderDuringCancel, 'submission lease must be held during kill-switch entry cancel');
        assert.ok(client.calls.cancelOrder.includes('parent-f1'), 'entry parent order must be cancelled under latched switch');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('F-2 latched switch, entry parent accepted (0 filled) -> cancelled', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('MSFT', 'dt-msft-entry-f2');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-f2',
        filled_entry_qty: 0,
    });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'parent-f2', symbol: 'MSFT', side: 'buy', status: 'accepted', qty: 10, filled_qty: 0 },
        ],
        positions: { MSFT: { qty: 0 } },
    });

    let leaseHolderDuringCancel = null;
    const origCancelOrderF2 = client.cancelOrder;
    client.cancelOrder = async (id) => {
        const state = await store.getMonitorState();
        leaseHolderDuringCancel = state.submission_lease_holder;
        return origCancelOrderF2(id);
    };

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.ok(leaseHolderDuringCancel, 'submission lease must be held during kill-switch entry cancel');
        assert.ok(client.calls.cancelOrder.includes('parent-f2'), 'accepted entry parent order must be cancelled under latched switch');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('F-3 not latched, partial entry within timeout -> NOT cancelled (existing behavior unchanged)', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: false,
        block_entries: false,
    });

    const plan = await seedPlan('GOOG', 'dt-goog-entry-f3');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-f3',
        filled_entry_qty: 4,
    });

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'parent-f3', symbol: 'GOOG', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 4 },
        ],
        positions: { GOOG: { qty: 4, side: 'long' } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.strictEqual(client.calls.cancelOrder.includes('parent-f3'), false, 'entry parent order must NOT be cancelled when kill switch is not active');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('Finding 6: timer tick and runTickNow never run concurrently (max concurrency is 1)', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'shadow',
        last_rest_reconciliation_at: testNow().toISOString(),
    });
    await seedPlan('NVDA', 'dt-nvda-finding6');

    let concurrentTicks = 0;
    let maxConcurrentTicks = 0;
    let resolveClock = null;
    const clockPromise = new Promise((resolve) => { resolveClock = resolve; });

    let clockCalls = 0;
    const client = fakeClient({
        getClock: async () => {
            concurrentTicks++;
            maxConcurrentTicks = Math.max(maxConcurrentTicks, concurrentTicks);
            clockCalls++;
            if (clockCalls === 1) {
                await clockPromise;
            }
            concurrentTicks--;
            return { is_open: true, next_close: '2026-09-17T20:00:00.000Z' };
        },
    });

    const worker = createWorker({
        client,
        lockPath,
        pollIntervalMs: 10,
        idlePollIntervalMs: 10,
        now: testNow,
    });

    try {
        await worker.start();
        while (clockCalls === 0) {
            await new Promise((r) => setTimeout(r, 5));
        }

        const tickNowPromise = worker.runTickNow();
        await new Promise((r) => setTimeout(r, 20));
        resolveClock();

        await tickNowPromise;
        assert.strictEqual(maxConcurrentTicks, 1, 'max concurrent ticks must be 1');
    } finally {
        if (resolveClock) resolveClock();
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('T3 latched switch, entry parent \'canceled\' with filled_qty 6, position 6, no protective legs -> an OCO for exactly 6 shares is submitted this tick; kill_switch stays true', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('AMD', 'dt-amd-entry-t3');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-t3',
        filled_entry_qty: 6,
    });

    const client = createWorkerStatefulClient({
        clock: { is_open: true, next_close: '2026-09-17T22:00:00.000Z' },
        orders: [
            { id: 'parent-t3', symbol: 'AMD', side: 'buy', status: 'canceled', qty: 10, filled_qty: 6 },
        ],
        positions: { AMD: { qty: 6, side: 'long' } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const state = await store.getMonitorState();
        assert.strictEqual(state.kill_switch, 1, 'kill_switch stays true');
        assert.strictEqual(client.calls.submitOrder.length, 1, 'an OCO order must be submitted');
        const submitted = client.calls.submitOrder[0];
        assert.strictEqual(submitted.symbol, 'AMD');
        assert.strictEqual(submitted.qty, 6, 'OCO qty must be exactly 6');
        assert.strictEqual(submitted.order_class, 'oco');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('T4 latched switch, entry parent still \'partially_filled\' -> the same tick cancels and verifies the entry, then protects the filled qty; the next tick does not duplicate the OCO', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('AMD', 'dt-amd-entry-t4');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-t4',
        filled_entry_qty: 6,
    });

    const client = createWorkerStatefulClient({
        clock: { is_open: true, next_close: '2026-09-17T22:00:00.000Z' },
        orders: [
            { id: 'parent-t4', symbol: 'AMD', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 6 },
        ],
        positions: { AMD: { qty: 6, side: 'long' } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        // Tick 1: parent is partially_filled
        await worker.runTickNow();

        // Tick 1: the entry is cancelled, proven non-executable, and the 6 filled shares are
        // protected in the same pass (not left uncovered until the next tick).
        assert.ok(client.calls.cancelOrder.includes('parent-t4'), 'tick 1 must cancel entry');
        assert.strictEqual(client.ordersMap.get('parent-t4').status, 'canceled');
        assert.strictEqual(client.calls.submitOrder.length, 1, 'tick 1 must protect the filled qty');
        assert.strictEqual(client.calls.submitOrder[0].qty, 6, 'OCO for filled qty 6');
        assert.strictEqual(client.calls.submitOrder[0].order_class, 'oco');

        // Tick 2: the live OCO is replayed, never duplicated.
        await worker.runTickNow();
        assert.strictEqual(client.calls.submitOrder.length, 1, 'tick 2 must not submit a second OCO');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('T11 after a kill-switch entry cancel, the persisted event detail has no order_id and JSON.stringify(detail) does not contain the broker order id string', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('INTC', 'dt-intc-entry-t11');
    const brokerOrderId = 'broker-parent-secret-11';
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: brokerOrderId,
        filled_entry_qty: 0,
    });

    const client = createWorkerStatefulClient({
        clock: { is_open: true, next_close: '2026-09-17T22:00:00.000Z' },
        orders: [
            { id: brokerOrderId, symbol: 'INTC', side: 'buy', status: 'accepted', qty: 10, filled_qty: 0 },
        ],
        positions: { INTC: { qty: 0 } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        const events = await store.listEvents();
        const cancelEvent = events.find((e) => e.event_type === 'monitor_action' && e.action === 'cancel_unfilled_remainder' && e.plan_id === plan.id);
        assert.ok(cancelEvent, 'cancel entry event must exist');
        const detail = JSON.parse(cancelEvent.detail_json || '{}');
        assert.strictEqual(detail.order_id, undefined, 'persisted detail must not have order_id');
        assert.strictEqual('order_id' in detail, false, 'order_id key must not exist in detail');
        assert.strictEqual(JSON.stringify(detail).includes(brokerOrderId), false, 'JSON.stringify(detail) must not contain the broker order id');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('N4-t: latched switch, 6 shares filled, no protective legs, entry parent A replaced -> B canceled -> no cancel this tick; an OCO for exactly 6 shares is submitted', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const testNow = () => new Date('2026-09-17T14:30:00.000Z');
    await store.updateMonitorState({
        mode: 'paper_execute',
        last_rest_reconciliation_at: testNow().toISOString(),
        kill_switch: true,
        block_entries: true,
    });

    const plan = await seedPlan('AMD', 'dt-amd-entry-n4t');
    await db.updateAlpacaDayTradePlan(plan.id, {
        entry_parent_broker_order_id: 'parent-a',
        filled_entry_qty: 6,
    });

    const client = createWorkerStatefulClient({
        clock: { is_open: true, next_close: '2026-09-17T22:00:00.000Z' },
        orders: [
            { id: 'parent-a', symbol: 'AMD', side: 'buy', status: 'replaced', replaced_by: 'parent-b', qty: 10, filled_qty: 6 },
            { id: 'parent-b', symbol: 'AMD', side: 'buy', status: 'canceled', qty: 10, filled_qty: 6 },
        ],
        positions: { AMD: { qty: 6, side: 'long' } },
    });

    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: testNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.strictEqual(client.calls.cancelOrder.length, 0, 'no cancel this tick');
        assert.strictEqual(client.calls.submitOrder.length, 1, 'an OCO for exactly 6 shares is submitted');
        const submitted = client.calls.submitOrder[0];
        assert.strictEqual(submitted.symbol, 'AMD');
        assert.strictEqual(submitted.qty, 6, 'OCO qty must be exactly 6');
        assert.strictEqual(submitted.order_class, 'oco');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('B2 a kill switch triggered by a later plan still sweeps a plan processed earlier in the same tick', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const sweepNow = () => new Date('2026-09-17T19:56:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: sweepNow().toISOString(), kill_switch: false, block_entries: false });
    // Plans are listed newest first: the trigger (older id) is evaluated AFTER the plan with the
    // live entry, which is exactly the order the old single-pass loop got wrong.
    const trigger = await seedPlan('TRGR', 'dt-trgr-entry-b2');
    await db.updateAlpacaDayTradePlan(trigger.id, { protective_stop_broker_order_id: 'stop-trgr-b2' });
    const liveEntryPlan = await seedPlan('LIVE', 'dt-live-entry-b2');

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'stop-trgr-b2', symbol: 'TRGR', side: 'sell', status: 'held', qty: 10 },
            { id: 'broker-parent-LIVE', symbol: 'LIVE', side: 'buy', status: 'accepted', qty: 10, filled_qty: 0, legs: [] },
        ],
        positions: { TRGR: { qty: 10, side: 'long' }, LIVE: null },
    });
    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: sweepNow,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.strictEqual(Boolean((await store.getMonitorState()).kill_switch), true);
        assert.ok(client.calls.cancelOrder.includes('broker-parent-LIVE'), 'the earlier plan\'s live entry must be cancelled in the same tick');
        assert.strictEqual(client.ordersMap.get('broker-parent-LIVE').status, 'canceled');
        const cancelEvent = (await store.listEvents(liveEntryPlan.id))
            .find((e) => e.event_type === 'monitor_action' && e.action === 'cancel_unfilled_remainder');
        assert.ok(cancelEvent, 'the sweep must journal the entry cancellation');
        assert.strictEqual(cancelEvent.outcome, 'cancel_verified');
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

test('B4 a partial entry cancelled under the kill switch is verified and its filled shares protected in the same tick', { timeout: 30_000 }, async () => {
    const lockPath = tempLockPath();
    const midSession = () => new Date('2026-09-17T15:00:00.000Z');
    await store.updateMonitorState({ mode: 'paper_execute', last_rest_reconciliation_at: midSession().toISOString(), kill_switch: true, block_entries: true });
    const plan = await seedPlan('PART', 'dt-part-entry-b4');

    const client = createWorkerStatefulClient({
        orders: [
            { id: 'broker-parent-PART', symbol: 'PART', side: 'buy', status: 'partially_filled', qty: 10, filled_qty: 6, legs: [], submitted_at: '2026-09-17T14:59:00.000Z' },
        ],
        positions: { PART: { qty: 6, side: 'long' } },
    });
    const worker = createWorker({
        client, lockPath, pollIntervalMs: 3_600_000, idlePollIntervalMs: 3_600_000, now: midSession,
        exitPolicy: { legTerminalTimeoutMs: 50, flatVerifyTimeoutMs: 50, pollIntervalMs: 5 },
        sleep: async () => {},
    });

    try {
        await worker.start();
        await worker.runTickNow();
        await worker.stop();

        assert.strictEqual(client.ordersMap.get('broker-parent-PART').status, 'canceled');
        const protection = client.calls.submitOrder.filter((o) => o.symbol === 'PART');
        assert.strictEqual(protection.length, 1, 'the remaining 6 shares must be protected in the same tick');
        assert.strictEqual(protection[0].order_class, 'oco');
        assert.strictEqual(protection[0].qty, 6);
        const actions = (await store.listEvents(plan.id)).filter((e) => e.event_type === 'monitor_action').map((e) => e.action);
        assert.deepStrictEqual(actions, ['cancel_unfilled_remainder', 'attach_protective_oco']);
        assert.strictEqual(Boolean((await store.getMonitorState()).kill_switch), true);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});
