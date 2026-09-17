const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trading_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');

function post(port, body, requestPath, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const request = http.request({
            host: '127.0.0.1', port, path: requestPath, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
        }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let parsed;
                try { parsed = text ? JSON.parse(text) : null; } catch (_err) { parsed = text; }
                resolve({ status: response.statusCode, body: parsed });
            });
        });
        request.on('error', reject);
        request.end(data);
    });
}

function createApp() {
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../services/alpaca_day_trade_execution')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];
    delete require.cache[require.resolve('../routes/alpaca_day_trading')];
    const app = express();
    app.use(express.json());
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    app.use('/api/alpaca-paper/day-trading', require('../routes/alpaca_day_trading'));
    return app;
}

async function ledgerCounts() {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.get(
        `SELECT (SELECT COUNT(*) FROM transactions) AS portfolio_count,
                (SELECT COUNT(*) FROM sim_transactions) AS simulator_count`,
        (err, row) => { sqlite.close(); err ? reject(err) : resolve(row); },
    ));
}

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
            "UPDATE alpaca_monitor_state SET submission_lease_holder = NULL, submission_lease_expires_at = NULL, mode = 'disabled' WHERE id = 1",
            (err) => { sqlite.close(); err ? reject(err) : resolve(); },
        );
    }));
});

function enableDayTradingGate() {
    const saved = {
        enabled: process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED,
        token: process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN,
        key: process.env.ALPACA_API_KEY,
        secret: process.env.ALPACA_API_SECRET,
        fetch: global.fetch,
    };
    process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = 'true';
    process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = 'test-day-trading-token';
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    return {
        restore() {
            if (saved.enabled == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED; else process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = saved.enabled;
            if (saved.token == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN; else process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = saved.token;
            if (saved.key == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = saved.key;
            if (saved.secret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = saved.secret;
            global.fetch = saved.fetch;
        },
    };
}

function mockAlpacaBroker({
    cash = '50000.00', equity = '100000.00', openOrders = [],
    submitResult = { id: 'private-broker-order-id', status: 'accepted' }, submitError = null, submitStatus = 200,
} = {}) {
    const requests = [];
    const currentOpenOrders = [...openOrders];
    // Captured once, before any request: generating this lazily inside the fetch handler would
    // make it later than the `now` the route already captured as executeDayTradeEntry's default
    // parameter (evaluated synchronously at call time, before the quote fetch's several awaits),
    // making the quote look like it's from the future.
    const quoteTimestamp = new Date().toISOString();
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/v2/account')) {
            return { ok: true, json: async () => ({ status: 'ACTIVE', trading_blocked: false, account_blocked: false, cash, equity }) };
        }
        if (url.endsWith('/v2/assets/NVDA')) return { ok: true, json: async () => ({ class: 'us_equity', status: 'active', tradable: true }) };
        if (url.endsWith('/v2/clock')) return { ok: true, json: async () => ({ is_open: true, next_close: '2026-09-17T20:00:00.000Z' }) };
        if (url.includes('/v2/orders?status=open')) return { ok: true, json: async () => currentOpenOrders };
        if (url.includes('/v2/stocks/NVDA/quotes/latest')) {
            return {
                ok: true,
                json: async () => ({
                    symbol: 'NVDA',
                    quote: { t: quoteTimestamp, bp: 99.98, bs: 2, ap: 100.00, as: 1, c: ['R'], z: 'C' },
                }),
            };
        }
        if (url.endsWith('/v2/orders') && options.method === 'POST') {
            if (submitError) throw submitError;
            if (submitStatus !== 200) return { ok: false, status: submitStatus, json: async () => ({}) };
            currentOpenOrders.push({ ...JSON.parse(options.body), status: 'accepted' });
            return { ok: true, json: async () => submitResult };
        }
        throw new Error(`unexpected broker request: ${url}`);
    };
    return { requests };
}

function fullSectionSevenIntent(overrides = {}) {
    return {
        account_id: 2,
        client_order_id: 'dt-20260917-nvda-opening-breakout-v1',
        symbol: 'NVDA',
        qty: 100,
        setup: 'opening-range breakout',
        catalyst: 'named and verified same-day catalyst',
        thesis: 'price and participation confirmation',
        invalidation: 'loss of opening range and VWAP',
        stop_price: 98.00,
        target_price: 104.00,
        exit_deadline: '2026-09-17T19:45:00.000Z',
        ...overrides,
    };
}

test('POST /day-trading/entries is disabled without the Day Trading gate token, and never contacts the broker', async () => {
    delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED;
    delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
    const savedFetch = global.fetch;
    let called = false;
    global.fetch = async () => { called = true; throw new Error('must not be called'); };

    const app = createApp();
    const server = app.listen(0);
    const result = await post(server.address().port, fullSectionSevenIntent(), '/api/alpaca-paper/day-trading/entries');
    await new Promise((resolve) => server.close(resolve));
    global.fetch = savedFetch;

    assert.strictEqual(result.status, 403);
    assert.strictEqual(called, false);
});

test('POST /day-trading/entries rejects a request without the matching token even when the gate is enabled', async () => {
    const gate = enableDayTradingGate();
    mockAlpacaBroker();
    const app = createApp();
    const server = app.listen(0);
    const result = await post(server.address().port, fullSectionSevenIntent(), '/api/alpaca-paper/day-trading/entries', {
        'X-Alpaca-Day-Trading-Token': 'wrong-token',
    });
    await new Promise((resolve) => server.close(resolve));
    gate.restore();

    assert.strictEqual(result.status, 403);
});

test('POST /day-trading/entries requires account_id 2 as the strategy scope', async () => {
    const gate = enableDayTradingGate();
    const broker = mockAlpacaBroker();
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        fullSectionSevenIntent({ account_id: 1 }),
        '/api/alpaca-paper/day-trading/entries',
        { 'X-Alpaca-Day-Trading-Token': 'test-day-trading-token' },
    );
    await new Promise((resolve) => server.close(resolve));
    gate.restore();

    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.length, 0, 'a wrong account scope must never reach the broker');
});

