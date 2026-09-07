const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TEST_DB = path.join(__dirname, `test_snap_prov_${process.pid}.db`);
process.env.DB_PATH_OVERRIDE = TEST_DB;

const db = require('../database/db');

before(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await db.initDb();
});

after(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
});

test('upsertStockSnapshot persists quote provenance basis and retrieval time', async () => {
    await db.upsertStockSnapshot({
        symbol: 'AAPL', slot: 'midday', marketDate: '2026-09-04',
        quoteTimestamp: '2026-09-04T16:00:00Z', quoteTimestampBasis: 'provider_event',
        retrievedAt: '2026-09-04T16:00:05Z',
        price: 215.25, previousClose: 210, changeAmount: 5.25, changePercent: 2.5,
        currency: 'USD', source: 'yfinance', isMarketClosed: false, isCarryForward: false,
    });
    const sqlite = db.getDb();
    const row = await new Promise((resolve, reject) => sqlite.get(
        "SELECT quote_timestamp, quote_timestamp_basis, retrieved_at FROM stock_snapshots WHERE symbol = 'AAPL'",
        (err, r) => { sqlite.close(); err ? reject(err) : resolve(r); },
    ));
    assert.equal(row.quote_timestamp, '2026-09-04T16:00:00Z');
    assert.equal(row.quote_timestamp_basis, 'provider_event');
    assert.equal(row.retrieved_at, '2026-09-04T16:00:05Z');
});

test('upsertStockSnapshot updates provenance on conflict and defaults stay null-safe', async () => {
    await db.upsertStockSnapshot({
        symbol: 'MSFT', slot: 'closeish', marketDate: '2026-09-04',
        quoteTimestamp: '2026-09-04T19:59:58Z', quoteTimestampBasis: 'provider_event',
        retrievedAt: '2026-09-04T20:00:03Z', price: 500,
    });
    await db.upsertStockSnapshot({
        symbol: 'MSFT', slot: 'closeish', marketDate: '2026-09-04',
        quoteTimestamp: '2026-09-04T19:59:59Z', quoteTimestampBasis: 'provider_event',
        retrievedAt: '2026-09-04T20:00:09Z', price: 500.5,
    });
    const sqlite = db.getDb();
    const rows = await new Promise((resolve, reject) => sqlite.all(
        "SELECT quote_timestamp_basis, retrieved_at, price FROM stock_snapshots WHERE symbol = 'MSFT'",
        (err, r) => { sqlite.close(); err ? reject(err) : resolve(r); },
    ));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].price, 500.5);
    assert.equal(rows[0].retrieved_at, '2026-09-04T20:00:09Z');
});
