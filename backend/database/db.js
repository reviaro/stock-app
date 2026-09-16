const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { normalizeSimTransaction } = require('../services/simulator_transaction_validation');
const { normalizeTradePlan, closeStructuredTrade } = require('../services/trade_journal');
const { ALPACA_PAPER_ORDERS_COLUMNS_SQL } = require('./migrations/002_alpaca_execution_epochs');

const VALID_BUCKETS = ['compounders', 'buy_soon', 'expensive', 'speculative', 'owned', 'unsorted'];
const VALID_TXN_TYPES = ['buy', 'sell', 'dividend', 'deposit', 'withdrawal'];
const VALID_SIM_TXN_TYPES = ['buy', 'sell', 'deposit', 'withdrawal']; // 'dividend' excluded: sim tracks manual trades only
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RULE_FIELDS = ['max_position_pct', 'max_sector_pct', 'max_risk_per_trade_pct', 'target_cash_pct'];
const MEMO_FIELDS = ['thesis', 'variant_view', 'fair_value_low', 'fair_value_high', 'buy_below', 'trim_above', 'sell_rule', 'invalidation', 'risks', 'conviction'];

const DB_PATH = process.env.DB_PATH_OVERRIDE || path.join(__dirname, '..', 'database', 'stocks.db');

function ignoreDuplicateColumnError(err) {
    if (err && !/duplicate column name/i.test(err.message)) {
        console.error('Schema update error:', err.message);
    }
}

function getDb() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }

    const conn = new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('Database connection error:', err.message);
        }
    });
    // Serialize lock acquisition across connections: without a busy timeout a
    // contended BEGIN IMMEDIATE fails instantly instead of waiting its turn.
    conn.configure('busyTimeout', 5000);
    return conn;
}