test('POST /day-trading/entries accepts the full Section 7 intent shape end to end, without leaking private identifiers or touching dashboard ledgers', async () => {
    const gate = enableDayTradingGate();
    const store = require('../services/alpaca_day_trade_store');
    await store.updateMonitorState({ mode: 'paper_execute' });
    mockAlpacaBroker();
    const before = await ledgerCounts();

    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        fullSectionSevenIntent(),
        '/api/alpaca-paper/day-trading/entries',
        { 'X-Alpaca-Day-Trading-Token': 'test-day-trading-token' },
    );
    await new Promise((resolve) => server.close(resolve));
    gate.restore();

    assert.strictEqual(result.status, 201, JSON.stringify(result.body));
    assert.strictEqual(result.body.data.symbol, 'NVDA');
    assert.strictEqual(result.body.data.clientOrderId, 'dt-20260917-nvda-opening-breakout-v1');
    assert.ok(result.body.data.planId > 0);

    const serialized = JSON.stringify(result.body);
    assert.doesNotMatch(serialized, /paper-key|paper-secret|private-broker-order-id/i);

    const after = await ledgerCounts();
    assert.deepStrictEqual(after, before);
});

test('POST /day-trading/entries returns a generic error message, never the policy failure detail', async () => {
    const gate = enableDayTradingGate();
    const store = require('../services/alpaca_day_trade_store');
    await store.updateMonitorState({ mode: 'paper_execute' });
    // cash far below what NVDA qty=100 costs -> ALPACA_INSUFFICIENT_CASH, whose internal
    // message would otherwise disclose exact dollar figures.
    mockAlpacaBroker({ cash: '10.00' });
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        fullSectionSevenIntent(),
        '/api/alpaca-paper/day-trading/entries',
        { 'X-Alpaca-Day-Trading-Token': 'test-day-trading-token' },
    );
    await new Promise((resolve) => server.close(resolve));
    gate.restore();

    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.body.code, 'ALPACA_INSUFFICIENT_CASH');
    assert.doesNotMatch(result.body.error, /\d/, 'the response must not echo computed account figures');
});

test('POST /orders (the generic order route) is refused once Day Trading owns the account (mode paper_execute), without any broker request', async () => {
    const store = require('../services/alpaca_day_trade_store');
    await store.updateMonitorState({ mode: 'paper_execute' });
    const broker = mockAlpacaBroker();
    process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
    process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'irrelevant';
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        { idempotency_key: 'buy-nvda-bypass', symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', limit_price: 100, time_in_force: 'day' },
        '/api/alpaca-paper/orders',
        { 'X-Alpaca-Paper-Order-Token': 'irrelevant' },
    );
    await new Promise((resolve) => server.close(resolve));
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;

    assert.strictEqual(result.status, 403);
    assert.strictEqual(broker.requests.length, 0, 'the generic order route must not reach the broker once Day Trading owns the account');
});

test('POST /orders stays available while Day Trading has not taken over the account (mode not paper_execute), even if its own HTTP gate is enabled', async () => {
    const gate = enableDayTradingGate(); // enables the DT route's own token gate, not `mode`
    mockAlpacaBroker();
    process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
    process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'paper-order-token';
    const app = createApp();
    const server = app.listen(0);
    const result = await post(
        server.address().port,
        { idempotency_key: 'buy-nvda-still-allowed', symbol: 'NVDA', side: 'buy', qty: 1, type: 'limit', limit_price: 100, time_in_force: 'day' },
        '/api/alpaca-paper/orders',
        { 'X-Alpaca-Paper-Order-Token': 'paper-order-token' },
    );
    await new Promise((resolve) => server.close(resolve));
    gate.restore();
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
    delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;

    assert.notStrictEqual(result.status, 403, 'the DT route\'s own access gate must not, by itself, disable the unrelated generic order route');
});
