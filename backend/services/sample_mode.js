const fs = require('node:fs');
const path = require('node:path');
const sqlite3 = require('sqlite3');

const SAMPLE_DB_PATH = path.resolve(__dirname, '../database/sample.db');
const SAMPLE_MARKER = 'stock-dashboard-fictional-portfolio-v1';

function assertSamplePath(candidate, expected = SAMPLE_DB_PATH) {
    if (!candidate || !path.isAbsolute(candidate) || path.resolve(candidate) !== expected
        || path.basename(candidate) !== 'sample.db') {
        throw new Error('Sample mode requires the designated absolute sample.db path; stocks.db is never allowed');
    }
    // Reject aliases before opening anything, including symlinked parent directories.
    for (let current = candidate; ; current = path.dirname(current)) {
        try {
            const stat = fs.lstatSync(current);
            if (stat.isSymbolicLink() || (current === candidate && (!stat.isFile() || stat.nlink !== 1))) {
                throw new Error('Sample database path must not contain symlinks, hard links or non-files');
            }
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        if (path.dirname(current) === current) break;
    }
    return candidate;
}

function acquireSampleLock(samplePath) {
    const lockPath = `${samplePath}.lock`;
    let fd;
    try {
        fd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (error) {
        if (error.code === 'EEXIST') throw new Error('Sample database is in use. Stop the sample server before reseeding. For a stale lock, see README.');
        throw error;
    }
    fs.writeFileSync(fd, String(process.pid));
    fs.closeSync(fd);
    let released = false;
    return () => {
        if (!released) {
            released = true;
            fs.unlinkSync(lockPath);
        }
    };
}

async function verifySampleDatabase(samplePath) {
    if (!fs.existsSync(samplePath)) throw new Error('Sample database missing. Run npm run seed:sample first.');
    await new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(samplePath, sqlite3.OPEN_READONLY, (openError) => {
            if (openError) return reject(new Error('Unable to open sample database read-only'));
            conn.get('SELECT marker FROM sample_metadata WHERE id = 1', (error, row) => {
                conn.close((closeError) => {
                    if (error || row?.marker !== SAMPLE_MARKER) return reject(new Error('Refusing an unmarked database; only seed:sample databases are allowed'));
                    closeError ? reject(closeError) : resolve();
                });
            });
        });
    });
}

function validateSampleEnvironment(env = process.env) {
    if (env.SAMPLE_DATA !== '1') return false;
    assertSamplePath(env.DB_PATH_OVERRIDE);
    if (env.STOCK_DASHBOARD_HOST !== '127.0.0.1' || env.STOCK_DASHBOARD_PUBLIC_ORIGIN
        || env.STOCK_DASHBOARD_TRUSTED_PROXY_IP) {
        throw new Error('Sample mode requires a local 127.0.0.1 listener without a proxy');
    }
    if (Object.keys(env).some((key) => key.startsWith('ALPACA_') && env[key])
        || env.STOCK_DASHBOARD_API_TOKEN || env.STOCK_DASHBOARD_SIMULATOR_TOKENS
        || env.ENABLE_LEDGER_MIGRATION === '1') {
        throw new Error('Sample mode refuses broker credentials, automation tokens and legacy migration');
    }
    return true;
}

module.exports = { SAMPLE_DB_PATH, SAMPLE_MARKER, assertSamplePath, acquireSampleLock,
    verifySampleDatabase, validateSampleEnvironment };