function initDb() {
    return new Promise((resolve, reject) => {
        const db = getDb();

        db.serialize(() => {
            db.run(`
                CREATE TABLE IF NOT EXISTS watchlist (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT UNIQUE NOT NULL,
                    added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    notes TEXT
                )
            `);

            db.all('PRAGMA table_info(watchlist)', (err, cols) => {
                if (err) return;
                const hasBucket = (cols || []).some((c) => c.name === 'bucket');
                if (!hasBucket) {
                    db.run("ALTER TABLE watchlist ADD COLUMN bucket TEXT NOT NULL DEFAULT 'unsorted'");
                }
            });

            db.run(`
                CREATE TABLE IF NOT EXISTS universe_cache (
                    symbol TEXT PRIMARY KEY,
                    weighted_score REAL NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS stock_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    slot TEXT NOT NULL,
                    market_date TEXT NOT NULL,
                    captured_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    quote_timestamp TEXT,
                    price REAL NOT NULL,
                    previous_close REAL,
                    change_amount REAL,
                    change_percent REAL,
                    open_price REAL,
                    day_high REAL,
                    fifty_two_week_high REAL,
                    fifty_two_week_low REAL,
                    change_from_open_percent REAL,
                    gap_apr22_percent REAL,
                    dist_from_52wh_percent REAL,
                    dist_from_52wl_percent REAL,
                    currency TEXT DEFAULT 'USD',
                    source TEXT DEFAULT 'yfinance',
                    is_market_closed INTEGER DEFAULT 0,
                    is_carry_forward INTEGER DEFAULT 0,
                    raw_payload TEXT,
                    UNIQUE(symbol, market_date, slot)
                )
            `);

            db.run('ALTER TABLE stock_snapshots ADD COLUMN open_price REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN day_high REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN fifty_two_week_high REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN fifty_two_week_low REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN change_from_open_percent REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN gap_apr22_percent REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN dist_from_52wh_percent REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN dist_from_52wl_percent REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN quote_timestamp_basis TEXT', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_snapshots ADD COLUMN retrieved_at TEXT', ignoreDuplicateColumnError);

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_stock_snapshots_symbol_captured
                ON stock_snapshots(symbol, captured_at DESC)
            `);

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_stock_snapshots_market_date_slot
                ON stock_snapshots(market_date, slot)
            `);

            // Legacy table retained so migration 001 can lift rows into transactions.
            db.run(`
                CREATE TABLE IF NOT EXISTS portfolio (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL UNIQUE,
                    shares REAL NOT NULL,
                    buy_price REAL NOT NULL,
                    buy_date TEXT,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT,
                    type TEXT NOT NULL CHECK (type IN ('buy','sell','dividend','deposit','withdrawal')),
                    shares REAL,
                    price REAL,
                    amount REAL NOT NULL,
                    fees REAL NOT NULL DEFAULT 0,
                    txn_date TEXT NOT NULL,
                    notes TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run('CREATE INDEX IF NOT EXISTS idx_transactions_symbol_date ON transactions(symbol, txn_date)');

            db.run(`
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL DEFAULT 'default',
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                CREATE TABLE IF NOT EXISTS stock_memos (
                    symbol TEXT PRIMARY KEY,
                    thesis TEXT,
                    variant_view TEXT,
                    fair_value_low REAL,
                    fair_value_high REAL,
                    buy_below REAL,
                    trim_above REAL,
                    sell_rule TEXT,
                    invalidation TEXT,
                    risks TEXT,
                    conviction INTEGER,
                    last_reviewed_at DATETIME,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run('ALTER TABLE stock_memos ADD COLUMN variant_view TEXT', ignoreDuplicateColumnError);
            db.run('ALTER TABLE stock_memos ADD COLUMN trim_above REAL', ignoreDuplicateColumnError);

            db.run(`
                CREATE TABLE IF NOT EXISTS risk_rules (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    max_position_pct REAL NOT NULL DEFAULT 10,
                    max_sector_pct REAL NOT NULL DEFAULT 30,
                    max_risk_per_trade_pct REAL NOT NULL DEFAULT 1,
                    target_cash_pct REAL NOT NULL DEFAULT 20,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run('INSERT OR IGNORE INTO risk_rules (id) VALUES (1)');

            db.run(`
                CREATE TABLE IF NOT EXISTS position_stops (
                    symbol TEXT PRIMARY KEY,
                    stop_loss REAL NOT NULL,
                    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Simulator sleeves are intentionally separate ledgers. Existing transaction rows
            // retain account_id=1, preserving the original long-term portfolio untouched.
            db.run(`
                CREATE TABLE IF NOT EXISTS simulator_sleeves (
                    id INTEGER PRIMARY KEY,
                    name TEXT NOT NULL,
                    slug TEXT NOT NULL UNIQUE,
                    tax_bracket INTEGER NOT NULL DEFAULT 22,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            `);
            db.run(`INSERT OR IGNORE INTO simulator_sleeves (id, name, slug, tax_bracket)
                    VALUES (1, 'Long-Term Investing', 'long-term', 22)`);
            db.run(`INSERT OR IGNORE INTO simulator_sleeves (id, name, slug, tax_bracket)
                    VALUES (2, 'Day Trading', 'day-trading', 22)`);

            // The retired sim_accounts table held the pre-sleeve tax bracket. Recreating it
            // empty when absent keeps the carry-over a plain serialized statement sequence
            // (no conditional callbacks racing initDb's resolve): copy any persisted bracket
            // into sleeve 1 — the INSERT OR IGNORE above only seeds a missing row, so a
            // bracket the user sets later is never clobbered — then drop the table.
            db.run(`
                CREATE TABLE IF NOT EXISTS sim_accounts (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    tax_bracket INTEGER NOT NULL DEFAULT 22
                )
            `);
            db.run(`UPDATE simulator_sleeves
                    SET tax_bracket = COALESCE((SELECT tax_bracket FROM sim_accounts WHERE id = 1), tax_bracket)
                    WHERE id = 1`);
            db.run('DROP TABLE sim_accounts');

            db.run(`
                CREATE TABLE IF NOT EXISTS sim_transactions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL DEFAULT 1,
                    symbol TEXT,
                    type TEXT NOT NULL CHECK (type IN ('buy','sell','deposit','withdrawal')),
                    shares REAL,
                    price REAL,
                    amount REAL NOT NULL,
                    fees REAL NOT NULL DEFAULT 0,
                    txn_date TEXT NOT NULL,
                    notes TEXT,
                    created_at TEXT DEFAULT (datetime('now'))
                )
            `);

            db.run('CREATE INDEX IF NOT EXISTS idx_sim_transactions_symbol ON sim_transactions(symbol, txn_date)');

            // Evaluated simulator orders: idempotency ledger and quote provenance.
            // Existing sim_transactions rows are untouched; manual helpers remain
            // usable without an order record (legacy/seed paths keep working).
            db.run(`
                CREATE TABLE IF NOT EXISTS sim_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    client_order_id TEXT NOT NULL,
                    intent_hash TEXT NOT NULL,
                    transaction_id INTEGER NOT NULL,
                    result_json TEXT NOT NULL,
                    quote_json TEXT,
                    fill_date TEXT NOT NULL,
                    fill_time TEXT NOT NULL,
                    created_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(account_id, client_order_id),
                    FOREIGN KEY(account_id) REFERENCES simulator_sleeves(id),
                    FOREIGN KEY(transaction_id) REFERENCES sim_transactions(id)
                )
            `);
            db.run('CREATE INDEX IF NOT EXISTS idx_sim_orders_intent ON sim_orders(account_id, intent_hash, transaction_id)');

            // Reinvestment preferences are sleeve-specific. Keeping them separate avoids
            // mutating the established sleeve schema and gives each strategy safe defaults.
            db.run(`
                CREATE TABLE IF NOT EXISTS sim_reinvestment_settings (
                    account_id INTEGER PRIMARY KEY,
                    dividend_reinvestment_mode TEXT NOT NULL CHECK (dividend_reinvestment_mode IN ('cash', 'drip')),
                    profit_reinvestment_mode TEXT NOT NULL CHECK (profit_reinvestment_mode IN ('hold_cash', 'redeploy_excess')),
                    target_cash_pct REAL NOT NULL CHECK (target_cash_pct >= 0 AND target_cash_pct <= 100),
                    updated_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY(account_id) REFERENCES simulator_sleeves(id)
                )
            `);
            db.run(`INSERT OR IGNORE INTO sim_reinvestment_settings
                    (account_id, dividend_reinvestment_mode, profit_reinvestment_mode, target_cash_pct)
                    VALUES (1, 'drip', 'redeploy_excess', 10)`);
            db.run(`INSERT OR IGNORE INTO sim_reinvestment_settings
                    (account_id, dividend_reinvestment_mode, profit_reinvestment_mode, target_cash_pct)
                    VALUES (2, 'cash', 'hold_cash', 10)`);

            // Dividend events live separately because the original simulator transaction
            // table intentionally has a CHECK constraint that excludes dividends. DRIP's
            // linked fractional buy is still a normal simulator transaction.
            db.run(`
                CREATE TABLE IF NOT EXISTS sim_dividends (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    amount REAL NOT NULL CHECK (amount > 0),
                    txn_date TEXT NOT NULL,
                    idempotency_key TEXT NOT NULL,
                    reinvestment_mode TEXT NOT NULL CHECK (reinvestment_mode IN ('cash', 'drip')),
                    reinvestment_price REAL,
                    reinvested_shares REAL,
                    drip_transaction_id INTEGER,
                    notes TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(account_id, idempotency_key),
                    FOREIGN KEY(account_id) REFERENCES simulator_sleeves(id),
                    FOREIGN KEY(drip_transaction_id) REFERENCES sim_transactions(id)
                )
            `);
            db.run('CREATE INDEX IF NOT EXISTS idx_sim_dividends_account_date ON sim_dividends(account_id, txn_date, id)');

            // Structured paper-trade plans are isolated from both the real portfolio and
            // Alpaca audit mirror. They document risk and post-trade evidence only.
            db.run(`
                CREATE TABLE IF NOT EXISTS sim_trade_plans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    account_id INTEGER NOT NULL,
                    symbol TEXT NOT NULL,
                    setup TEXT NOT NULL,
                    catalyst TEXT,
                    thesis TEXT NOT NULL,
                    invalidation TEXT,
                    entry_transaction_id INTEGER NOT NULL,
                    exit_transaction_id INTEGER,
                    shares REAL NOT NULL CHECK (shares > 0),
                    planned_entry REAL NOT NULL CHECK (planned_entry > 0),
                    stop_price REAL NOT NULL CHECK (stop_price > 0),
                    target_price REAL NOT NULL CHECK (target_price > 0),
                    planned_risk REAL NOT NULL CHECK (planned_risk > 0),
                    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled')),
                    exit_reason TEXT CHECK (exit_reason IN ('stop', 'target', 'time_exit', 'thesis_break', 'discretionary')),
                    thesis_valid INTEGER,
                    exit_price REAL,
                    exit_shares REAL,
                    exit_cost_basis REAL,
                    realized_pnl REAL,
                    realized_r REAL,
                    mfe REAL,
                    mae REAL,
                    review_notes TEXT,
                    opened_at TEXT DEFAULT (datetime('now')),
                    closed_at TEXT,
                    FOREIGN KEY(account_id) REFERENCES simulator_sleeves(id),
                    FOREIGN KEY(entry_transaction_id) REFERENCES sim_transactions(id),
                    FOREIGN KEY(exit_transaction_id) REFERENCES sim_transactions(id)
                )
            `);
            db.run('ALTER TABLE sim_trade_plans ADD COLUMN exit_shares REAL', ignoreDuplicateColumnError);
            db.run('ALTER TABLE sim_trade_plans ADD COLUMN exit_cost_basis REAL', ignoreDuplicateColumnError);
            db.run('CREATE INDEX IF NOT EXISTS idx_sim_trade_plans_account_status ON sim_trade_plans(account_id, status, opened_at DESC)');
            db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_trade_plans_one_active ON sim_trade_plans(account_id, symbol) WHERE status = 'active'");

            // Separate, broker-facing paper-order audit mirror. It never feeds the local
            // simulator or real portfolio ledgers; idempotency prevents duplicate submits.
            // A pre-existing database with the narrower legacy shape (buy/sell day-limit
            // only, no execution_epoch) is upgraded in place by migration 002 below.
            db.run(`CREATE TABLE IF NOT EXISTS alpaca_paper_orders (${ALPACA_PAPER_ORDERS_COLUMNS_SQL})`);
            db.run('CREATE INDEX IF NOT EXISTS idx_alpaca_paper_orders_status ON alpaca_paper_orders(status, created_at DESC)');

            // Day Trading strategy plans, independent of the sim_trade_plans ledger tables:
            // these track a broker-backed bracket lifecycle, not a simulator transaction.
            db.run(`
                CREATE TABLE IF NOT EXISTS alpaca_day_trade_plans (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol TEXT NOT NULL,
                    setup TEXT NOT NULL,
                    catalyst TEXT NOT NULL,
                    thesis TEXT NOT NULL,
                    invalidation TEXT NOT NULL,
                    planned_entry_low REAL NOT NULL,
                    planned_entry_high REAL NOT NULL,
                    planned_stop REAL NOT NULL,
                    planned_target REAL NOT NULL,
                    planned_qty INTEGER NOT NULL CHECK (planned_qty > 0),
                    planned_risk_dollars REAL NOT NULL,
                    planned_reward_risk REAL NOT NULL,
                    planned_account_risk_pct REAL NOT NULL,
                    state TEXT NOT NULL DEFAULT 'planned'
                        CHECK (state IN ('planned', 'entry_pending', 'partially_entered', 'active', 'exit_pending', 'closed', 'cancelled', 'error')),
                    entry_parent_broker_order_id TEXT,
                    protective_stop_broker_order_id TEXT,
                    protective_target_broker_order_id TEXT,
                    -- Denormalized cache of alpaca_paper_fills' effective totals (see
                    -- computeFilledSummary in alpaca_day_trade_store.js), refreshed by fill
                    -- reconciliation. Fills stay authoritative; these columns exist so plan
                    -- reads (UI, journal) don't have to re-aggregate fills on every request.
                    filled_entry_qty INTEGER NOT NULL DEFAULT 0 CHECK (filled_entry_qty >= 0),
                    avg_entry_price REAL,
                    filled_exit_qty INTEGER NOT NULL DEFAULT 0 CHECK (filled_exit_qty >= 0),
                    avg_exit_price REAL,
                    exit_deadline TEXT NOT NULL,
                    exit_reason TEXT CHECK (exit_reason IS NULL OR exit_reason IN ('take_profit', 'stop_loss', 'time_exit', 'repair_exit', 'emergency_flatten', 'manual')),
                    realized_pnl REAL,
                    realized_r REAL,
                    mfe REAL,
                    mae REAL,
                    thesis_valid INTEGER CHECK (thesis_valid IS NULL OR thesis_valid IN (0, 1)),
                    review_notes TEXT,
                    strategy_version TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    opened_at TEXT,
                    closed_at TEXT
                )
            `);
            db.run(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_alpaca_day_trade_plans_one_nonterminal
                ON alpaca_day_trade_plans(symbol)
                WHERE state NOT IN ('closed', 'cancelled', 'error')
            `);
            db.run('CREATE INDEX IF NOT EXISTS idx_alpaca_day_trade_plans_state ON alpaca_day_trade_plans(state, created_at DESC)');

            // Idempotent execution-event mirror: the trade_updates WebSocket and Alpaca FILL
            // account activities can both deliver the same event, so activity_id is the
            // dedup key rather than a per-order or per-plan sequence.
            db.run(`
                CREATE TABLE IF NOT EXISTS alpaca_paper_fills (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    activity_id TEXT NOT NULL UNIQUE,
                    broker_order_id TEXT,
                    plan_id INTEGER,
                    symbol TEXT NOT NULL,
                    side TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
                    qty INTEGER NOT NULL CHECK (qty > 0),
                    price REAL NOT NULL CHECK (price > 0),
                    executed_at TEXT NOT NULL,
                    fill_type TEXT NOT NULL CHECK (fill_type IN ('partial_fill', 'fill')),
                    correction_of TEXT,
                    is_bust INTEGER NOT NULL DEFAULT 0 CHECK (is_bust IN (0, 1)),
                    imported_at TEXT DEFAULT (datetime('now')),
                    source TEXT NOT NULL CHECK (source IN ('websocket', 'rest_reconciliation'))
                )
            `);
            db.run('CREATE INDEX IF NOT EXISTS idx_alpaca_paper_fills_plan ON alpaca_paper_fills(plan_id, executed_at)');
            db.run('CREATE INDEX IF NOT EXISTS idx_alpaca_paper_fills_order ON alpaca_paper_fills(broker_order_id)');

            // Singleton row: exactly one Day Trading monitor process is ever active (Task 13's
            // single-instance lock), so its runtime state needs no additional key.
            db.run(`
                CREATE TABLE IF NOT EXISTS alpaca_monitor_state (
                    id INTEGER PRIMARY KEY CHECK (id = 1),
                    mode TEXT NOT NULL DEFAULT 'disabled' CHECK (mode IN ('disabled', 'shadow', 'paper_execute')),
                    last_rest_reconciliation_at TEXT,
                    last_websocket_event_at TEXT,
                    last_websocket_reconnect_at TEXT,
                    activity_cursor TEXT,
                    session_date TEXT,
                    health_code TEXT,
                    health_error TEXT,
                    kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
                    last_flatten_sweep_at TEXT,
                    submission_lease_holder TEXT,
                    submission_lease_expires_at TEXT,
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            `);
            db.run(`INSERT OR IGNORE INTO alpaca_monitor_state (id, mode) VALUES (1, 'disabled')`);

            // Strategy Lab is an evidence registry only. These isolated tables contain
            // experiment definitions, versioned rules, and observed test/paper runs.
            db.run(`
                CREATE TABLE IF NOT EXISTS strategy_experiments (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    hypothesis TEXT NOT NULL,
                    created_at TEXT DEFAULT (datetime('now')),
                    updated_at TEXT DEFAULT (datetime('now'))
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS strategy_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    experiment_id INTEGER NOT NULL,
                    version_number INTEGER NOT NULL,
                    rules_json TEXT NOT NULL,
                    notes TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    UNIQUE(experiment_id, version_number),
                    FOREIGN KEY(experiment_id) REFERENCES strategy_experiments(id)
                )
            `);
            db.run(`
                CREATE TABLE IF NOT EXISTS strategy_runs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    version_id INTEGER NOT NULL,
                    run_type TEXT NOT NULL CHECK (run_type IN ('backtest', 'out_of_sample', 'paper')),
                    evidence_domain TEXT NOT NULL DEFAULT 'trading' CHECK (evidence_domain IN ('trading', 'allocation')),
                    start_date TEXT NOT NULL,
                    end_date TEXT NOT NULL,
                    trade_count INTEGER NOT NULL CHECK (trade_count >= 0),
                    total_return_pct REAL NOT NULL,
                    benchmark_return_pct REAL NOT NULL,
                    max_drawdown_pct REAL NOT NULL CHECK (max_drawdown_pct >= 0),
                    sharpe REAL,
                    win_rate REAL,
                    expectancy REAL,
                    avg_r REAL,
                    notes TEXT,
                    created_at TEXT DEFAULT (datetime('now')),
                    FOREIGN KEY(version_id) REFERENCES strategy_versions(id)
                )
            `);
            db.run("ALTER TABLE strategy_runs ADD COLUMN evidence_domain TEXT NOT NULL DEFAULT 'trading' CHECK (evidence_domain IN ('trading', 'allocation'))", ignoreDuplicateColumnError);
            db.run('CREATE INDEX IF NOT EXISTS idx_strategy_versions_experiment ON strategy_versions(experiment_id, version_number)');
            db.run('CREATE INDEX IF NOT EXISTS idx_strategy_runs_version ON strategy_runs(version_id, id)');

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_chat_history_session
                ON chat_history(session_id, created_at DESC)
            `, async (err) => {
                if (err) {
                    db.close();
                    reject(err);
                    return;
                }

                try {
                    await new Promise((resolveClose, rejectClose) => {
                        db.close((closeError) => closeError ? rejectClose(closeError) : resolveClose());
                    });
                } catch (closeError) {
                    reject(closeError);
                    return;
                }

                if (process.env.ENABLE_LEDGER_MIGRATION === '1') {
                    try {
                        const { runMigration001 } = require('./migrations/001_portfolio_to_ledger');
                        const result = await runMigration001({ dbPath: DB_PATH });
                        if (result && result.migrated > 0) {
                            console.log(`[migration 001] migrated ${result.migrated} portfolio rows; backup at ${result.backupPath}`);
                            // Reconcile watchlist buckets for migrated symbols
                            try {
                                const txns = await listTransactions();
                                const net = {};
                                for (const t of txns) {
                                    if (!t.symbol) continue;
                                    const s = t.symbol.toUpperCase();
                                    if (t.type === 'buy') net[s] = (net[s] ?? 0) + Number(t.shares);
                                    else if (t.type === 'sell') net[s] = (net[s] ?? 0) - Number(t.shares);
                                }
                                const watchlist = await getWatchlist();
                                for (const row of watchlist) {
                                    const shares = net[row.symbol] ?? 0;
                                    await setWatchlistBucket(row.symbol, shares > 0 ? 'owned' : 'unsorted');
                                }
                                console.log('[migration 001] bucket reconciliation complete');
                            } catch (reconcileErr) {
                                console.error('[migration 001] bucket reconciliation non-fatal:', reconcileErr.message);
                            }
                        }
                    } catch (migrationError) {
                        console.error('[migration 001] FAILED:', migrationError.message);
                        reject(migrationError);
                        return;
                    }
                } else {
                    console.log('[migration 001] skipped; set ENABLE_LEDGER_MIGRATION=1 to run the portfolio -> transactions migration');
                }

                try {
                    const { runAlpacaExecutionEpochsMigration } = require('./migrations/002_alpaca_execution_epochs');
                    const epochResult = await runAlpacaExecutionEpochsMigration({ dbPath: DB_PATH });
                    if (!epochResult.skipped) {
                        console.log(`[migration 002] classified ${epochResult.migrated} legacy Alpaca paper-order rows (${epochResult.legacyLongTerm} legacy_long_term, ${epochResult.legacyUnattributed} legacy_unattributed)`);
                    }
                } catch (migrationError) {
                    console.error('[migration 002] FAILED:', migrationError.message);
                    reject(migrationError);
                    return;
                }

                // Verify the schema this build actually needs before declaring success:
                // serialized db.run fire-and-forget callbacks can swallow failures and
                // let initDb resolve over a partially migrated database. The setup
                // connection was closed above, so verify on a fresh connection.
                const REQUIRED_TABLES = ['watchlist', 'simulator_sleeves', 'sim_transactions', 'sim_reinvestment_settings', 'sim_dividends', 'sim_trade_plans'];
                const verifyDb = getDb();
                verifyDb.all(
                    `SELECT name FROM sqlite_master WHERE type = 'table'`,
                    [],
                    (tablesErr, tables) => {
                        verifyDb.close();
                        if (tablesErr) return reject(tablesErr);
                        const present = new Set((tables || []).map((row) => row.name));
                        const missing = REQUIRED_TABLES.filter((name) => !present.has(name));
                        if (missing.length > 0) {
                            return reject(new Error(`initDb failed: missing tables after initialization: ${missing.join(', ')}`));
                        }
                        console.log('Database initialized');
                        resolve();
                    },
                );
            });
        });
    });
}

function getWatchlist() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all('SELECT * FROM watchlist ORDER BY added_at DESC', [], (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows || []);
        });
    });
}

