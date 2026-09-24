const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trading_v2_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const store = require('../services/alpaca_day_trade_v2_store');
const { createV2Router } = require('../routes/alpaca_day_trading_v2');
const { createAuth, hashPassword } = require('../services/auth');
const { createApp: createServerApp } = require('../server');

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
                resolve({ status: res.statusCode, body: parsed, text });
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
function appWith(auth) {
    const app = express();
    app.use(express.json());
    if (auth) app.use((req, _res, next) => { req.auth = auth; next(); });
    app.use('/v2', createV2Router({ store, createClient: () => broker.client, now: NOW }));
    return app;
}

async function withServer(auth, fn) {
    const server = appWith(auth).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
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
    return store.updatePlan(plan.id, {
        state: 'closed', parent_order_id: 'parent-uuid-1', stop_order_id: 'stop-uuid-1', target_order_id: 'target-uuid-1',
        filled_entry_qty: 10, avg_entry_price: 100.4, filled_exit_qty: 10, avg_exit_price: 104, exit_reason: 'take_profit', realized_pnl: 36, realized_r: 1.44,
        closed_at: '2026-09-23T18:00:00.000Z',
    });
}

// ---- entries ----

test('scoped agent entry in paper_execute submits one bracket and the response carries no broker/client ids', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    const res = await withServer(AGENT, (server) => request(server, 'POST', '/v2/entries', entryBody()));
    assert.strictEqual(res.status, 201, res.text);
    assert.strictEqual(res.body.data.outcome, 'acknowledged');
    assert.strictEqual(res.body.data.symbol, 'NVDA');
    assert.strictEqual(broker.calls.submit, 1);
    assert.doesNotMatch(res.text, PRIVATE);
});

test('an entry refused by policy returns a fixed generic message with no account figures', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    broker.client.getAccount = async () => ({ status: 'ACTIVE', cash: '1000', equity: '100000' });
    const res = await withServer(AGENT, (server) => request(server, 'POST', '/v2/entries', entryBody()));
    assert.strictEqual(res.status, 422);
    assert.strictEqual(res.body.code, 'ALPACA_V2_INSUFFICIENT_CASH');
    assert.doesNotMatch(res.body.error, /\d/);
    assert.strictEqual(broker.calls.submit, 0);
});

test('entries require account_id 2 at the route even for an operator', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    const res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/entries', entryBody({ account_id: 1 })));
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.code, 'ALPACA_V2_ACCOUNT_SCOPE_REQUIRED');
    assert.strictEqual(broker.calls.submit, 0);
});

test('entries are refused outside paper_execute before any broker call', async () => {
    const res = await withServer(AGENT, (server) => request(server, 'POST', '/v2/entries', entryBody()));
    assert.strictEqual(res.status, 403);
    assert.strictEqual(res.body.code, 'ALPACA_V2_EXECUTION_DISABLED');
    assert.strictEqual(broker.calls.submit, 0);
});

test('an uncertain submission answers 503 SUBMISSION_UNKNOWN; a retry that cannot be resolved answers 409 unresolved', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    broker.client.submitOrder = async () => { throw Object.assign(new Error('timeout'), { name: 'TimeoutError' }); };
    const first = await withServer(AGENT, (server) => request(server, 'POST', '/v2/entries', entryBody()));
    assert.strictEqual(first.status, 503);
    assert.strictEqual(first.body.code, 'ALPACA_V2_SUBMISSION_UNKNOWN');
    const retry = await withServer(AGENT, (server) => request(server, 'POST', '/v2/entries', entryBody()));
    assert.strictEqual(retry.status, 409);
    assert.strictEqual(retry.body.code, 'ALPACA_V2_SUBMISSION_UNRESOLVED');
    assert.doesNotMatch(first.text + retry.text, PRIVATE);
});

test('a reader principal cannot submit entries, decisions, or reviews', async () => {
    for (const p of ['/v2/entries', '/v2/decisions', '/v2/plans/1/review']) {
        const res = await withServer(READER, (server) => request(server, 'POST', p, { account_id: 2 }));
        assert.strictEqual(res.status, 403, p);
    }
});

// ---- decisions and reviews ----

test('a NO TRADE decision is journaled idempotently with sanitized detail', async () => {
    const body = { account_id: 2, decision_key: '2026-09-23:nvda:open', reason_code: 'NO_SETUP', symbol: 'NVDA', notes: 'no volume; see https://evil.example dt2-leak', api_secret: 'x' };
    const first = await withServer(AGENT, (server) => request(server, 'POST', '/v2/decisions', body));
    const replay = await withServer(AGENT, (server) => request(server, 'POST', '/v2/decisions', body));
    assert.strictEqual(first.status, 201, first.text);
    assert.strictEqual(replay.status, 200);
    const decisions = (await store.listEvents()).filter((e) => e.event_type === 'decision');
    assert.strictEqual(decisions.length, 1);
    assert.doesNotMatch(decisions[0].detail_json, /https|dt2-leak|api_secret/);
});

