'use strict';

const controls = require('./simulator_controls');
const { computeHoldings } = require('./simulator_ledger');
const { obtainValuationQuote } = require('./valuation_quote_policy');
const { getDefaultHybridQuote } = require('./hybrid_market_data');
const db = () => require('../database/db');

async function quotesFor(accountId, extraSymbols = []) {
    const symbols = new Set([...Object.keys(computeHoldings(await db().listSimTransactions(accountId))), ...extraSymbols]);
    const active = await controls.connection((conn) => controls.activeRun(conn, accountId));
    if (active) symbols.add(JSON.parse(active.config_json).benchmark_symbol);
    const quotes = {};
    await Promise.all([...symbols].map(async (symbol) => {
        const quote = await obtainValuationQuote(symbol, { getHybridQuote: getDefaultHybridQuote });
        if (quote.valid) quotes[symbol] = quote.quote;
    }));
    return quotes;
}

// Time-weighted returns are chained only across complete observations. Cash
// flows require an immediately preceding pre-flow mark at the same prices.
// Missing boundaries invalidate the series instead of silently diluting returns.
function calculatePerformance(samples, { benchmarkSymbol = null } = {}) {
    const blockers = new Set();
    let factor = 1, peak = 1, maxDrawdown = 0;
    if (samples.length < 2) blockers.add('insufficient_observations');
    if (samples.some((s) => typeof s.equity !== 'number' || !Number.isFinite(s.equity) || s.equity < 0)) blockers.add('incomplete_valuation');
    for (let i = 1; i < samples.length; i++) {
        const previous = samples[i - 1], current = samples[i];
        if (!Number.isFinite(Date.parse(current.captured_at)) || Date.parse(current.captured_at) < Date.parse(previous.captured_at)) blockers.add('invalid_observation_order');
        const delta = current.net_contributions - previous.net_contributions;
        if (Math.abs(delta) > 1e-8 && (previous.origin !== 'before_flow' || current.origin !== 'cash_flow'
            || Math.abs(delta - current.flow) > 1e-8
            || JSON.stringify(previous.quotes || {}) !== JSON.stringify(current.quotes || {}))) blockers.add('unvalued_cash_flow');
        if (!(previous.equity > 0)) {
            // Initial funding establishes capital; it is not a return.
            if (previous.equity === 0 && current.origin === 'cash_flow' && delta > 0) {
                factor *= current.equity / delta;
                maxDrawdown = Math.max(maxDrawdown, 1 - factor / peak);
                continue;
            }
            blockers.add('nonpositive_start_equity'); continue;
        }
        factor *= (current.equity - delta) / previous.equity;
        peak = Math.max(peak, factor);
        maxDrawdown = Math.max(maxDrawdown, peak > 0 ? 1 - factor / peak : 0);
    }
    if (samples.some((s) => ['manual_trade', 'reset'].includes(s.origin))) blockers.add('manual_or_reset_activity');
    if (!Number.isFinite(factor)) blockers.add('invalid_return');
    const first = samples[0], last = samples.at(-1);
    let benchmarkReturn = null;
    if (benchmarkSymbol) {
        const start = first?.quotes?.[benchmarkSymbol]?.price;
        const end = last?.quotes?.[benchmarkSymbol]?.price;
        if (start > 0 && end > 0) benchmarkReturn = (end / start - 1) * 100;
        else blockers.add('benchmark_unavailable');
    }
    const complete = blockers.size === 0;
    return { basis: 'time_weighted_observed_equity', valuation_basis: 'validated_latest_trade_surrogate',
        complete, blockers: [...blockers], observation_count: samples.length,
        start_at: first?.captured_at || null, end_at: last?.captured_at || null,
        twr_pct: complete ? (factor - 1) * 100 : null,
        max_drawdown_pct: complete ? maxDrawdown * 100 : null,
        benchmark_return_pct: benchmarkReturn,
        benchmark_basis: benchmarkSymbol ? 'price_return_excludes_benchmark_dividends' : null,
        net_pnl: first?.equity != null && last?.equity != null
            ? last.equity - first.equity - (last.net_contributions - first.net_contributions) : null };
}

