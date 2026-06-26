const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_txns.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
});

beforeEach(async () => {
  const sqlite = db.getDb();
  await new Promise((resolve) => sqlite.run('DELETE FROM transactions', () => { sqlite.close(); resolve(); }));
});

after(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

test('addTransaction(buy) inserts with computed amount', async () => {
  const result = await db.addTransaction({ type: 'buy', symbol: 'AAPL', shares: 10, price: 150, txn_date: '2026-01-15' });
  assert.ok(result.id);
  const rows = await db.listTransactions();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].symbol, 'AAPL');
  assert.strictEqual(rows[0].amount, 1500);
});

test('addTransaction(sell) inserts', async () => {
  await db.addTransaction({ type: 'sell', symbol: 'AAPL', shares: 5, price: 180, txn_date: '2026-02-01' });
  const rows = await db.listTransactions();
  assert.strictEqual(rows[0].type, 'sell');
});

test('addTransaction(dividend) inserts amount without shares/price', async () => {
  const result = await db.addTransaction({ type: 'dividend', symbol: 'AAPL', amount: 12.5, txn_date: '2026-03-01' });
  assert.ok(result.id);
  const rows = await db.listTransactions();
  assert.strictEqual(rows[0].type, 'dividend');
  assert.strictEqual(rows[0].amount, 12.5);
});

test('addTransaction(deposit) inserts cash amount', async () => {
  const result = await db.addTransaction({ type: 'deposit', amount: 10000, txn_date: '2026-01-01' });
  assert.ok(result.id);
  const rows = await db.listTransactions();
  assert.strictEqual(rows[0].type, 'deposit');
  assert.strictEqual(rows[0].symbol, null);
});

test('addTransaction rejects buy without shares/price', async () => {
  await assert.rejects(() => db.addTransaction({ type: 'buy', symbol: 'AAPL', txn_date: '2026-01-01' }));
});

test('addTransaction rejects buy with non-positive shares', async () => {
  await assert.rejects(() => db.addTransaction({ type: 'buy', symbol: 'AAPL', shares: 0, price: 150, txn_date: '2026-01-01' }));
});

test('addTransaction rejects unknown type', async () => {
  await assert.rejects(() => db.addTransaction({ type: 'wat', txn_date: '2026-01-01' }));
});

test('addTransaction rejects missing txn_date', async () => {
  await assert.rejects(() => db.addTransaction({ type: 'deposit', amount: 100 }));
});

test('addTransaction rejects invalid date format', async () => {
  await assert.rejects(() => db.addTransaction({ type: 'deposit', amount: 100, txn_date: 'yesterday' }));
});

test('listTransactions filters by symbol', async () => {
  await db.addTransaction({ type: 'buy', symbol: 'AAPL', shares: 1, price: 100, txn_date: '2026-01-01' });
  await db.addTransaction({ type: 'buy', symbol: 'MSFT', shares: 1, price: 300, txn_date: '2026-01-01' });
  const rows = await db.listTransactions({ symbol: 'AAPL' });
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].symbol, 'AAPL');
});

test('listTransactions filters by type', async () => {
  await db.addTransaction({ type: 'buy', symbol: 'AAPL', shares: 1, price: 100, txn_date: '2026-01-01' });
  await db.addTransaction({ type: 'dividend', symbol: 'AAPL', amount: 2, txn_date: '2026-02-01' });
  const rows = await db.listTransactions({ type: 'dividend' });
  assert.strictEqual(rows.length, 1);
});

test('deleteTransaction removes the row', async () => {
  const result = await db.addTransaction({ type: 'buy', symbol: 'AAPL', shares: 1, price: 100, txn_date: '2026-01-01' });
  await db.deleteTransaction(result.id);
  const rows = await db.listTransactions();
  assert.strictEqual(rows.length, 0);
});