test('decisions and reviews require account_id 2', async () => {
    const decision = await withServer(AGENT, (server) => request(server, 'POST', '/v2/decisions', { account_id: 1, decision_key: 'k', reason_code: 'NO_SETUP' }));
    assert.strictEqual(decision.status, 400);
    const review = await withServer(AGENT, (server) => request(server, 'POST', '/v2/plans/1/review', { account_id: '2', revision_key: 'r1', thesis_valid: true }));
    assert.strictEqual(review.status, 400);
});

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

test('paper_execute requires the exact typed confirmation', async () => {
    for (const confirm of [true, 'PAPER_EXECUTE', 'paper_execute ', undefined]) {
        const res = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/mode', { mode: 'paper_execute', confirm }));
        assert.strictEqual(res.status, 400, String(confirm));
        assert.strictEqual(res.body.code, 'ALPACA_V2_CONFIRMATION_REQUIRED');
    }
    assert.strictEqual((await store.getMonitorState()).mode, 'disabled');
    const ok = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/mode', { mode: 'paper_execute', confirm: 'paper_execute' }));
    assert.strictEqual(ok.status, 200);
    assert.strictEqual((await store.getMonitorState()).mode, 'paper_execute');
    const events = (await store.listEvents()).filter((e) => e.event_type === 'mode_change');
    assert.strictEqual(events.length, 1);
});

test('shadow and disabled need an explicit confirmation too, and unknown modes are refused', async () => {
    const missing = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/mode', { mode: 'shadow' }));
    assert.strictEqual(missing.status, 400);
    const bad = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/mode', { mode: 'live', confirm: 'live' }));
    assert.strictEqual(bad.status, 400);
    const ok = await withServer(OPERATOR, (server) => request(server, 'POST', '/v2/mode', { mode: 'shadow', confirm: 'shadow' }));
    assert.strictEqual(ok.status, 200);
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

// ---- full server wiring ----

function serverAuth(token) {
    return createAuth({
        username: 'dashboard-user', passwordHash: hashPassword('pw', Buffer.alloc(16, 9)),
        sessionSecret: 'integration-test-session-secret-32-bytes', alpacaDayTradingToken: token, allowLoopback: false,
    });
}

test('through the real server, the scoped agent reaches only v2 entries/decisions/reviews and only with account_id 2', async () => {
    const token = 'day-trading-agent-token-at-least-32-characters';
    const server = createServerApp({ auth: serverAuth(token) }).listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const auth = { Authorization: `Bearer ${token}` };
    try {
        const allowed = await request(server, 'POST', '/api/alpaca-paper/day-trading/v2/decisions', { account_id: 2, decision_key: 'wire-check', reason_code: 'NO_SETUP' }, auth);
        assert.notStrictEqual(allowed.body?.code, 'CAPABILITY_DENIED', allowed.text);
        for (const [method, p, body] of [
            ['POST', '/api/alpaca-paper/day-trading/v2/entries', { account_id: 999 }],
            ['POST', '/api/alpaca-paper/day-trading/v2/decisions', { account_id: '2' }],
            ['POST', '/api/alpaca-paper/day-trading/v2/plans/1/review', {}],
            ['POST', '/api/alpaca-paper/day-trading/v2/mode', { account_id: 2, mode: 'paper_execute', confirm: 'paper_execute' }],
            ['POST', '/api/alpaca-paper/day-trading/v2/kill-switch/clear', { account_id: 2, confirm: 'CLEAR' }],
            ['POST', '/api/alpaca-paper/day-trading/v2/plans/1/resolve', { account_id: 2, confirm: 'NVDA' }],
            ['POST', '/api/alpaca-paper/day-trading/entries', { account_id: 2 }],
            ['POST', '/api/alpaca-paper/orders', { account_id: 2 }],
            ['POST', '/api/simulator/trade', { account_id: 2 }],
            ['GET', '/api/alpaca-paper/day-trading/v2/snapshot', undefined],
        ]) {
            const res = await request(server, method, p, body, auth);
            assert.strictEqual(res.status, 403, `${method} ${p}`);
            assert.strictEqual(res.body.code, 'CAPABILITY_DENIED', `${method} ${p}`);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('the generic paper order route is refused while v2 owns the account in paper_execute', async () => {
    await store.updateMonitorState({ mode: 'paper_execute' });
    process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
    process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'paper-order-token';
    const savedFetch = global.fetch;
    let fetched = false;
    global.fetch = async () => { fetched = true; throw new Error('no'); };
    const app = express();
    app.use(express.json());
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const res = await request(server, 'POST', '/api/alpaca-paper/orders',
            { idempotency_key: 'k', symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', limit_price: 100, time_in_force: 'day' },
            { 'X-Alpaca-Paper-Order-Token': 'paper-order-token' });
        assert.strictEqual(res.status, 403);
        assert.strictEqual(fetched, false);
    } finally {
        await new Promise((resolve) => server.close(resolve));
        global.fetch = savedFetch;
        delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
        delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;
    }
});
