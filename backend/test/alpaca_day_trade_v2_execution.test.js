const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { execFile } = require('node:child_process');

const { createTestDatabase } = require('../test-support/test_database');
const TEST_DB = createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Execution, resolvePlanByClientOrderId, ENTRY_HEARTBEAT_MAX_AGE_MS } = require('../services/alpaca_day_trade_v2_execution');
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
    assert.deepStrictEqual(events, ['submission_started', 'entry_admitted', 'submission_acknowledged', 'entry_settled']);
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

for (const [label, source, code] of [
    ['mode disabled', "await store.updateMonitorState({ mode: 'disabled' });", 'ALPACA_V2_EXECUTION_DISABLED'],
    ['kill switch', 'await store.updateMonitorState({ kill_switch: 1 });', 'ALPACA_V2_KILL_SWITCH_ACTIVE'],
    ['monitor attention', "await store.latchAttention({ code: 'UNEXPECTED_POSITION', eventKey: 'synthetic-anomaly' });", 'ALPACA_V2_ATTENTION_REQUIRED'],
]) {
    test(`a separate process setting ${label} during broker reads prevents admission and POST`, async () => {
        const { client, calls } = fakeClient({ getAccount: async () => {
            await inOtherProcess(source);
            return { status: 'ACTIVE', cash: '50000', equity: '100000' };
        } });
        await assert.rejects(createV2Execution({ store, client, now: () => NOW }).submitEntry(intent()), (error) => error.code === code);
        assert.strictEqual(calls.submit.length, 0);
        assert.deepStrictEqual(await store.listPlans(), []);
        assert.deepStrictEqual(await store.listEntrySubmissions(), []);
    });
}

test('disable cannot succeed over an admitted call, and succeeds after the broker outcome is committed', async () => {
    const disable = `
        try { await store.updateMonitorState({ mode: 'disabled' }); process.stdout.write(JSON.stringify({ changed: true })); }
        catch (error) { process.stdout.write(JSON.stringify({ code: error.code })); }
    `;
    const { client } = fakeClient({ submitOrder: async () => {
        assert.deepStrictEqual(await inOtherProcess(disable), { code: 'ALPACA_V2_SUBMISSION_IN_PROGRESS' });
        const response = await control('/mode', { mode: 'disabled', confirm: true }, client);
        assert.strictEqual(response.status, 409);
        assert.strictEqual(response.body.code, 'ALPACA_V2_SUBMISSION_IN_PROGRESS');
        assert.strictEqual(response.body.error, 'entry submission is in progress; retry after reconciliation');
        const clear = await control('/kill-switch/clear', { confirm: 'CLEAR' }, client);
        assert.strictEqual(clear.status, 409);
        assert.strictEqual(clear.body.code, 'ALPACA_V2_SUBMISSION_IN_PROGRESS');
        assert.strictEqual((await store.getMonitorState()).mode, 'paper_execute');
        return ACK;
    } });
    await createV2Execution({ store, client, now: () => NOW }).submitEntry(intent());
    assert.deepStrictEqual(await store.listEntrySubmissions(), []);
    assert.deepStrictEqual(await inOtherProcess(disable), { changed: true });
    assert.strictEqual((await store.getMonitorState()).mode, 'disabled');
});

