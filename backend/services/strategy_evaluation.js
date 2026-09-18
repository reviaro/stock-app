'use strict';

const controls = require('./simulator_controls');
const performance = require('./simulator_performance');
const { computeHoldings, computeRealizedPnl } = require('./simulator_ledger');

const schema = [
    `CREATE TABLE IF NOT EXISTS strategy_evaluation_artifacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, version_id INTEGER NOT NULL, run_type TEXT NOT NULL,
        source_kind TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL,
        artifact_json TEXT NOT NULL, artifact_hash TEXT NOT NULL UNIQUE,
        metrics_json TEXT NOT NULL, policy_json TEXT NOT NULL, created_at TEXT NOT NULL)`,
    ...['UPDATE', 'DELETE'].map((op) => `CREATE TRIGGER IF NOT EXISTS immutable_strategy_artifacts_${op}
        BEFORE ${op} ON strategy_evaluation_artifacts BEGIN SELECT RAISE(ABORT, 'evaluation artifacts are immutable'); END`),
];

function validateEvaluationPolicy(policy) {
    if (!policy || typeof policy !== 'object') throw controls.error('EVALUATION_POLICY_REQUIRED', 'define evaluation_policy in the strategy rules before collecting results');
    for (const key of ['min_observations', 'min_closed_trades', 'max_drawdown_pct', 'min_return_pct', 'min_excess_return_pct']) {
        if (typeof policy[key] !== 'number' || !Number.isFinite(policy[key])) throw controls.error('INVALID_EVALUATION_POLICY', `${key} must be a finite number`);
    }
    if (!Number.isInteger(policy.min_observations) || policy.min_observations < 2
        || !Number.isInteger(policy.min_closed_trades) || policy.min_closed_trades < 1
        || policy.max_drawdown_pct <= 0 || policy.max_drawdown_pct > 100) throw controls.error('INVALID_EVALUATION_POLICY', 'require at least two observations, one closed lifecycle, and drawdown limit in (0,100]');
    return Object.fromEntries(['min_observations', 'min_closed_trades', 'max_drawdown_pct', 'min_return_pct', 'min_excess_return_pct'].map((k) => [k, policy[k]]));
}

function closedLifecycles(rows) {
    const shares = {}, pnl = {};
    const sales = new Map(computeRealizedPnl(rows).sales.map((s) => [s.id, s.realized_pnl]));
    const results = [];
    for (const row of [...rows].sort((a, b) => String(a.txn_date).localeCompare(String(b.txn_date)) || a.id - b.id)) {
        if (!row.symbol) continue;
        const symbol = row.symbol;
        if (row.type === 'buy') shares[symbol] = (shares[symbol] || 0) + row.shares;
        if (row.type === 'dividend' && (shares[symbol] || 0) > 0) pnl[symbol] = (pnl[symbol] || 0) + row.amount;
        if (row.type === 'sell') {
            shares[symbol] = (shares[symbol] || 0) - row.shares;
            pnl[symbol] = (pnl[symbol] || 0) + (sales.get(row.id) || 0);
            if (Math.abs(shares[symbol]) < 1e-6) { results.push(pnl[symbol]); delete pnl[symbol]; }
        }
    }
    return results;
}

function assessMetrics(metrics, policy) {
    const blockers = [...metrics.blockers];
    if (metrics.observation_count < policy.min_observations) blockers.push('insufficient_observations');
    if (metrics.closed_trade_count < policy.min_closed_trades) blockers.push('insufficient_closed_trades');
    if (metrics.twr_pct == null || metrics.twr_pct <= 0 || metrics.twr_pct < policy.min_return_pct) blockers.push('return_objective_not_met');
    if (metrics.benchmark_return_pct == null || metrics.twr_pct == null
        || metrics.twr_pct - metrics.benchmark_return_pct < policy.min_excess_return_pct) blockers.push('benchmark_objective_not_met');
    if (metrics.max_drawdown_pct == null || metrics.max_drawdown_pct > policy.max_drawdown_pct) blockers.push('drawdown_objective_not_met');
    return { passed: blockers.length === 0, blockers: [...new Set(blockers)] };
}

