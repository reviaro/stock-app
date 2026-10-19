const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Call before importing database/db, which captures DB_PATH_OVERRIDE at load time.
// Each test file runs in its own Node test process; concurrent suite invocations
// also receive distinct directories. Never reuse an inherited application path.
function createTestDatabase() {
    const temporaryRoot = process.env.STOCK_DASHBOARD_TEST_TMPDIR || os.tmpdir();
    const directory = fs.mkdtempSync(path.join(temporaryRoot, 'stock-dashboard-test-'));
    const databasePath = path.join(directory, 'test.db');
    process.env.DB_PATH_OVERRIDE = databasePath;

    // Wait until the process has finished its test hooks and pending SQLite closes.
    // Removing the owned directory also removes journals and migration backups.
    process.once('exit', () => fs.rmSync(directory, { recursive: true, force: true }));
    return databasePath;
}

module.exports = { createTestDatabase };