test('broker facts read before another instance admits an entry must be refreshed even after it settles', async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let started;
    const reading = new Promise((resolve) => { started = resolve; });
    const second = fakeClient({
        getAccount: async () => { started(); await waiting; return { status: 'ACTIVE', cash: '50000', equity: '100000' }; },
        getLatestQuote: async (symbol) => ({ symbol, quote: { t: '2026-09-23T14:59:59.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } }),
    });
    const pending = createV2Execution({ store, client: second.client, now: () => NOW }).submitEntry(intent({
        symbol: 'AMD', client_order_id: 'dt2-20260923-amd-orb',
    }));
    const refused = assert.rejects(pending, (error) => error.code === 'ALPACA_V2_CONTROL_STATE_CHANGED');
    try {
        await reading;
        const first = fakeClient();
        await createV2Execution({ store, client: first.client, now: () => NOW }).submitEntry(intent());
    } finally {
        release();
    }
    await refused;
    assert.strictEqual(second.calls.submit.length, 0);
});

test('an admission immediately after the initial no-sender check invalidates later broker facts', async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let started;
    const submitted = new Promise((resolve) => { started = resolve; });
    let pending;
    const first = fakeClient({ submitOrder: async () => { started(); await waiting; return ACK; } });
    const observedStore = {
        ...store,
        assertNoEntrySubmissions: async () => {
            await store.assertNoEntrySubmissions();
            pending = createV2Execution({ store, client: first.client, now: () => NOW }).submitEntry(intent());
            await submitted;
        },
    };
    const second = fakeClient({
        getAccount: async () => {
            const snapshot = { status: 'ACTIVE', cash: '50000', equity: '100000' };
            release();
            await pending;
            return snapshot;
        },
        getLatestQuote: async (symbol) => ({ symbol, quote: { t: '2026-09-23T14:59:59.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } }),
    });
    try {
        await assert.rejects(createV2Execution({ store: observedStore, client: second.client, now: () => NOW }).submitEntry(intent({
            symbol: 'AMD', client_order_id: 'dt2-20260923-amd-orb',
        })), (error) => error.code === 'ALPACA_V2_CONTROL_STATE_CHANGED');
    } finally {
        release();
        if (pending) await pending;
    }
    assert.strictEqual(second.calls.submit.length, 0);
});

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

test('independent execution instances cannot admit a second entry while the first call is unresolved', async () => {
    let release;
    const waiting = new Promise((resolve) => { release = resolve; });
    let started;
    const submitted = new Promise((resolve) => { started = resolve; });
    const first = fakeClient({ submitOrder: async () => { started(); await waiting; return ACK; } });
    const second = fakeClient();
    const pending = createV2Execution({ store, client: first.client, now: () => NOW }).submitEntry(intent());
    try {
        await submitted;
        await assert.rejects(createV2Execution({ store, client: second.client, now: () => NOW }).submitEntry(intent({
            symbol: 'AMD', client_order_id: 'dt2-20260923-amd-orb',
        })), (error) => error.code === 'ALPACA_V2_SUBMISSION_IN_PROGRESS');
        assert.strictEqual(second.calls.submit.length, 0);
    } finally {
        release();
        await pending;
    }
});

test('a separate monitor latch during submission survives acknowledgement and blocks subsequent entries', async () => {
    const { client } = fakeClient({ submitOrder: async () => {
        await inOtherProcess(`
            const plan = await store.getPlanByClientOrderId('dt2-20260923-nvda-orb');
            await store.latchAttention({ planId: plan.id, code: 'POSITION_MISMATCH', eventKey: 'concurrent-monitor-anomaly' });
        `);
        return ACK;
    } });
    const execution = createV2Execution({ store, client, now: () => NOW });
    const result = await execution.submitEntry(intent());
    assert.strictEqual(result.plan.state, 'attention_required');
    assert.strictEqual(result.plan.attention_code, 'POSITION_MISMATCH');
    assert.strictEqual(result.plan.parent_order_id, ACK.id);
    assert.strictEqual((await store.getMonitorState()).attention_required, 1);
    assert.deepStrictEqual(await store.listEntrySubmissions(), []);
    await assert.rejects(execution.submitEntry(intent({ symbol: 'AMD', client_order_id: 'dt2-20260923-amd-orb' })),
        (error) => error.code === 'ALPACA_V2_ATTENTION_REQUIRED');
});

for (const state of ['active', 'time_exit_pending', 'closed', 'cancelled']) {
    test(`an acknowledgement preserves concurrently reconciled ${state} state and settles admission`, async () => {
        const { client } = fakeClient({ submitOrder: async () => {
            const plan = await store.getPlanByClientOrderId('dt2-20260923-nvda-orb');
            await store.updatePlan(plan.id, { state });
            return ACK;
        } });
        const result = await createV2Execution({ store, client, now: () => NOW }).submitEntry(intent());
        assert.strictEqual(result.plan.state, state);
        assert.strictEqual(result.plan.parent_order_id, ACK.id);
        assert.deepStrictEqual(await store.listEntrySubmissions(), []);
        await store.updateMonitorState({ mode: 'disabled' });
    });
}

test('a finished local attempt with a failed settlement can recover controls without restarting or resubmitting', async () => {
    let submits = 0;
    const { client } = fakeClient({
        submitOrder: async () => {
            submits += 1;
            await exec(`CREATE TRIGGER test_fail_entry_settlement BEFORE INSERT ON alpaca_dt_v2_events
                WHEN NEW.action = 'entry_settled' BEGIN SELECT RAISE(ABORT, 'synthetic settlement failure'); END`);
            return ACK;
        },
        getOrderByClientOrderId: async () => ({ found: true, order: ACK }),
    });
    const execution = createV2Execution({ store, client, now: () => NOW });
    try {
        await assert.rejects(execution.submitEntry(intent()), /synthetic settlement failure/);
        assert.strictEqual((await store.listEntrySubmissions()).length, 1);
        assert.strictEqual((await store.getPlanByClientOrderId('dt2-20260923-nvda-orb')).state, 'pending_submission');
    } finally {
        await exec('DROP TRIGGER IF EXISTS test_fail_entry_settlement');
    }
    const disabled = await control('/mode', { mode: 'disabled', confirm: true }, client);
    assert.strictEqual(disabled.status, 200);
    assert.deepStrictEqual(await store.listEntrySubmissions(), []);
    const replay = await execution.submitEntry(intent());
    assert.strictEqual(replay.outcome, 'linked');
    assert.strictEqual(replay.plan.state, 'attention_required');
    assert.strictEqual(replay.plan.attention_code, 'SUBMISSION_INTERRUPTED');
    assert.strictEqual(submits, 1);
});

for (const found of [false, true]) {
    test(`a dead sender releases controls while broker ${found ? 'acknowledgement' : 'not-found'} remains subject to reconciliation`, async () => {
        const plan = await inOtherProcess(`
            const { plan } = await store.transaction(async (repo) => {
                const result = await repo.createPlan({
                    client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 's', catalyst: 'c', thesis: 't', invalidation: 'i',
                    planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
                    exit_deadline: '2026-09-23T19:30:00.000Z',
                });
                await repo.admitEntrySubmission(result.plan.id);
                return result;
            });
            process.stdout.write(JSON.stringify(plan));
        `);
        assert.strictEqual((await store.listEntrySubmissions()).length, 1);
        assert.deepStrictEqual(await store.recoverEntrySubmissions(), { activePlanIds: [] });
        await store.updateMonitorState({ mode: 'disabled' });
        assert.strictEqual((await store.getMonitorState()).mode, 'disabled');
        const { client, calls } = fakeClient({ getOrderByClientOrderId: async () => ({ found, order: found ? ACK : null }) });
        const outcome = await resolvePlanByClientOrderId({ store, client, plan, now: () => NOW });
        assert.strictEqual(outcome, found ? 'linked' : 'unresolved');
        const recovered = await store.getPlan(plan.id);
        assert.strictEqual(recovered.state, 'attention_required');
        assert.strictEqual(recovered.attention_code, 'SUBMISSION_INTERRUPTED');
        assert.strictEqual(calls.submit.length, 0);
        assert.deepStrictEqual(await store.listEntrySubmissions(), []);
    });
}
