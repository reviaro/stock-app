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
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, activity_cursor = NULL, mode = 'disabled', kill_switch = 0, health_code = NULL WHERE id = 1",
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
        await new Promise((resolve) => { setTimeout(resolve, 100); });
        assert.strictEqual(submitCalls, 0, 'shadow mode must never actually submit an order');
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

        const state = await store.getMonitorState();
        assert.strictEqual(state.kill_switch, 1); // SQLite stores this as an integer, not a JS boolean
    } finally {
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
