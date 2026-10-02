const fs = require('node:fs');
const path = require('node:path');
const { SAMPLE_DB_PATH, SAMPLE_MARKER, assertSamplePath, acquireSampleLock, verifySampleDatabase } = require('../services/sample_mode');
const scenario = require('../fixtures/sample/scenario.json');
const prices = require('../fixtures/sample/prices.json');

function priceTransaction(transaction) {
    if (!['buy', 'sell'].includes(transaction.type)) return transaction;
    const price = prices.dates[transaction.txn_date]?.[transaction.symbol];
    if (!Number.isFinite(price) || price <= 0) throw new Error('Missing fixed historical close in sample fixture');
    return { ...transaction, price };
}

// A separate process owns the db module and its path. Tests can supply a scratch
// samplePath, but the CLI only permits this checkout's designated sample.db.
async function seedSample({ samplePath = SAMPLE_DB_PATH } = {}) {
    assertSamplePath(process.env.DB_PATH_OVERRIDE || samplePath, samplePath);
    if (require.cache[require.resolve('../database/db')]) throw new Error('Seed must run in a fresh process before loading the database');
    fs.mkdirSync(path.dirname(samplePath), { recursive: true });
    const release = acquireSampleLock(samplePath);
    const buildPath = path.join(path.dirname(samplePath), `sample.db.build-${process.pid}`);
    let ownsBuild = false;
    try {
        if (fs.existsSync(samplePath)) await verifySampleDatabase(samplePath);
        if (['-wal', '-shm', '-journal'].some((suffix) => fs.existsSync(samplePath + suffix))) {
            throw new Error('Sample SQLite sidecars exist; stop the server and close database clients before reseeding');
        }
        // Exclusive reservation prevents following any existing build-path alias.
        fs.closeSync(fs.openSync(buildPath, 'wx', 0o600));
        ownsBuild = true;
        process.env.DB_PATH_OVERRIDE = buildPath;
        delete process.env.ENABLE_LEDGER_MIGRATION;
        const db = require('../database/db');
        await db.initDb();
        for (const txn of scenario.transactions) await db.addTransaction(priceTransaction(txn));
        for (const row of scenario.watchlist) await db.addToWatchlist(row.symbol, row.notes, row.bucket);
        for (const { symbol, ...memo } of scenario.memos) await db.upsertMemo(symbol, memo);
        await db.setRiskRules(scenario.risk_rules);
        for (const txn of scenario.simulator_transactions) await db.addSimTransaction(priceTransaction(txn));
        const controls = require('../services/simulator_controls');
        for (const accountId of [1, 2]) {
            await controls.setPolicy(accountId, { max_position_pct: 40, min_cash_pct: 10,
                max_risk_per_trade_pct: 2, max_open_risk_pct: 8, max_daily_loss_pct: 3 }, 'sample-seed');
        }
        await controls.connection(async (conn) => {
            await controls.run(conn, 'UPDATE stock_memos SET last_reviewed_at = ?, updated_at = ?, created_at = ?',
                [scenario.as_of, scenario.as_of, scenario.as_of]);
            await controls.run(conn, 'CREATE TABLE sample_metadata (id INTEGER PRIMARY KEY CHECK (id = 1), marker TEXT NOT NULL, as_of TEXT NOT NULL)');
            await controls.run(conn, 'INSERT INTO sample_metadata VALUES (1, ?, ?)', [SAMPLE_MARKER, scenario.as_of]);
        });
        const { buildSummary } = require('../services/portfolio_ledger');
        const summary = buildSummary(await db.listTransactions(), prices.dates[scenario.as_of]);
        // Publish only a fully built database. A failed rebuild preserves the previous sample.
        fs.renameSync(buildPath, samplePath);
        console.log(`Sample ready: ${Object.keys(summary.holdings).length} holdings; cash $${summary.cash.toFixed(2)}; realized P&L $${summary.realized.total.toFixed(2)}.`);
        return summary;
    } finally {
        if (ownsBuild) {
            for (const suffix of ['', '-journal', '-wal', '-shm']) {
                fs.rmSync(buildPath + suffix, { force: true });
            }
        }
        release();
    }
}

if (require.main === module) {
    if (process.argv.length > 2) {
        console.error('seed:sample takes no arguments; it only rebuilds this checkout\'s sample.db');
        process.exitCode = 1;
    } else seedSample().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { seedSample, priceTransaction };
