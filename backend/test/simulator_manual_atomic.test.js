const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-manual-'));
process.env.DB_PATH_OVERRIDE = path.join(dir, 'test.db');
const db = require('../database/db');
before(() => db.initDb());
beforeEach(async () => { await db.deleteAllSimTransactions(1); await db.deleteAllSimTransactions(2); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const txn = (extra = {}) => ({ account_id: 1, type: 'buy', symbol: 'AAPL', shares: 10, price: 10, txn_date: '2026-09-04', ...extra });
const fund = (account_id = 1, amount = 100) => db.addSimTransaction({ account_id, type: 'deposit', amount, txn_date: '2024-02-29' });
const plan = { setup: 'breakout', thesis: 'manual test', stop_price: 9, target_price: 12, shares: 10, planned_entry: 10, planned_risk: 10 };
test('plan helpers validate at the DB boundary and recheck locked resources', async () => {
    await fund(2);
    const entry = txn({ account_id: 2 });
    for (const extra of [{ fees: -1 }, { fees: Infinity }, { txn_date: '2026-02-30' }, { shares: Infinity }, { symbol: 'BAD/US' }]) {
        await assert.rejects(db.addSimTransactionWithPlan({ ...entry, ...extra }, plan), { code: 'SIM_INVALID_TRANSACTION' });
        assert.equal((await db.listSimTransactions(2)).length, 1);
        assert.equal((await db.listSimTradePlans(2)).length, 0);
    }
    const results = await Promise.allSettled(['AAPL', 'MSFT'].map(symbol => db.addSimTransactionWithPlan({ ...entry, symbol }, plan)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SIM_INSUFFICIENT_CASH');
});

test('manual close helper ignores stale economics and rejects duplicate sells', async () => {
    await fund(2, 102);
    const entry = txn({ account_id: 2, fees: 2 });
    const opened = await db.addSimTransactionWithPlan(entry, plan);
    const exit = { ...entry, type: 'sell', fees: 1, shares: 6, price: 11 };
    await db.addSimTransaction({ ...exit, shares: 4, price: 12 });
    await assert.rejects(db.addSimTransactionAndCloseTradePlan({ ...exit, txn_date: '2026-02-30' }, opened.trade_plan_id, {}), { code: 'SIM_INVALID_TRANSACTION' });
    const results = await Promise.allSettled([1, 2].map(() => db.addSimTransactionAndCloseTradePlan(exit, opened.trade_plan_id, { exit_reason: 'time_exit', realized_pnl: 999, realized_r: 999, exit_cost_basis: 999 })));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SIM_INSUFFICIENT_SHARES');
    const closed = (await db.listSimTradePlans(2))[0];
    assert.equal(closed.realized_pnl, 10);
    assert.equal(closed.exit_cost_basis, 102);
    assert.equal(closed.realized_r, 1);
    assert.equal(closed.exit_reason, 'time_exit');
    assert.equal((await db.listSimTransactions(2)).length, 4);
});

test('manual journal requires a full active exit and preserves inferred exit reason', async () => {
    await fund(2, 200);
    const entry = txn({ account_id: 2 });
    await db.addSimTransactionWithPlan(entry, plan);
    await assert.rejects(db.recordSimTradeAtomic({ transaction: { ...entry, type: 'sell', shares: 4 }, closure: { exit_reason: 'time_exit' } }), { code: 'SIM_PLAN_REQUIRED' });
    assert.equal((await db.listSimTransactions(2)).length, 2);
    await db.recordSimTradeAtomic({ transaction: { ...entry, type: 'sell', price: 12 } });
    assert.equal((await db.listSimTradePlans(2))[0].exit_reason, 'target');
    const plain = txn({ account_id: 2, symbol: 'MSFT' });
    await db.addSimTransaction(plain);
    await assert.rejects(db.recordSimTradeAtomic({ transaction: { ...plain, type: 'sell' }, closure: { exit_reason: 'time_exit' } }), { code: 'SIM_PLAN_REQUIRED' });
});

test('record route leaves resource and closure decisions inside the DB lock', async () => {
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(name) {
        if (name.includes('pybridge')) return {};
        if (name.includes('hybrid_market_data')) return {};
        return originalLoad.apply(this, arguments);
    };
    let router;
    try { router = require('../routes/simulator'); } finally { Module._load = originalLoad; }
    const handler = router.stack.find(layer => layer.route?.path === '/record').route.stack[0].handle;
    const record = async body => {
        const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(payload) { this.body = payload; return this; } };
        await handler({ body: { source: 'operator-manual', ...body }, query: {} }, res);
        return res;
    };
    await fund(2, 102);
    const entry = txn({ account_id: 2, fees: 2 });
    const opened = await db.addSimTransactionWithPlan(entry, plan);
    const list = db.listSimTransactions;
    db.listSimTransactions = async () => { throw new Error('unlocked ledger preflight is forbidden'); };
    try {
        for (const invalid of [{ txn_date: '' }, { txn_date: '2026-02-30' }, { fees: -1 }, { fees: Infinity }]) {
            const rejected = await record({ ...entry, type: 'sell', shares: 1, ...invalid });
            assert.equal(rejected.statusCode, 400, JSON.stringify(rejected.body));
            assert.equal(rejected.body.code, 'SIM_INVALID_TRANSACTION');
        }
        const partial = await record({ ...entry, type: 'sell', shares: 4, price: 12, fees: 1 });
        assert.equal(partial.statusCode, 200, JSON.stringify(partial.body));
        const final = await record({ ...entry, type: 'sell', shares: 6, price: 11, fees: 1, journal: { exit_reason: 'time_exit' } });
        assert.equal(final.statusCode, 200, JSON.stringify(final.body));
        assert.equal(final.body.data.evaluated, false);
        assert.equal(final.body.data.trade_plan_id, opened.trade_plan_id);
        const duplicate = await record({ ...entry, type: 'sell', shares: 6, price: 11 });
        assert.equal(duplicate.statusCode, 400);
        assert.equal(duplicate.body.code, 'SIM_INSUFFICIENT_SHARES');
    } finally { db.listSimTransactions = list; }
    assert.equal((await db.listSimTradePlans(2))[0].realized_pnl, 10);
});

test('concurrent manual buys cannot spend the same cash or create evaluated orders', async () => {
    await fund();
    const results = await Promise.allSettled([db.addSimTransaction(txn()), db.addSimTransaction(txn())]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SIM_INSUFFICIENT_CASH');
    assert.equal((await db.listSimTransactions(1)).filter(t => t.type === 'buy').length, 1);
    const sqlite = db.getDb();
    const orders = await new Promise((resolve, reject) => sqlite.all('SELECT * FROM sim_orders', (err, rows) => { sqlite.close(); err ? reject(err) : resolve(rows); }));
    assert.equal(orders.length, 0);
});
