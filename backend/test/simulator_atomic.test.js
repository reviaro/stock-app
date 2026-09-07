const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-atomic-'));
process.env.DB_PATH_OVERRIDE = path.join(dir, 'test.db');
const db = require('../database/db');
before(() => db.initDb());
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const buy = (extra = {}) => ({ account_id: 1, type: 'buy', symbol: 'AAPL', shares: 1, price: 10, txn_date: '2026-09-04', ...extra });
test('normalization rejects malformed new writes without changing historical rows', async () => {
    for (const extra of [{ fees: -1 }, { fees: Infinity }, { shares: Infinity }, { price: NaN }, { shares: 1e308, price: 1e308 }, { txn_date: '2026-02-30' }, { symbol: 'AAPL/US' }]) {
        await assert.rejects(db.addSimTransaction(buy(extra)));
    }
    assert.equal((await db.listSimTransactions(1)).length, 0);
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 100, txn_date: '2024-02-29' });
    const row = await db.addSimTransaction(buy({ symbol: 'brk.b', fees: '1' }));
    assert.equal(row.symbol, 'BRK.B');
});

test('atomic trade: resource checks, idempotent replay, conflict, order metadata', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 1000, txn_date: '2026-09-04' });
    const order = {
        transaction: buy({ shares: 10, price: 5, fees: 1 }),
        client_order_id: 'k1',
        intent: { symbol: 'AAPL', shares: 10, price: 5, type: 'buy' },
        quote: { symbol: 'AAPL', price: 5, source: 'hybrid', quote_timestamp: '2026-09-04T15:00:00Z' },
    };
    const r1 = await db.executeSimTradeAtomic(order);
    assert.ok(Number.isInteger(r1.id));
    assert.equal(r1.symbol, 'AAPL');
    assert.equal(r1.price, 5);
    assert.equal(r1.shares, 10);
    assert.equal(r1.fees, 1);

    const replay = await db.executeSimTradeAtomic(order);
    assert.deepEqual(replay, r1);
    const txns = await db.listSimTransactions(1);
    assert.equal(txns.filter((t) => t.symbol === 'AAPL' && t.type === 'buy').length, 1);

    await assert.rejects(
        db.executeSimTradeAtomic({ ...order, intent: { symbol: 'AAPL', shares: 10, price: 6, type: 'buy' } }),
        (err) => err.code === 'SIM_ORDER_CONFLICT',
    );
    assert.equal((await db.listSimTransactions(1)).filter((t) => t.symbol === 'AAPL').length, 1);

    const saved = await db.getSimOrder(1, 'k1');
    assert.equal(saved.client_order_id, 'k1');
    assert.equal(saved.intent_hash, db.canonicalIntentHash(order.intent));
    assert.equal(saved.result.id, r1.id);
    assert.equal(saved.quote.source, 'hybrid');
    assert.equal(saved.fill_date, '2026-09-04');
    assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(saved.fill_time));

    await assert.rejects(
        db.executeSimTradeAtomic({ ...order, client_order_id: 'k2', transaction: buy({ shares: 100000 }) }),
        (err) => err.code === 'SIM_INSUFFICIENT_CASH',
    );
    await assert.rejects(
        db.executeSimTradeAtomic({ ...order, client_order_id: 'k3', transaction: buy({ type: 'sell', shares: 999 }) }),
        (err) => err.code === 'SIM_INSUFFICIENT_SHARES',
    );
    assert.equal(await db.getSimOrder(1, 'k2'), null);
});

const planFor = (txn, extra = {}) => ({ setup: 'breakout', thesis: 'test thesis', stop_price: txn.price - 1, target_price: txn.price + 2, ...extra });
const orderFor = (key, txn, extra = {}) => ({ transaction: txn, client_order_id: key, intent: { symbol: txn.symbol, type: txn.type, shares: txn.shares }, ...extra });