function addToWatchlist(symbol, notes = '', bucket = 'unsorted') {
    if (!VALID_BUCKETS.includes(bucket)) {
        return Promise.reject(new Error(`invalid bucket: ${bucket}`));
    }

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            'INSERT OR IGNORE INTO watchlist (symbol, notes, bucket) VALUES (?, ?, ?)',
            [symbol.toUpperCase(), notes, bucket],
            function(err) {
                sqlite.close();
                if (err) reject(err);
                else resolve({ id: this.lastID, symbol: symbol.toUpperCase() });
            }
        );
    });
}

function removeFromWatchlist(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run('DELETE FROM watchlist WHERE symbol = ?', [symbol.toUpperCase()], function(err) {
            db.close();
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

function isInWatchlist(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get('SELECT 1 FROM watchlist WHERE symbol = ?', [symbol.toUpperCase()], (err, row) => {
            db.close();
            if (err) reject(err);
            else resolve(Boolean(row));
        });
    });
}

function setWatchlistBucket(symbol, bucket) {
    if (!VALID_BUCKETS.includes(bucket)) {
        return Promise.reject(new Error(`invalid bucket: ${bucket}`));
    }

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            'UPDATE watchlist SET bucket = ? WHERE symbol = ?',
            [bucket, symbol.toUpperCase()],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ changed: this.changes });
            }
        );
    });
}

function upsertStockSnapshot(snapshot) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            `INSERT INTO stock_snapshots (
                symbol, slot, market_date, quote_timestamp, quote_timestamp_basis, retrieved_at, price, previous_close,
                change_amount, change_percent, currency, source,
                is_market_closed, is_carry_forward, raw_payload,
                open_price, day_high, fifty_two_week_high, fifty_two_week_low,
                change_from_open_percent, gap_apr22_percent,
                dist_from_52wh_percent, dist_from_52wl_percent
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, market_date, slot)
            DO UPDATE SET
                quote_timestamp=excluded.quote_timestamp,
                quote_timestamp_basis=excluded.quote_timestamp_basis,
                retrieved_at=excluded.retrieved_at,
                price=excluded.price,
                previous_close=excluded.previous_close,
                change_amount=excluded.change_amount,
                change_percent=excluded.change_percent,
                currency=excluded.currency,
                source=excluded.source,
                is_market_closed=excluded.is_market_closed,
                is_carry_forward=excluded.is_carry_forward,
                raw_payload=excluded.raw_payload,
                open_price=excluded.open_price,
                day_high=excluded.day_high,
                fifty_two_week_high=excluded.fifty_two_week_high,
                fifty_two_week_low=excluded.fifty_two_week_low,
                change_from_open_percent=excluded.change_from_open_percent,
                gap_apr22_percent=excluded.gap_apr22_percent,
                dist_from_52wh_percent=excluded.dist_from_52wh_percent,
                dist_from_52wl_percent=excluded.dist_from_52wl_percent,
                captured_at=CURRENT_TIMESTAMP`,
            [
                snapshot.symbol.toUpperCase(),
                snapshot.slot,
                snapshot.marketDate,
                snapshot.quoteTimestamp ?? null,
                snapshot.quoteTimestampBasis ?? null,
                snapshot.retrievedAt ?? null,
                snapshot.price,
                snapshot.previousClose ?? null,
                snapshot.changeAmount ?? null,
                snapshot.changePercent ?? null,
                snapshot.currency ?? 'USD',
                snapshot.source ?? 'yfinance',
                snapshot.isMarketClosed ? 1 : 0,
                snapshot.isCarryForward ? 1 : 0,
                snapshot.rawPayload ?? null,
                snapshot.openPrice ?? null,
                snapshot.dayHigh ?? null,
                snapshot.fiftyTwoWeekHigh ?? null,
                snapshot.fiftyTwoWeekLow ?? null,
                snapshot.changeFromOpenPercent ?? null,
                snapshot.gapApr22Percent ?? null,
                snapshot.distFrom52whPercent ?? null,
                snapshot.distFrom52wlPercent ?? null,
            ],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ id: this.lastID, symbol: snapshot.symbol.toUpperCase() });
            }
        );
    });
}

function getFirstStockSnapshot(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(
            `SELECT *
             FROM stock_snapshots
             WHERE symbol = ?
             ORDER BY datetime(captured_at) ASC
             LIMIT 1`,
            [symbol.toUpperCase()],
            (err, row) => {
                db.close();
                if (err) reject(err);
                else resolve(row || null);
            }
        );
    });
}

function getStockHistory(symbol, days = 30) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(
            `SELECT * FROM stock_snapshots
             WHERE symbol = ?
               AND datetime(captured_at) >= datetime('now', ?)
             ORDER BY datetime(captured_at) ASC`,
            [symbol.toUpperCase(), `-${days} days`],
            (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

function getLatestSnapshotsForWatchlist() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(
            `SELECT s.*
             FROM stock_snapshots s
             INNER JOIN (
                SELECT symbol, MAX(datetime(captured_at)) AS max_captured_at
                FROM stock_snapshots
                GROUP BY symbol
             ) latest
             ON latest.symbol = s.symbol AND datetime(latest.max_captured_at) = datetime(s.captured_at)
             ORDER BY s.symbol ASC`,
            [],
            (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

// Legacy helpers retained for tests/migration compatibility.
function getPortfolio() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all('SELECT * FROM portfolio ORDER BY symbol ASC', [], (err, rows) => {
            db.close();
            if (err) {
                if (/no such table/i.test(err.message)) return resolve([]);
                return reject(err);
            }
            resolve(rows || []);
        });
    });
}

function upsertPortfolioPosition(symbol, shares, buyPrice, buyDate, notes) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            `INSERT INTO portfolio (symbol, shares, buy_price, buy_date, notes)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(symbol) DO UPDATE SET
               shares=excluded.shares,
               buy_price=excluded.buy_price,
               buy_date=excluded.buy_date,
               notes=excluded.notes`,
            [symbol.toUpperCase(), shares, buyPrice, buyDate || null, notes || null],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ id: this.lastID, symbol: symbol.toUpperCase() });
            }
        );
    });
}

function removeFromPortfolio(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run('DELETE FROM portfolio WHERE symbol = ?', [symbol.toUpperCase()], function(err) {
            db.close();
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

function saveChatMessage(role, content, sessionId = 'default') {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            'INSERT INTO chat_history (session_id, role, content) VALUES (?, ?, ?)',
            [sessionId, role, content],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ id: this.lastID });
            }
        );
    });
}

function getChatHistory(sessionId = 'default', limit = 50) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all(
            `SELECT role, content FROM chat_history
             WHERE session_id = ?
             ORDER BY created_at ASC
             LIMIT ?`,
            [sessionId, limit],
            (err, rows) => {
                db.close();
                if (err) reject(err);
                else resolve(rows || []);
            }
        );
    });
}

function clearChatHistory(sessionId = 'default') {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run('DELETE FROM chat_history WHERE session_id = ?', [sessionId], function(err) {
            db.close();
            if (err) reject(err);
            else resolve({ deleted: this.changes });
        });
    });
}

function validateMemoFields(fields = {}) {
    if (fields.conviction !== undefined && fields.conviction !== null && fields.conviction !== '') {
        const conviction = Number(fields.conviction);
        if (!Number.isInteger(conviction) || conviction < 1 || conviction > 5) {
            throw new Error('conviction must be an integer from 1 to 5');
        }
    }

    for (const field of ['fair_value_low', 'fair_value_high', 'buy_below', 'trim_above']) {
        if (fields[field] !== undefined && fields[field] !== null && fields[field] !== '') {
            const numeric = Number(fields[field]);
            if (!Number.isFinite(numeric) || numeric < 0) {
                throw new Error(`${field} must be a non-negative number`);
            }
        }
    }
}

function upsertMemo(symbol, fields) {
    try {
        validateMemoFields(fields);
    } catch (err) {
        return Promise.reject(err);
    }

    const cols = MEMO_FIELDS;
    const values = cols.map((col) => fields[col] ?? null);
    const updateSql = cols.map((col) => `${col}=excluded.${col}`).join(',\n               ');
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO stock_memos (symbol, ${cols.join(',')}, updated_at)
             VALUES (?, ${cols.map(() => '?').join(',')}, CURRENT_TIMESTAMP)
             ON CONFLICT(symbol) DO UPDATE SET
               ${updateSql},
               updated_at=CURRENT_TIMESTAMP`,
            [symbol.toUpperCase(), ...values],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ symbol: symbol.toUpperCase() });
            }
        );
    });
}

function getMemo(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM stock_memos WHERE symbol = ?', [symbol.toUpperCase()], (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

function listMemos() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all('SELECT * FROM stock_memos ORDER BY updated_at DESC', [], (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function markMemoReviewed(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            'UPDATE stock_memos SET last_reviewed_at = CURRENT_TIMESTAMP WHERE symbol = ?',
            [symbol.toUpperCase()],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ changed: this.changes });
            }
        );
    });
}

function deleteMemo(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run('DELETE FROM stock_memos WHERE symbol = ?', [symbol.toUpperCase()], function(err) {
            sqlite.close();
            err ? reject(err) : resolve({ deleted: this.changes });
        });
    });
}

function getRiskRules() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM risk_rules WHERE id = 1', [], (err, row) => {
            sqlite.close();
            if (err) return reject(err);
            if (!row) {
                return resolve({
                    id: 1,
                    max_position_pct: 10,
                    max_sector_pct: 30,
                    max_risk_per_trade_pct: 1,
                    target_cash_pct: 20,
                });
            }
            resolve(row);
        });
    });
}

function setRiskRules(fields) {
    const updates = [];
    const values = [];

    for (const field of RULE_FIELDS) {
        if (fields[field] !== undefined) {
            const numeric = Number(fields[field]);
            if (!Number.isFinite(numeric) || numeric < 0) {
                return Promise.reject(new Error(`invalid value for ${field}: ${fields[field]}`));
            }
            updates.push(`${field} = ?`);
            values.push(numeric);
        }
    }

    if (updates.length === 0) {
        return Promise.resolve({ changed: 0 });
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `UPDATE risk_rules SET ${updates.join(', ')} WHERE id = 1`,
            values,
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ changed: this.changes });
            }
        );
    });
}

function setPositionStop(symbol, stopLoss) {
    const numeric = Number(stopLoss);
    if (!Number.isFinite(numeric) || numeric <= 0) {
        return Promise.reject(new Error(`invalid stop_loss: ${stopLoss}`));
    }

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO position_stops (symbol, stop_loss, updated_at)
             VALUES (?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(symbol) DO UPDATE SET
               stop_loss = excluded.stop_loss,
               updated_at = CURRENT_TIMESTAMP`,
            [symbol.toUpperCase(), numeric],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ symbol: symbol.toUpperCase(), stop_loss: numeric });
            }
        );
    });
}

