const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFile } = require('node:child_process');

const { createTestDatabase } = require('../test-support/test_database');
const TEST_DB = createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Execution, resolvePlanByClientOrderId } = require('../services/alpaca_day_trade_v2_execution');
const { createV2Router } = require('../routes/alpaca_day_trading_v2');

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
        getOrder: async (id) => ({ ...ACK, id, legs: ACK.legs.map((leg) => ({ ...leg, symbol: 'NVDA', filled_qty: '0' })) }),
        submitOrder: async (order) => { calls.submit.push(order); return ACK; },
        getOrderByClientOrderId: async (id) => { calls.byClientId.push(id); return { found: false, order: null }; },
        ...overrides,
    };
    return { client, calls };
}

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

// Independent Node processes share only the disposable database. These exercise the
// same boundary used by an HTTP server and a separately running monitor.
function inOtherProcess(source) {
    return new Promise((resolve, reject) => {
        execFile(process.execPath, ['-e', `
            const store = require(process.argv[1]);
            (async () => { ${source} })().catch(error => {
                console.error(error.code || error.message); process.exitCode = 1;
            });
        `, require.resolve('../services/alpaca_day_trade_v2_store')], {
            env: { PATH: process.env.PATH, DB_PATH_OVERRIDE: TEST_DB }, timeout: 30000,
        }, (error, stdout) => error ? reject(error) : resolve(stdout ? JSON.parse(stdout) : null));
    });
}

async function control(path, body, client) {
    const router = createV2Router({ store, createClient: () => client, now: () => NOW });
    const handler = router.stack.find((layer) => layer.route?.path === path).route.stack[0].handle;
    const response = { status: 200, body: null };
    const res = { status(code) { response.status = code; return this; }, json(value) { response.body = value; return this; } };
    await handler({ auth: { type: 'session', role: 'operator' }, body }, res, (error) => { throw error; });
    return response;
}

test('CLEAR cannot erase a monitor anomaly observed while reading the broker', async () => {
    await store.updateMonitorState({ kill_switch: 1 });
    const { client } = fakeClient({ getPositions: async () => {
        await inOtherProcess("await store.latchAttention({ code: 'UNEXPECTED_POSITION', eventKey: 'new-anomaly-during-clear' });");
        return [];
    } });
    const response = await control('/kill-switch/clear', { confirm: 'CLEAR' }, client);
    assert.strictEqual(response.status, 409);
    assert.strictEqual(response.body.code, 'ALPACA_V2_CONTROL_STATE_CHANGED');
    const state = await store.getMonitorState();
    assert.strictEqual(state.kill_switch, 1);
    assert.strictEqual(state.attention_required, 1);
});

// Retirement applies to callers that still import the former execution service,
// even if an existing database remains in paper_execute mode.
test('retired direct entry and preview refuse before any store or broker access', async () => {
    const unexpected = new Proxy({}, { get() { throw new Error('retired path accessed a dependency'); } });
    const execution = createV2Execution({ store: unexpected, client: unexpected });
    for (const method of ['submitEntry', 'previewEntry']) {
        await assert.rejects(execution[method](intent()), { code: 'ALPACA_DAY_TRADING_RETIRED' });
    }
    assert.deepStrictEqual(await store.listPlans(), []);
});
