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
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.serialize(() => {
        sqlite.run('DELETE FROM alpaca_day_trade_plans');
        sqlite.run('DELETE FROM alpaca_paper_orders');
        sqlite.run('DELETE FROM alpaca_paper_fills');
        sqlite.run(
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, activity_cursor = NULL, mode = 'disabled', kill_switch = 0, block_entries = 0, health_code = NULL, last_rest_reconciliation_at = NULL, session_date = NULL WHERE id = 1",
            (err) => { sqlite.close(); err ? reject(err) : resolve(); },
        );
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

function fakeClient(overrides = {}) {
    return {
        getClock: async () => ({ is_open: true, next_close: '2026-09-17T20:00:00.000Z' }),
        getPosition: async () => null,
        getOrder: async () => ({ id: 'broker-parent-1', legs: [] }),
        submitOrder: async () => ({ id: 'broker-order-1', status: 'accepted' }),
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
        let state = await store.getMonitorState();
        while (!state.session_date && Date.now() < deadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            state = await store.getMonitorState();
        }
        assert.strictEqual(state.session_date, '2026-09-17');
        assert.ok(calendarCalls >= 1);
        let noActiveEvents = (await store.listEvents()).filter((event) => event.event_type === 'monitor_decision' && event.outcome === 'no_active_plans');
        const eventDeadline = Date.now() + 10_000;
        while (noActiveEvents.length === 0 && Date.now() < eventDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            noActiveEvents = (await store.listEvents()).filter((event) => event.event_type === 'monitor_decision' && event.outcome === 'no_active_plans');
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

        const state = await store.getMonitorState();
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
                if (Date.now() - start > 3000) return reject(new Error('timed out waiting for a repair submission'));
                setTimeout(check, 10);
            }());
        });
        assert.strictEqual(submitted[0].client_order_id, `dt-repair-${plan.id}`);
    } finally {
        await worker.stop();
        if (fs.existsSync(lockPath)) fs.unlinkSync(lockPath);
    }
});

async function seedPlan(symbol, entryKey) {
    const { plan } = await store.createPlanWithEntry(
        {
            symbol, setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
            planned_entry_low: 100.50, planned_entry_high: 100.50, planned_stop: 98.00, planned_target: 104.00,
            planned_qty: 10, planned_risk_dollars: 25, planned_reward_risk: 1.4, planned_account_risk_pct: 0.00025,
            exit_deadline: '2026-09-17T19:45:00.000Z',
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
                if (Date.now() - start > 3000) return reject(new Error('timed out waiting for the buy-to-cover submission'));
                setTimeout(check, 10);
            }());
        });
        assert.strictEqual(submitted.length, 1, 'the plan after the kill-switch trip must not also be executed in the same tick');
        assert.strictEqual(submitted[0].client_order_id.startsWith('dt-cover-'), true);

        let state = await store.getMonitorState();
        const stateDeadline = Date.now() + 10_000;
        while (!state.kill_switch && Date.now() < stateDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 20); });
            state = await store.getMonitorState();
        }
        assert.strictEqual(state.kill_switch, 1); // SQLite stores this as an integer, not a JS boolean
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
        const submitDeadline = Date.now() + 5_000;
        while (!(submittedSymbols.includes('AAA') && submittedSymbols.includes('BBB')) && Date.now() < submitDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
        }
        assert.ok(injected, 'the injected failure must actually have fired for this assertion to mean anything');
        assert.ok(submittedSymbols.includes('BBB'), 'the plan whose own decision-event append failed must still have its action executed');
        assert.ok(submittedSymbols.includes('AAA'), 'a later plan in the same tick must still be managed after an earlier plan\'s decision-event append failed');
        // Also directly persist discovery (the same two fields the real discoverProtectiveLegs
        // path writes), same as the block_entries self-heal test above -- buildObservation reads
        // these columns, not just the live getOrder legs, to decide a plan is covered.
        await db.updateAlpacaDayTradePlan(planA.id, { protective_stop_broker_order_id: 'stop-aaa', protective_target_broker_order_id: 'target-aaa' });
        await db.updateAlpacaDayTradePlan(planB.id, { protective_stop_broker_order_id: 'stop-bbb', protective_target_broker_order_id: 'target-bbb' });

        let state = await store.getMonitorState();
        const healDeadline = Date.now() + 5_000;
        while (state.block_entries !== 0 && Date.now() < healDeadline) {
            await new Promise((resolve) => { setTimeout(resolve, 50); });
            state = await store.getMonitorState();
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
