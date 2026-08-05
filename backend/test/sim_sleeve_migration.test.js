const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const TEST_DB = path.join(__dirname, 'test_sim_sleeve_migration.db');
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');

function runSql(dbPath, statements) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.serialize(() => {
            for (const sql of statements) conn.run(sql, (err) => { if (err) reject(err); });
            conn.close((err) => (err ? reject(err) : resolve()));
        });
    });
}

function getRow(dbPath, sql) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(dbPath);
        conn.get(sql, (err, row) => {
            conn.close();
            err ? reject(err) : resolve(row ?? null);
        });
    });
}

test('initDb migrates a pre-sleeve tax bracket into sleeve 1 and drops sim_accounts', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await runSql(TEST_DB, [
        `CREATE TABLE sim_accounts (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            name TEXT NOT NULL DEFAULT 'default',
            tax_bracket INTEGER NOT NULL DEFAULT 22,
            created_at TEXT DEFAULT (datetime('now'))
        )`,
        'INSERT INTO sim_accounts (id, tax_bracket) VALUES (1, 32)',
    ]);

    await db.initDb();

    const sleeve = await db.getSimAccount(1);
    assert.strictEqual(sleeve.tax_bracket, 32);
    const leftover = await getRow(TEST_DB, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sim_accounts'");
    assert.strictEqual(leftover, null);
    fs.unlinkSync(TEST_DB);
});

test('initDb on a fresh database seeds sleeve 1 at the 22% default', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    const sleeve = await db.getSimAccount(1);
    assert.strictEqual(sleeve.tax_bracket, 22);
    const leftover = await getRow(TEST_DB, "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sim_accounts'");
    assert.strictEqual(leftover, null);
    fs.unlinkSync(TEST_DB);
});

test('a bracket set after migration is not clobbered by a later initDb', async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
    await db.setSimTaxBracket(35, 1);
    await db.initDb();
    const sleeve = await db.getSimAccount(1);
    assert.strictEqual(sleeve.tax_bracket, 35);
    fs.unlinkSync(TEST_DB);
});
