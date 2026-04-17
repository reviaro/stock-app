const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Use an isolated test DB
const TEST_DB = path.join(__dirname, 'test_stocks.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
});

beforeEach(async () => {
  // Clear memos between tests
  const sqlite = db.getDb();
  await new Promise((resolve, reject) =>
    sqlite.run('DELETE FROM stock_memos', (err) => { sqlite.close(); err ? reject(err) : resolve(); })
  );
});

after(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

test('upsert + get memo', async () => {
  await db.upsertMemo('AAPL', {
    thesis: 'Great business',
    fair_value_low: 150,
    fair_value_high: 200,
    buy_below: 170,
    sell_rule: 'Trim at 1.3x FV',
    invalidation: 'Services slowdown',
    risks: 'China',
    conviction: 4,
  });
  const got = await db.getMemo('AAPL');
  assert.strictEqual(got.symbol, 'AAPL');
  assert.strictEqual(got.thesis, 'Great business');
  assert.strictEqual(got.conviction, 4);
  assert.ok(got.updated_at);
});

test('get missing memo returns null', async () => {
  const got = await db.getMemo('NONEXISTENT');
  assert.strictEqual(got, null);
});

test('markMemoReviewed updates last_reviewed_at', async () => {
  await db.upsertMemo('MSFT', { thesis: 'x' });
  await db.markMemoReviewed('MSFT');
  const got = await db.getMemo('MSFT');
  assert.ok(got.last_reviewed_at);
});

test('listMemos returns all memos', async () => {
  await db.upsertMemo('AAPL', { thesis: 'a' });
  await db.upsertMemo('MSFT', { thesis: 'b' });
  const list = await db.listMemos();
  assert.strictEqual(list.length, 2);
});

test('deleteMemo removes the memo', async () => {
  await db.upsertMemo('AAPL', { thesis: 'x' });
  await db.deleteMemo('AAPL');
  const got = await db.getMemo('AAPL');
  assert.strictEqual(got, null);
});
