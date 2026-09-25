'use strict';

const crypto = require('node:crypto');
const { computeHoldings, computeCashBalance } = require('./simulator_ledger');
const { validateExecutionQuote } = require('./execution_quote_policy');
const { validateValuationQuote } = require('./valuation_quote_policy');

const schema = [
    `CREATE TABLE IF NOT EXISTS sim_risk_policy_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
        policy_json TEXT NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS sim_equity_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL,
        captured_at TEXT NOT NULL, origin TEXT NOT NULL, equity REAL,
        net_contributions REAL NOT NULL, ledger_json TEXT NOT NULL, quotes_json TEXT NOT NULL,
        missing_json TEXT NOT NULL, run_id TEXT, flow REAL NOT NULL DEFAULT 0)`,
    `CREATE INDEX IF NOT EXISTS idx_sim_samples_account ON sim_equity_samples(account_id, id)`,
    `CREATE TABLE IF NOT EXISTS sim_evaluation_sessions (
        id TEXT PRIMARY KEY, account_id INTEGER NOT NULL, config_json TEXT NOT NULL,
        config_hash TEXT NOT NULL, started_at TEXT NOT NULL, start_sample_id INTEGER NOT NULL,
        ended_at TEXT, end_sample_id INTEGER)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sim_one_active_run ON sim_evaluation_sessions(account_id) WHERE ended_at IS NULL`,
    `CREATE TABLE IF NOT EXISTS sim_decision_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER NOT NULL, run_id TEXT,
        decision_key TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL,
        detail_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(account_id, decision_key))`,
    ...['sim_risk_policy_versions', 'sim_equity_samples', 'sim_decision_events'].flatMap((table) =>
        ['UPDATE', 'DELETE'].map((op) => `CREATE TRIGGER IF NOT EXISTS immutable_${table}_${op}
            BEFORE ${op} ON ${table} BEGIN SELECT RAISE(ABORT, 'evaluation history is append-only'); END`)),
    `CREATE TRIGGER IF NOT EXISTS immutable_sim_run_config BEFORE UPDATE ON sim_evaluation_sessions
        WHEN OLD.ended_at IS NOT NULL OR NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id
        OR NEW.config_json IS NOT OLD.config_json OR NEW.config_hash IS NOT OLD.config_hash
        OR NEW.started_at IS NOT OLD.started_at OR NEW.start_sample_id IS NOT OLD.start_sample_id
        OR NEW.ended_at IS NULL OR NEW.end_sample_id IS NULL
        BEGIN SELECT RAISE(ABORT, 'run configuration is immutable'); END`,
    `CREATE TRIGGER IF NOT EXISTS immutable_sim_run_delete BEFORE DELETE ON sim_evaluation_sessions
        BEGIN SELECT RAISE(ABORT, 'runs must be archived, never deleted'); END`,
    ...['sim_transactions', 'sim_trade_plans', 'sim_dividends', 'sim_orders'].map((table) =>
        `CREATE TRIGGER IF NOT EXISTS protect_active_run_${table} BEFORE DELETE ON ${table}
         WHEN EXISTS (SELECT 1 FROM sim_evaluation_sessions WHERE account_id=OLD.account_id AND ended_at IS NULL)
         BEGIN SELECT RAISE(ABORT, 'archive the evaluation run before resetting its ledger'); END`),
    `CREATE TRIGGER IF NOT EXISTS protect_active_run_dividend BEFORE INSERT ON sim_dividends
        WHEN EXISTS (SELECT 1 FROM sim_evaluation_sessions WHERE account_id=NEW.account_id AND ended_at IS NULL)
        BEGIN SELECT RAISE(ABORT, 'operator dividend recording is unavailable during an evaluated run'); END`,
];

