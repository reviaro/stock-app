const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const TEST_DB = path.join(__dirname, 'test_alpaca_day_trading_migration.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;
const db = require('../database/db');
const { runAlpacaExecutionEpochsMigration } = require('../database/migrations/002_alpaca_execution_epochs');

const OLD_SCHEMA_SQL = `
    CREATE TABLE alpaca_paper_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        idempotency_key TEXT NOT NULL UNIQUE,
        broker_order_id TEXT UNIQUE,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
        qty INTEGER NOT NULL CHECK (qty > 0),
        order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit')),
        time_in_force TEXT NOT NULL CHECK (time_in_force = 'day'),
        limit_price REAL,
        status TEXT NOT NULL,
        request_payload TEXT NOT NULL,
        broker_payload TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
    )
`;

function runSql(dbPath, statements) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.serialize(() => {
            for (const sql of statements) conn.run(sql, (err) => { if (err) reject(err); });
            conn.close((err) => (err ? reject(err) : resolve()));
        });
    });
}

function allRows(dbPath, sql) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.all(sql, (err, rows) => {
            conn.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function buildPreExistingDatabase(dbPath) {
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    return runSql(dbPath, [
        OLD_SCHEMA_SQL,
        'CREATE INDEX idx_alpaca_paper_orders_status ON alpaca_paper_orders(status, created_at DESC)',
        // Minimal stand-ins for the real ledgers, only to prove the migration never touches them.
        'CREATE TABLE transactions (id INTEGER PRIMARY KEY, symbol TEXT)',
        "INSERT INTO transactions (symbol) VALUES ('AAPL')",
        'CREATE TABLE sim_transactions (id INTEGER PRIMARY KEY, symbol TEXT)',
        "INSERT INTO sim_transactions (symbol) VALUES ('MSFT')",
        `INSERT INTO alpaca_paper_orders
            (idempotency_key, broker_order_id, symbol, side, qty, order_type, time_in_force, limit_price, status, request_payload)
         VALUES
            ('ltr-2f9a1c3e4b5d6a7c8e9f0a1b2c3d4e5f', 'private-broker-ltr-1', 'SPY', 'sell', 3, 'limit', 'day', 550.25, 'filled', '{"note":"ltr"}')`,
        `INSERT INTO alpaca_paper_orders
            (idempotency_key, broker_order_id, symbol, side, qty, order_type, time_in_force, limit_price, status, request_payload)
         VALUES
            ('intent-msft-001', 'private-broker-other-1', 'MSFT', 'buy', 5, 'limit', 'day', 400, 'accepted', '{"note":"other"}')`,
    ]);
}

after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

test('a fresh database already carries the extended schema and the migration is a no-op', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();

    const cols = await allRows(TEST_DB, "PRAGMA table_info('alpaca_paper_orders')");
    const colNames = cols.map((c) => c.name);
    for (const expected of ['execution_epoch', 'client_order_id', 'plan_id', 'parent_broker_order_id', 'leg_role', 'order_class', 'filled_qty']) {
        assert.ok(colNames.includes(expected), `expected fresh schema to already include ${expected}`);
    }

    const result = await runAlpacaExecutionEpochsMigration({ dbPath: TEST_DB });
    assert.deepStrictEqual(result, { migrated: 0, legacyLongTerm: 0, legacyUnattributed: 0, skipped: true });
});

test('classifies legacy rows by their immutable Long-Term idempotency-key prefix and leaves everything else unattributed', async () => {
    const fixtureDb = path.join(__dirname, 'test_alpaca_day_trading_migration_fixture.db');
    await buildPreExistingDatabase(fixtureDb);

    const result = await runAlpacaExecutionEpochsMigration({ dbPath: fixtureDb });
    assert.strictEqual(result.skipped, false);
    assert.strictEqual(result.migrated, 2);
    assert.strictEqual(result.legacyLongTerm, 1);
    assert.strictEqual(result.legacyUnattributed, 1);

    const rows = await allRows(fixtureDb, 'SELECT * FROM alpaca_paper_orders ORDER BY id ASC');
    assert.strictEqual(rows.length, 2);

    const [ltrRow, otherRow] = rows;
    assert.strictEqual(ltrRow.execution_epoch, 'legacy_long_term');
    assert.strictEqual(ltrRow.broker_order_id, 'private-broker-ltr-1');
    assert.strictEqual(ltrRow.symbol, 'SPY');
    assert.strictEqual(ltrRow.side, 'sell');
    assert.strictEqual(ltrRow.qty, 3);
    assert.strictEqual(ltrRow.status, 'filled');

    assert.strictEqual(otherRow.execution_epoch, 'legacy_unattributed');
    assert.strictEqual(otherRow.broker_order_id, 'private-broker-other-1');

    for (const row of rows) {
        assert.strictEqual(row.order_class, 'simple');
        assert.strictEqual(row.filled_qty, 0);
        assert.strictEqual(row.leg_role, null);
        assert.strictEqual(row.parent_broker_order_id, null);
        assert.strictEqual(row.plan_id, null);
        assert.strictEqual(row.client_order_id, null);
    }

    const indexes = await allRows(fixtureDb, "PRAGMA index_list('alpaca_paper_orders')");
    assert.ok(indexes.some((idx) => idx.name === 'idx_alpaca_paper_orders_status'), 'rebuilt table should keep its status index');

    const ledgerCounts = await allRows(fixtureDb, 'SELECT (SELECT COUNT(*) FROM transactions) AS t, (SELECT COUNT(*) FROM sim_transactions) AS s');
    assert.deepStrictEqual(ledgerCounts[0], { t: 1, s: 1 });

    const reportJson = JSON.stringify(result);
    assert.ok(!reportJson.includes('private-broker-ltr-1'), 'migration report must not leak broker order identifiers');
    assert.ok(!reportJson.includes('ltr-2f9a1c3e4b5d6a7c8e9f0a1b2c3d4e5f'), 'migration report must not leak idempotency keys');

    // Plan Section 10 Stage 1 requires exporting a snapshot of existing audit rows before
    // any are classified as legacy; keeping the pre-migration table in place (rather than
    // dropping it) means that evidence survives even if this migration runs before an
    // operator gets to it, satisfying Section 11 item 5 ("preserve all... audit evidence").
    const preMigrationRows = await allRows(fixtureDb, 'SELECT * FROM alpaca_paper_orders_pre_epoch_migration ORDER BY id ASC');
    assert.strictEqual(preMigrationRows.length, 2);
    assert.strictEqual(preMigrationRows[0].idempotency_key, 'ltr-2f9a1c3e4b5d6a7c8e9f0a1b2c3d4e5f');
    assert.strictEqual(preMigrationRows[0].broker_order_id, 'private-broker-ltr-1');

    fs.unlinkSync(fixtureDb);
});

test('running the migration twice on an already-migrated database changes nothing', async () => {
    const fixtureDb = path.join(__dirname, 'test_alpaca_day_trading_migration_repeat.db');
    await buildPreExistingDatabase(fixtureDb);

    await runAlpacaExecutionEpochsMigration({ dbPath: fixtureDb });
    const firstPass = await allRows(fixtureDb, 'SELECT * FROM alpaca_paper_orders ORDER BY id ASC');

    const secondResult = await runAlpacaExecutionEpochsMigration({ dbPath: fixtureDb });
    assert.deepStrictEqual(secondResult, { migrated: 0, legacyLongTerm: 0, legacyUnattributed: 0, skipped: true });

    const secondPass = await allRows(fixtureDb, 'SELECT * FROM alpaca_paper_orders ORDER BY id ASC');
    assert.deepStrictEqual(secondPass, firstPass);

    fs.unlinkSync(fixtureDb);
});

test('persists a bracket entry and its protective child legs with correct parent linkage', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();

    const entry = await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-nvda-entry-1', client_order_id: 'dt-nvda-entry-1', symbol: 'NVDA', side: 'buy', qty: 10,
        order_type: 'limit', time_in_force: 'day', limit_price: 176.5, status: 'pending_submission',
        execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'entry',
    });
    await db.updateAlpacaPaperOrderAudit('dt-nvda-entry-1', { status: 'filled', broker_order_id: 'broker-parent-1' });

    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-nvda-stop-1', client_order_id: 'dt-nvda-stop-1', symbol: 'NVDA', side: 'sell', qty: 10,
        order_type: 'stop', time_in_force: 'day', stop_price: 171.25, status: 'accepted',
        execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'stop_loss', parent_broker_order_id: 'broker-parent-1',
    });
    await db.createAlpacaPaperOrderAudit({
        idempotency_key: 'dt-nvda-target-1', client_order_id: 'dt-nvda-target-1', symbol: 'NVDA', side: 'sell', qty: 10,
        order_type: 'limit', time_in_force: 'day', limit_price: 182, status: 'accepted',
        execution_epoch: 'day_trading', order_class: 'bracket', leg_role: 'take_profit', parent_broker_order_id: 'broker-parent-1',
    });

    const rows = await db.listAlpacaPaperOrderAudits();
    const byRole = Object.fromEntries(rows.map((r) => [r.leg_role, r]));

    assert.strictEqual(byRole.entry.broker_order_id, 'broker-parent-1');
    assert.strictEqual(byRole.entry.order_class, 'bracket');
    assert.strictEqual(byRole.stop_loss.parent_broker_order_id, 'broker-parent-1');
    assert.strictEqual(byRole.stop_loss.stop_price, 171.25);
    assert.strictEqual(byRole.take_profit.parent_broker_order_id, 'broker-parent-1');
    assert.strictEqual(byRole.take_profit.limit_price, 182);
    assert.ok(rows.every((r) => r.execution_epoch === 'day_trading'));
    assert.strictEqual(entry.id > 0, true);
});
