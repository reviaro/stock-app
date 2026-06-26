const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

function runMigration001({ dbPath }) {
    if (!dbPath) throw new Error('dbPath required');

    return new Promise((resolve, reject) => {
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err) reject(err);
        });

        db.serialize(() => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'", (txnErr, txnTable) => {
                if (txnErr) {
                    db.close();
                    reject(txnErr);
                    return;
                }
                if (!txnTable) {
                    db.close();
                    reject(new Error('transactions table missing — run initDb first'));
                    return;
                }

                db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio'", (portfolioErr, portfolioTable) => {
                    if (portfolioErr) {
                        db.close();
                        reject(portfolioErr);
                        return;
                    }
                    if (!portfolioTable) {
                        db.close();
                        resolve({ migrated: 0, skipped: true, backupPath: null });
                        return;
                    }

                    db.all('SELECT * FROM portfolio', (rowsErr, rows) => {
                        if (rowsErr) {
                            db.close();
                            reject(rowsErr);
                            return;
                        }

                        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
                        const backupPath = `${dbPath}.backup.${stamp}`;
                        try {
                            fs.copyFileSync(dbPath, backupPath);
                        } catch (copyErr) {
                            db.close();
                            reject(copyErr);
                            return;
                        }

                        db.run('BEGIN TRANSACTION');

                        let inserted = 0;
                        const insertRow = (index) => {
                            if (index >= rows.length) {
                                db.run(
                                    `INSERT INTO transactions (symbol, type, shares, price, amount, fees, txn_date, notes)
                                     VALUES (NULL, 'deposit', NULL, NULL, 0, 0, '1970-01-01', 'migration seed')`,
                                    (seedErr) => {
                                        if (seedErr) {
                                            db.run('ROLLBACK');
                                            db.close();
                                            reject(seedErr);
                                            return;
                                        }
                                        db.run('DROP TABLE portfolio', (dropErr) => {
                                            if (dropErr) {
                                                db.run('ROLLBACK');
                                                db.close();
                                                reject(dropErr);
                                                return;
                                            }
                                            db.run('COMMIT', (commitErr) => {
                                                db.close();
                                                if (commitErr) reject(commitErr);
                                                else resolve({ migrated: inserted, backupPath });
                                            });
                                        });
                                    }
                                );
                                return;
                            }

                            const row = rows[index];
                            const txnDate = row.buy_date && /^\d{4}-\d{2}-\d{2}$/.test(row.buy_date)
                                ? row.buy_date
                                : '1970-01-01';
                            const amount = Number(row.shares) * Number(row.buy_price);

                            db.run(
                                `INSERT INTO transactions (symbol, type, shares, price, amount, fees, txn_date, notes)
                                 VALUES (?, 'buy', ?, ?, ?, 0, ?, ?)`,
                                [row.symbol.toUpperCase(), row.shares, row.buy_price, amount, txnDate, row.notes],
                                (insertErr) => {
                                    if (insertErr) {
                                        db.run('ROLLBACK');
                                        db.close();
                                        reject(insertErr);
                                        return;
                                    }
                                    inserted += 1;
                                    insertRow(index + 1);
                                }
                            );
                        };

                        insertRow(0);
                    });
                });
            });
        });
    });
}

module.exports = { runMigration001 };
