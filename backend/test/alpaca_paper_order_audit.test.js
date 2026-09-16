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

test('defaults execution_epoch to legacy_unattributed when the caller does not classify the order', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'unclassified-order', symbol: 'AAPL', side: 'buy', qty: 2,
    order_type: 'limit', time_in_force: 'day', limit_price: 230, status: 'pending_submission',
  });
  const [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.execution_epoch, 'legacy_unattributed');
});

test('records day-trading order-tree metadata and preserves it through a broker-id update', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-tree-entry', client_order_id: 'dt-tree-entry', symbol: 'NVDA', side: 'buy', qty: 10,
    order_type: 'limit', time_in_force: 'day', limit_price: 176.5, status: 'pending_submission',
    execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry', plan_id: 42,
  });
  await db.updateAlpacaPaperOrderAudit('dt-tree-entry', { status: 'filled', broker_order_id: 'broker-tree-1' });

  const [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.execution_epoch, 'day_trading');
  assert.strictEqual(row.client_order_id, 'dt-tree-entry');
  assert.strictEqual(row.order_class, 'bracket');
  assert.strictEqual(row.leg_role, 'entry');
  assert.strictEqual(row.plan_id, 42);
  assert.strictEqual(row.broker_order_id, 'broker-tree-1');
});

test('rejects a duplicate client_order_id with a distinct error from an idempotency-key collision', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-dup-key-a', client_order_id: 'dt-shared-client-id', symbol: 'MSFT', side: 'buy', qty: 1,
    order_type: 'limit', time_in_force: 'day', limit_price: 400, status: 'pending_submission',
  });
  await assert.rejects(() => db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-dup-key-b', client_order_id: 'dt-shared-client-id', symbol: 'MSFT', side: 'buy', qty: 1,
    order_type: 'limit', time_in_force: 'day', limit_price: 400, status: 'pending_submission',
  }), /duplicate Alpaca paper-order client order id/);
  assert.strictEqual((await db.listAlpacaPaperOrderAudits()).length, 1);
});

test('records partial then full fill progress without resetting the broker order identifier', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-fill-progress', client_order_id: 'dt-fill-progress', symbol: 'NVDA', side: 'buy', qty: 10,
    order_type: 'limit', time_in_force: 'day', limit_price: 176.5, status: 'pending_submission',
    execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
  });
  await db.updateAlpacaPaperOrderAudit('dt-fill-progress', { status: 'pending_new', broker_order_id: 'broker-fill-1' });

  await db.updateAlpacaPaperOrderAudit('dt-fill-progress', {
    status: 'partially_filled', filled_qty: 4, avg_fill_price: 176.52,
  });
  let [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.filled_qty, 4);
  assert.strictEqual(row.avg_fill_price, 176.52);
  assert.strictEqual(row.broker_order_id, 'broker-fill-1');

  await db.updateAlpacaPaperOrderAudit('dt-fill-progress', {
    status: 'filled', filled_qty: 10, avg_fill_price: 176.6, filled_at: '2026-09-16T14:31:00Z',
  });
  [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.filled_qty, 10);
  assert.strictEqual(row.avg_fill_price, 176.6);
  assert.strictEqual(row.filled_at, '2026-09-16T14:31:00Z');
  assert.strictEqual(row.broker_order_id, 'broker-fill-1');
});

test('marks an audit row unresolved on an ambiguous broker outcome and clears it once reconciled', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-ambiguous-1', symbol: 'NVDA', side: 'buy', qty: 5,
    order_type: 'limit', time_in_force: 'day', limit_price: 176.5, status: 'pending_submission',
  });
  await db.updateAlpacaPaperOrderAudit('dt-ambiguous-1', { status: 'submission_unknown', unresolved: true });
  let [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.unresolved, 1);

  await db.updateAlpacaPaperOrderAudit('dt-ambiguous-1', { status: 'filled', unresolved: false });
  [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.unresolved, 0);
});

test('round-trips broker lifecycle timestamps without disturbing ones left unset', async () => {
  await db.createAlpacaPaperOrderAudit({
    idempotency_key: 'dt-timestamps-1', symbol: 'NVDA', side: 'buy', qty: 5,
    order_type: 'limit', time_in_force: 'day', limit_price: 176.5, status: 'pending_submission',
  });
  await db.updateAlpacaPaperOrderAudit('dt-timestamps-1', {
    status: 'pending_new',
    broker_created_at: '2026-09-16T13:30:00Z',
    submitted_at: '2026-09-16T13:30:01Z',
  });
  await db.updateAlpacaPaperOrderAudit('dt-timestamps-1', {
    status: 'canceled',
    broker_updated_at: '2026-09-16T13:35:00Z',
    canceled_at: '2026-09-16T13:35:00Z',
  });

  const [row] = await db.listAlpacaPaperOrderAudits();
  assert.strictEqual(row.broker_created_at, '2026-09-16T13:30:00Z');
  assert.strictEqual(row.submitted_at, '2026-09-16T13:30:01Z');
  assert.strictEqual(row.broker_updated_at, '2026-09-16T13:35:00Z');
  assert.strictEqual(row.canceled_at, '2026-09-16T13:35:00Z');
  assert.strictEqual(row.filled_at, null);
  assert.strictEqual(row.expired_at, null);
});
