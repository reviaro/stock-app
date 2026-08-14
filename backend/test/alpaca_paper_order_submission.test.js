const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_alpaca_paper_order_submission.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');

function post(port, body, requestPath = '/api/alpaca-paper/orders') {
    return new Promise((resolve, reject) => {
        const request = http.request({ host: '127.0.0.1', port, path: requestPath, method: 'POST', headers: {
            'Content-Type': 'application/json',
            ...(process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN ? { 'X-Alpaca-Paper-Order-Token': process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN } : {}),
        } }, (response) => {
            let text = '';
            response.on('data', (chunk) => { text += chunk; });
            response.on('end', () => {
                let body;
                try { body = text ? JSON.parse(text) : null; } catch (_err) { body = text; }
                resolve({ status: response.statusCode, body });
            });
        });
        request.on('error', reject);
        request.end(JSON.stringify(body));
    });
}

function createApp() {
    delete require.cache[require.resolve('../services/alpaca_paper_service')];
    delete require.cache[require.resolve('../routes/alpaca_paper')];
    const app = express();
    app.use(express.json());
    app.use('/api/alpaca-paper', require('../routes/alpaca_paper'));
    return app;
}

async function ledgerCounts() {
    const sqlite = db.getDb();
    return new Promise((resolve, reject) => sqlite.get('SELECT (SELECT COUNT(*) FROM transactions) AS portfolio_count, (SELECT COUNT(*) FROM sim_transactions) AS simulator_count', (err, row) => { sqlite.close(); err ? reject(err) : resolve(row); }));
}

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});
after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });
beforeEach(async () => {
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.run('DELETE FROM alpaca_paper_orders', (err) => { sqlite.close(); err ? reject(err) : resolve(); }));
});

function enableMockBroker({ cash = '1000.00', position = null, openOrders = [], postResult = { id: 'private-broker-id', status: 'accepted' }, postError = null, postStatus = 200, orderEntryEnabled = true } = {}) {
    const saved = {
        fetch: global.fetch, key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET,
        entryEnabled: process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED, entryToken: process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN,
    };
    process.env.ALPACA_API_KEY = 'paper-key';
    process.env.ALPACA_API_SECRET = 'paper-secret';
    if (orderEntryEnabled) {
        process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = 'true';
        process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = 'test-order-entry-token';
    } else {
        delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED;
        delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;
    }
    const requests = [];
    const currentOpenOrders = [...openOrders];
    global.fetch = async (url, options = {}) => {
        requests.push({ url, options });
        if (url.endsWith('/v2/account')) return { ok: true, json: async () => ({ status: 'ACTIVE', cash }) };
        if (url.endsWith('/v2/assets/MSFT')) return { ok: true, json: async () => ({ class: 'us_equity', status: 'active', tradable: true }) };
        if (url.endsWith('/v2/positions/MSFT')) return position ? { ok: true, json: async () => position } : { ok: false, status: 404, json: async () => ({}) };
        if (url.includes('/v2/orders:by_client_order_id')) return { ok: false, status: 404, json: async () => ({}) };
        if (url.endsWith('/v2/orders') && options.method === 'POST') {
            if (postError) throw postError;
            if (postStatus !== 200) return { ok: false, status: postStatus, json: async () => ({}) };
            const submitted = JSON.parse(options.body);
            currentOpenOrders.push({ ...submitted, status: 'accepted' });
            return { ok: true, json: async () => postResult };
        }
        if (url.includes('/v2/orders?status=open')) return { ok: true, json: async () => currentOpenOrders };
        throw new Error(`unexpected broker request: ${url}`);
    };
    return { requests, restore() {
        global.fetch = saved.fetch;
        if (saved.key == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = saved.key;
        if (saved.secret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = saved.secret;
        if (saved.entryEnabled == null) delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED; else process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = saved.entryEnabled;
        if (saved.entryToken == null) delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN; else process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = saved.entryToken;
    } };
}

const buy = { idempotency_key: 'buy-msft-001', symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400, time_in_force: 'day' };

test('POST submits a cash-covered paper limit buy after auditing it without touching dashboard ledgers', async () => {
    const broker = enableMockBroker();
    const server = createApp().listen(0);
    const result = await post(server.address().port, buy);
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 201);
    assert.deepStrictEqual(result.body, { status: 'success', data: { symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', timeInForce: 'day', limitPrice: 400, status: 'accepted' } });
    assert.strictEqual(broker.requests.length, 5);
    assert.strictEqual(broker.requests[4].url, 'https://paper-api.alpaca.markets/v2/orders');
    assert.strictEqual(broker.requests[4].options.method, 'POST');
    assert.deepStrictEqual(JSON.parse(broker.requests[4].options.body), { symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400, time_in_force: 'day', client_order_id: 'buy-msft-001' });
    assert.doesNotMatch(JSON.stringify(result.body), /private-broker-id|paper-key|paper-secret/i);
    assert.deepStrictEqual(await ledgerCounts(), { portfolio_count: 0, simulator_count: 0 });
    const audits = await db.listAlpacaPaperOrderAudits();
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].status, 'accepted');
    assert.strictEqual(audits[0].broker_order_id, 'private-broker-id');
});

test('POST order entry is disabled by default before any broker request', async () => {
    const broker = enableMockBroker({ orderEntryEnabled: false });
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'order-entry-disabled' });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 403);
    assert.strictEqual(broker.requests.length, 0);
});

test('POST rejects a duplicate idempotency key without a second broker submission', async () => {
    const broker = enableMockBroker();
    const server = createApp().listen(0);
    const first = await post(server.address().port, { ...buy, idempotency_key: 'buy-msft-duplicate' });
    const second = await post(server.address().port, { ...buy, idempotency_key: 'buy-msft-duplicate' });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(first.status, 201);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(broker.requests.filter((request) => request.url.endsWith('/v2/orders')).length, 1);
});

