const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-run-'));
process.env.DB_PATH_OVERRIDE = path.join(dir, 'test.db');
const hybrid = require('../services/hybrid_market_data');
let price = 100;
hybrid.getDefaultHybridQuote = async (symbol) => ({ symbol, price: symbol === 'SPY' ? 100 : price,
    data_source: 'alpaca_iex', market_state: 'REGULAR', timestamp: new Date(Date.now() - 1000).toISOString() });
const db = require('../database/db');
const controls = require('../services/simulator_controls');
const performance = require('../services/simulator_performance');
const evaluation = require('../services/strategy_evaluation');
const strategy = require('../services/strategy_lab');
const { executeSimulatorTrade } = require('../services/simulator_execution_service');
const policy = { max_position_pct: 25, min_cash_pct: 10, max_risk_per_trade_pct: 10, max_open_risk_pct: 30, max_daily_loss_pct: 5 };
let version;
before(async () => {
    await db.initDb();
    await controls.setPolicy(2, policy, 'operator');
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 1000, txn_date: '2026-09-07' });
    const exp = await strategy.createExperiment({ name: 'Reproducible run', hypothesis: 'An explicit test objective' });
    version = await strategy.addVersion(exp.id, { rules: { evaluation_policy: { min_observations: 2, min_closed_trades: 1,
        max_drawdown_pct: 20, min_return_pct: 0, min_excess_return_pct: 0 } } });
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const config = () => ({ strategy_version_id: version.id, model_id: 'frozen-test-model', prompt_hash: 'a'.repeat(64), benchmark_symbol: 'SPY' });

test('archived runs preserve immutable source, quotes, decisions and independently computed net outcomes', async () => {
    const session = await performance.startRun(2, config());
    assert.ok(session.config.source_manifest['services/simulator_execution_service.js']);
    await assert.rejects(performance.startRun(2, config()), { code: 'SIM_RUN_ACTIVE' });
    await assert.rejects(db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 100, txn_date: '2026-09-07' }), { code: 'SIM_RUN_LOCKED' });
    await assert.rejects(controls.connection((c) => controls.run(c, "UPDATE sim_evaluation_sessions SET config_json='{}' WHERE id=?", [session.id])), /immutable/);
    await performance.recordDecision(2, { decision_key: 'skip-1', reason: 'No qualified second setup' });
    const replay = await performance.recordDecision(2, { decision_key: 'skip-1', reason: 'No qualified second setup' });
    assert.equal(replay.duplicate, true);
    await assert.rejects(performance.recordDecision(2, { decision_key: 'skip-1', reason: 'Changed reason' }), { code: 'SIM_ORDER_CONFLICT' });
    const bought = await executeSimulatorTrade({ account_id: 2, run_id: session.id, type: 'buy', symbol: 'AAA', shares: 1, fees: 1,
        client_order_id: 'run-buy', trade_plan: { setup: 'test', thesis: 'test', stop_price: 90, target_price: 120 } });
    assert.equal(bought.result.run_id, session.id);
    await assert.rejects(db.deleteAllSimTransactions(2), /archive/);
    await assert.rejects(db.recordSimTradeAtomic({ transaction: { account_id: 2, type: 'sell', symbol: 'AAA', shares: 1, price: 100, txn_date: '2026-09-07' } }), { code: 'SIM_RUN_LOCKED' });
    price = 110;
    await executeSimulatorTrade({ account_id: 2, run_id: session.id, type: 'sell', symbol: 'AAA', shares: 1, fees: 1, client_order_id: 'run-sell' });
    await performance.archiveRun(2, session.id);
    const artifact = await evaluation.evaluateSession(version.id, session.id);
    assert.ok(Math.abs(artifact.metrics.twr_pct - 0.8) < 1e-8);
    assert.equal(artifact.metrics.closed_trade_count, 1);
    assert.equal(artifact.metrics.expectancy, 8);
    assert.equal(artifact.assessment.passed, true);
    assert.equal((await evaluation.evaluateSession(version.id, session.id)).duplicate, true);
    await assert.rejects(controls.connection((c) => controls.run(c, 'DELETE FROM strategy_evaluation_artifacts')), /immutable/);
    const beforeReset = await performance.getPerformance(2, session.id);
    await db.deleteAllSimTransactions(2);
    assert.deepEqual(await performance.getPerformance(2, session.id), beforeReset);
});

test('delegated policy adjustments remain possible but cannot improve a frozen-run score retroactively', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 1000, txn_date: '2026-09-07' });
    const session = await performance.startRun(2, config());
    await controls.setPolicy(2, { ...policy, max_position_pct: 40 }, 'buffett');
    await performance.archiveRun(2, session.id);
    const artifact = await evaluation.evaluateSession(version.id, session.id);
    assert.equal(artifact.assessment.passed, false);
    assert.ok(artifact.assessment.blockers.includes('risk_policy_changed_during_run'));
    assert.ok(artifact.assessment.blockers.includes('insufficient_closed_trades'));
});