function getPositionStop(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM position_stops WHERE symbol = ?', [symbol.toUpperCase()], (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

function listPositionStops() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all('SELECT * FROM position_stops ORDER BY symbol ASC', [], (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function deletePositionStop(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run('DELETE FROM position_stops WHERE symbol = ?', [symbol.toUpperCase()], function(err) {
            sqlite.close();
            err ? reject(err) : resolve({ deleted: this.changes });
        });
    });
}

function validateTransaction(txn) {
    if (!txn || typeof txn !== 'object') throw new Error('transaction object required');

    const { type, symbol, shares, price, amount, fees, txn_date: txnDate } = txn;

    if (!VALID_TXN_TYPES.includes(type)) throw new Error(`invalid type: ${type}`);
    if (!txnDate || !DATE_RE.test(txnDate)) throw new Error('txn_date required as YYYY-MM-DD');

    if (type === 'buy' || type === 'sell') {
        const shareCount = Number(shares);
        const tradePrice = Number(price);
        if (!symbol || typeof symbol !== 'string') throw new Error('symbol required for trades');
        if (!Number.isFinite(shareCount) || shareCount <= 0) throw new Error('shares must be > 0');
        if (!Number.isFinite(tradePrice) || tradePrice <= 0) throw new Error('price must be > 0');
    }

    if (type === 'dividend') {
        const cashAmount = Number(amount);
        if (!symbol || typeof symbol !== 'string') throw new Error('symbol required for dividend');
        if (!Number.isFinite(cashAmount) || cashAmount <= 0) throw new Error('amount must be > 0');
    }

    if (type === 'deposit' || type === 'withdrawal') {
        const cashAmount = Number(amount);
        if (!Number.isFinite(cashAmount) || cashAmount <= 0) throw new Error('amount must be > 0');
    }

    if (fees !== undefined && fees !== null) {
        const feeAmount = Number(fees);
        if (!Number.isFinite(feeAmount) || feeAmount < 0) throw new Error('fees must be >= 0');
    }
}

function addTransaction(txn) {
    return new Promise((resolve, reject) => {
        try {
            validateTransaction(txn);
        } catch (err) {
            reject(err);
            return;
        }

        const { type, symbol = null, shares = null, price = null, txn_date: txnDate, notes = null } = txn;
        const fees = Number(txn.fees ?? 0);

        let amount;
        if (type === 'buy' || type === 'sell') {
            amount = Number(shares) * Number(price);
        } else {
            amount = Number(txn.amount);
        }

        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO transactions (symbol, type, shares, price, amount, fees, txn_date, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [symbol ? symbol.toUpperCase() : null, type, shares, price, amount, fees, txnDate, notes],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ id: this.lastID, symbol: symbol ? symbol.toUpperCase() : null, type });
            }
        );
    });
}

function listTransactions({ symbol, type, from, to, limit } = {}) {
    const where = [];
    const args = [];

    if (symbol) {
        where.push('symbol = ?');
        args.push(symbol.toUpperCase());
    }
    if (type) {
        where.push('type = ?');
        args.push(type);
    }
    if (from) {
        where.push('txn_date >= ?');
        args.push(from);
    }
    if (to) {
        where.push('txn_date <= ?');
        args.push(to);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limitSql = limit ? `LIMIT ${Number(limit)}` : '';

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(
            `SELECT * FROM transactions ${whereSql} ORDER BY txn_date DESC, id DESC ${limitSql}`,
            args,
            (err, rows) => {
                sqlite.close();
                err ? reject(err) : resolve(rows || []);
            }
        );
    });
}

function getTransactionById(id) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM transactions WHERE id = ?', [Number(id)], (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

function deleteTransaction(id) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run('DELETE FROM transactions WHERE id = ?', [Number(id)], function(err) {
            sqlite.close();
            err ? reject(err) : resolve({ deleted: this.changes });
        });
    });
}

function listSimAccounts() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(`SELECT s.*,
                           COALESCE(r.dividend_reinvestment_mode, CASE WHEN s.id = 1 THEN 'drip' ELSE 'cash' END) AS dividend_reinvestment_mode,
                           COALESCE(r.profit_reinvestment_mode, CASE WHEN s.id = 1 THEN 'redeploy_excess' ELSE 'hold_cash' END) AS profit_reinvestment_mode,
                           COALESCE(r.target_cash_pct, 10) AS target_cash_pct
                    FROM simulator_sleeves s
                    LEFT JOIN sim_reinvestment_settings r ON r.account_id = s.id
                    ORDER BY s.id ASC`, [], (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function getSimAccount(accountId = 1) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get(`SELECT s.*,
                           COALESCE(r.dividend_reinvestment_mode, CASE WHEN s.id = 1 THEN 'drip' ELSE 'cash' END) AS dividend_reinvestment_mode,
                           COALESCE(r.profit_reinvestment_mode, CASE WHEN s.id = 1 THEN 'redeploy_excess' ELSE 'hold_cash' END) AS profit_reinvestment_mode,
                           COALESCE(r.target_cash_pct, 10) AS target_cash_pct
                    FROM simulator_sleeves s
                    LEFT JOIN sim_reinvestment_settings r ON r.account_id = s.id
                    WHERE s.id = ?`, [Number(accountId)], (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

function setSimReinvestmentSettings(settings, accountId = 1) {
    const dividendMode = settings.dividend_reinvestment_mode;
    const profitMode = settings.profit_reinvestment_mode;
    const targetCashPct = settings.target_cash_pct == null ? null : Number(settings.target_cash_pct);
    const hasDividend = dividendMode !== undefined;
    const hasProfit = profitMode !== undefined;
    const hasTarget = targetCashPct !== null;
    if (!hasDividend && !hasProfit && !hasTarget) {
        return Promise.reject(new Error('at least one reinvestment setting is required'));
    }
    if (hasDividend && !['cash', 'drip'].includes(dividendMode)) {
        return Promise.reject(new Error('invalid dividend reinvestment mode'));
    }
    if (hasProfit && !['hold_cash', 'redeploy_excess'].includes(profitMode)) {
        return Promise.reject(new Error('invalid profit reinvestment mode'));
    }
    if (hasTarget && (!Number.isFinite(targetCashPct) || targetCashPct < 0 || targetCashPct > 100)) {
        return Promise.reject(new Error('target_cash_pct must be between 0 and 100'));
    }
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.serialize(() => {
            sqlite.run('BEGIN IMMEDIATE', (beginErr) => {
                if (beginErr) {
                    sqlite.close();
                    return reject(beginErr);
                }
                // Field-specific update: omitted fields keep their stored values, so
                // concurrent partial PATCHes cannot overwrite each other. The insert
                // branch must supply full safe defaults because excluded.* carries the
                // resolved insert tuple (defaults included), not the caller's NULLs —
                // COALESCE(excluded.x, stored.x) inside DO UPDATE would therefore push
                // insert-time defaults over live settings on every later partial patch.
                sqlite.run(
                    `INSERT INTO sim_reinvestment_settings
                     (account_id, dividend_reinvestment_mode, profit_reinvestment_mode, target_cash_pct)
                     VALUES (?, ?, ?, ?)
                     ON CONFLICT(account_id) DO UPDATE SET
                         dividend_reinvestment_mode = CASE WHEN ? = 1 THEN ? ELSE sim_reinvestment_settings.dividend_reinvestment_mode END,
                         profit_reinvestment_mode = CASE WHEN ? = 1 THEN ? ELSE sim_reinvestment_settings.profit_reinvestment_mode END,
                         target_cash_pct = CASE WHEN ? = 1 THEN ? ELSE sim_reinvestment_settings.target_cash_pct END,
                         updated_at = datetime('now')`,
                    [
                        Number(accountId),
                        hasDividend ? dividendMode : (Number(accountId) === 1 ? 'drip' : 'cash'),
                        hasProfit ? profitMode : (Number(accountId) === 1 ? 'redeploy_excess' : 'hold_cash'),
                        hasTarget ? targetCashPct : 10,
                        hasDividend ? 1 : 0, hasDividend ? dividendMode : null,
                        hasProfit ? 1 : 0, hasProfit ? profitMode : null,
                        hasTarget ? 1 : 0, hasTarget ? targetCashPct : null,
                    ],
                    function(err) {
                        if (err) {
                            return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(err); });
                        }
                        sqlite.get(
                            'SELECT account_id, dividend_reinvestment_mode, profit_reinvestment_mode, target_cash_pct FROM sim_reinvestment_settings WHERE account_id = ?',
                            [Number(accountId)],
                            (readErr, row) => {
                                if (readErr) {
                                    return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(readErr); });
                                }
                                sqlite.run('COMMIT', (commitErr) => {
                                    if (commitErr) {
                                        sqlite.close();
                                        return reject(commitErr);
                                    }
                                    sqlite.close();
                                    resolve({ ...row, changed: this.changes });
                                });
                            },
                        );
                    },
                );
            });
        });
    });
}

function setSimTaxBracket(bracket, accountId = 1) {
    const valid = [10, 12, 22, 24, 32, 35, 37];
    if (!valid.includes(Number(bracket))) {
        return Promise.reject(new Error(`invalid tax bracket: ${bracket}`));
    }
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run('UPDATE simulator_sleeves SET tax_bracket = ? WHERE id = ?', [Number(bracket), Number(accountId)], function(err) {
            sqlite.close();
            err ? reject(err) : resolve({ tax_bracket: Number(bracket), changed: this.changes });
        });
    });
}

function addSimTransaction(txn) {
    if (txn && ['buy', 'sell'].includes(txn.type)) return recordSimTradeAtomic({ transaction: txn });
    let normalized;
    try {
        normalized = normalizeSimTransaction(txn);
    } catch (err) {
        return Promise.reject(err);
    }
    const { account_id: accountId, symbol, type, amount } = normalized;
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO sim_transactions (account_id, symbol, type, shares, price, amount, fees, txn_date, notes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [accountId, symbol, type, normalized.shares, normalized.price, amount, normalized.fees, normalized.txn_date, normalized.notes],
            function(err) {
                sqlite.close();
                err ? reject(err) : resolve({ id: this.lastID, account_id: accountId, symbol, type, amount });
            }
        );
    });
}

