const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();

const TEST_DB = path.join(__dirname, `test_sim_routes_${process.pid}.db`);
process.env.DB_PATH_OVERRIDE = TEST_DB;

// Stub pybridge before any route module is loaded
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request.includes('pybridge')) {
        return { getStockInfo: async (symbol) => {
            if (symbol === 'FAIL') throw new Error('quote unavailable');
            return { data: { price: 200.00, name: 'Test', change: -5.25, changePercent: -2.56, previousClose: 205.25 } };
        } };
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
    await db.setSimReinvestmentSettings({
        dividend_reinvestment_mode: 'drip',
        profit_reinvestment_mode: 'redeploy_excess',
        target_cash_pct: 10,
    }, 1);
    await db.setSimReinvestmentSettings({
        dividend_reinvestment_mode: 'cash',
        profit_reinvestment_mode: 'hold_cash',
        target_cash_pct: 10,
    }, 2);
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

test('simulator sleeves expose safe reinvestment defaults', async () => {
    const [longTerm, dayTrading] = await Promise.all([
        request('GET', '/api/simulator/account?account_id=1'),
        request('GET', '/api/simulator/account?account_id=2'),
    ]);

    assert.strictEqual(longTerm.body.data.dividend_reinvestment_mode, 'drip');
    assert.strictEqual(longTerm.body.data.profit_reinvestment_mode, 'redeploy_excess');
    assert.strictEqual(longTerm.body.data.target_cash_pct, 10);
    assert.strictEqual(dayTrading.body.data.dividend_reinvestment_mode, 'cash');
    assert.strictEqual(dayTrading.body.data.profit_reinvestment_mode, 'hold_cash');
});

test('a missing settings row cannot hide a valid simulator sleeve', async () => {
    await new Promise((resolve, reject) => {
        const sqlite = new sqlite3.Database(TEST_DB);
        sqlite.run('DELETE FROM sim_reinvestment_settings WHERE account_id = 2', [], (err) => {
            sqlite.close();
            err ? reject(err) : resolve();
        });
    });

    const accounts = await request('GET', '/api/simulator/accounts');
    assert.strictEqual(accounts.status, 200);
    assert.strictEqual(accounts.body.data.length, 2);
    assert.strictEqual(accounts.body.data[1].dividend_reinvestment_mode, 'cash');
    assert.strictEqual(accounts.body.data[1].profit_reinvestment_mode, 'hold_cash');
});

test('PATCH /api/simulator/reinvestment-settings validates and isolates sleeve settings', async () => {
    const updated = await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'cash',
        profit_reinvestment_mode: 'hold_cash',
        target_cash_pct: 15,
    });
    assert.strictEqual(updated.status, 200);
    assert.strictEqual(updated.body.data.target_cash_pct, 15);

    const dayTrading = await request('GET', '/api/simulator/account?account_id=2');
    assert.strictEqual(dayTrading.body.data.dividend_reinvestment_mode, 'cash');
    assert.strictEqual(dayTrading.body.data.profit_reinvestment_mode, 'hold_cash');

    const invalid = await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'magic',
    });
    assert.strictEqual(invalid.status, 400);
});

test('concurrent partial settings PATCHes do not overwrite each other', async () => {
    await db.setSimReinvestmentSettings({ dividend_reinvestment_mode: 'drip', profit_reinvestment_mode: 'hold_cash', target_cash_pct: 10 }, 1);
    // Two agents patch different fields at the same time; both must land.
    await Promise.all([
        request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', { target_cash_pct: 20 }),
        request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', { profit_reinvestment_mode: 'redeploy_excess' }),
    ]);
    const account = await request('GET', '/api/simulator/account?account_id=1');
    assert.strictEqual(account.body.data.dividend_reinvestment_mode, 'drip');
    assert.strictEqual(account.body.data.profit_reinvestment_mode, 'redeploy_excess');
    assert.strictEqual(account.body.data.target_cash_pct, 20);
});

test('cash dividend credits simulator cash and total return without changing shares', async () => {
    await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'cash',
        profit_reinvestment_mode: 'hold_cash',
        target_cash_pct: 10,
    });
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });

    const dividend = await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    assert.strictEqual(dividend.status, 200);
    assert.strictEqual(dividend.body.data.mode, 'cash');

    const [account, holdings, transactions] = await Promise.all([
        request('GET', '/api/simulator/account'),
        request('GET', '/api/simulator/holdings'),
        request('GET', '/api/simulator/transactions'),
    ]);
    assert.strictEqual(account.body.data.cash, 8550);
    assert.strictEqual(account.body.data.dividend_income, 50);
    assert.strictEqual(holdings.body.data[0].shares, 10);
    assert.strictEqual(transactions.body.data.filter((txn) => txn.type === 'dividend').length, 1);
});

test('DRIP rejects a dividend without an explicit reinvestment price', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });

    const dividend = await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    assert.strictEqual(dividend.status, 400);
    assert.match(dividend.body.error, /reinvestment price/);
});

