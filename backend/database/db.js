const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, '..', 'database', 'stocks.db');

function getDb() {
    const dbDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dbDir)) {
        fs.mkdirSync(dbDir, { recursive: true });
    }
    
    return new sqlite3.Database(DB_PATH, (err) => {
        if (err) {
            console.error('Database connection error:', err.message);
        }
    });
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
                    currency TEXT DEFAULT 'USD',
                    source TEXT DEFAULT 'yfinance',
                    is_market_closed INTEGER DEFAULT 0,
                    is_carry_forward INTEGER DEFAULT 0,
                    raw_payload TEXT,
                    UNIQUE(symbol, market_date, slot)
                )
            `);

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_stock_snapshots_symbol_captured
                ON stock_snapshots(symbol, captured_at DESC)
            `);

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_stock_snapshots_market_date_slot
                ON stock_snapshots(market_date, slot)
            `);

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
                CREATE TABLE IF NOT EXISTS chat_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL DEFAULT 'default',
                    role TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            db.run(`
                CREATE INDEX IF NOT EXISTS idx_chat_history_session
                ON chat_history(session_id, created_at DESC)
            `, (err) => {
                if (err) {
                    db.close();
                    reject(err);
                } else {
                    console.log('Database initialized');
                    db.close();
                    resolve();
                }
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
            else resolve(rows);
        });
    });
}

function addToWatchlist(symbol, notes = '') {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            'INSERT OR IGNORE INTO watchlist (symbol, notes) VALUES (?, ?)',
            [symbol.toUpperCase(), notes],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ id: this.lastID, symbol: symbol.toUpperCase() });
            }
        );
    });
}

function removeFromWatchlist(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            'DELETE FROM watchlist WHERE symbol = ?',
            [symbol.toUpperCase()],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ deleted: this.changes });
            }
        );
    });
}

function isInWatchlist(symbol) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.get(
            'SELECT 1 FROM watchlist WHERE symbol = ?',
            [symbol.toUpperCase()],
            (err, row) => {
                db.close();
                if (err) reject(err);
                else resolve(!!row);
            }
        );
    });
}

function upsertStockSnapshot(snapshot) {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.run(
            `INSERT INTO stock_snapshots (
                symbol, slot, market_date, quote_timestamp, price, previous_close,
                change_amount, change_percent, currency, source,
                is_market_closed, is_carry_forward, raw_payload
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(symbol, market_date, slot)
            DO UPDATE SET
                quote_timestamp=excluded.quote_timestamp,
                price=excluded.price,
                previous_close=excluded.previous_close,
                change_amount=excluded.change_amount,
                change_percent=excluded.change_percent,
                currency=excluded.currency,
                source=excluded.source,
                is_market_closed=excluded.is_market_closed,
                is_carry_forward=excluded.is_carry_forward,
                raw_payload=excluded.raw_payload,
                captured_at=CURRENT_TIMESTAMP`,
            [
                snapshot.symbol.toUpperCase(),
                snapshot.slot,
                snapshot.marketDate,
                snapshot.quoteTimestamp ?? null,
                snapshot.price,
                snapshot.previousClose ?? null,
                snapshot.changeAmount ?? null,
                snapshot.changePercent ?? null,
                snapshot.currency ?? 'USD',
                snapshot.source ?? 'yfinance',
                snapshot.isMarketClosed ? 1 : 0,
                snapshot.isCarryForward ? 1 : 0,
                snapshot.rawPayload ?? null,
            ],
            function(err) {
                db.close();
                if (err) reject(err);
                else resolve({ id: this.lastID, symbol: snapshot.symbol.toUpperCase() });
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
                else resolve(rows);
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
                else resolve(rows);
            }
        );
    });
}

function getPortfolio() {
    return new Promise((resolve, reject) => {
        const db = getDb();
        db.all('SELECT * FROM portfolio ORDER BY symbol ASC', [], (err, rows) => {
            db.close();
            if (err) reject(err);
            else resolve(rows);
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
                else resolve(rows);
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

module.exports = {
    getDb,
    initDb,
    getWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    isInWatchlist,
    upsertStockSnapshot,
    getStockHistory,
    getLatestSnapshotsForWatchlist,
    getPortfolio,
    upsertPortfolioPosition,
    removeFromPortfolio,
    saveChatMessage,
    getChatHistory,
    clearChatHistory,
};
