const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const sqlite3 = require('sqlite3');
const { SAMPLE_DB_PATH, assertSamplePath, acquireSampleLock, verifySampleDatabase, validateSampleEnvironment } = require('../services/sample_mode');
const { buildSampleEnvironment } = require('../scripts/start-sample');
const expected = require('../fixtures/sample/expected.json');
const scenario = require('../fixtures/sample/scenario.json');
const prices = require('../fixtures/sample/prices.json');
const { buildSummary } = require('../services/portfolio_ledger');
const simLedger = require('../services/simulator_ledger');
const { computeBreaches } = require('../services/risk_engine');

const backend = path.resolve(__dirname, '..');
function scratch(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stock-sample-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
}
async function readRows(file, sql) {
    return new Promise((resolve, reject) => {
        const conn = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
        conn.all(sql, (error, rows) => conn.close(() => error ? reject(error) : resolve(rows)));
    });
}
function seed(file) {
    const env = { ...process.env, DB_PATH_OVERRIDE: file };
    delete env.SAMPLE_DATA;
    return spawnSync(process.execPath, ['-e', `require('./scripts/seed-sample').seedSample({samplePath: process.env.DB_PATH_OVERRIDE}).catch(e => { console.error(e.message); process.exitCode = 1; })`],
        { cwd: backend, env, encoding: 'utf8', timeout: 600000 });
}
function near(actual, target) { assert.ok(Math.abs(actual - target) < 0.000001, `${actual} != ${target}`); }

test('sample path refuses stocks.db, arbitrary targets, relative paths and filesystem aliases before opening', (t) => {
    const dir = scratch(t);
    const file = path.join(dir, 'sample.db');
    assert.throws(() => assertSamplePath(path.join(dir, 'stocks.db')), /designated/);
    assert.throws(() => assertSamplePath('sample.db'), /designated/);
    assert.throws(() => assertSamplePath(file), /designated/);
    const sentinel = path.join(dir, 'do-not-open');
    fs.writeFileSync(sentinel, 'untouched');
    fs.symlinkSync(sentinel, file);
    assert.throws(() => assertSamplePath(file, file), /symlinks/);
    fs.unlinkSync(file);
    fs.linkSync(sentinel, file);
    assert.throws(() => assertSamplePath(file, file), /hard links/);
    fs.unlinkSync(file);
    fs.mkdirSync(path.join(dir, 'real'));
    fs.symlinkSync(path.join(dir, 'real'), path.join(dir, 'alias'));
    const aliased = path.join(dir, 'alias/sample.db');
    assert.throws(() => assertSamplePath(aliased, aliased), /symlinks/);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'untouched');
});

test('sample launcher excludes inherited database, broker and operator credentials and uses its own login', () => {
    const env = buildSampleEnvironment({ PATH: process.env.PATH, DB_PATH_OVERRIDE: '/forbidden/stocks.db',
        ALPACA_API_KEY: 'inherited', STOCK_DASHBOARD_API_TOKEN: 'inherited',
        GOOGLE_GENERATIVE_AI_API_KEY: 'inherited', STOCK_DASHBOARD_HOST: '0.0.0.0' },
    { ALPACA_API_KEY: 'file-value', DB_PATH_OVERRIDE: '/forbidden/stocks.db', GOOGLE_GENERATIVE_AI_API_KEY: 'sample-only' });
    assert.equal(env.DB_PATH_OVERRIDE, SAMPLE_DB_PATH);
    assert.equal(env.ALPACA_API_KEY, undefined);
    assert.equal(env.STOCK_DASHBOARD_API_TOKEN, undefined);
    assert.equal(env.GOOGLE_GENERATIVE_AI_API_KEY, 'sample-only');
    assert.equal(env.STOCK_DASHBOARD_HOST, '127.0.0.1');
    assert.equal(env.STOCK_DASHBOARD_USERNAME, 'sample-investor');
    assert.equal(env.PORT, '3003');
    assert.equal(validateSampleEnvironment(env), true);
    assert.notEqual(env.STOCK_DASHBOARD_SESSION_SECRET, buildSampleEnvironment({}).STOCK_DASHBOARD_SESSION_SECRET);
});

test('normal mode keeps existing configuration; sample mode rejects missing paths and unsafe runtime settings', () => {
    assert.equal(validateSampleEnvironment({ DB_PATH_OVERRIDE: '/some/production.db', ALPACA_API_KEY: 'existing' }), false);
    const env = buildSampleEnvironment({});
    for (const patch of [{ DB_PATH_OVERRIDE: '' }, { DB_PATH_OVERRIDE: '/tmp/stocks.db' },
        { STOCK_DASHBOARD_HOST: '0.0.0.0' }, { ALPACA_API_KEY: 'credential' },
        { ALPACA_PAPER_ORDER_ENTRY_ENABLED: 'true' }, { STOCK_DASHBOARD_API_TOKEN: 'token' },
        { STOCK_DASHBOARD_SIMULATOR_TOKENS: '[]' }, { ENABLE_LEDGER_MIGRATION: '1' }]) {
        assert.throws(() => validateSampleEnvironment({ ...env, ...patch }));
    }
});

test('sample lock blocks a second server or seed and can be released', (t) => {
    const file = path.join(scratch(t), 'sample.db');
    const release = acquireSampleLock(file);
    assert.throws(() => acquireSampleLock(file), /in use/);
    release();
    release();
    acquireSampleLock(file)();
});

