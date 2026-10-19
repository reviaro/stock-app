const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTestDatabase } = require('./test_database');

// Loaded through NODE_OPTIONS by the test launcher, including in fixture children.
// Preserve explicitly selected fixture databases, but give each test process its
// own fallback instead of inheriting another process's default database.
const requested = process.env.DB_PATH_OVERRIDE;
if (!requested || requested === process.env.STOCK_DASHBOARD_TEST_DEFAULT_DB) {
    process.env.STOCK_DASHBOARD_TEST_DEFAULT_DB = createTestDatabase();
} else {
    const temporaryRoot = fs.realpathSync(os.tmpdir());
    const parent = fs.realpathSync(path.dirname(requested));
    const relative = path.relative(temporaryRoot, parent);
    if (!path.isAbsolute(requested) || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) {
        throw new Error('Test databases must be inside the operating-system temporary directory.');
    }
    if (fs.existsSync(requested) && fs.lstatSync(requested).isSymbolicLink()) {
        throw new Error('Test database paths must not be symbolic links.');
    }
}

// server.js imports dotenv itself. Keep parsing available for sample-mode tests,
// while ensuring neither this process nor its Node children read local secrets.
const dotenv = require('dotenv');
dotenv.config = () => ({ parsed: {} });
dotenv.configDotenv = dotenv.config;
