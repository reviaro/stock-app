const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_ai_sim_tools.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

// Stub pybridge before ai_service is loaded
const Module = require('module');
const _originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
    if (request.includes('pybridge')) {
        return { getStockInfo: async () => ({ data: { price: 200.00, name: 'Test' } }) };
    }
    return _originalLoad.apply(this, arguments);
};

const db = require('../database/db');
const { tools } = require('../services/ai_service');

const today = new Date().toISOString().slice(0, 10);

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});

beforeEach(async () => {
    await db.deleteAllSimTransactions(1);
    await db.deleteAllSimTransactions(2);
});

after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

test('simulator_deposit records the deposit in the requested sleeve', async () => {
    const result = await tools.simulator_deposit.execute({ amount: 5000, account_id: 2 });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    const dayTrading = await db.listSimTransactions(2);
    assert.strictEqual(dayTrading.length, 1);
    assert.strictEqual(dayTrading[0].account_id, 2);
    assert.strictEqual((await db.listSimTransactions(1)).length, 0);
});

test('simulator_buy trades against the requested sleeve cash', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 10000, txn_date: today });
    const result = await tools.simulator_buy.execute({ symbol: 'AAPL', shares: 10, account_id: 2 });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    const buys = (await db.listSimTransactions(2)).filter((t) => t.type === 'buy');
    assert.strictEqual(buys.length, 1);
    assert.strictEqual((await db.listSimTransactions(1)).length, 0);
});

test('simulator_sell sells from the requested sleeve position', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 10000, txn_date: today });
    await db.addSimTransaction({ account_id: 2, type: 'buy', symbol: 'AAPL', shares: 10, price: 100, txn_date: today });
    const result = await tools.simulator_sell.execute({ symbol: 'AAPL', shares: 5, account_id: 2 });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    const sells = (await db.listSimTransactions(2)).filter((t) => t.type === 'sell');
    assert.strictEqual(sells.length, 1);
});

test('simulator_get_account reports the requested sleeve', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 7000, txn_date: today });
    const result = await tools.simulator_get_account.execute({ account_id: 2 });
    assert.strictEqual(result.data.id, 2);
    assert.strictEqual(result.data.cash, 7000);
});

test('simulator_get_transactions lists the requested sleeve only', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 1000, txn_date: today });
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 2000, txn_date: today });
    const result = await tools.simulator_get_transactions.execute({ account_id: 2 });
    assert.strictEqual(result.data.length, 1);
    assert.strictEqual(result.data[0].account_id, 2);
});

test('simulator_reset wipes only the requested sleeve', async () => {
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 1000, txn_date: today });
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 2000, txn_date: today });
    const result = await tools.simulator_reset.execute({ account_id: 2 });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    assert.strictEqual((await db.listSimTransactions(1)).length, 1);
    assert.strictEqual((await db.listSimTransactions(2)).length, 0);
});

test('simulator tools default to the long-term sleeve when account_id omitted', async () => {
    const result = await tools.simulator_deposit.execute({ amount: 1000 });
    assert.strictEqual(result.status, 'success', JSON.stringify(result));
    const longTerm = await db.listSimTransactions(1);
    assert.strictEqual(longTerm.length, 1);
    assert.strictEqual(longTerm[0].account_id, 1);
});

test('simulator tools reject an unknown sleeve', async () => {
    const result = await tools.simulator_get_account.execute({ account_id: 99 });
    assert.match(result.error ?? '', /not found/);
});