test('sample sessions identify sample data and use a separate cookie from production', async () => {
    const express = require('express');
    const { createAuthFromEnv, COOKIE_NAME } = require('../services/auth');
    const auth = createAuthFromEnv(buildSampleEnvironment({}));
    const app = express();
    app.use(express.json());
    app.use('/api/auth', auth.router);
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    try {
        const login = await fetch(`${origin}/api/auth/login`, { method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'sample-investor', password: 'sample-portfolio' }) });
        assert.equal(login.status, 200);
        assert.equal((await login.json()).data.sampleData, true);
        const cookie = login.headers.get('set-cookie').split(';')[0];
        assert.ok(cookie.startsWith('stock_dashboard_sample_session='));
        assert.ok(!cookie.startsWith(`${COOKIE_NAME}=`));
        const session = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
        assert.equal((await session.json()).data.sampleData, true);
        const logout = await fetch(`${origin}/api/auth/logout`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
        assert.equal(logout.status, 200);
        const after = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: cookie } });
        assert.equal((await after.json()).data.authenticated, false);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

test('Python cache reader and writer honor the override; unset override keeps the original default', (t) => {
    const file = path.join(scratch(t), 'python-test.db');
    const source = `
import os, sys, sqlite3
sys.path.insert(0, 'python')
from database_path import get_database_path
import yf_wrapper, universe_updater
target = os.environ['DB_PATH_OVERRIDE']
conn = sqlite3.connect(target)
conn.execute('CREATE TABLE universe_cache (symbol TEXT, weighted_score REAL, updated_at TEXT)')
conn.commit()
conn.close()
original = sqlite3.connect
calls = []
def guarded_connect(filename, *args, **kwargs):
    assert filename == target, 'attempt to access a different database'
    calls.append(filename)
    return original(filename, *args, **kwargs)
sqlite3.connect = guarded_connect
yf_wrapper.get_rs_rating_from_cache('AAPL')
universe_updater.SP500_TOP100 = []
universe_updater.update_universe_cache()
assert len(calls) == 2
del os.environ['DB_PATH_OVERRIDE']
assert os.path.abspath(get_database_path()) == os.path.abspath('database/stocks.db')
os.environ['DB_PATH_OVERRIDE'] = ''
assert os.path.abspath(get_database_path()) == os.path.abspath('database/stocks.db')
`;
    const result = spawnSync(path.join(backend, 'venv/bin/python'), ['-c', source], {
        cwd: backend, env: { ...process.env, DB_PATH_OVERRIDE: file }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
});

test('sample CLI rejects stocks.db without creating or opening it', (t) => {
    const file = path.join(scratch(t), 'stocks.db');
    const result = spawnSync(process.execPath, ['scripts/seed-sample.js'], {
        cwd: backend, env: { ...process.env, DB_PATH_OVERRIDE: file }, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /stocks.db is never allowed/);
    assert.equal(fs.existsSync(file), false);
});

test('unmarked databases cannot be launched or overwritten', async (t) => {
    const file = path.join(scratch(t), 'sample.db');
    await assert.rejects(verifySampleDatabase(file), /missing/);
    fs.writeFileSync(file, 'not a sample database');
    await assert.rejects(verifySampleDatabase(file), /unmarked/);
    const result = seed(file);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unmarked/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'not a sample database');
    assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('seed is repeatable, matches independently calculated ledgers and creates the intended sample scenario', async (t) => {
    const file = path.join(scratch(t), 'sample.db');
    const result = seed(file);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    await verifySampleDatabase(file);
    const txns = await readRows(file, 'SELECT * FROM transactions ORDER BY txn_date, id');
    const summary = buildSummary(txns, prices.dates[scenario.as_of]);
    near(summary.cash, expected.portfolio.cash);
    near(summary.realized.total, expected.portfolio.realized_pnl);
    assert.equal(Object.keys(summary.holdings).length, 14);
    for (const [symbol, holding] of Object.entries(expected.portfolio.holdings)) {
        near(summary.holdings[symbol].shares, holding.shares);
        near(summary.holdings[symbol].total_cost, holding.cost_basis);
    }
    const positions = Object.entries(summary.holdings).map(([symbol, h]) => ({ symbol,
        shares: h.shares, currentValue: prices.dates[scenario.as_of][symbol] * h.shares, sector: scenario.sectors[symbol] }));
    const breaches = computeBreaches({ positions, cash: summary.cash, rules: scenario.risk_rules }).breaches;
    assert.deepEqual(breaches.map(({ kind, symbol }) => ({ kind, symbol })), [{ kind: 'position', symbol: 'MSFT' }]);
    const buckets = await readRows(file, 'SELECT DISTINCT bucket FROM watchlist');
    assert.equal(buckets.length, 6);
    assert.equal((await readRows(file, 'SELECT * FROM stock_memos WHERE thesis IS NOT NULL AND conviction IS NOT NULL')).length, 3);
    for (const id of [1, 2]) {
        const rows = await readRows(file, `SELECT * FROM sim_transactions WHERE account_id = ${id}`);
        near(simLedger.computeCashBalance(rows), expected.simulator[id].cash);
        near(simLedger.computeRealizedPnl(rows).total, expected.simulator[id].realized_pnl);
        for (const [symbol, h] of Object.entries(expected.simulator[id].holdings)) {
            near(simLedger.computeHoldings(rows)[symbol].total_cost, h.cost_basis);
        }
    }
    const second = seed(file);
    assert.equal(second.status, 0, second.stderr || second.error?.message);
    const stable = rows => rows.map(({ created_at, ...row }) => row);
    assert.deepEqual(stable(await readRows(file, 'SELECT * FROM transactions ORDER BY txn_date, id')), stable(txns));
    assert.equal(fs.existsSync(path.join(path.dirname(file), 'stocks.db')), false);
});