function decodeSample(row) {
    return { ...row, ledger: JSON.parse(row.ledger_json || '[]'), quotes: JSON.parse(row.quotes_json), missing_symbols: JSON.parse(row.missing_json) };
}
async function captureCurrent(accountId, origin = 'observation') {
    const quotes = await quotesFor(accountId);
    return controls.transaction(async (conn) => controls.capture(conn, accountId,
        await db().loadSimLedgerRows(conn, accountId), quotes, origin));
}
async function getPerformance(accountId, runId = null) {
    return controls.connection(async (conn) => {
        let session = null;
        if (runId) {
            session = await controls.get(conn, 'SELECT * FROM sim_evaluation_sessions WHERE id=? AND account_id=?', [runId, accountId]);
            if (!session) throw controls.error('SIM_RUN_NOT_FOUND', 'evaluation run not found', 404);
        }
        let rows = await controls.all(conn, `SELECT id,account_id,captured_at,origin,equity,net_contributions,
            quotes_json,missing_json,run_id,flow FROM sim_equity_samples WHERE account_id=?
            ${session ? 'AND id >= ? AND id <= ?' : ''} ORDER BY id`,
        session ? [accountId, session.start_sample_id, session.end_sample_id || Number.MAX_SAFE_INTEGER] : [accountId]);
        // A reset begins a new display period. Archived runs retain their exact boundaries.
        if (!session) { const index = rows.findLastIndex((r) => r.origin === 'reset'); if (index >= 0) rows = rows.slice(index + 1); }
        const samples = rows.map(decodeSample);
        const config = session ? JSON.parse(session.config_json) : null;
        const result = calculatePerformance(samples, { benchmarkSymbol: config?.benchmark_symbol });
        return { ...result, run: session ? { ...session, config } : null,
            samples: samples.map(({ ledger, ledger_json, quotes_json, missing_json, ...sample }) => sample) };
    });
}
async function startRun(accountId, input) {
    for (const key of ['model_id', 'prompt_hash', 'benchmark_symbol']) {
        if (typeof input[key] !== 'string' || !input[key].trim()) throw controls.error('SIM_INVALID_RUN', `${key} is required`);
    }
    if (!/^[a-f0-9]{64}$/i.test(input.prompt_hash) || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(input.benchmark_symbol)) throw controls.error('SIM_INVALID_RUN', 'valid prompt SHA-256 and benchmark symbol are required');
    const quotes = await quotesFor(accountId, [input.benchmark_symbol]);
    return controls.transaction(async (conn) => {
        if (await controls.activeRun(conn, accountId)) throw controls.error('SIM_RUN_ACTIVE', 'archive the current run first', 409);
        const policy = await controls.latestPolicy(conn, accountId);
        if (!policy) throw controls.error('SIM_POLICY_REQUIRED', 'configure risk limits before starting an evaluation');
        const version = await controls.get(conn, 'SELECT * FROM strategy_versions WHERE id=?', [input.strategy_version_id]);
        if (!version) throw controls.error('SIM_INVALID_RUN', 'a strategy_version_id is required');
        require('./strategy_evaluation').validateEvaluationPolicy(JSON.parse(version.rules_json).evaluation_policy);
        const rows = await db().loadSimLedgerRows(conn, accountId);
        // An evaluated run starts flat, with funding supplied by the operator.
        if (Object.keys(computeHoldings(rows)).length) throw controls.error('SIM_RUN_NOT_FLAT', 'start evaluation from a flat sleeve');
        const sample = await controls.capture(conn, accountId, rows, quotes, 'run_start');
        if (!(sample.equity > 0) || !quotes[input.benchmark_symbol]) throw controls.error('SIM_RISK_DATA_UNAVAILABLE', 'funded equity and a validated benchmark quote are required', 503);
        const config = { strategy_version_id: version.id, rules: JSON.parse(version.rules_json), model_id: input.model_id.trim(),
            prompt_hash: input.prompt_hash, benchmark_symbol: input.benchmark_symbol, policy,
            execution_basis: 'latest_trade_surrogate', starting_equity: sample.equity,
            source_manifest: sourceManifest() };
        const id = require('node:crypto').randomUUID();
        await controls.run(conn, `INSERT INTO sim_evaluation_sessions(id,account_id,config_json,config_hash,started_at,start_sample_id)
            VALUES (?,?,?,?,?,?)`, [id, accountId, JSON.stringify(config), controls.hash(config), sample.captured_at, sample.id]);
        return { id, account_id: accountId, config, started_at: sample.captured_at };
    });
}
async function archiveRun(accountId, id) {
    const quotes = await quotesFor(accountId);
    return controls.transaction(async (conn) => {
        const session = await controls.activeRun(conn, accountId);
        if (!session || session.id !== id) throw controls.error('SIM_RUN_NOT_FOUND', 'active evaluation run not found', 404);
        const rows = await db().loadSimLedgerRows(conn, accountId);
        const originalSource = JSON.parse(session.config_json).source_manifest;
        const changed = controls.hash(originalSource) !== controls.hash(sourceManifest());
        const sample = await controls.capture(conn, accountId, rows, quotes, changed ? 'run_end_source_changed' : 'run_end');
        await controls.run(conn, 'UPDATE sim_evaluation_sessions SET ended_at=?,end_sample_id=? WHERE id=?', [sample.captured_at, sample.id, id]);
        return { id, archived: true, valuation_complete: sample.equity !== null };
    });
}
async function recordDecision(accountId, input, outcome = 'abstained') {
    if (typeof input.decision_key !== 'string' || !input.decision_key.trim() || input.decision_key.length > 200
        || typeof input.reason !== 'string' || !input.reason.trim() || input.reason.length > 4000) throw controls.error('SIM_INVALID_DECISION', 'decision_key and concise reason are required');
    return controls.transaction(async (conn) => {
        const session = await controls.activeRun(conn, accountId);
        const detail = { reason: input.reason, input_snapshot_ids: input.input_snapshot_ids || [] };
        const key = `hold:${input.decision_key}`;
        const prior = await controls.get(conn, 'SELECT * FROM sim_decision_events WHERE account_id=? AND decision_key=?', [accountId, key]);
        if (prior) {
            if (prior.detail_json !== JSON.stringify(detail)) throw controls.error('SIM_ORDER_CONFLICT', 'decision key already used for a different decision', 409);
            return { id: prior.id, duplicate: true };
        }
        return controls.run(conn, `INSERT INTO sim_decision_events(account_id,run_id,decision_key,action,outcome,detail_json,created_at)
            VALUES (?,?,?,?,?,?,?)`, [accountId, session?.id || null, key, 'hold', outcome, JSON.stringify(detail), new Date().toISOString()]);
    });
}

