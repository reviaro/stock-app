const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, 'test_alpaca_paper_order_audit.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');

before(async () => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  await db.initDb();
});

after(() => {
  if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

beforeEach(async () => {
  const sqlite = db.getDb();
  await new Promise((resolve, reject) => sqlite.run('DELETE FROM alpaca_paper_orders', (err) => {
    sqlite.close();
    err ? reject(err) : resolve();
  }));
});

test('records a paper-order audit intent without touching either portfolio ledger', async () => {
  const recorded = await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'intent-msft-001',
    symbol: 'msft',
    side: 'buy',
    qty: 5,
    order_type: 'limit',
    time_in_force: 'day',
    limit_price: 400,
    status: 'pending_submission',
  });

  assert.ok(recorded.id);
  assert.strictEqual(recorded.symbol, 'MSFT');
  const rows = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].idempotency_key, 'intent-msft-001');
  assert.strictEqual(rows[0].status, 'pending_submission');

  const sqlite = db.getDb();
  const ledgerCounts = await new Promise((resolve, reject) => sqlite.get(
    'SELECT (SELECT COUNT(*) FROM transactions) AS portfolio_count, (SELECT COUNT(*) FROM sim_transactions) AS simulator_count',
    (err, row) => { sqlite.close(); err ? reject(err) : resolve(row); },
  ));
  assert.deepStrictEqual(ledgerCounts, { portfolio_count: 0, simulator_count: 0 });
});

test('rejects a duplicate idempotency key before a second order can be submitted', async () => {
  const order = {
    idempotency_key: 'intent-msft-duplicate', symbol: 'MSFT', side: 'buy', qty: 5,
    order_type: 'limit', time_in_force: 'day', limit_price: 400, status: 'pending_submission',
  };
  await db.createAlpacaPaperOrderAudit(order);
  await assert.rejects(() => db.createAlpacaPaperOrderAudit(order), /idempotency/);
  assert.strictEqual((await db.listAlpacaPaperOrderAudits()).length, 1);
});

test('reconciliation status updates preserve the original broker order identifier', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'preserve-broker-id', symbol: 'SPY', side: 'buy', qty: 1,
    order_type: 'limit', time_in_force: 'day', limit_price: 775, status: 'pending_submission',
  });
  await db.updateAlpacaPaperOrderAudit('preserve-broker-id', {
    status: 'pending_new', broker_order_id: 'private-broker-id', broker_payload: { status: 'pending_new' },
  });
  await db.updateAlpacaPaperOrderAudit('preserve-broker-id', {
    status: 'filled', broker_payload: { status: 'filled' },
  });
  const [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.status, 'filled');
  assert.strictEqual(row.broker_order_id, 'private-broker-id');
});
