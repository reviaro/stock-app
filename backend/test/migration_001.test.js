const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_migration.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const { runMigration001 } = require('../database/migrations/001_portfolio_to_ledger');

function cleanupTestDb() {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const candidate = `${TEST_DB}${suffix}`;
    if (fs.existsSync(candidate)) fs.unlinkSync(candidate);
  }
}

beforeEach(async () => {
  cleanupTestDb();
});

after(() => {
  cleanupTestDb();
  for (const file of fs.readdirSync(__dirname).filter((name) => name.startsWith('test_migration.db.backup.'))) {
    fs.unlinkSync(path.join(__dirname, file));
  }
});

test('migration copies portfolio rows as buy transactions', async () => {
  await db.initDb();
  await new Promise((resolve, reject) => {
    const sqlite = db.getDb();
    sqlite.run(
      'INSERT INTO portfolio (symbol, shares, buy_price, buy_date, notes) VALUES (?, ?, ?, ?, ?)',
      ['AAPL', 10, 150, '2025-12-01', 'legacy note'],
      (err) => sqlite.close((closeError) => (err || closeError) ? reject(err || closeError) : resolve())
    );
  });

  const result = await runMigration001({ dbPath: TEST_DB });
  assert.strictEqual(result.migrated, 1);

  const txns = await db.listTransactions();
  assert.strictEqual(txns.length, 2);
  const buy = txns.find((txn) => txn.type === 'buy');
  const seed = txns.find((txn) => txn.type === 'deposit');
  assert.ok(buy);
  assert.ok(seed);
  assert.strictEqual(buy.symbol, 'AAPL');
  assert.strictEqual(buy.shares, 10);
  assert.strictEqual(buy.price, 150);
  assert.strictEqual(buy.amount, 1500);
  assert.strictEqual(buy.txn_date, '2025-12-01');
  assert.strictEqual(buy.notes, 'legacy note');
  assert.strictEqual(seed.amount, 0);
  assert.strictEqual(seed.txn_date, '1970-01-01');
});

test('migration is idempotent (second run is a no-op)', async () => {
  await db.initDb();
  await new Promise((resolve, reject) => {
    const sqlite = db.getDb();
    sqlite.run(
      'INSERT INTO portfolio (symbol, shares, buy_price, buy_date, notes) VALUES (?, ?, ?, ?, ?)',
      ['AAPL', 10, 150, '2025-12-01', 'legacy note'],
      (err) => sqlite.close((closeError) => (err || closeError) ? reject(err || closeError) : resolve())
    );
  });
  await runMigration001({ dbPath: TEST_DB });
  const second = await runMigration001({ dbPath: TEST_DB });
  assert.strictEqual(second.migrated, 0);
  assert.ok(second.skipped);
});

test('migration falls back to 1970-01-01 when buy_date missing', async () => {
  await db.initDb();
  await new Promise((resolve, reject) => {
    const sqlite = db.getDb();
    sqlite.run(
      'INSERT INTO portfolio (symbol, shares, buy_price, buy_date, notes) VALUES (?, ?, ?, ?, ?)',
      ['MSFT', 5, 300, null, null],
      (err) => sqlite.close((closeError) => (err || closeError) ? reject(err || closeError) : resolve())
    );
  });
  await runMigration001({ dbPath: TEST_DB });
  const txns = await db.listTransactions({ symbol: 'MSFT' });
  assert.strictEqual(txns[0].txn_date, '1970-01-01');
});

test('migration writes a timestamped backup file', async () => {
  await db.initDb();
  const result = await runMigration001({ dbPath: TEST_DB });
  assert.ok(result.backupPath);
  assert.ok(fs.existsSync(result.backupPath));
});