// Only a server-recorded, archived simulator run can create verified evidence.
// Existing manually entered backtest/OOS metrics remain unverified registry
// records. A future replay runner must produce its own immutable artifacts.
async function evaluateSession(versionId, sessionId) {
    return controls.transaction(async (conn) => {
        const version = await controls.get(conn, 'SELECT * FROM strategy_versions WHERE id=?', [versionId]);
        if (!version) throw controls.error('STRATEGY_NOT_FOUND', 'strategy version not found', 404);
        const policy = validateEvaluationPolicy(JSON.parse(version.rules_json).evaluation_policy);
        const session = await controls.get(conn, 'SELECT * FROM sim_evaluation_sessions WHERE id=?', [sessionId]);
        if (!session?.ended_at) throw controls.error('RUN_NOT_ARCHIVED', 'archive the simulator run before evaluating it');
        const config = JSON.parse(session.config_json);
        if (controls.hash(config) !== session.config_hash) throw controls.error('RUN_INTEGRITY_ERROR', 'run configuration hash does not match its frozen contents');
        if (config.strategy_version_id !== Number(versionId)) throw controls.error('RUN_VERSION_MISMATCH', 'run belongs to a different strategy version');
        const samples = (await controls.all(conn, 'SELECT * FROM sim_equity_samples WHERE account_id=? AND id>=? AND id<=? ORDER BY id',
            [session.account_id, session.start_sample_id, session.end_sample_id])).map(performance.decodeSample);
        const rows = samples.at(-1)?.ledger || [];
        const startRows = new Set((samples[0]?.ledger || []).map((r) => r.id));
        const newRows = rows.filter((r) => !startRows.has(r.id));
        const outcomes = closedLifecycles(newRows);
        const metrics = { ...performance.calculatePerformance(samples, { benchmarkSymbol: config.benchmark_symbol }),
            closed_trade_count: outcomes.length,
            win_rate_pct: outcomes.length ? 100 * outcomes.filter((n) => n > 0).length / outcomes.length : null,
            expectancy: outcomes.length ? outcomes.reduce((a, b) => a + b, 0) / outcomes.length : null };
        if (Object.keys(computeHoldings(rows)).length) metrics.blockers.push('open_positions_at_end');
        if (samples.some((sample) => sample.origin === 'run_end_source_changed')) metrics.blockers.push('source_changed_during_run');
        const changed = await controls.get(conn, 'SELECT id FROM sim_risk_policy_versions WHERE account_id=? AND id>? AND created_at<=? LIMIT 1',
            [session.account_id, config.policy.id, session.ended_at]);
        if (changed) metrics.blockers.push('risk_policy_changed_during_run');
        // Cash flow / manual operator edits cannot silently enter run evidence.
        if (newRows.some((r) => ['deposit', 'withdrawal'].includes(r.type))) metrics.blockers.push('funding_changed_during_run');
        metrics.complete = metrics.blockers.length === 0;
        const assessment = assessMetrics(metrics, policy);
        const decisions = await controls.all(conn, 'SELECT * FROM sim_decision_events WHERE run_id=? ORDER BY id', [sessionId]);
        const artifact = { schema_version: 1, session, samples, decisions, assessment };
        const artifactHash = controls.hash(artifact);
        const prior = await controls.get(conn, 'SELECT id FROM strategy_evaluation_artifacts WHERE artifact_hash=?', [artifactHash]);
        if (prior) return { id: prior.id, metrics, assessment, duplicate: true };
        const result = await controls.run(conn, `INSERT INTO strategy_evaluation_artifacts
            (version_id,run_type,source_kind,start_at,end_at,artifact_json,artifact_hash,metrics_json,policy_json,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`, [versionId, 'paper', 'server_observed_simulator', session.started_at, session.ended_at,
            JSON.stringify(artifact), artifactHash, JSON.stringify(metrics), JSON.stringify(policy), new Date().toISOString()]);
        return { id: result.id, artifact_hash: artifactHash, metrics, assessment };
    });
}

async function listArtifacts(versionId) {
    return controls.connection(async (conn) => (await controls.all(conn,
        'SELECT id,version_id,run_type,source_kind,start_at,end_at,artifact_hash,metrics_json,policy_json FROM strategy_evaluation_artifacts WHERE version_id=? ORDER BY id', [versionId]))
        .map((row) => ({ ...row, metrics: JSON.parse(row.metrics_json), assessment: assessMetrics(JSON.parse(row.metrics_json), JSON.parse(row.policy_json)) })));
}

function readiness(runs, artifacts = []) {
    const types = new Set(runs.filter((r) => r.evidence_domain !== 'allocation').map((r) => r.run_type));
    const verified = artifacts.filter((a) => a.assessment.passed);
    function gate(required) {
        const blockers = [];
        const selected = required.map((type) => verified.find((a) => a.run_type === type));
        required.forEach((type, i) => { if (!selected[i]) blockers.push(`missing_verified_${type}_evidence`); });
        for (let i = 1; i < selected.length; i++) {
            if (selected[i] && selected[i - 1] && selected[i].start_at <= selected[i - 1].end_at) blockers.push('overlapping_evaluation_periods');
        }
        return { ready: blockers.length === 0, blockers };
    }
    return { paper: gate(['backtest', 'out_of_sample']), live: gate(['backtest', 'out_of_sample', 'paper']),
        evidence_types_present: [...types], automated_promotion_enabled: false };
}

module.exports = { schema, validateEvaluationPolicy, closedLifecycles, assessMetrics, evaluateSession, listArtifacts, readiness };
