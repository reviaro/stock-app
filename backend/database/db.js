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

module.exports = {
    getDb,
    initDb,
    getWatchlist,
    addToWatchlist,
    removeFromWatchlist,
    isInWatchlist
};
