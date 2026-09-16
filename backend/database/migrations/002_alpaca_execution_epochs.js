const sqlite3 = require('sqlite3').verbose();

// Single source of truth for the alpaca_paper_orders shape, shared by db.js (fresh
// CREATE TABLE IF NOT EXISTS) and this migration's rebuild of a pre-existing table,
// so the two paths can never drift apart.
const ALPACA_PAPER_ORDERS_COLUMNS_SQL = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL UNIQUE,
    client_order_id TEXT UNIQUE,
    broker_order_id TEXT UNIQUE,
    execution_epoch TEXT NOT NULL DEFAULT 'legacy_unattributed'
        CHECK (execution_epoch IN ('legacy_long_term', 'legacy_unattributed', 'day_trading')),
    plan_id INTEGER,
    parent_broker_order_id TEXT,
    leg_role TEXT
        CHECK (leg_role IS NULL OR leg_role IN ('entry', 'take_profit', 'stop_loss', 'time_exit', 'repair_exit', 'emergency_flatten')),
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    qty INTEGER NOT NULL CHECK (qty > 0),
    filled_qty INTEGER NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
    avg_fill_price REAL,
    order_class TEXT NOT NULL DEFAULT 'simple' CHECK (order_class IN ('simple', 'bracket', 'oco', 'oto')),
    order_type TEXT NOT NULL CHECK (order_type IN ('market', 'limit', 'stop', 'stop_limit', 'trailing_stop')),
    time_in_force TEXT NOT NULL CHECK (time_in_force = 'day'),
    limit_price REAL,
    stop_price REAL,
    take_profit_price REAL,
    status TEXT NOT NULL,
    -- status stays authoritative for cash/quantity reservation (see committedBuyCash/
    -- committedSellQty in alpaca_paper_service.js); this is a settable convenience flag
    -- for callers that need to index/query ambiguity without re-deriving it from status.
    unresolved INTEGER NOT NULL DEFAULT 0 CHECK (unresolved IN (0, 1)),
    request_payload TEXT NOT NULL,
    broker_payload TEXT,
    broker_created_at TEXT,
    submitted_at TEXT,
    broker_updated_at TEXT,
    filled_at TEXT,
    canceled_at TEXT,
    expired_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
`;

// A row's idempotency_key is immutable, broker-submission evidence: only the retired
// Long-Term reconciliation service ever minted the 'ltr-' prefix (see cyclePrefix() on
// feature/alpaca-long-term-reconciliation). Everything else is classified conservatively
// as unattributed rather than guessed from symbol or any other mutable field.
const LONG_TERM_KEY_PREFIX = 'ltr-';

function runAlpacaExecutionEpochsMigration({ dbPath }) {
    if (!dbPath) throw new Error('dbPath required');

    return new Promise((resolve, reject) => {
        let settled = false;
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err && !settled) {
                settled = true;
                reject(err);
            }
        });
        db.configure('busyTimeout', 5000);

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            db.close((closeError) => {
                const finalError = error || closeError;
                finalError ? reject(finalError) : resolve(value);
            });
        };
        const rollbackAndFail = (error) => db.run('ROLLBACK', () => finish(error));
        const skip = () => finish(null, { migrated: 0, legacyLongTerm: 0, legacyUnattributed: 0, skipped: true });

        db.serialize(() => {
            db.all("PRAGMA table_info('alpaca_paper_orders')", (infoErr, cols) => {
                if (infoErr) return finish(infoErr);
                if (!cols || cols.length === 0) return skip();
                if (cols.some((col) => col.name === 'execution_epoch')) return skip();

                // The rename is nested inside BEGIN's own callback (rather than queued
                // alongside it) because serialize() only orders statement dispatch — it
                // does not stop a later statement just because an earlier one's callback
                // reported an error. Nesting is what actually prevents the rename from
                // running unguarded (outside any transaction) if BEGIN itself fails.
                db.run('BEGIN TRANSACTION', (beginErr) => {
                    if (beginErr) return finish(beginErr);

                    db.run('ALTER TABLE alpaca_paper_orders RENAME TO alpaca_paper_orders_pre_epoch_migration', (renameErr) => {
                        if (renameErr) return rollbackAndFail(renameErr);

                        db.run(`CREATE TABLE alpaca_paper_orders (${ALPACA_PAPER_ORDERS_COLUMNS_SQL})`, (createErr) => {
                            if (createErr) return rollbackAndFail(createErr);

                            db.run(`
                                INSERT INTO alpaca_paper_orders (
                                    id, idempotency_key, broker_order_id, execution_epoch, symbol, side, qty,
                                    order_type, time_in_force, limit_price, status, request_payload, broker_payload,
                                    created_at, updated_at
                                )
                                SELECT
                                    id, idempotency_key, broker_order_id,
                                    CASE WHEN idempotency_key LIKE '${LONG_TERM_KEY_PREFIX}%' THEN 'legacy_long_term' ELSE 'legacy_unattributed' END,
                                    symbol, side, qty, order_type, time_in_force, limit_price, status, request_payload,
                                    broker_payload, created_at, updated_at
                                FROM alpaca_paper_orders_pre_epoch_migration
                            `, (copyErr) => {
                                if (copyErr) return rollbackAndFail(copyErr);

                                // Keep the renamed original around as durable evidence (plan Section
                                // 10 Stage 1 requires exporting existing audit rows before any are
                                // classified as legacy, and Section 11 requires preserving all audit
                                // evidence during rollback) rather than dropping it. SQLite carries
                                // its index along with the rename, and an index name is unique
                                // database-wide, so that old index must be dropped explicitly before
                                // the replacement can be created on the new table.
                                db.run('DROP INDEX idx_alpaca_paper_orders_status', (dropIdxErr) => {
                                    if (dropIdxErr) return rollbackAndFail(dropIdxErr);

                                    db.run('CREATE INDEX idx_alpaca_paper_orders_status ON alpaca_paper_orders(status, created_at DESC)', (idxErr) => {
                                        if (idxErr) return rollbackAndFail(idxErr);

                                        db.all('SELECT execution_epoch, COUNT(*) AS c FROM alpaca_paper_orders GROUP BY execution_epoch', (countErr, rows) => {
                                            if (countErr) return rollbackAndFail(countErr);
                                            const counts = Object.fromEntries((rows || []).map((r) => [r.execution_epoch, r.c]));

                                            db.run('COMMIT', (commitErr) => {
                                                if (commitErr) return finish(commitErr);
                                                const legacyLongTerm = counts.legacy_long_term || 0;
                                                const legacyUnattributed = counts.legacy_unattributed || 0;
                                                finish(null, {
                                                    migrated: legacyLongTerm + legacyUnattributed,
                                                    legacyLongTerm,
                                                    legacyUnattributed,
                                                    skipped: false,
                                                });
                                            });
                                        });
                                    });
                                });
                            });
                        });
                    });
                });
            });
        });
    });
}

module.exports = { runAlpacaExecutionEpochsMigration, ALPACA_PAPER_ORDERS_COLUMNS_SQL };
