const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const express = require('express');

const { createTestDatabase } = require('../test-support/test_database');
const TEST_DB = createTestDatabase();
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Router } = require('../routes/alpaca_day_trading_v2');

const OPERATOR = { type: 'session', role: 'operator', username: 'op' };
const AGENT = { type: 'bearer', role: 'alpaca-day-trading-agent', username: 'alpaca-day-trading-agent' };
const READER = { type: 'loopback', role: 'reader', username: 'op' };
const NOW = () => new Date();
const PRIVATE = /9f1c2d3e-1111|parent-uuid|stop-uuid|target-uuid|dt2-|client_order_id|order_id|account_number|acct-|https?:|APCA|secret|exec-uuid/i;

function exec(sql) {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.exec(sql, (err) => { sqlite.close(); err ? reject(err) : resolve(); }));
}

function request(server, method, requestPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: server.address().port, path: requestPath, method,
            headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = text ? JSON.parse(text) : null; } catch (_error) { parsed = text; }
                resolve({ status: res.statusCode, body: parsed, text, headers: res.headers });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function fakeClient(overrides = {}) {
    const calls = { submit: 0, mutations: 0 };
    const client = {
        getAccount: async () => ({ id: 'acct-123', account_number: 'PA-SECRET', status: 'ACTIVE', cash: '50000', equity: '100000', buying_power: '400000' }),
        getClock: async () => ({ is_open: true, next_close: new Date(Date.now() + 5 * 3600_000).toISOString(), next_open: new Date(Date.now() + 20 * 3600_000).toISOString() }),
        getAsset: async () => ({ class: 'us_equity', status: 'active', tradable: true }),
        getLatestQuote: async (symbol) => ({ symbol, quote: { t: new Date(Date.now() - 500).toISOString(), bp: 99.98, bs: 3, ap: 100, as: 2 } }),
        getOrders: async () => [],
        getPositions: async () => [],
        getPosition: async () => null,
        getOrder: async () => null,
        getOrderByClientOrderId: async () => ({ found: false, order: null }),
        getAccountActivities: async () => [],
        submitOrder: async (order) => {
            calls.submit += 1; calls.mutations += 1;
            return { id: 'parent-uuid-1', client_order_id: order.client_order_id, symbol: order.symbol, side: 'buy', status: 'accepted', qty: String(order.qty), filled_qty: '0', legs: [{ id: 'stop-uuid-1', type: 'stop' }, { id: 'target-uuid-1', type: 'limit' }] };
        },
        cancelOrder: async () => { calls.mutations += 1; return { canceled: true }; },
        ...overrides,
    };
    return { client, calls };
}

let broker;
function appWith(auth, options = {}) {
    const app = express();
    app.use(express.json());
    if (auth) app.use((req, _res, next) => { req.auth = auth; next(); });
    app.use('/v2', createV2Router({ store, createClient: () => broker.client, now: NOW, ...options }));
    return app;
}

async function withServer(auth, fn, options) {
    const server = appWith(auth, options).listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    try { return await fn(server); } finally { await new Promise((resolve) => server.close(resolve)); }
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
    await store.updateMonitorState({ mode: 'disabled', kill_switch: 0, attention_required: 0, attention_code: null, last_reconciled_at: new Date().toISOString() });
    broker = fakeClient();
});

function entryBody(overrides = {}) {
    return {
        account_id: 2, client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', qty: 10,
        setup: 'opening-range breakout', catalyst: 'earnings beat', thesis: 'holds range', invalidation: 'loses VWAP',
        stop: 98, target: 104, exit_deadline: new Date(Date.now() + 4 * 3600_000).toISOString(), ...overrides,
    };
}