test('day buys require a valid fill-bound plan under the write lock', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 1000, txn_date: '2026-09-04' });
    const txn = buy({ account_id: 2, symbol: 'DAY', shares: 10, price: 10 });
    await assert.rejects(db.executeSimTradeAtomic(orderFor('no-plan', txn)), { code: 'SIM_PLAN_REQUIRED' });
    await assert.rejects(db.executeSimTradeAtomic(orderFor('bad-plan', txn, { trade_plan: planFor(txn, { stop_price: 11 }) })));
    const result = await db.executeSimTradeAtomic(orderFor('day-entry', txn, { trade_plan: planFor(txn, { shares: 999, planned_entry: 999, planned_risk: 999 }) }));
    const active = await db.getActiveSimTradePlan(2, 'DAY');
    assert.equal(active.entry_transaction_id, result.id);
    assert.equal(active.shares, 10);
    assert.equal(active.planned_entry, 10);
    assert.equal(active.planned_risk, 10);
    await assert.rejects(db.executeSimTradeAtomic(orderFor('day-add', txn, { trade_plan: planFor(txn) })), { code: 'SIM_PLAN_REQUIRED' });
    assert.equal((await db.listSimTransactions(2)).filter(t => t.type === 'buy').length, 1);
});

test('final exit automatically closes from fill history; partial exits stay active', async () => {
    const entry = buy({ symbol: 'EXIT', shares: 10, price: 10, fees: 2 });
    const opened = await db.executeSimTradeAtomic(orderFor('exit-entry', entry, { trade_plan: planFor(entry) }));
    await db.executeSimTradeAtomic(orderFor('exit-part', { ...entry, type: 'sell', shares: 4, price: 12, fees: 1 }));
    assert.equal((await db.getActiveSimTradePlan(1, 'EXIT')).id, opened.trade_plan_id);
    const finalOrder = orderFor('exit-final', { ...entry, type: 'sell', shares: 6, price: 11, fees: 1 }, {
        closure: { exit_price: 999, realized_pnl: 999, realized_r: 999, exit_shares: 999, exit_cost_basis: 999, fees: 999 },
    });
    const closed = await db.executeSimTradeAtomic(finalOrder);
    assert.equal(closed.trade_plan_id, opened.trade_plan_id);
    assert.equal(await db.getActiveSimTradePlan(1, 'EXIT'), null);
    const plan = (await db.listSimTradePlans(1)).find(p => p.id === opened.trade_plan_id);
    assert.equal(plan.exit_transaction_id, closed.id);
    assert.equal(plan.exit_price, 11);
    assert.equal(plan.exit_shares, 6);
    assert.equal(plan.exit_cost_basis, 102);
    assert.equal(plan.realized_pnl, 10);
    assert.equal(plan.realized_r, 1);
    assert.equal(plan.exit_reason, 'discretionary');
    assert.deepEqual(await db.executeSimTradeAtomic(finalOrder), closed);
});

test('explicit close rejects mismatched accounts/symbols and premature partial close atomically', async () => {
    const entry = buy({ symbol: 'SAFE', shares: 2 });
    const opened = await db.executeSimTradeAtomic(orderFor('safe-entry', entry, { trade_plan: planFor(entry) }));
    const before = await db.listSimTransactions(1);
    const cases = [
        orderFor('wrong-symbol', buy({ symbol: 'AAPL', type: 'sell', shares: 1 }), { close_plan_id: opened.trade_plan_id }),
        orderFor('wrong-account', buy({ account_id: 2, symbol: 'DAY', type: 'sell', shares: 1 }), { close_plan_id: opened.trade_plan_id }),
        orderFor('premature', { ...entry, type: 'sell', shares: 1 }, { close_plan_id: opened.trade_plan_id }),
    ];
    for (const order of cases) {
        await assert.rejects(db.executeSimTradeAtomic(order), { code: 'SIM_PLAN_REQUIRED' });
        assert.equal(await db.getSimOrder(order.transaction.account_id, order.client_order_id), null);
    }
    assert.deepEqual(await db.listSimTransactions(1), before);
    assert.equal((await db.getActiveSimTradePlan(1, 'SAFE')).id, opened.trade_plan_id);
});