function listSimTradePlans(accountId = 1, status = null) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        const where = status ? 'WHERE account_id = ? AND status = ?' : 'WHERE account_id = ?';
        const params = status ? [Number(accountId), status] : [Number(accountId)];
        sqlite.all(`SELECT * FROM sim_trade_plans ${where} ORDER BY id DESC`, params, (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function getActiveSimTradePlan(accountId, symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get(
            "SELECT * FROM sim_trade_plans WHERE account_id = ? AND symbol = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
            [Number(accountId), String(symbol).toUpperCase()],
            (err, row) => {
                sqlite.close();
                err ? reject(err) : resolve(row || null);
            },
        );
    });
}

function addSimTransactionWithPlan(txn, plan) {
    return recordSimTradeAtomic({ transaction: txn, trade_plan: plan });
}

function addSimTransactionAndCloseTradePlan(txn, planId, closure) {
    // Only journal annotations are accepted; economics are rebuilt under lock.
    return recordSimTradeAtomic({ transaction: txn, close_plan_id: planId, closure });
}

function recordSimDividend(dividend) {
    const accountId = Number(dividend.account_id ?? 1);
    const symbol = String(dividend.symbol || '').trim().toUpperCase();
    const amount = Number(dividend.amount);
    const txnDate = String(dividend.txn_date || '');
    const key = String(dividend.idempotency_key || '').trim();
    const mode = dividend.reinvestment_mode;
    const price = dividend.reinvestment_price == null ? null : Number(dividend.reinvestment_price);
    if (!symbol || !Number.isFinite(amount) || amount <= 0 || !DATE_RE.test(txnDate) || !key || key.length > 200) {
        return Promise.reject(new Error('invalid simulator dividend'));
    }
    if (!['cash', 'drip'].includes(mode) || (mode === 'drip' && (!Number.isFinite(price) || price <= 0))) {
        return Promise.reject(new Error('invalid simulator dividend reinvestment'));
    }
    const reinvestedShares = mode === 'drip' ? amount / price : null;

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        let finished = false;
        const fail = (error) => {
            if (finished) return;
            finished = true;
            sqlite.run('ROLLBACK', () => { sqlite.close(); reject(error); });
        };
        sqlite.serialize(() => {
            sqlite.run('BEGIN IMMEDIATE', (beginErr) => {
                if (beginErr) return fail(beginErr);
            // Re-read the sleeve policy inside the write transaction: a concurrent
            // settings save must not leave this dividend applying a stale mode.
            sqlite.get(
                'SELECT dividend_reinvestment_mode FROM sim_reinvestment_settings WHERE account_id = ?',
                [accountId],
                (policyErr, policyRow) => {
                    if (policyErr) return fail(policyErr);
                    const effectiveMode = policyRow ? policyRow.dividend_reinvestment_mode : mode;
                    if (!['cash', 'drip'].includes(effectiveMode)) {
                        return fail(new Error('invalid simulator dividend reinvestment'));
                    }
                    if (effectiveMode === 'drip' && !(Number.isFinite(price) && price > 0)) {
                        return fail(Object.assign(new Error('dividend reinvestment price is required for DRIP mode'), { code: 'SIM_DIVIDEND_PRICE_REQUIRED' }));
                    }
                    const dripShares = effectiveMode === 'drip' ? amount / price : null;
            sqlite.run(
                `INSERT INTO sim_dividends
                 (account_id, symbol, amount, txn_date, idempotency_key, reinvestment_mode,
                  reinvestment_price, reinvested_shares, notes)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [accountId, symbol, amount, txnDate, key, effectiveMode, effectiveMode === 'drip' ? price : null, dripShares, dividend.notes ?? null],
                function(dividendErr) {
                    if (dividendErr) {
                        if (/UNIQUE constraint failed: sim_dividends\.account_id, sim_dividends\.idempotency_key/i.test(dividendErr.message)) {
                            dividendErr.code = 'DUPLICATE_SIM_DIVIDEND';
                        }
                        return fail(dividendErr);
                    }
                    const dividendId = this.lastID;
                    if (effectiveMode === 'cash') {
                        return sqlite.run('COMMIT', (commitErr) => {
                            if (commitErr) return fail(commitErr);
                            finished = true;
                            sqlite.close();
                            resolve({ id: dividendId, account_id: accountId, symbol, amount, mode: effectiveMode, reinvested_shares: null });
                        });
                    }

                    sqlite.run(
                        `INSERT INTO sim_transactions
                         (account_id, symbol, type, shares, price, amount, fees, txn_date, notes)
                         VALUES (?, ?, 'buy', ?, ?, ?, 0, ?, ?)`,
                        [accountId, symbol, dripShares, price, amount, txnDate, `DRIP ${key}: reinvested $${amount}`],
                        function(buyErr) {
                            if (buyErr) return fail(buyErr);
                            const transactionId = this.lastID;
                            sqlite.run(
                                'UPDATE sim_dividends SET drip_transaction_id = ? WHERE id = ?',
                                [transactionId, dividendId],
                                (updateErr) => {
                                    if (updateErr) return fail(updateErr);
                                    sqlite.run('COMMIT', (commitErr) => {
                                        if (commitErr) return fail(commitErr);
                                        finished = true;
                                        sqlite.close();
                                        resolve({ id: dividendId, account_id: accountId, symbol, amount, mode: effectiveMode, reinvested_shares: dripShares, drip_transaction_id: transactionId });
                                    });
                                },
                            );
                        },
                    );
                },
            );
                });
            });
        });
    });
}

function listSimTransactions(accountId = 1) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(
            `SELECT id, account_id, symbol, type, shares, price, amount, fees, txn_date, notes,
                    created_at, NULL AS idempotency_key, NULL AS reinvestment_mode,
                    NULL AS reinvested_shares, NULL AS drip_transaction_id
             FROM sim_transactions WHERE account_id = ?
             UNION ALL
             SELECT 1000000000000 + id AS id, account_id, symbol, 'dividend' AS type, NULL AS shares,
                    reinvestment_price AS price, amount, 0 AS fees, txn_date, notes, created_at,
                    idempotency_key, reinvestment_mode, reinvested_shares, drip_transaction_id
             FROM sim_dividends WHERE account_id = ?
             ORDER BY txn_date ASC, id ASC`,
            [Number(accountId), Number(accountId)],
            (err, rows) => {
                sqlite.close();
                err ? reject(err) : resolve(rows || []);
            }
        );
    });
}

// Canonical intention hash: stable JSON key ordering over the caller's intent
// object, so semantically identical intents replay identically regardless of
// property order, and any semantic difference conflicts.
function canonicalIntentHash(intent) {
    if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) {
        throw Object.assign(new Error('intent must be a plain object'), { code: 'SIM_INVALID_INTENT' });
    }
    const sorted = Object.keys(intent)
        .sort()
        .map((key) => {
            const value = intent[key];
            if (value !== null && typeof value === 'object') return JSON.stringify([key, canonicalIntentHash(value)]);
            return JSON.stringify([key, value]);
        });
    return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function simOrderError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Fractional-share tolerance the routes already use for "fully closed".
const SIM_SHARE_TOLERANCE = 0.000001;

function computeSimLedgerSnapshot(rows) {
    let cash = 0;
    const shares = {};
    for (const row of rows) {
        const amount = Number(row.amount ?? 0);
        const fees = Number(row.fees ?? 0);
        if (row.type === 'deposit') cash += amount - fees;
        else if (row.type === 'withdrawal') cash -= amount - fees;
        else if (row.type === 'buy') {
            cash -= amount + fees;
            shares[row.symbol] = (shares[row.symbol] || 0) + Number(row.shares ?? 0);
        } else if (row.type === 'sell') {
            cash += amount - fees;
            shares[row.symbol] = (shares[row.symbol] || 0) - Number(row.shares ?? 0);
        } else if (row.type === 'dividend') cash += amount - fees;
    }
    return { cash, shares };
}

function loadSimLedgerRows(sqlite, accountId) {
    return new Promise((resolve, reject) => {
        // Cash-mode dividends are spendable cash exactly like the displayed
        // ledger: the locked snapshot must union them in or dividend-funded
        // buys get rejected with cash the UI already shows.
        sqlite.all(
            `SELECT id, account_id, symbol, type, shares, price, amount, fees, txn_date FROM sim_transactions WHERE account_id = ?
             UNION ALL
             SELECT 1000000000000 + id AS id, account_id, symbol, 'dividend' AS type, NULL AS shares,
                    reinvestment_price AS price, amount, 0 AS fees, txn_date
             FROM sim_dividends WHERE account_id = ? AND reinvestment_mode = 'cash'
             ORDER BY txn_date ASC, id ASC`,
            [Number(accountId), Number(accountId)],
            (err, rows) => (err ? reject(err) : resolve(rows || [])),
        );
    });
}

/**
 * Atomically execute a simulator trade with idempotency.
 *
 * order = {
 *   transaction,           // sim transaction payload (account_id, type buy/sell, symbol, shares, price, fees, txn_date, notes)
 *   client_order_id,       // unique per account: idempotency key
 *   intent,                // plain object describing the intended order; hashed canonically
 *   quote,                 // optional quote provenance { symbol, price, source, quote_timestamp, ... }
 *   trade_plan,            // optional normalized plan (buy on day sleeve): created in the same transaction
 *   close_plan_id,         // optional plan id closed by this sell (full close)
 *   closure,               // optional closure payload for close_plan_id
 *   on_partial_close,      // optional callback(plan, txns, sqlite) invoked under lock for a partial sell
 * }
 *
 * Returns the stored result (identical for replays of the same intent).
 * Throws coded errors: SIM_INVALID_TRANSACTION, SIM_INVALID_INTENT, SIM_INVALID_ORDER,
 * SIM_ORDER_CONFLICT, SIM_INSUFFICIENT_CASH, SIM_INSUFFICIENT_SHARES, SIM_PLAN_REQUIRED.
 * Deposits/withdrawals are not supported here; use addSimTransaction.
 */
function executeSimTradeAtomic(order = {}) {
    return persistSimTradeAtomic(order, false);
}

// Manual fills share the lock/resource/plan machinery, never the evaluated
// order ledger. This is provenance separation, not operator authorization.
function recordSimTradeAtomic(order = {}) {
    return persistSimTradeAtomic(order, true);
}

function persistSimTradeAtomic(order = {}, manual = false) {
    return Promise.resolve().then(() => {
        const clientOrderId = manual ? null : (order.client_order_id == null ? null : String(order.client_order_id).trim());
        if (!manual && (!clientOrderId || clientOrderId.length > 200)) {
            throw simOrderError('SIM_INVALID_ORDER', 'client_order_id is required (1-200 chars)');
        }
        if (!order.transaction || !['buy', 'sell'].includes(order.transaction.type)) {
            throw simOrderError('SIM_INVALID_ORDER', 'transaction must be a buy or sell');
        }
        const normalized = normalizeSimTransaction(order.transaction);
        if (order.close_plan_id != null && normalized.type !== 'sell') {
            throw simOrderError('SIM_INVALID_ORDER', 'close_plan_id requires a sell');
        }
        const intentHash = manual ? null : canonicalIntentHash(order.intent);
        const accountId = normalized.account_id;
        const fill_date = normalized.txn_date;
        const fill_time = new Date().toISOString().slice(11, 19);

        return new Promise((resolve, reject) => {
            const sqlite = getDb();
            let finished = false;
            const fail = (error) => {
                if (finished) return;
                finished = true;
                sqlite.run('ROLLBACK', () => { sqlite.close(); reject(error); });
            };
            sqlite.serialize(() => {
                sqlite.run('BEGIN IMMEDIATE', (beginErr) => {
                    if (beginErr) return fail(beginErr);
                    // Idempotency: exact prior result returned before any validation,
                    // resource check, or quote/plan mutation.
                    sqlite.get(
                        'SELECT * FROM sim_orders WHERE account_id = ? AND client_order_id = ?',
                        [accountId, clientOrderId],
                        (lookupErr, existing) => {
                            if (lookupErr) return fail(lookupErr);
                            if (existing) {
                                if (existing.intent_hash !== intentHash) {
                                    return fail(simOrderError('SIM_ORDER_CONFLICT',
                                        `client_order_id ${clientOrderId} already used with a different intent`));
                                }
                                return sqlite.run('COMMIT', (commitErr) => {
                                    if (commitErr) return fail(commitErr);
                                    finished = true;
                                    sqlite.close();
                                    resolve(JSON.parse(existing.result_json));
                                });
                            }
                            loadSimLedgerRows(sqlite, accountId).then((rows) => {
                                const snapshot = computeSimLedgerSnapshot(rows);
                                const cost = normalized.amount + normalized.fees;
                                if (normalized.type === 'buy' && snapshot.cash + SIM_SHARE_TOLERANCE < cost) {
                                    return fail(simOrderError('SIM_INSUFFICIENT_CASH',
                                        `insufficient cash: have ${snapshot.cash.toFixed(2)}, need ${cost.toFixed(2)}`));
                                }
                                const owned = snapshot.shares[normalized.symbol] || 0;
                                if (normalized.type === 'sell' && normalized.shares > owned + SIM_SHARE_TOLERANCE) {
                                    return fail(simOrderError('SIM_INSUFFICIENT_SHARES',
                                        `insufficient shares: own ${owned}, tried to sell ${normalized.shares}`));
                                }

                                const insertTxn = () => new Promise((res, rej) => {
                                    sqlite.run(
                                        `INSERT INTO sim_transactions (account_id, symbol, type, shares, price, amount, fees, txn_date, notes)
                                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [accountId, normalized.symbol, normalized.type, normalized.shares, normalized.price,
                                            normalized.amount, normalized.fees, normalized.txn_date, normalized.notes],
                                        function(err) { err ? rej(err) : res(this.lastID); },
                                    );
                                });
                                const insertPlan = (transactionId) => new Promise((res, rej) => {
                                    const plan = normalizedPlan;
                                    sqlite.run(
                                        `INSERT INTO sim_trade_plans
                                         (account_id, symbol, setup, catalyst, thesis, invalidation, entry_transaction_id,
                                          shares, planned_entry, stop_price, target_price, planned_risk)
                                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [accountId, normalized.symbol, plan.setup, plan.catalyst, plan.thesis, plan.invalidation,
                                            transactionId, plan.shares, plan.planned_entry, plan.stop_price, plan.target_price, plan.planned_risk],
                                        function(err) { err ? rej(err) : res(this.lastID); },
                                    );
                                });
                                const closePlan = (transactionId, active) => new Promise((res, rej) => {
                                    const journal = order.closure || (manual ? {
                                        exit_reason: normalized.price <= Number(active.stop_price) ? 'stop'
                                            : (normalized.price >= Number(active.target_price) ? 'target' : 'discretionary'),
                                        review_notes: 'Auto-closed from a full simulator exit; thesis validity was not supplied.',
                                    } : {});
                                    const closure = closeStructuredTrade(active, {
                                        exit_reason: journal.exit_reason ?? 'discretionary',
                                        thesis_valid: journal.thesis_valid ?? null,
                                        mfe: journal.mfe, mae: journal.mae, review_notes: journal.review_notes,
                                        exit_transaction_id: transactionId, exit_price: normalized.price,
                                        shares: normalized.shares, exit_shares: normalized.shares, fees: normalized.fees,
                                    }, [...rows, { ...normalized, id: transactionId }]);
                                    sqlite.run(
                                        `UPDATE sim_trade_plans
                                         SET status = 'closed', exit_transaction_id = ?, exit_reason = ?, thesis_valid = ?,
                                             exit_price = ?, exit_shares = ?, exit_cost_basis = ?, realized_pnl = ?, realized_r = ?, mfe = ?, mae = ?, review_notes = ?,
                                             closed_at = datetime('now')
                                         WHERE id = ? AND account_id = ? AND status = 'active'`,
                                        [transactionId, closure.exit_reason, closure.thesis_valid == null ? null : (closure.thesis_valid ? 1 : 0),
                                            closure.exit_price, closure.exit_shares, closure.exit_cost_basis,
                                            closure.realized_pnl, closure.realized_r, closure.mfe, closure.mae, closure.review_notes,
                                            active.id, accountId],
                                        function(err) {
                                            if (err) return rej(err);
                                            if (this.changes !== 1) return rej(simOrderError('SIM_PLAN_REQUIRED', 'active trade plan was not found'));
                                            res(active.id);
                                        },
                                    );
                                });
                                const loadActivePlan = () => new Promise((res, rej) => {
                                    sqlite.get(
                                        "SELECT * FROM sim_trade_plans WHERE account_id = ? AND symbol = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
                                        [accountId, normalized.symbol],
                                        (err, row) => (err ? rej(err) : res(row || null)),
                                    );
                                });

                                let transactionId;
                                let normalizedPlan;
                                const runPlanFlow = new Promise((res, rej) => sqlite.get(
                                    'SELECT * FROM simulator_sleeves WHERE id = ?', [accountId],
                                    (err, account) => err ? rej(err) : res(account),
                                )).then(async (account) => {
                                    if (!account) throw simOrderError('SIM_INVALID_ORDER', 'simulator account not found');
                                    if (normalized.type === 'buy') {
                                        if (!manual && account.slug === 'day-trading' && !order.trade_plan) {
                                            throw simOrderError('SIM_PLAN_REQUIRED', 'day-trading buys require a structured trade plan');
                                        }
                                        const active = await loadActivePlan();
                                        if (active) throw simOrderError('SIM_PLAN_REQUIRED', `${normalized.symbol} already has an active structured trade plan`);
                                        if (order.trade_plan) normalizedPlan = normalizeTradePlan({
                                            ...order.trade_plan, account_id: accountId, symbol: normalized.symbol,
                                            shares: normalized.shares, planned_entry: normalized.price,
                                        });
                                    }
                                    if (manual && order.closure != null) {
                                        const active = await loadActivePlan();
                                        if (normalized.type !== 'sell' || !active || owned - normalized.shares > SIM_SHARE_TOLERANCE) {
                                            throw simOrderError('SIM_PLAN_REQUIRED', 'structured exit review requires a full exit of an active structured trade plan');
                                        }
                                    }
                                    if (normalized.type === 'sell' && order.close_plan_id != null) {
                                        const active = await loadActivePlan();
                                        if (!active || active.id !== Number(order.close_plan_id)) {
                                            throw simOrderError('SIM_PLAN_REQUIRED', 'close_plan_id must match the active plan for this account and symbol');
                                        }
                                        if (owned - normalized.shares > SIM_SHARE_TOLERANCE) {
                                            throw simOrderError('SIM_PLAN_REQUIRED', 'cannot close an active plan with a partial exit');
                                        }
                                    }
                                    return insertTxn();
                                }).then((txnId) => {
                                    transactionId = txnId;
                                    if (normalized.type === 'buy' && order.trade_plan) return loadActivePlan().then((active) => {
                                        if (active) throw simOrderError('SIM_PLAN_REQUIRED', `${normalized.symbol} already has an active structured trade plan`);
                                        return insertPlan(txnId);
                                    });
                                    return loadActivePlan().then((active) => {
                                        if (normalized.type === 'sell' && active && owned - normalized.shares <= SIM_SHARE_TOLERANCE) {
                                            return closePlan(txnId, active);
                                        }
                                        return null;
                                    });
                                });
                                runPlanFlow.then((resolvedPlanId) => {
                                    const planIdFinal = resolvedPlanId;
                                    const result = {
                                        id: transactionId,
                                        account_id: accountId,
                                        symbol: normalized.symbol,
                                        type: normalized.type,
                                        amount: normalized.amount,
                                        price: normalized.price,
                                        shares: normalized.shares,
                                        fees: normalized.fees,
                                        client_order_id: clientOrderId,
                                        intent_hash: intentHash,
                                        fill_date,
                                        fill_time,
                                    };
                                    if (planIdFinal != null) result.trade_plan_id = planIdFinal;
                                    if (manual) {
                                        delete result.client_order_id;
                                        delete result.intent_hash;
                                        result.source = 'operator-manual';
                                        result.evaluated = false;
                                        return sqlite.run('COMMIT', (commitErr) => {
                                            if (commitErr) return fail(commitErr);
                                            finished = true;
                                            sqlite.close();
                                            resolve(result);
                                        });
                                    }
                                    sqlite.run(
                                        `INSERT INTO sim_orders (account_id, client_order_id, intent_hash, transaction_id, result_json, quote_json, fill_date, fill_time)
                                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                                        [accountId, clientOrderId, intentHash, transactionId, JSON.stringify(result),
                                            order.quote == null ? null : JSON.stringify(order.quote), fill_date, fill_time],
                                        (orderErr) => {
                                            if (orderErr) return fail(orderErr);
                                            sqlite.run('COMMIT', (commitErr) => {
                                                if (commitErr) return fail(commitErr);
                                                finished = true;
                                                sqlite.close();
                                                resolve(result);
                                            });
                                        },
                                    );
                                }, fail);
                            }).catch(fail);
                        },
                    );
                });
            });
        });
    });
}