test('POST rejects an insufficient-cash buy before broker submission', async () => {
    const broker = enableMockBroker({ cash: '100.00' });
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'buy-insufficient-cash' });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.filter((request) => request.url.endsWith('/v2/orders')).length, 0);
    assert.strictEqual((await db.listAlpacaPaperOrderAudits()).length, 0);
});

test('POST deducts open buy commitments from cash before sizing a new order', async () => {
    const broker = enableMockBroker({
        cash: '1000.00',
        openOrders: [{ symbol: 'AAPL', side: 'buy', qty: '2', limit_price: '350', status: 'new' }],
    });
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'buy-after-open-commitment' });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('POST reserves cash from a nonterminal local audit when broker open orders lag', async () => {
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'accepted-local-reservation',
        symbol: 'AAPL',
        side: 'buy',
        qty: 2,
        order_type: 'limit',
        time_in_force: 'day',
        limit_price: 350,
        status: 'accepted',
    });
    const broker = enableMockBroker({ cash: '1000.00', openOrders: [] });
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'buy-during-broker-lag' });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('an ambiguous broker timeout blocks later submissions until reconciliation', async () => {
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    const broker = enableMockBroker({ cash: '1000.00', postError: timeoutError });
    const server = createApp().listen(0);
    const first = await post(server.address().port, { ...buy, idempotency_key: 'ambiguous-first' });
    const second = await post(server.address().port, {
        ...buy,
        idempotency_key: 'blocked-after-ambiguous',
        qty: 1,
        limit_price: 100,
    });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();

    assert.strictEqual(first.status, 503);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 1);
    const audits = await db.listAlpacaPaperOrderAudits();
    assert.strictEqual(audits.find((audit) => audit.idempotency_key === 'ambiguous-first').status, 'submission_unknown');
});

test('an ambiguous broker 503 blocks later submissions until reconciliation', async () => {
    const broker = enableMockBroker({ cash: '1000.00', postStatus: 503 });
    const server = createApp().listen(0);
    const first = await post(server.address().port, { ...buy, idempotency_key: 'test-503' });
    const second = await post(server.address().port, {
        ...buy,
        idempotency_key: 'blocked-after-503',
        qty: 1,
        limit_price: 100,
    });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();

    assert.strictEqual(first.status, 503);
    assert.strictEqual(second.status, 409);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 1);
    const audits = await db.listAlpacaPaperOrderAudits();
    assert.strictEqual(audits.find((audit) => audit.idempotency_key === 'test-503').status, 'submission_unknown');
});

test('a stale pending submission blocks another broker POST after restart', async () => {
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'crash-left-pending',
        symbol: 'AAPL',
        side: 'buy',
        qty: 1,
        order_type: 'limit',
        time_in_force: 'day',
        limit_price: 10,
        status: 'pending_submission',
    });
    const broker = enableMockBroker({ cash: '1000.00' });
    const server = createApp().listen(0);
    const result = await post(server.address().port, {
        ...buy,
        idempotency_key: 'blocked-after-crash',
        qty: 1,
        limit_price: 100,
    });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();

    assert.strictEqual(result.status, 409);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 0);
});

test('operator can explicitly resolve a broker-confirmed missing submission', async () => {
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'confirmed-missing',
        symbol: 'MSFT',
        side: 'buy',
        qty: 1,
        order_type: 'limit',
        time_in_force: 'day',
        limit_price: 100,
        status: 'submission_unknown',
    });
    const broker = enableMockBroker();
    const server = createApp().listen(0);
    const result = await post(server.address().port, {
        idempotency_key: 'confirmed-missing',
        confirm_not_found: true,
    }, '/api/alpaca-paper/resolve-missing');
    await new Promise((resolve) => server.close(resolve));
    broker.restore();

    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { status: 'success', data: { status: 'submission_not_found' } });
});

test('concurrent buys are serialized so they cannot overcommit cash', async () => {
    const broker = enableMockBroker({ cash: '1000.00' });
    const server = createApp().listen(0);
    const [first, second] = await Promise.all([
        post(server.address().port, { ...buy, idempotency_key: 'concurrent-buy-1' }),
        post(server.address().port, { ...buy, idempotency_key: 'concurrent-buy-2' }),
    ]);
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.deepStrictEqual([first.status, second.status].sort(), [201, 400]);
    assert.strictEqual(broker.requests.filter((request) => request.options.method === 'POST').length, 1);
});

test('POST rejects a sell above the fresh held long quantity before broker submission', async () => {
    const broker = enableMockBroker({ position: { side: 'long', qty: '1' } });
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'sell-over-held', side: 'sell', qty: 2 });
    await new Promise((resolve) => server.close(resolve));
    broker.restore();
    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.filter((request) => request.url.endsWith('/v2/orders')).length, 0);
});

test('POST refuses a configured non-paper broker endpoint without any network request', async () => {
    const broker = enableMockBroker();
    const savedUrl = process.env.ALPACA_TRADING_BASE_URL;
    process.env.ALPACA_TRADING_BASE_URL = 'https://api.alpaca.markets';
    const server = createApp().listen(0);
    const result = await post(server.address().port, { ...buy, idempotency_key: 'live-endpoint-refusal' });
    await new Promise((resolve) => server.close(resolve));
    if (savedUrl == null) delete process.env.ALPACA_TRADING_BASE_URL; else process.env.ALPACA_TRADING_BASE_URL = savedUrl;
    broker.restore();
    assert.strictEqual(result.status, 400);
    assert.strictEqual(broker.requests.length, 0);
});