async function seedClosedPlan() {
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 'orb', catalyst: 'earnings', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25,
        exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    await store.recordFill({ execution_id: 'exec-uuid-1', plan_id: plan.id, order_id: 'parent-uuid-1', order_client_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', side: 'buy', qty: 10, price: 100.4, role: 'entry', executed_at: '2026-09-23T14:31:00.000Z', source: 'rest' });
    await store.recordFill({ execution_id: 'exec-uuid-2', plan_id: plan.id, order_id: 'target-uuid-1', symbol: 'NVDA', side: 'sell', qty: 10, price: 104, role: 'bracket_exit', executed_at: '2026-09-23T18:00:00.000Z', source: 'rest' });
    return store.updatePlan(plan.id, {
        state: 'closed', parent_order_id: 'parent-uuid-1', stop_order_id: 'stop-uuid-1', target_order_id: 'target-uuid-1',
        filled_entry_qty: 10, avg_entry_price: 100.4, filled_exit_qty: 10, avg_exit_price: 104, exit_reason: 'take_profit', realized_pnl: 36, realized_r: 1.44,
        closed_at: '2026-09-23T18:00:00.000Z',
    });
}


async function previewState() {
    return { plans: await store.listPlans(), fills: await store.listFills(), events: await store.listEvents(), state: await store.getMonitorState() };
}

test('a review of a terminal plan is journaled; a conflicting revision is refused', async () => {
    const plan = await seedClosedPlan();
    const body = { account_id: 2, revision_key: 'r1', thesis_valid: true, notes: 'clean breakout', mfe: 4.1, mae: 0.6 };
    const first = await withServer(AGENT, (server) => request(server, 'POST', `/v2/plans/${plan.id}/review`, body));
    assert.strictEqual(first.status, 201, first.text);
    const conflict = await withServer(AGENT, (server) => request(server, 'POST', `/v2/plans/${plan.id}/review`, { ...body, thesis_valid: false }));
    assert.strictEqual(conflict.status, 409);
});

// ---- operator controls ----

test('agent and reader principals cannot change mode, clear the kill switch, or resolve plans', async () => {
    for (const auth of [AGENT, READER, null]) {
        for (const [p, body] of [['/v2/mode', { mode: 'shadow', confirm: 'shadow' }], ['/v2/kill-switch/clear', { confirm: 'CLEAR' }], ['/v2/plans/1/resolve', { confirm: 'NVDA' }]]) {
            const res = await withServer(auth, (server) => request(server, 'POST', p, body, { 'X-Alpaca-Day-Trading-Token': 'anything' }));
            assert.strictEqual(res.status, 403, `${auth?.role} ${p}`);
            assert.strictEqual(res.body.code, 'ALPACA_V2_OPERATOR_REQUIRED');
        }
    }
    assert.strictEqual((await store.getMonitorState()).mode, 'disabled');
});

test('clearing the kill switch requires exactly CLEAR', async () => {
    await store.updateMonitorState({ kill_switch: 1 });
    for (const confirm of [true, 'clear', 'CLEAR ']) {
        const res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/kill-switch/clear', { confirm }));
        assert.strictEqual(res.status, 400);
    }
    assert.strictEqual((await store.getMonitorState()).kill_switch, 1);
});

test('CLEAR clears the kill switch and attention latch only after a read-only broker pass shows nothing unaccounted for', async () => {
    await store.updateMonitorState({ kill_switch: 1, attention_required: 1, attention_code: 'BROKER_UNREADABLE' });
    const res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/kill-switch/clear', { confirm: 'CLEAR' }));
    assert.strictEqual(res.status, 200, res.text);
    const state = await store.getMonitorState();
    assert.strictEqual(state.kill_switch, 0);
    assert.strictEqual(state.attention_required, 0);
    assert.strictEqual(broker.calls.mutations, 0);
});

test('CLEAR is refused while a plan is attention-required, or an untracked position/order exists, or the broker is unreadable', async () => {
    await store.updateMonitorState({ attention_required: 1, attention_code: 'X' });
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 'orb', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25, exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_NOT_FOUND', eventKey: 'x' });
    let res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/kill-switch/clear', { confirm: 'CLEAR' }));
    assert.strictEqual(res.status, 409);
    assert.strictEqual((await store.getMonitorState()).attention_required, 1);

    await exec(`UPDATE alpaca_dt_v2_plans SET state = 'cancelled'`);
    broker.client.getPositions = async () => [{ symbol: 'TSLA', qty: '1', side: 'long' }];
    res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/kill-switch/clear', { confirm: 'CLEAR' }));
    assert.strictEqual(res.status, 409);

    broker.client.getPositions = async () => { throw new Error('down'); };
    res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/kill-switch/clear', { confirm: 'CLEAR' }));
    assert.strictEqual(res.status, 503);
    assert.strictEqual((await store.getMonitorState()).attention_required, 1);
});

test('operator resolve needs the typed symbol and a flat broker; it never mutates the broker', async () => {
    const { plan } = await store.createPlan({
        client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', setup: 'orb', catalyst: 'c', thesis: 't', invalidation: 'i',
        planned_qty: 10, planned_entry_price: 100.5, planned_stop: 98, planned_target: 104, planned_risk_dollars: 25, exit_deadline: '2026-09-23T19:30:00.000Z',
    });
    await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_NOT_FOUND', eventKey: 'y' });
    const wrong = await withServer(OPERATOR, (server) => request(server, 'POST', `/v2/plans/${plan.id}/resolve`, { confirm: 'AMD' }));
    assert.strictEqual(wrong.status, 400);

    broker.client.getPosition = async () => ({ symbol: 'NVDA', qty: '10', side: 'long' });
    const exposed = await withServer(OPERATOR, (server) => request(server, 'POST', `/v2/plans/${plan.id}/resolve`, { confirm: 'NVDA' }));
    assert.strictEqual(exposed.status, 409);

    broker.client.getPosition = async () => null;
    const ok = await withServer(OPERATOR, (server) => request(server, 'POST', `/v2/plans/${plan.id}/resolve`, { confirm: 'NVDA' }));
    assert.strictEqual(ok.status, 200, ok.text);
    assert.strictEqual((await store.getPlan(plan.id)).state, 'cancelled');
    assert.strictEqual(broker.calls.mutations, 0);
});

// ---- readers ----

test('reader routes expose only sanitized status, quantities, and prices', async () => {
    const plan = await seedClosedPlan();
    await store.appendEvent({ event_key: `plan:${plan.id}:note`, plan_id: plan.id, event_type: 'submission', action: 'x', detail: { symbol: 'NVDA', note: 'order 9f1c2d3e-1111-4222-8333-444455556666' } });
    broker.client.getPositions = async () => [{ symbol: 'NVDA', qty: '5', side: 'long', asset_id: 'asset-uuid', avg_entry_price: '100', current_price: '101', market_value: '505', unrealized_pl: '5' }];
    broker.client.getOrders = async () => [{ id: 'target-uuid-1', client_order_id: 'dt2-20260923-nvda-orb', symbol: 'NVDA', side: 'sell', type: 'limit', qty: '5', filled_qty: '0', status: 'new', limit_price: '104' }];
    await withServer(READER, async (server) => {
        for (const p of ['/v2/status', '/v2/snapshot', '/v2/plans', `/v2/plans/${plan.id}`, '/v2/journal']) {
            const res = await request(server, 'GET', p);
            assert.strictEqual(res.status, 200, `${p} ${res.text}`);
            assert.doesNotMatch(res.text, PRIVATE, p);
            assert.doesNotMatch(res.text, /event_key|eventKey/, p);
        }
    });
});

test('the snapshot reports a broker outage generically without exception text', async () => {
    broker.client.getAccount = async () => { throw new Error('Alpaca paper request failed (503) https://paper-api.alpaca.markets'); };
    const res = await withServer(READER, (server) => request(server, 'GET', '/v2/snapshot'));
    assert.strictEqual(res.status, 503);
    assert.doesNotMatch(res.text, /https|request failed/);
});

test('status reports mode, latch, and heartbeat freshness from local state only', async () => {
    broker.client.getAccount = async () => { throw new Error('must not be called'); };
    await store.updateMonitorState({ mode: 'shadow', attention_required: 1, attention_code: 'CANCEL_TIMEOUT' });
    const res = await withServer(READER, (server) => request(server, 'GET', '/v2/status'));
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.mode, 'shadow');
    assert.strictEqual(res.body.data.attentionRequired, true);
    assert.strictEqual(res.body.data.attentionCode, 'CANCEL_TIMEOUT');
    assert.strictEqual(res.body.data.heartbeatFresh, true);
});

test('retired entry routes refuse every caller before broker or store writes', async () => {
    const before = await previewState();
    for (const principal of [undefined, OPERATOR, AGENT, READER]) {
        await withServer(principal, async server => {
            for (const endpoint of ['/entries', '/entries/preview', '/decisions']) {
                const result = await request(server, 'POST', '/v2' + endpoint, entryBody());
                assert.strictEqual(result.status, 410);
                assert.strictEqual(result.body.code, 'ALPACA_DAY_TRADING_RETIRED');
            }
        }, { createClient: () => { throw new Error('retired entry accessed broker'); } });
    }
    assert.deepStrictEqual(await previewState(), before);
});

test('retired monitor mode cannot reactivate but operator can explicitly disable it', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    await withServer(OPERATOR, async server => {
        for (const mode of ['paper_execute', 'shadow']) {
            const result = await request(server, 'POST', '/v2/mode', { mode, confirm: mode });
            assert.strictEqual(result.status, 410);
            assert.strictEqual(result.body.code, 'ALPACA_DAY_TRADING_RETIRED');
        }
        assert.strictEqual((await request(server, 'POST', '/v2/mode', { mode: 'disabled' })).status, 400);
        const disabled = await request(server, 'POST', '/v2/mode', { mode: 'disabled', confirm: 'disabled' });
        assert.strictEqual(disabled.status, 200);
        assert.strictEqual((await store.getMonitorState()).mode, 'disabled');
    });
    assert.strictEqual(broker.calls.mutations, 0);
});