/**
 * Look up a persisted simulator order by account + client_order_id.
 * Returns null when absent, otherwise { id, account_id, client_order_id, intent_hash,
 * transaction_id, result, quote, fill_date, fill_time, created_at }.
 */
function getSimOrder(accountId, clientOrderId) {
    const key = String(clientOrderId == null ? '' : clientOrderId).trim();
    if (!key) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get(
            'SELECT * FROM sim_orders WHERE account_id = ? AND client_order_id = ?',
            [Number(accountId), key],
            (err, row) => {
                sqlite.close();
                if (err) return reject(err);
                if (!row) return resolve(null);
                resolve({
                    id: row.id,
                    account_id: row.account_id,
                    client_order_id: row.client_order_id,
                    intent_hash: row.intent_hash,
                    transaction_id: row.transaction_id,
                    result: JSON.parse(row.result_json),
                    quote: row.quote_json ? JSON.parse(row.quote_json) : null,
                    fill_date: row.fill_date,
                    fill_time: row.fill_time,
                    created_at: row.created_at,
                });
            },
        );
    });
}

/** Find evaluated orders whose intent hash matches (retry-before-quote support). */
function findSimOrdersByIntentHash(intent, accountId = null) {
    let hash;
    try {
        hash = canonicalIntentHash(intent);
    } catch (err) {
        return Promise.reject(err);
    }
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        const where = accountId == null ? 'WHERE intent_hash = ?' : 'WHERE intent_hash = ? AND account_id = ?';
        const params = accountId == null ? [hash] : [hash, Number(accountId)];
        sqlite.all(`SELECT * FROM sim_orders ${where} ORDER BY id DESC`, params, (err, rows) => {
            sqlite.close();
            if (err) return reject(err);
            resolve((rows || []).map((row) => ({
                id: row.id,
                account_id: row.account_id,
                client_order_id: row.client_order_id,
                intent_hash: row.intent_hash,
                transaction_id: row.transaction_id,
                result: JSON.parse(row.result_json),
                fill_date: row.fill_date,
                fill_time: row.fill_time,
            })));
        });
    });
}


