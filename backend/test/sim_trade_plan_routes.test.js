const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const TEST_DB = path.join(__dirname, 'test_sim_trade_plans.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const Module = require('module');
const originalLoad = Module._load;
let quoteData = { price: 200, timestamp: new Date().toISOString(), marketState: 'REGULAR', isDemo: false, source: 'alpaca_iex' };
Module._load = function(request, parent, isMain) {
    if (request.includes('hybrid_market_data')) {
        return {
            getDefaultHybridQuote: async () => quoteData.isDemo === true
                ? { price: null, timestamp: null, market_state: null, data_source: 'unavailable' }
                : {
                    price: quoteData.price,
                    timestamp: quoteData.timestamp,
                    market_state: quoteData.marketState,
                    data_source: quoteData.source,
                },
        };
    }
    if (request.includes('pybridge')) {
        return { getStockInfo: async () => ({ data: quoteData }) };
    }
    return originalLoad.apply(this, arguments);
};

const db = require('../database/db');
const simRouter = require('../routes/simulator');
let server;
let port;

function cleanupTestDb() {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const candidate = `${TEST_DB}${suffix}`;
        if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
}

before(async () => {
    cleanupTestDb();
    await db.initDb();
    const app = express();
    app.use(express.json());
    app.use('/api/simulator', simRouter);
    server = app.listen(0);
    port = server.address().port;
});

beforeEach(async () => {
    quoteData = { price: 200, timestamp: new Date().toISOString(), marketState: 'REGULAR', isDemo: false, source: 'alpaca_iex' };
    await db.deleteAllSimTransactions(2);
    const sqlite = db.getDb();
    await new Promise((resolve, reject) => sqlite.run('DELETE FROM sim_trade_plans', [], (err) => {
        sqlite.close();
        err ? reject(err) : resolve();
    }));
});

after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanupTestDb();
});

function request(method, pathname, body) {
    return new Promise((resolve, reject) => {
        const data = body ? JSON.stringify(body) : null;
        const req = http.request({ method, hostname: '127.0.0.1', port, path: pathname, headers: { 'Content-Type': 'application/json', 'Content-Length': data ? Buffer.byteLength(data) : 0 } }, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: chunks ? JSON.parse(chunks) : null }));
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

async function fundDaySleeve() {
    await request('PATCH', '/api/simulator/account', { account_id: 2, deposit: 10000 });
}

const tradePlan = {
    setup: 'catalyst continuation',
    catalyst: 'earnings',
    thesis: 'Relative strength persists.',
    stop_price: 205,
    target_price: 220,
    invalidation: 'Loses opening range.',
};

test('day-trading buy can persist a structured plan tied to the transaction', async () => {
    await fundDaySleeve();
    const buy = await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 10, price: 210, txn_date: '2026-08-11', trade_plan: tradePlan,
    });
    assert.strictEqual(buy.status, 200);
    assert.ok(buy.body.data.trade_plan_id);

    const plans = await request('GET', '/api/simulator/trade-plans?account_id=2');
    assert.strictEqual(plans.status, 200);
    assert.strictEqual(plans.body.data[0].entry_transaction_id, buy.body.data.id);
    assert.strictEqual(plans.body.data[0].planned_risk, 50);
});

test('risk monitor is read-only and reports a documented stop breach', async () => {
    await fundDaySleeve();
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 10, price: 210, txn_date: '2026-08-11', trade_plan: tradePlan,
    });

    const monitor = await request('GET', '/api/simulator/risk-monitor?account_id=2');
    assert.strictEqual(monitor.status, 200);
    assert.strictEqual(monitor.body.data.read_only, true);
    assert.strictEqual(monitor.body.data.execution_enabled, false);
    assert.strictEqual(monitor.body.data.alerts[0].type, 'stop_breached');
    assert.strictEqual(monitor.body.data.positions[0].data_source, 'alpaca_iex');
    assert.strictEqual(monitor.body.data.positions[0].market_state, 'REGULAR');
    const txns = await request('GET', '/api/simulator/transactions?account_id=2');
    assert.strictEqual(txns.body.data.length, 2);
});

test('risk monitor rejects demo fallback prices as unavailable market data', async () => {
    await fundDaySleeve();
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 10, price: 210, txn_date: '2026-08-11', trade_plan: tradePlan,
    });
    quoteData = { price: 200, timestamp: null, marketState: 'UNKNOWN', isDemo: true };

    const monitor = await request('GET', '/api/simulator/risk-monitor?account_id=2');
    assert.strictEqual(monitor.status, 200);
    assert.strictEqual(monitor.body.data.alerts[0].type, 'price_unavailable');
});

test('selling the full position closes the active plan and feeds R analytics', async () => {
    await fundDaySleeve();
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 10, price: 210, txn_date: '2026-08-11', trade_plan: tradePlan,
    });
    const sell = await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'sell', symbol: 'MSFT', shares: 10, price: 215, txn_date: '2026-08-11',
        journal: { exit_reason: 'time_exit', thesis_valid: true, mfe: 1.5, mae: -0.5, review_notes: 'Good process.' },
    });
    assert.strictEqual(sell.status, 200);

    const journal = await request('GET', '/api/simulator/journal?account_id=2');
    assert.strictEqual(journal.status, 200);
    assert.strictEqual(journal.body.data.analytics.closed_trade_count, 1);
    assert.strictEqual(journal.body.data.analytics.average_r, 1);
    assert.strictEqual(journal.body.data.trades[0].exit_reason, 'time_exit');
});

test('structured exit uses the full closed position size after an unplanned add-on', async () => {
    await fundDaySleeve();
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 10, price: 210, txn_date: '2026-08-11', trade_plan: tradePlan,
    });
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'MSFT', shares: 5, price: 212, txn_date: '2026-08-11',
    });
    const sell = await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'sell', symbol: 'MSFT', shares: 15, price: 215, txn_date: '2026-08-11',
        journal: { exit_reason: 'time_exit', thesis_valid: true },
    });
    assert.strictEqual(sell.status, 200);

    const journal = await request('GET', '/api/simulator/journal?account_id=2');
    assert.strictEqual(journal.body.data.trades[0].realized_pnl, 65);
    assert.strictEqual(journal.body.data.trades[0].realized_r, 1.3);
    assert.strictEqual(journal.body.data.trades[0].exit_shares, 15);
    assert.strictEqual(journal.body.data.trades[0].exit_cost_basis, 3160);
});

test('open position without a plan is visible as a missing-plan alert', async () => {
    await fundDaySleeve();
    await request('POST', '/api/simulator/trade', {
        account_id: 2, type: 'buy', symbol: 'AAPL', shares: 10, price: 100, txn_date: '2026-08-11',
    });
    const monitor = await request('GET', '/api/simulator/risk-monitor?account_id=2');
    assert.strictEqual(monitor.body.data.alerts[0].type, 'missing_plan');
});