const all = (conn, sql, params = []) => new Promise((resolve, reject) => conn.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
const get = async (conn, sql, params = []) => (await all(conn, sql, params))[0] || null;
const run = (conn, sql, params = []) => new Promise((resolve, reject) => conn.run(sql, params, function(e) {
    e ? reject(e) : resolve({ id: this.lastID, changes: this.changes });
}));
function error(code, message, status = 400) { return Object.assign(new Error(message), { code, status, statusCode: status }); }
function hash(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
async function connection(fn) {
    const conn = require('../database/db').getDb();
    try { return await fn(conn); } finally { await new Promise((r) => conn.close(r)); }
}
async function transaction(fn) {
    return connection(async (conn) => {
        await run(conn, 'BEGIN IMMEDIATE');
        try { const result = await fn(conn); await run(conn, 'COMMIT'); return result; }
        catch (e) { await run(conn, 'ROLLBACK'); throw e; }
    });
}

const POLICY_FIELDS = ['max_position_pct', 'min_cash_pct', 'max_risk_per_trade_pct', 'max_open_risk_pct', 'max_daily_loss_pct'];
function validatePolicy(input) {
    const policy = {};
    for (const key of POLICY_FIELDS) {
        if (typeof input?.[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > 100) {
            throw error('SIM_INVALID_POLICY', `${key} must be a number between 0 and 100`);
        }
        policy[key] = input[key];
    }
    if (!policy.max_position_pct || !policy.max_daily_loss_pct || !policy.max_risk_per_trade_pct || !policy.max_open_risk_pct) {
        throw error('SIM_INVALID_POLICY', 'position, risk and daily-loss limits must be greater than zero');
    }
    return policy;
}
async function latestPolicy(conn, accountId) {
    const row = await get(conn, 'SELECT * FROM sim_risk_policy_versions WHERE account_id = ? ORDER BY id DESC LIMIT 1', [accountId]);
    return row ? { id: row.id, ...JSON.parse(row.policy_json), actor: row.actor, created_at: row.created_at } : null;
}
async function setPolicy(accountId, input, actor) {
    const policy = validatePolicy(input);
    return transaction(async (conn) => {
        if (!await get(conn, 'SELECT id FROM simulator_sleeves WHERE id = ?', [accountId])) throw error('SIM_ACCOUNT_NOT_FOUND', 'unknown simulator sleeve');
        await run(conn, 'INSERT INTO sim_risk_policy_versions(account_id, policy_json, actor, created_at) VALUES (?, ?, ?, ?)',
            [accountId, JSON.stringify(policy), actor, new Date().toISOString()]);
        return latestPolicy(conn, accountId);
    });
}
function valueLedger(rows, quotes) {
    const holdings = computeHoldings(rows);
    const missing = [];
    const values = {};
    for (const [symbol, position] of Object.entries(holdings)) {
        const valid = validateValuationQuote(quotes[symbol], { expectedSymbol: symbol });
        if (!valid.valid) missing.push(symbol);
        else values[symbol] = position.shares * quotes[symbol].price;
    }
    const cash = computeCashBalance(rows);
    const equity = missing.length ? null : cash + Object.values(values).reduce((a, b) => a + b, 0);
    const net = rows.reduce((n, r) => n + (r.type === 'deposit' ? r.amount : r.type === 'withdrawal' ? -r.amount : 0), 0);
    return { cash, equity, values, holdings, missing, net };
}
async function activeRun(conn, accountId) {
    return get(conn, 'SELECT * FROM sim_evaluation_sessions WHERE account_id = ? AND ended_at IS NULL', [accountId]);
}
async function capture(conn, accountId, rows, quotes, origin, flow = 0) {
    const v = valueLedger(rows, quotes);
    const session = await activeRun(conn, accountId);
    const sample = { account_id: accountId, captured_at: new Date().toISOString(), origin, equity: v.equity,
        net_contributions: v.net, ledger: rows, quotes, missing_symbols: v.missing, run_id: session?.id || null, flow };
    const saved = await run(conn, `INSERT INTO sim_equity_samples(account_id,captured_at,origin,equity,net_contributions,
        ledger_json,quotes_json,missing_json,run_id,flow) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [accountId, sample.captured_at, origin, v.equity, v.net, JSON.stringify(rows), JSON.stringify(quotes), JSON.stringify(v.missing), sample.run_id, flow]);
    return { id: saved.id, ...sample };
}

function sessionDate(time = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
}
async function enforceRisk(conn, accountId, rows, order) {
    // Resource checks always remain in db.js; limits must not trap risk-reducing exits.
    if (order.transaction.type !== 'buy') return null;
    const policy = await latestPolicy(conn, accountId);
    if (!policy) throw error('SIM_POLICY_REQUIRED', 'configure simulator risk limits before new entries');
    if (!validateExecutionQuote(order.quote, { expectedSymbol: order.transaction.symbol }).valid) {
        throw error('SIM_QUOTE_REJECTED', 'entry quote is no longer valid at execution time', 503);
    }
    const quotes = order.valuation_quotes || {};
    const v = valueLedger(rows, quotes);
    if (v.equity == null || v.equity <= 0) throw error('SIM_RISK_DATA_UNAVAILABLE', 'current prices for all holdings are required for entry risk checks', 503);
    const { symbol, shares, price, fees = 0 } = order.transaction;
    const equity = v.equity - fees;
    const cost = shares * price + fees;
    if (equity <= 0) throw error('SIM_RISK_LIMIT', 'trade fees exhaust account equity');
    const pct = (n) => 100 * n / equity;
    const breaches = [];
    if (pct((v.values[symbol] || 0) + shares * price) > policy.max_position_pct + 1e-8) breaches.push('max_position_pct');
    if (pct(v.cash - cost) < policy.min_cash_pct - 1e-8) breaches.push('min_cash_pct');
    const plans = await all(conn, "SELECT * FROM sim_trade_plans WHERE account_id=? AND status='active'", [accountId]);
    const stop = order.trade_plan?.stop_price;
    // Without a documented stop (e.g. long-term holdings), budget the full
    // principal at risk instead of pretending the risk is zero.
    const newRisk = shares * (price - (typeof stop === 'number' && stop > 0 && stop < price ? stop : 0)) + fees;
    if (pct(newRisk) > policy.max_risk_per_trade_pct + 1e-8) breaches.push('max_risk_per_trade_pct');
    let openRisk = newRisk;
    for (const [held, position] of Object.entries(v.holdings)) {
        const plan = plans.find((p) => p.symbol === held);
        // Legacy positions without a stop conservatively risk their full marked value.
        openRisk += position.shares * Math.max(0, quotes[held].price - (plan?.stop_price || 0));
    }
    if (pct(openRisk) > policy.max_open_risk_pct + 1e-8) breaches.push('max_open_risk_pct');
    const samples = await all(conn, 'SELECT captured_at,equity,net_contributions FROM sim_equity_samples WHERE account_id=? ORDER BY id', [accountId]);
    const opening = samples.find((s) => s.equity > 0 && sessionDate(new Date(s.captured_at)) === sessionDate());
    // The first complete observation establishes today's measured loss baseline.
    const base = opening || { equity: v.equity, net_contributions: v.net };
    const dailyPnl = equity - base.equity - (v.net - base.net_contributions);
    if (-100 * dailyPnl / base.equity >= policy.max_daily_loss_pct) breaches.push('max_daily_loss_pct');
    if (breaches.length) throw error('SIM_RISK_LIMIT', `entry exceeds simulator limits: ${breaches.join(', ')}`);
    return policy.id;
}

module.exports = { schema, all, get, run, connection, transaction, error, hash, validatePolicy, latestPolicy,
    setPolicy, valueLedger, capture, activeRun, enforceRisk, sessionDate };