test('cash dividends fund atomic buys: locked snapshot matches displayed cash', async () => {
    await new Promise((resolve, reject) => db.getDb().run(
        'UPDATE sim_reinvestment_settings SET dividend_reinvestment_mode = ? WHERE account_id = ?',
        ['cash', 1], (err) => { db.getDb(); err ? reject(err) : resolve(); },
    ));
    // Relative cash: the $50 cash dividend must be spendable by the very next
    // atomic buy even when prior tests left residual ledger state.
    const { computeCashBalance } = require('../services/simulator_ledger');
    const before = computeCashBalance(await db.listSimTransactions(1));
    await db.recordSimDividend({ account_id: 1, symbol: 'AAPL', amount: 50, txn_date: '2026-09-02', reinvestment_mode: 'cash', idempotency_key: 'div-key-1' });
    const withDividend = computeCashBalance(await db.listSimTransactions(1));
    assert.ok(Math.abs(withDividend - before - 50) < 0.000001, `displayed cash should rise by 50, delta ${withDividend - before}`);
    await db.executeSimTradeAtomic({
        transaction: { account_id: 1, type: 'buy', symbol: 'F', shares: 1, price: 50, txn_date: '2026-09-03' },
        client_order_id: 'div-funded-1',
        intent: { type: 'buy', symbol: 'F', shares: 1 },
    });
    const after = computeCashBalance(await db.listSimTransactions(1));
    assert.ok(Math.abs(after - before) < 0.000001, `post-buy cash should return to pre-dividend level, got ${after - before}`);
});

test('real concurrent conflicting buys: exactly one commits', async () => {
    // Isolated fresh account state: cash covers exactly ONE of the two buys,
    // so a resource re-check race would let both through.
    const iso = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'sim-atomic-race-'));
    process.env.DB_PATH_OVERRIDE = require('path').join(iso, 'race.db');
    delete require.cache[require.resolve('../database/db')];
    const dbIso = require('../database/db');
    try {
        await dbIso.initDb();
        await dbIso.addSimTransaction({ account_id: 1, type: 'deposit', amount: 100, txn_date: '2026-09-04' });
        const mk = (key) => dbIso.executeSimTradeAtomic({
            transaction: buy({ symbol: 'K1', shares: 60, price: 1 }),
            client_order_id: key,
            intent: { symbol: 'K1', shares: 60 },
            quote: { symbol: 'K1', price: 1, source: 'test' },
        });
        const outcomes = await Promise.allSettled([mk('p1'), mk('p2')]);
        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        const rejected = outcomes.filter((o) => o.status === 'rejected');
        assert.equal(fulfilled.length, 1);
        assert.equal(rejected.length, 1);
        assert.equal(rejected[0].reason.code, 'SIM_INSUFFICIENT_CASH');
        const rows = (await dbIso.listSimTransactions(1)).filter((t) => t.symbol === 'K1' && t.type === 'buy');
        assert.equal(rows.length, 1);
    } finally {
        require('fs').rmSync(iso, { recursive: true, force: true });
    }
});

test('real concurrent buy and sell on different symbols both commit', async () => {
    const outcomes = await Promise.allSettled([
        db.executeSimTradeAtomic({ transaction: buy({ symbol: 'K2', shares: 10, price: 5 }), client_order_id: 'm1', intent: { symbol: 'K2' }, quote: { symbol: 'K2', price: 5, source: 'test' } }),
        db.executeSimTradeAtomic({ transaction: buy({ symbol: 'AAPL', type: 'sell', shares: 5, price: 6 }), client_order_id: 'm2', intent: { symbol: 'AAPL' }, quote: { symbol: 'AAPL', price: 6, source: 'test' } }),
    ]);
    assert(outcomes.every((o) => o.status === 'fulfilled'), outcomes.map((o) => o.reason && o.reason.message).join('; '));
    const txns = await db.listSimTransactions(1);
    assert.equal(txns.filter((t) => t.symbol === 'K2' && t.type === 'buy').length, 1);
    assert.equal(txns.filter((t) => t.symbol === 'AAPL' && t.type === 'sell').length, 1);
    for (const outcome of outcomes) {
        const result = outcome.value;
        const txn = txns.find(t => t.id === result.id);
        assert.equal(txn.symbol, result.symbol);
        assert.equal(txn.type, result.type);
        assert.equal((await db.getSimOrder(1, result.client_order_id)).transaction_id, result.id);
    }
    assert.equal(Object.hasOwn(globalThis, 'transactionId'), false, 'order IDs must not leak into process globals');
    assert.equal(Object.hasOwn(globalThis, 'planIdFinal'), false);
});

