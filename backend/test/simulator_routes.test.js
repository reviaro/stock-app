const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_sim_routes.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

// Stub pybridge before any route module is loaded
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request.includes('pybridge')) {
        return { getStockInfo: async () => ({ data: { price: 200.00, name: 'Test', change: -5.25, changePercent: -2.56, previousClose: 205.25 } }) };
    }
    return _originalLoad.apply(this, arguments);
};

const db = require('../database/db');
const simRouter = require('../routes/simulator');

let server;
let port;

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/simulator', simRouter);
    server = app.listen(0);
    port = server.address().port;
});

beforeEach(async () => {
    await db.deleteAllSimTransactions(1);
    await db.deleteAllSimTransactions(2);
    await db.setSimTaxBracket(22, 1);
    await db.setSimTaxBracket(22, 2);
});

after(() => {
    server.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method,
            hostname: '127.0.0.1',
            port,
            path: pathname,
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': data ? Buffer.byteLength(data) : 0,
            },
        }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(chunks) }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function rawRequest(method, pathname) {
    return new Promise((resolve, reject) => {
        const req = http.request({ method, hostname: '127.0.0.1', port, path: pathname }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks }));
        });
        req.on('error', reject);
        req.end();
    });
}

test('GET /api/simulator/accounts exposes isolated long-term and day-trading sleeves', async () => {
    const res = await request('GET', '/api/simulator/accounts');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(
        res.body.data.map((account) => ({ id: account.id, slug: account.slug })),
        [
            { id: 1, slug: 'long-term' },
            { id: 2, slug: 'day-trading' },
        ],
    );
});

test('GET /api/simulator/account returns account with cash=0 initially', async () => {
    const res = await request('GET', '/api/simulator/account');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'success');
    assert.strictEqual(res.body.data.cash, 0);
    assert.strictEqual(res.body.data.tax_bracket, 22);
});

test('day-trading deposit stays isolated from the long-term sleeve', async () => {
    const deposit = await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 10000 });
    assert.strictEqual(deposit.status, 200);

    const [longTerm, dayTrading, longTermTransactions, dayTradingTransactions] = await Promise.all([
        request('GET', '/api/simulator/account?account_id=1'),
        request('GET', '/api/simulator/account?account_id=2'),
        request('GET', '/api/simulator/transactions?account_id=1'),
        request('GET', '/api/simulator/transactions?account_id=2'),
    ]);

    assert.strictEqual(longTerm.body.data.cash, 0);
    assert.strictEqual(dayTrading.body.data.cash, 10000);
    assert.strictEqual(longTermTransactions.body.data.length, 0);
    assert.strictEqual(dayTradingTransactions.body.data.length, 1);
    assert.strictEqual(dayTradingTransactions.body.data[0].account_id, 2);
});

test('PATCH /api/simulator/account deposit increases cash', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    const res = await request('GET', '/api/simulator/account');
    assert.strictEqual(res.body.data.cash, 10000);
});

test('PATCH /api/simulator/account set tax_bracket', async () => {
    const res = await request('PATCH', '/api/simulator/account', { tax_bracket: 32 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.tax_bracket, 32);
});

test('PATCH /api/simulator/account invalid tax_bracket -> 400', async () => {
    const res = await request('PATCH', '/api/simulator/account', { tax_bracket: 99 });
    assert.strictEqual(res.status, 400);
});

test('POST /api/simulator/trade buy -> recorded', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.id);
});

test('POST /api/simulator/trade buy without enough cash -> 400', async () => {
    const res = await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 100, price: 150, txn_date: '2026-01-01',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /insufficient cash/);
});

test('POST /api/simulator/trade sell without position -> 400', async () => {
    const res = await request('POST', '/api/simulator/trade', {
        type: 'sell', symbol: 'AAPL', shares: 5, price: 200, txn_date: '2026-01-15',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /insufficient shares/);
});

test('buy then sell -> cash updated correctly', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 100, txn_date: '2026-01-01',
    });
    await request('POST', '/api/simulator/trade', {
        type: 'sell', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-06-01',
    });
    const res = await request('GET', '/api/simulator/account');
    assert.strictEqual(res.body.data.cash, 10500);
});

test('GET /api/simulator/holdings includes live stock daily performance', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });

    const res = await request('GET', '/api/simulator/holdings');

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data[0].symbol, 'AAPL');
    assert.strictEqual(res.body.data[0].priceChange, -5.25);
    assert.strictEqual(res.body.data[0].priceChangePct, -2.56);
    assert.strictEqual(res.body.data[0].previousClose, 205.25);
});

test('GET /api/simulator/transactions returns list', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 5000 });
    const res = await request('GET', '/api/simulator/transactions');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.length, 1);
    assert.strictEqual(res.body.data[0].type, 'deposit');
});

test('GET /api/simulator/tax-preview returns breakdown', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 100, txn_date: '2024-01-01',
    });
    const res = await request('GET', '/api/simulator/tax-preview?symbol=AAPL&shares=5');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.data.symbol, 'AAPL');
    assert.strictEqual(res.body.data.shares, 5);
    assert.strictEqual(res.body.data.current_price, 200);
    assert.ok(typeof res.body.data.total_tax === 'number');
    assert.ok(typeof res.body.data.after_tax_net_gain === 'number');
    assert.ok(typeof res.body.data.breakeven_price === 'number');
});

test('GET /api/simulator/tax-preview no position -> 400', async () => {
    const res = await request('GET', '/api/simulator/tax-preview?symbol=AAPL&shares=5');
    assert.strictEqual(res.status, 400);
});

test('POST /api/simulator/reset wipes transactions', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 5000 });
    await request('POST', '/api/simulator/reset');
    const res = await request('GET', '/api/simulator/account');
    assert.strictEqual(res.body.data.cash, 0);
});

test('GET routes return 404 for an unknown sleeve', async () => {
    const paths = [
        '/api/simulator/account?account_id=999',
        '/api/simulator/holdings?account_id=999',
        '/api/simulator/transactions?account_id=999',
        '/api/simulator/tax-preview?symbol=AAPL&shares=5&account_id=999',
        '/api/simulator/review?account_id=999',
        '/api/simulator/export.csv?account_id=999',
    ];
    for (const pathname of paths) {
        const res = await request('GET', pathname);
        assert.strictEqual(res.status, 404, `${pathname} -> ${res.status}`);
        assert.match(res.body.error, /not found/);
    }
});

test('GET routes return 400 for an invalid account_id', async () => {
    for (const pathname of ['/api/simulator/account?account_id=abc', '/api/simulator/holdings?account_id=0']) {
        const res = await request('GET', pathname);
        assert.strictEqual(res.status, 400, `${pathname} -> ${res.status}`);
        assert.match(res.body.error, /invalid account_id/);
    }
});

test('export.csv names the download after the sleeve slug', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 1000 });
    const res = await rawRequest('GET', '/api/simulator/export.csv?account_id=2');
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-disposition'], /simulator-day-trading-transactions\.csv/);
});

test('POST /api/simulator/trade negative shares -> 400', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: -5, price: 150, txn_date: '2026-01-01',
    });
    assert.strictEqual(res.status, 400);
});
