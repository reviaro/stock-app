const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

function runMigration001({ dbPath }) {
    if (!dbPath) throw new Error('dbPath required');

    return new Promise((resolve, reject) => {
        let settled = false;
        const db = new sqlite3.Database(dbPath, (err) => {
            if (err && !settled) {
                settled = true;
                reject(err);
            }
        });

        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            db.close((closeError) => {
                const finalError = error || closeError;
                finalError ? reject(finalError) : resolve(value);
            });
        };
        const rollbackAndFail = (error) => {
            db.run('ROLLBACK', () => finish(error));
        };

        db.serialize(() => {
            db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='transactions'", (txnErr, txnTable) => {
                if (txnErr) {
                    finish(txnErr);
                    return;
                }
                if (!txnTable) {
                    finish(new Error('transactions table missing — run initDb first'));
                    return;
                }

                db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='portfolio'", (portfolioErr, portfolioTable) => {
                    if (portfolioErr) {
                        finish(portfolioErr);
                        return;
                    }
                    if (!portfolioTable) {
                        finish(null, { migrated: 0, skipped: true, backupPath: null });
                        return;
                    }

                    db.all('SELECT * FROM portfolio', (rowsErr, rows) => {
                        if (rowsErr) {
                            finish(rowsErr);
                            return;
                        }

                        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
                        const backupPath = `${dbPath}.backup.${stamp}`;
                        try {
                            fs.copyFileSync(dbPath, backupPath);
                        } catch (copyErr) {
                            finish(copyErr);
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
                                            rollbackAndFail(seedErr);
                                            return;
                                        }
                                        db.run('DROP TABLE portfolio', (dropErr) => {
                                            if (dropErr) {
                                                rollbackAndFail(dropErr);
                                                return;
                                            }
                                            db.run('COMMIT', (commitErr) => {
                                                finish(commitErr, { migrated: inserted, backupPath });
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
                                        rollbackAndFail(insertErr);
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
