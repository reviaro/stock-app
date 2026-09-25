const { seedRiskPolicies } = require('../test-support/simulator_risk_fixture');
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, `test_sim_exec_${process.pid}.db`);
process.env.DB_PATH_OVERRIDE = TEST_DB;

// Stub the hybrid feed BEFORE modules load: deterministic server-side quotes.
const Module = require('module');
const _originalLoad = Module._load;
let quoteSeq = 0;
let fundQuoteOverrides = {};
Module._load = function(request, parent, isMain) {
    if (request.includes('hybrid_market_data')) {
        return {
            getHybridQuote: async () => { throw new Error('not used'); },
            getDefaultHybridQuote: async (symbol) => ({
                price: 200.00,
                timestamp: new Date(Date.now() - 30_000).toISOString(),
                market_state: 'REGULAR',
                data_source: 'alpaca_iex',
                ...(symbol === 'FXAIX' ? {
                    symbol, currency: 'USD', instrument_type: 'MUTUALFUND',
                    data_source: 'yfinance', market_state: 'CLOSED',
                    timestamp: new Date(Date.now() - 24 * 3600000).toISOString(),
                    ...fundQuoteOverrides,
                } : {}),
            }),
            createAlpacaMarketDataSource: () => { throw new Error('not configured'); },
        };
    }
    if (request.includes('pybridge')) {
        return { getStockInfo: async () => ({ data: { price: 200.00, name: 'Test', change: 0, changePercent: 0, previousClose: 200 } }) };
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
    await seedRiskPolicies();
    const app = express();
    app.use(express.json());
    app.use('/api/simulator', simRouter);
    server = app.listen(0);
    port = server.address().port;
});

beforeEach(async () => {
    fundQuoteOverrides = {};
    await db.deleteAllSimTransactions(1);
    await db.deleteAllSimTransactions(2);
});

after(() => {
    server.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({
            method, hostname: '127.0.0.1', port, path: pathname,
            headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 },
        }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(chunks) }); }
                catch { resolve({ status: res.statusCode, body: { raw: chunks } }); }
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

test('evaluated trade ignores caller price and uses server quote', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        account_id: 1, type: 'buy', symbol: 'AAPL', shares: 10,
        price: 1, // caller price must be IGNORED
        client_order_id: 'exec-1',
    });
    assert.strictEqual(res.status, 200);
    const txns = await request('GET', '/api/simulator/transactions?account_id=1');
    assert.strictEqual(txns.body.data[0].price, 200);
    const order = await db.getSimOrder(1, 'exec-1');
    assert.strictEqual(order.quote.price, 200);
});

test('ADBE entry can value an existing FXAIX holding at daily NAV', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 10000, txn_date: '2026-09-23' });
    await db.addSimTransaction({ account_id: 1, type: 'buy', symbol: 'FXAIX', shares: 10, price: 200, txn_date: '2026-09-23' });
    const review = await request('GET', '/api/simulator/review?account_id=1');
    assert.equal(review.body.data.valuation_complete, true);
    const body = { account_id: 1, type: 'buy', symbol: 'ADBE', shares: 4, client_order_id: 'adbe-with-fund' };
    const result = await request('POST', '/api/simulator/trade', body);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal((await request('POST', '/api/simulator/trade', body)).body.duplicate, true);
    assert.equal((await db.listSimTransactions(1)).filter((t) => t.symbol === 'ADBE').length, 1);
    assert.equal((await db.getSimOrder(1, body.client_order_id)).quote.source, 'alpaca_iex');
});

test('expired fund NAV blocks entry atomically even when review has numeric prices', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 10000, txn_date: '2026-09-23' });
    await db.addSimTransaction({ account_id: 1, type: 'buy', symbol: 'FXAIX', shares: 10, price: 200, txn_date: '2026-09-23' });
    fundQuoteOverrides = { timestamp: new Date(Date.now() - 5 * 24 * 3600000).toISOString() };
    const before = await db.listSimTransactions(1);
    const body = { account_id: 1, type: 'buy', symbol: 'ADBE', shares: 4, client_order_id: 'adbe-expired-fund' };
    for (let attempt = 0; attempt < 2; attempt++) {
        const result = await request('POST', '/api/simulator/trade', body);
        assert.equal(result.status, 503);
        assert.equal(result.body.code, 'SIM_RISK_DATA_UNAVAILABLE');
    }
    assert.equal(await db.getSimOrder(1, body.client_order_id), null);
    assert.deepEqual(await db.listSimTransactions(1), before);
});

test('evaluated trade replays idempotently on same client_order_id', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    const body = { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 5, client_order_id: 'exec-2' };
    const r1 = await request('POST', '/api/simulator/trade', body);
    const r2 = await request('POST', '/api/simulator/trade', body);
    assert.strictEqual(r2.status, 200);
    assert.strictEqual(r2.body.duplicate, true);
    assert.strictEqual(r2.body.data.id, r1.body.data.id);
    const txns = await request('GET', '/api/simulator/transactions?account_id=1');
    assert.strictEqual(txns.body.data.filter((t) => t.type === 'buy').length, 1);
});

test('evaluated trade conflicts when client_order_id is reused with a different intent', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    await request('POST', '/api/simulator/trade', { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 5, client_order_id: 'exec-3' });
    const res = await request('POST', '/api/simulator/trade', { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 7, client_order_id: 'exec-3' });
    assert.strictEqual(res.status, 409);
});

