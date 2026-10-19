const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { createTestDatabase } = require('../test-support/test_database');
const TEST_DB = createTestDatabase();
const db = require('../database/db');

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
});

beforeEach(async () => {
  const s = db.getDb();
  await new Promise(r => s.run('DELETE FROM watchlist', () => { s.close(); r(); }));
});

after(() => { if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB); });

test('new watchlist entry defaults to unsorted', async () => {
  await db.addToWatchlist('AAPL');
  const rows = await db.getWatchlist();
  assert.strictEqual(rows[0].bucket, 'unsorted');
});

test('setWatchlistBucket updates bucket', async () => {
  await db.addToWatchlist('AAPL');
  await db.setWatchlistBucket('AAPL', 'compounders');
  const rows = await db.getWatchlist();
  assert.strictEqual(rows[0].bucket, 'compounders');
});

test('invalid bucket rejected', async () => {
  await db.addToWatchlist('AAPL');
  await assert.rejects(() => db.setWatchlistBucket('AAPL', 'garbage'));
});

test('addToWatchlist accepts optional bucket', async () => {
  await db.addToWatchlist('AAPL', '', 'buy_soon');
  const rows = await db.getWatchlist();
  assert.strictEqual(rows[0].bucket, 'buy_soon');
});