function sourceManifest() {
    const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
    const root = path.join(__dirname, '..');
    const files = ['server.js', 'package-lock.json', 'database/db.js'];
    for (const directory of ['services', 'routes']) {
        for (const file of fs.readdirSync(path.join(root, directory)).sort()) if (file.endsWith('.js')) files.push(`${directory}/${file}`);
    }
    return Object.fromEntries(files.map((file) => [file, crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')]));
}
function initSimulatorPerformanceScheduler() {
    let running = false;
    return require('node-cron').schedule('*/5 * * * *', async () => {
        if (running) return;
        running = true;
        try {
            // Closed-session prices intentionally fail execution freshness.
            // Do not turn every overnight period into a missing-data gap.
            const clockQuote = await getDefaultHybridQuote('SPY');
            if (['CLOSED', 'PRE', 'POST', 'PREPRE', 'POSTPOST'].includes(clockQuote?.market_state)) return;
            for (const account of await db().listSimAccounts()) {
                const policy = await controls.connection((conn) => controls.latestPolicy(conn, account.id));
                if (policy) await captureCurrent(account.id);
            }
        } catch (error) { console.error('[simulator performance] capture failed:', error.message); }
        finally { running = false; }
    });
}

module.exports = { quotesFor, calculatePerformance, decodeSample, captureCurrent, getPerformance, startRun, archiveRun, recordDecision, initSimulatorPerformanceScheduler };