test('dividend rejects calendar-invalid and future payment dates', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });

    for (const badDate of ['2026-99-99', '2026-02-30', '26-03-01']) {
        const res = await request('POST', '/api/simulator/dividend', {
            symbol: 'AAPL', amount: 50, price: 200, txn_date: badDate, idempotency_key: `bad-${badDate}`,
        });
        assert.strictEqual(res.status, 400, `expected 400 for ${badDate}`);
    }

    const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const res = await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, price: 200, txn_date: future, idempotency_key: `future-${future}`,
    });
    assert.strictEqual(res.status, 400);
});

test('DRIP records dividend and fractional buy atomically without changing cash', async () => {
    await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'drip',
        profit_reinvestment_mode: 'redeploy_excess',
        target_cash_pct: 10,
    });
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });

    const dividend = await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, price: 200, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    assert.strictEqual(dividend.status, 200);
    assert.strictEqual(dividend.body.data.mode, 'drip');
    assert.strictEqual(dividend.body.data.reinvested_shares, 0.25);

    const [account, holdings, transactions] = await Promise.all([
        request('GET', '/api/simulator/account'),
        request('GET', '/api/simulator/holdings'),
        request('GET', '/api/simulator/transactions'),
    ]);
    assert.strictEqual(account.body.data.cash, 8500);
    assert.strictEqual(account.body.data.dividend_income, 50);
    assert.strictEqual(account.body.data.reinvested_dividends, 50);
    assert.strictEqual(holdings.body.data[0].shares, 10.25);
    assert.strictEqual(transactions.body.data.filter((txn) => txn.type === 'buy').length, 2);
});

test('dividend idempotency prevents duplicate cash and DRIP entries', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });
    const payload = {
        symbol: 'AAPL', amount: 50, price: 200, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    };
    assert.strictEqual((await request('POST', '/api/simulator/dividend', payload)).status, 200);
    assert.strictEqual((await request('POST', '/api/simulator/dividend', payload)).status, 409);

    const transactions = await request('GET', '/api/simulator/transactions');
    assert.strictEqual(transactions.body.data.filter((txn) => txn.type === 'dividend').length, 1);
    assert.strictEqual(transactions.body.data.filter((txn) => txn.type === 'buy').length, 2);
});

test('dividend requires an owned position on the dividend date', async () => {
    const res = await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, price: 200, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /open position/);
});

test('dividend idempotency still wins after the original position is closed', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });
    const payload = {
        symbol: 'AAPL', amount: 50, price: 200, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    };
    await request('POST', '/api/simulator/dividend', payload);
    await request('POST', '/api/simulator/trade', {
        type: 'sell', symbol: 'AAPL', shares: 10.25, price: 210, txn_date: '2026-04-01',
    });

    const duplicate = await request('POST', '/api/simulator/dividend', payload);
    assert.strictEqual(duplicate.status, 409);
});

test('redeploy-excess policy reports only cash above the configured target', async () => {
    await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'cash',
        profit_reinvestment_mode: 'redeploy_excess',
        target_cash_pct: 10,
    });
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 40, price: 200, txn_date: '2026-01-01',
    });

    const account = await request('GET', '/api/simulator/account');
    assert.strictEqual(account.body.data.cash, 2000);
    assert.strictEqual(account.body.data.redeployable_cash, 1000);

    await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        profit_reinvestment_mode: 'hold_cash',
    });
    const held = await request('GET', '/api/simulator/account');
    assert.strictEqual(held.body.data.redeployable_cash, 0);
});

test('redeployable cash fails closed when a holding quote is unavailable', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'FAIL', shares: 40, price: 200, txn_date: '2026-01-01',
    });

    const account = await request('GET', '/api/simulator/account');
    assert.strictEqual(account.status, 200);
    assert.strictEqual(account.body.data.redeployable_cash, null);
    assert.strictEqual(account.body.data.reinvestment_data_complete, false);
});

test('dividend income appears in simulator review and does not keep a sold position open', async () => {
    await request('PATCH', '/api/simulator/reinvestment-settings?account_id=1', {
        dividend_reinvestment_mode: 'cash',
        profit_reinvestment_mode: 'hold_cash',
        target_cash_pct: 10,
    });
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });
    await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    await request('POST', '/api/simulator/trade', {
        type: 'sell', symbol: 'AAPL', shares: 10, price: 200, txn_date: '2026-04-01',
    });

    const [review, holdings] = await Promise.all([
        request('GET', '/api/simulator/review'),
        request('GET', '/api/simulator/holdings'),
    ]);
    assert.strictEqual(review.body.data.dividend_income, 50);
    assert.strictEqual(review.body.data.reinvested_dividends, 0);
    assert.deepStrictEqual(holdings.body.data, []);
});

test('reset removes dividend events together with simulator trades', async () => {
    await request('PATCH', '/api/simulator/account', { deposit: 10000 });
    await request('POST', '/api/simulator/trade', {
        type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-01',
    });
    await request('POST', '/api/simulator/dividend', {
        symbol: 'AAPL', amount: 50, txn_date: '2026-03-01', idempotency_key: 'AAPL-2026-Q1',
    });
    await request('POST', '/api/simulator/reset');

    const transactions = await request('GET', '/api/simulator/transactions');
    assert.deepStrictEqual(transactions.body.data, []);
});