function deleteAllSimTransactions(accountId = 1) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        const id = Number(accountId);
        sqlite.serialize(() => {
            sqlite.run('BEGIN IMMEDIATE');
            sqlite.run('DELETE FROM sim_dividends WHERE account_id = ?', [id], function(dividendErr) {
                if (dividendErr) return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(dividendErr); });
                sqlite.run('DELETE FROM sim_trade_plans WHERE account_id = ?', [id], function(planErr) {
                    if (planErr) return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(planErr); });
                    sqlite.run('DELETE FROM sim_orders WHERE account_id = ?', [id], function(orderErr) {
                        if (orderErr) return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(orderErr); });
                        sqlite.run('DELETE FROM sim_transactions WHERE account_id = ?', [id], function(txnErr) {
                            if (txnErr) return sqlite.run('ROLLBACK', () => { sqlite.close(); reject(txnErr); });
                            const deleted = this.changes;
                            sqlite.run('COMMIT', (commitErr) => {
                                sqlite.close();
                                commitErr ? reject(commitErr) : resolve({ deleted });
                            });
                        });
                    });
                });
            });
        });
    });
}

function normalizeAlpacaPaperOrderAudit(order) {
    const normalized = {
        idempotency_key: String(order.idempotency_key || '').trim(),
        client_order_id: order.client_order_id == null ? null : (String(order.client_order_id).trim() || null),
        symbol: String(order.symbol || '').trim().toUpperCase(),
        side: order.side,
        qty: Number(order.qty),
        order_type: order.order_type,
        time_in_force: order.time_in_force,
        limit_price: order.limit_price == null ? null : Number(order.limit_price),
        stop_price: order.stop_price == null ? null : Number(order.stop_price),
        take_profit_price: order.take_profit_price == null ? null : Number(order.take_profit_price),
        status: order.status,
        execution_epoch: order.execution_epoch || 'legacy_unattributed',
        order_class: order.order_class || 'simple',
        leg_role: order.leg_role || null,
        parent_broker_order_id: order.parent_broker_order_id == null ? null : String(order.parent_broker_order_id),
        plan_id: order.plan_id == null ? null : Number(order.plan_id),
    };
    const ORDER_TYPES = ['market', 'limit', 'stop', 'stop_limit', 'trailing_stop'];
    const EXECUTION_EPOCHS = ['legacy_long_term', 'legacy_unattributed', 'day_trading'];
    const ORDER_CLASSES = ['simple', 'bracket', 'oco', 'oto'];
    const LEG_ROLES = ['entry', 'take_profit', 'stop_loss', 'time_exit', 'repair_exit', 'emergency_flatten'];
    if (!normalized.idempotency_key || !normalized.symbol || !['buy', 'sell'].includes(normalized.side)
        || !Number.isInteger(normalized.qty) || normalized.qty <= 0
        || !ORDER_TYPES.includes(normalized.order_type) || normalized.time_in_force !== 'day'
        || !normalized.status || !EXECUTION_EPOCHS.includes(normalized.execution_epoch)
        || !ORDER_CLASSES.includes(normalized.order_class)
        || (normalized.leg_role !== null && !LEG_ROLES.includes(normalized.leg_role))) {
        throw new Error('invalid Alpaca paper order audit record');
    }
    if (normalized.order_type === 'limit' && !(normalized.limit_price > 0)) {
        throw new Error('limit paper-order audit requires positive limit_price');
    }
    return normalized;
}

function insertAlpacaPaperOrderAuditRow(sqlite, normalized, callback) {
    sqlite.run(
        `INSERT INTO alpaca_paper_orders (
            idempotency_key, client_order_id, symbol, side, qty, order_type, time_in_force, limit_price,
            stop_price, take_profit_price, status, execution_epoch, order_class, leg_role,
            parent_broker_order_id, plan_id, request_payload
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            normalized.idempotency_key, normalized.client_order_id, normalized.symbol, normalized.side, normalized.qty,
            normalized.order_type, normalized.time_in_force, normalized.limit_price, normalized.stop_price,
            normalized.take_profit_price, normalized.status, normalized.execution_epoch, normalized.order_class,
            normalized.leg_role, normalized.parent_broker_order_id, normalized.plan_id,
            JSON.stringify(normalized),
        ],
        function(err) {
            if (err) {
                if (/UNIQUE constraint failed: alpaca_paper_orders\.idempotency_key/i.test(err.message)) {
                    return callback(new Error('duplicate Alpaca paper-order idempotency key'));
                }
                if (/UNIQUE constraint failed: alpaca_paper_orders\.client_order_id/i.test(err.message)) {
                    return callback(new Error('duplicate Alpaca paper-order client order id'));
                }
                return callback(err);
            }
            return callback(null, { id: this.lastID, ...normalized });
        },
    );
}

function createAlpacaPaperOrderAudit(order) {
    let normalized;
    try {
        normalized = normalizeAlpacaPaperOrderAudit(order);
    } catch (validationError) {
        return Promise.reject(validationError);
    }
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        insertAlpacaPaperOrderAuditRow(sqlite, normalized, (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row);
        });
    });
}

function updateAlpacaPaperOrderAudit(idempotencyKey, {
    status, broker_order_id = null, broker_payload = null,
    filled_qty = null, avg_fill_price = null, unresolved = null,
    broker_created_at = null, submitted_at = null, broker_updated_at = null,
    filled_at = null, canceled_at = null, expired_at = null,
}) {
    const key = String(idempotencyKey || '').trim();
    if (!key || !status) return Promise.reject(new Error('invalid Alpaca paper order audit update'));
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `UPDATE alpaca_paper_orders
             SET status = ?,
                 broker_order_id = COALESCE(?, broker_order_id),
                 broker_payload = COALESCE(?, broker_payload),
                 filled_qty = COALESCE(?, filled_qty),
                 avg_fill_price = COALESCE(?, avg_fill_price),
                 unresolved = COALESCE(?, unresolved),
                 broker_created_at = COALESCE(?, broker_created_at),
                 submitted_at = COALESCE(?, submitted_at),
                 broker_updated_at = COALESCE(?, broker_updated_at),
                 filled_at = COALESCE(?, filled_at),
                 canceled_at = COALESCE(?, canceled_at),
                 expired_at = COALESCE(?, expired_at),
                 updated_at = datetime('now')
             WHERE idempotency_key = ?`,
            [
                status, broker_order_id, broker_payload == null ? null : JSON.stringify(broker_payload),
                filled_qty, avg_fill_price, unresolved == null ? null : (unresolved ? 1 : 0),
                broker_created_at, submitted_at, broker_updated_at, filled_at, canceled_at, expired_at,
                key,
            ],
            function(err) {
                sqlite.close();
                if (err) return reject(err);
                if (this.changes !== 1) return reject(new Error('Alpaca paper order audit record not found'));
                return resolve({ updated: this.changes });
            },
        );
    });
}

function listAlpacaPaperOrderAudits() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all('SELECT * FROM alpaca_paper_orders ORDER BY id DESC', [], (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

function normalizeAlpacaDayTradePlan(plan) {
    const normalized = {
        symbol: String(plan.symbol || '').trim().toUpperCase(),
        setup: String(plan.setup || '').trim(),
        catalyst: String(plan.catalyst || '').trim(),
        thesis: String(plan.thesis || '').trim(),
        invalidation: String(plan.invalidation || '').trim(),
        planned_entry_low: Number(plan.planned_entry_low),
        planned_entry_high: Number(plan.planned_entry_high),
        planned_stop: Number(plan.planned_stop),
        planned_target: Number(plan.planned_target),
        planned_qty: Number(plan.planned_qty),
        planned_risk_dollars: Number(plan.planned_risk_dollars),
        planned_reward_risk: Number(plan.planned_reward_risk),
        planned_account_risk_pct: Number(plan.planned_account_risk_pct),
        state: plan.state || 'entry_pending',
        exit_deadline: String(plan.exit_deadline || '').trim(),
        strategy_version: plan.strategy_version == null ? null : String(plan.strategy_version),
    };
    if (!normalized.symbol || !normalized.setup || !normalized.catalyst || !normalized.thesis || !normalized.invalidation
        || !normalized.exit_deadline || !Number.isInteger(normalized.planned_qty) || normalized.planned_qty <= 0
        || !Number.isFinite(normalized.planned_entry_low) || !Number.isFinite(normalized.planned_entry_high)
        || !Number.isFinite(normalized.planned_stop) || !Number.isFinite(normalized.planned_target)
        || !Number.isFinite(normalized.planned_risk_dollars) || !Number.isFinite(normalized.planned_reward_risk)
        || !Number.isFinite(normalized.planned_account_risk_pct)) {
        throw new Error('invalid Alpaca Day Trading plan');
    }
    return normalized;
}

function createAlpacaDayTradePlanWithEntry(plan, entryOrder) {
    let normalizedPlan;
    try {
        normalizedPlan = normalizeAlpacaDayTradePlan(plan);
    } catch (validationError) {
        return Promise.reject(validationError);
    }

    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            if (error) {
                sqlite.run('ROLLBACK', () => { sqlite.close(); reject(error); });
            } else {
                sqlite.close();
                resolve(value);
            }
        };

        sqlite.serialize(() => {
            // The plan INSERT is nested inside BEGIN's own callback (rather than queued
            // alongside it via serialize() alone) because serialize() only orders statement
            // dispatch — it does not stop a later statement just because an earlier one's
            // callback reported an error. Nesting is what actually prevents an unguarded
            // write if BEGIN itself fails (e.g. under lock contention).
            sqlite.run('BEGIN TRANSACTION', (beginErr) => {
                if (beginErr) return finish(beginErr);

                sqlite.run(
                    `INSERT INTO alpaca_day_trade_plans (
                        symbol, setup, catalyst, thesis, invalidation, planned_entry_low, planned_entry_high,
                        planned_stop, planned_target, planned_qty, planned_risk_dollars, planned_reward_risk,
                        planned_account_risk_pct, state, exit_deadline, strategy_version, opened_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
                    [
                        normalizedPlan.symbol, normalizedPlan.setup, normalizedPlan.catalyst, normalizedPlan.thesis,
                        normalizedPlan.invalidation, normalizedPlan.planned_entry_low, normalizedPlan.planned_entry_high,
                        normalizedPlan.planned_stop, normalizedPlan.planned_target, normalizedPlan.planned_qty,
                        normalizedPlan.planned_risk_dollars, normalizedPlan.planned_reward_risk,
                        normalizedPlan.planned_account_risk_pct, normalizedPlan.state, normalizedPlan.exit_deadline,
                        normalizedPlan.strategy_version,
                    ],
                    function(planErr) {
                        if (planErr) {
                            if (/UNIQUE constraint failed: alpaca_day_trade_plans\.symbol/i.test(planErr.message)) {
                                return finish(new Error(`a nonterminal Day Trading plan already exists for ${normalizedPlan.symbol}`));
                            }
                            return finish(planErr);
                        }
                        const planId = this.lastID;
                        let normalizedOrder;
                        try {
                            normalizedOrder = normalizeAlpacaPaperOrderAudit({
                                ...entryOrder,
                                plan_id: planId,
                                execution_epoch: entryOrder.execution_epoch || 'day_trading',
                                leg_role: entryOrder.leg_role || 'entry',
                            });
                        } catch (orderValidationError) {
                            return finish(orderValidationError);
                        }
                        insertAlpacaPaperOrderAuditRow(sqlite, normalizedOrder, (orderErr, orderRow) => {
                            if (orderErr) return finish(orderErr);
                            sqlite.run('COMMIT', (commitErr) => {
                                if (commitErr) return finish(commitErr);
                                finish(null, { plan: { id: planId, ...normalizedPlan }, order: orderRow });
                            });
                        });
                    },
                );
                },
            );
        });
    });
}

function getAlpacaDayTradePlan(id) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM alpaca_day_trade_plans WHERE id = ?', [Number(id)], (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

