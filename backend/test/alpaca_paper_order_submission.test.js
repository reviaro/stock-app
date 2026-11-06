const httpRuntime = require('../services/http_runtime');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');

const { createTestDatabase } = require('../test-support/test_database');
const TEST_DB = createTestDatabase();
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
        fetch: httpRuntime.fetch, key: process.env.ALPACA_API_KEY, secret: process.env.ALPACA_API_SECRET,
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
    httpRuntime.fetch = async (url, options = {}) => {
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
        httpRuntime.fetch = saved.fetch;
        if (saved.key == null) delete process.env.ALPACA_API_KEY; else process.env.ALPACA_API_KEY = saved.key;
        if (saved.secret == null) delete process.env.ALPACA_API_SECRET; else process.env.ALPACA_API_SECRET = saved.secret;
        if (saved.entryEnabled == null) delete process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED; else process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED = saved.entryEnabled;
        if (saved.entryToken == null) delete process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN; else process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN = saved.entryToken;
    } };
}

const buy = { idempotency_key: 'buy-msft-001', symbol: 'MSFT', side: 'buy', qty: 2, type: 'limit', limit_price: 400, time_in_force: 'day' };

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

test('raw paper order entry is permanently retired regardless of legacy enablement', async () => {
    const counts = await ledgerCounts();
    for (const enabled of [false, true]) {
        const broker = enableMockBroker({ orderEntryEnabled: enabled });
        const server = createApp().listen(0);
        try {
            const result = await post(server.address().port, {
                idempotency_key: 'retired-raw-order', symbol: 'MSFT', side: 'buy', qty: 1,
                type: 'limit', limit_price: 100, time_in_force: 'day',
            });
            assert.strictEqual(result.status, 410);
            assert.strictEqual(result.body.code, 'ALPACA_RAW_ORDER_ENTRY_RETIRED');
            assert.deepStrictEqual(broker.requests, []);
        } finally {
            await new Promise(resolve => server.close(resolve));
            broker.restore();
        }
    }
    assert.deepStrictEqual(await ledgerCounts(), counts);
});