test('day-trading evaluated buy requires a trade plan', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'NVDA', shares: 5, client_order_id: 'exec-4',
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /trade plan/i);
});

test('day-trading evaluated buy with a plan creates the structured plan', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'NVDA', shares: 5, client_order_id: 'exec-5',
        trade_plan: { setup: 'momentum', thesis: 'breakout over premarket range', stop_price: 190, target_price: 230 },
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.data.trade_plan_id);
    const plans = await request('GET', '/api/simulator/trade-plans?account_id=2&status=active');
    assert.strictEqual(plans.body.data.length, 1);
});

test('identical intentions with distinct order keys are distinct trades', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 10000, txn_date: new Date().toISOString().slice(0, 10) });
    const body = { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 2 };
    const first = await request('POST', '/api/simulator/trade', { ...body, client_order_id: 'distinct-a' });
    const second = await request('POST', '/api/simulator/trade', { ...body, client_order_id: 'distinct-b' });
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(second.body.data.id, first.body.data.id);
    assert.ok(await db.getSimOrder(1, 'distinct-b'));
});

test('changed fees with same key conflict and missing explicit sleeve rejects', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 10000, txn_date: new Date().toISOString().slice(0, 10) });
    const body = { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 2, client_order_id: 'fee-key', fees: 1 };
    assert.equal((await request('POST', '/api/simulator/trade', body)).status, 200);
    assert.equal((await request('POST', '/api/simulator/trade', { ...body, fees: 2 })).status, 409);
    const { account_id, ...withoutAccount } = { ...body, client_order_id: 'missing-account' };
    assert.equal((await request('POST', '/api/simulator/trade', withoutAccount)).status, 400);
});

test('negative fees are rejected on the evaluated path', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    const res = await request('POST', '/api/simulator/trade', {
        account_id: 1, type: 'buy', symbol: 'AAPL', shares: 5, client_order_id: 'exec-6', fees: -20,
    });
    assert.strictEqual(res.status, 400);
});

test('orders can be reconciled by key and are isolated by sleeve', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 1000, txn_date: '2026-09-04' });
    const first = await request('POST', '/api/simulator/trade', { account_id: 1, type: 'buy', symbol: 'MSFT', shares: 1, client_order_id: 'lookup-key' });
    const lookup = await request('GET', '/api/simulator/orders/lookup-key?account_id=1');
    assert.equal(lookup.status, 200);
    assert.equal(lookup.body.data.result.id, first.body.data.id);
    assert.equal((await request('GET', '/api/simulator/orders/lookup-key?account_id=2')).status, 404);
    assert.equal((await request('GET', '/api/simulator/orders/lookup-key')).status, 400);
});

test('evaluated trade persists quote provenance on the order', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    await request('POST', '/api/simulator/trade', { account_id: 1, type: 'buy', symbol: 'AAPL', shares: 5, client_order_id: 'exec-7' });
    const order = await db.getSimOrder(1, 'exec-7');
    assert.strictEqual(order.quote.source, 'alpaca_iex');
    assert.strictEqual(order.quote.price, 200);
});

test('manual record path still works with operator-manual source', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    const res = await request('POST', '/api/simulator/record', {
        account_id: 1, source: 'operator-manual', type: 'buy', symbol: 'MSFT', shares: 2, price: 100,
    });
    assert.strictEqual(res.status, 200);
    const txns = await request('GET', '/api/simulator/transactions?account_id=1');
    assert.strictEqual(txns.body.data.find((t) => t.symbol === 'MSFT').price, 100);
});

test('manual record without operator-manual source is rejected', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 1, deposit: 10000 });
    const res = await request('POST', '/api/simulator/record', {
        account_id: 1, type: 'buy', symbol: 'MSFT', shares: 2, price: 100,
    });
    assert.strictEqual(res.status, 400);
});

test('manual full exit nets every lifecycle fill, not just the final leg', async () => {
    await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 10000 });
    const buy = await request('POST', '/api/simulator/record', {
        account_id: 2, source: 'operator-manual', type: 'buy', symbol: 'AAPL', shares: 10, price: 100,
        txn_date: '2026-09-01', trade_plan: { setup: 's', thesis: 't', stop_price: 90, target_price: 130, planned_entry: 100, shares: 10 },
    });
    assert.strictEqual(buy.status, 200, `buy: ${buy.body?.error ?? ''}`);
    await request('POST', '/api/simulator/record', {
        account_id: 2, source: 'operator-manual', type: 'sell', symbol: 'AAPL', shares: 5, price: 120, txn_date: '2026-09-02',
    });
    const exit = await request('POST', '/api/simulator/record', {
        account_id: 2, source: 'operator-manual', type: 'sell', symbol: 'AAPL', shares: 5, price: 90, txn_date: '2026-09-03',
        journal: { exit_reason: 'stop', thesis_valid: false },
    });
    assert.strictEqual(exit.status, 200, `exit: ${exit.body?.error ?? ''}`);
    const journal = await request('GET', '/api/simulator/journal?account_id=2');
    const trade = journal.body.data.trades[0];
    assert.strictEqual(trade.status, 'closed');
    assert.strictEqual(trade.realized_pnl, 50, `trade: ${JSON.stringify(trade)}`);
});