function getActiveAlpacaDayTradePlanForSymbol(symbol) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get(
            `SELECT * FROM alpaca_day_trade_plans
             WHERE symbol = ? AND state NOT IN ('closed', 'cancelled', 'error')
             ORDER BY id DESC LIMIT 1`,
            [String(symbol).toUpperCase()],
            (err, row) => {
                sqlite.close();
                err ? reject(err) : resolve(row || null);
            },
        );
    });
}

function listAlpacaDayTradePlans(state = null) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        const where = state ? 'WHERE state = ?' : '';
        const params = state ? [state] : [];
        sqlite.all(`SELECT * FROM alpaca_day_trade_plans ${where} ORDER BY id DESC`, params, (err, rows) => {
            sqlite.close();
            err ? reject(err) : resolve(rows || []);
        });
    });
}

const ALPACA_DAY_TRADE_PLAN_UPDATE_FIELDS = [
    'state', 'entry_parent_broker_order_id', 'protective_stop_broker_order_id', 'protective_target_broker_order_id',
    'filled_entry_qty', 'avg_entry_price', 'filled_exit_qty', 'avg_exit_price', 'exit_reason',
    'realized_pnl', 'realized_r', 'mfe', 'mae', 'thesis_valid', 'review_notes', 'opened_at', 'closed_at',
];
const TERMINAL_ALPACA_DAY_TRADE_PLAN_STATES = ['closed', 'cancelled', 'error'];

function updateAlpacaDayTradePlan(id, patch = {}) {
    const sets = [];
    const params = [];
    for (const field of ALPACA_DAY_TRADE_PLAN_UPDATE_FIELDS) {
        if (patch[field] === undefined) continue;
        sets.push(`${field} = ?`);
        params.push(field === 'thesis_valid' && patch[field] != null ? (patch[field] ? 1 : 0) : patch[field]);
    }
    if (sets.length === 0) return Promise.reject(new Error('no Alpaca Day Trading plan fields to update'));
    params.push(Number(id));
    // A transition INTO a terminal state is guarded in the WHERE clause itself, not just by
    // a caller reading the row first: two concurrent closers (e.g. a time-exit sweep and a
    // take-profit fill event both concluding the same plan is done) would otherwise both
    // pass a read-then-write pre-check and the second write would overwrite the first's
    // exit_reason/realized_pnl/closed_at. This does not block a benign update (such as
    // adding review notes) against an already-terminal plan.
    const closingTransition = TERMINAL_ALPACA_DAY_TRADE_PLAN_STATES.includes(patch.state);
    const where = closingTransition
        ? `WHERE id = ? AND state NOT IN ('${TERMINAL_ALPACA_DAY_TRADE_PLAN_STATES.join("', '")}')`
        : 'WHERE id = ?';
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(`UPDATE alpaca_day_trade_plans SET ${sets.join(', ')} ${where}`, params, function(err) {
            sqlite.close();
            if (err) return reject(err);
            if (this.changes !== 1) return reject(new Error('Alpaca Day Trading plan not found'));
            resolve({ updated: this.changes });
        });
    });
}

function createAlpacaPaperFill(fill) {
    const normalized = {
        activity_id: String(fill.activity_id || '').trim(),
        broker_order_id: fill.broker_order_id == null ? null : String(fill.broker_order_id),
        plan_id: fill.plan_id == null ? null : Number(fill.plan_id),
        symbol: String(fill.symbol || '').trim().toUpperCase(),
        side: fill.side,
        qty: Number(fill.qty),
        price: Number(fill.price),
        executed_at: String(fill.executed_at || '').trim(),
        fill_type: fill.fill_type,
        correction_of: fill.correction_of == null ? null : String(fill.correction_of),
        is_bust: fill.is_bust ? 1 : 0,
        source: fill.source,
    };
    if (!normalized.activity_id || !normalized.symbol || !['buy', 'sell'].includes(normalized.side)
        || !Number.isInteger(normalized.qty) || normalized.qty <= 0 || !(normalized.price > 0) || !normalized.executed_at
        || !['partial_fill', 'fill'].includes(normalized.fill_type)
        || !['websocket', 'rest_reconciliation'].includes(normalized.source)) {
        return Promise.reject(new Error('invalid Alpaca paper fill record'));
    }
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT OR IGNORE INTO alpaca_paper_fills (
                activity_id, broker_order_id, plan_id, symbol, side, qty, price, executed_at,
                fill_type, correction_of, is_bust, source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                normalized.activity_id, normalized.broker_order_id, normalized.plan_id, normalized.symbol,
                normalized.side, normalized.qty, normalized.price, normalized.executed_at, normalized.fill_type,
                normalized.correction_of, normalized.is_bust, normalized.source,
            ],
            (err) => {
                if (err) { sqlite.close(); return reject(err); }
                sqlite.get('SELECT * FROM alpaca_paper_fills WHERE activity_id = ?', [normalized.activity_id], (getErr, row) => {
                    sqlite.close();
                    getErr ? reject(getErr) : resolve(row);
                });
            },
        );
    });
}

function listAlpacaPaperFillsForPlan(planId) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(
            'SELECT * FROM alpaca_paper_fills WHERE plan_id = ? ORDER BY executed_at ASC, id ASC',
            [Number(planId)],
            (err, rows) => {
                sqlite.close();
                err ? reject(err) : resolve(rows || []);
            },
        );
    });
}

function getAlpacaMonitorState() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM alpaca_monitor_state WHERE id = 1', (err, row) => {
            sqlite.close();
            err ? reject(err) : resolve(row || null);
        });
    });
}

const ALPACA_MONITOR_STATE_UPDATE_FIELDS = [
    'mode', 'last_rest_reconciliation_at', 'last_websocket_event_at', 'last_websocket_reconnect_at',
    'activity_cursor', 'session_date', 'health_code', 'health_error', 'kill_switch',
    'last_flatten_sweep_at', 'submission_lease_holder', 'submission_lease_expires_at',
];

function updateAlpacaMonitorState(patch = {}) {
    const sets = [];
    const params = [];
    for (const field of ALPACA_MONITOR_STATE_UPDATE_FIELDS) {
        if (patch[field] === undefined) continue;
        sets.push(`${field} = ?`);
        params.push(field === 'kill_switch' ? (patch[field] ? 1 : 0) : patch[field]);
    }
    if (sets.length === 0) return Promise.reject(new Error('no Alpaca monitor-state fields to update'));
    sets.push("updated_at = datetime('now')");
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(`UPDATE alpaca_monitor_state SET ${sets.join(', ')} WHERE id = 1`, params, function(err) {
            sqlite.close();
            if (err) return reject(err);
            resolve({ updated: this.changes });
        });
    });
}

function settleAfterClose(sqlite, sqlError, value, resolve, reject) {
    sqlite.close((closeError) => {
        const error = sqlError || closeError;
        error ? reject(error) : resolve(value);
    });
}

function createStrategyExperiment({ name, hypothesis }) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            'INSERT INTO strategy_experiments (name, hypothesis) VALUES (?, ?)',
            [name, hypothesis],
            function(err) {
                settleAfterClose(sqlite, err, { id: this.lastID, name, hypothesis }, resolve, reject);
            },
        );
    });
}

function listStrategyExperiments() {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all('SELECT * FROM strategy_experiments ORDER BY id DESC', [], (err, rows) => {
            settleAfterClose(sqlite, err, rows || [], resolve, reject);
        });
    });
}

function getStrategyExperimentById(id) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM strategy_experiments WHERE id = ?', [Number(id)], (err, row) => {
            settleAfterClose(sqlite, err, row || null, resolve, reject);
        });
    });
}

function createStrategyVersion({ experiment_id, version_number, rules_json, notes = null }) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO strategy_versions (experiment_id, version_number, rules_json, notes)
             VALUES (?, ?, ?, ?)`,
            [Number(experiment_id), Number(version_number), rules_json, notes],
            function(err) {
                settleAfterClose(sqlite, err, {
                    id: this.lastID,
                    experiment_id: Number(experiment_id),
                    version_number: Number(version_number),
                    rules_json,
                    notes,
                }, resolve, reject);
            },
        );
    });
}

function listStrategyVersions(experimentId) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(
            'SELECT * FROM strategy_versions WHERE experiment_id = ? ORDER BY version_number ASC',
            [Number(experimentId)],
            (err, rows) => {
                settleAfterClose(sqlite, err, rows || [], resolve, reject);
            },
        );
    });
}

function getStrategyVersionById(id) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.get('SELECT * FROM strategy_versions WHERE id = ?', [Number(id)], (err, row) => {
            settleAfterClose(sqlite, err, row || null, resolve, reject);
        });
    });
}

function createStrategyRun(run) {
    const fields = [
        'version_id', 'run_type', 'evidence_domain', 'start_date', 'end_date', 'trade_count',
        'total_return_pct', 'benchmark_return_pct', 'max_drawdown_pct',
        'sharpe', 'win_rate', 'expectancy', 'avg_r', 'notes',
    ];
    const values = fields.map((field) => run[field] ?? null);
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.run(
            `INSERT INTO strategy_runs (${fields.join(', ')})
             VALUES (${fields.map(() => '?').join(', ')})`,
            values,
            function(err) {
                settleAfterClose(sqlite, err, { id: this.lastID, ...run }, resolve, reject);
            },
        );
    });
}

function listStrategyRunsForExperiment(experimentId) {
    return new Promise((resolve, reject) => {
        const sqlite = getDb();
        sqlite.all(
            `SELECT r.*
             FROM strategy_runs r
             INNER JOIN strategy_versions v ON v.id = r.version_id
             WHERE v.experiment_id = ?
             ORDER BY r.id ASC`,
            [Number(experimentId)],
            (err, rows) => {
                settleAfterClose(sqlite, err, rows || [], resolve, reject);
            },
        );
    });
}

module.exports = {
    VALID_BUCKETS,
    VALID_TXN_TYPES,
    DB_PATH,
    getDb,
    initDb,
    getWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    isInWatchlist,
    setWatchlistBucket,
    upsertStockSnapshot,
    getFirstStockSnapshot,
    getStockHistory,
    getLatestSnapshotsForWatchlist,
    getPortfolio,
    upsertPortfolioPosition,
    removeFromPortfolio,
    saveChatMessage,
    getChatHistory,
    clearChatHistory,
    upsertMemo,
    getMemo,
    listMemos,
    markMemoReviewed,
    deleteMemo,
    getRiskRules,
    setRiskRules,
    setPositionStop,
    getPositionStop,
    listPositionStops,
    deletePositionStop,
    addTransaction,
    listTransactions,
    getTransactionById,
    deleteTransaction,
    listSimAccounts,
    getSimAccount,
    setSimTaxBracket,
    setSimReinvestmentSettings,
    addSimTransaction,
    recordSimDividend,
    addSimTransactionWithPlan,
    addSimTransactionAndCloseTradePlan,
    executeSimTradeAtomic,
    recordSimTradeAtomic,
    getSimOrder,
    findSimOrdersByIntentHash,
    canonicalIntentHash,
    listSimTradePlans,
    getActiveSimTradePlan,
    listSimTransactions,
    deleteAllSimTransactions,
    createAlpacaPaperOrderAudit,
    updateAlpacaPaperOrderAudit,
    listAlpacaPaperOrderAudits,
    createAlpacaDayTradePlanWithEntry,
    getAlpacaDayTradePlan,
    getActiveAlpacaDayTradePlanForSymbol,
    listAlpacaDayTradePlans,
    updateAlpacaDayTradePlan,
    createAlpacaPaperFill,
    listAlpacaPaperFillsForPlan,
    getAlpacaMonitorState,
    updateAlpacaMonitorState,
    createStrategyExperiment,
    listStrategyExperiments,
    getStrategyExperimentById,
    createStrategyVersion,
    listStrategyVersions,
    getStrategyVersionById,
    createStrategyRun,
    listStrategyRunsForExperiment,
};
