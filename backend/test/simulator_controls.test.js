const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-controls-'));
process.env.DB_PATH_OVERRIDE = path.join(dir, 'test.db');
const db = require('../database/db');
const controls = require('../services/simulator_controls');
const performance = require('../services/simulator_performance');
const evaluation = require('../services/strategy_evaluation');
const { authorizeApiRequest } = require('../services/api_capabilities');
const basePolicy = { max_position_pct: 25, min_cash_pct: 10, max_risk_per_trade_pct: 10, max_open_risk_pct: 30, max_daily_loss_pct: 5 };
const quote = (symbol, price) => ({ symbol, price, source: 'alpaca_iex', price_type: 'latest_trade', currency: 'USD',
    market_state: 'REGULAR', event_time: new Date(Date.now() - 1000).toISOString(), received_at: new Date().toISOString() });
before(() => db.initDb());
after(() => fs.rmSync(dir, { recursive: true, force: true }));

function allowed(principal, method, route, body = {}, query = {}) {
    let accepted = false, status;
    authorizeApiRequest({ auth: principal, method, path: route, body, query }, {
        status(n) { status = n; return this; }, json() {},
    }, () => { accepted = true; });
    return { accepted, status };
}
test('agents cannot escalate through funding, reset, manual records, chat, other sleeves or operator research writes', () => {
    const principal = { role: 'simulator-agent', account_id: 2, manage_limits: true };
    for (const route of ['/simulator/reset', '/simulator/record', '/simulator/runs', '/ai/chat', '/strategy-lab/experiments', '/alpaca-paper/orders']) {
        assert.equal(allowed(principal, 'POST', route, { account_id: 2 }).status, 403, route);
    }
    assert.equal(allowed(principal, 'PATCH', '/simulator/account', { account_id: 2, deposit: 1 }).status, 403);
    assert.equal(allowed(principal, 'POST', '/simulator/trade', { account_id: 1 }).status, 403);
    assert.equal(allowed(principal, 'POST', '/simulator/trade', { account_id: 2 }, { account_id: '1' }).status, 403);
    assert.equal(allowed(principal, 'GET', '/simulator/transactions').status, 403);
    assert.equal(allowed(principal, 'GET', '/simulator/transactions', {}, { account_id: ['2'] }).status, 403);
    assert.equal(allowed(principal, 'GET', '/stock/AAPL').accepted, true);
    assert.equal(allowed(principal, 'POST', '/simulator/trade', { account_id: 2 }).accepted, true);
    assert.equal(allowed(principal, 'PUT', '/simulator/risk-policy', { account_id: 2 }).accepted, true);
    assert.equal(allowed({ ...principal, manage_limits: false }, 'PUT', '/simulator/risk-policy', { account_id: 2 }).status, 403);
    assert.equal(allowed({ type: 'loopback', role: 'reader' }, 'POST', '/simulator/trade', { account_id: 2 }).status, 403);
    assert.equal(allowed({ type: 'session', role: 'operator' }, 'POST', '/simulator/reset').accepted, true);
});

test('limits are validated, sleeve-specific, versioned and append-only', async () => {
    await assert.rejects(controls.setPolicy(2, { ...basePolicy, max_position_pct: NaN }, 'buffett'), { code: 'SIM_INVALID_POLICY' });
    const first = await controls.setPolicy(2, basePolicy, 'buffett');
    const second = await controls.setPolicy(2, { ...basePolicy, max_position_pct: 30 }, 'operator');
    assert.ok(second.id > first.id);
    assert.equal(await controls.connection((c) => controls.latestPolicy(c, 1)), null);
    await assert.rejects(controls.connection((c) => controls.run(c, 'DELETE FROM sim_risk_policy_versions')), /append-only/);
});

async function order(key, symbol, shares = 1, extra = {}) {
    const q = quote(symbol, 100);
    return db.executeSimTradeAtomic({ transaction: { account_id: 2, type: 'buy', symbol, shares, price: 100, fees: 0, txn_date: '2026-09-07' },
        client_order_id: key, intent: { symbol, shares, type: 'buy' }, quote: q,
        valuation_quotes: { AAA: quote('AAA', 100), BBB: quote('BBB', 100), [symbol]: q },
        trade_plan: { setup: 'test', thesis: 'test', stop_price: 90, target_price: 120 }, ...extra });
}
test('concurrent entries recheck aggregate open risk under the write lock', async () => {
    await db.addSimTransaction({ account_id: 2, type: 'deposit', amount: 1000, txn_date: '2026-09-07' });
    await controls.setPolicy(2, { ...basePolicy, max_open_risk_pct: 1.5 }, 'operator');
    const results = await Promise.allSettled([order('risk-a', 'AAA'), order('risk-b', 'BBB')]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'SIM_RISK_LIMIT');
    assert.equal((await db.listSimTransactions(2)).filter((r) => r.type === 'buy').length, 1);
});
test('position, cash, stale data and daily loss cannot be bypassed; identical replay survives policy changes', async () => {
    const successful = (await db.listSimTransactions(2)).find((r) => r.type === 'buy');
    const key = successful.symbol === 'AAA' ? 'risk-a' : 'risk-b';
    await controls.setPolicy(2, { ...basePolicy, max_position_pct: 1 }, 'buffett');
    const replay = await order(key, successful.symbol);
    assert.equal(replay.id, successful.id);
    await assert.rejects(order('too-large', 'CCC', 2), { code: 'SIM_RISK_LIMIT' });
    await controls.setPolicy(2, { ...basePolicy, min_cash_pct: 95 }, 'buffett');
    await assert.rejects(order('cash-limit', 'CCC'), { code: 'SIM_RISK_LIMIT' });
    await assert.rejects(order('missing-marks', 'CCC', 1, { valuation_quotes: {} }), { code: 'SIM_RISK_DATA_UNAVAILABLE' });
    await controls.setPolicy(2, basePolicy, 'operator');
    await assert.rejects(order('daily-limit', 'CCC', 1, { valuation_quotes: { [successful.symbol]: quote(successful.symbol, 1), CCC: quote('CCC', 100) } }),
        (e) => e.code === 'SIM_RISK_LIMIT' && /max_daily_loss_pct/.test(e.message));
    const q = quote(successful.symbol, 100);
    const sold = await order('exit', successful.symbol, 1, {
        transaction: { account_id: 2, type: 'sell', symbol: successful.symbol, shares: 1, price: 100, txn_date: '2026-09-07' },
        intent: { type: 'sell' }, quote: q, valuation_quotes: {}, trade_plan: undefined,
    });
    assert.equal(sold.type, 'sell');
});

const sample = (equity, net, origin = 'observation', flow = 0) => ({ equity, net_contributions: net, origin, flow,
    captured_at: '2026-09-07T15:00:00.000Z', quotes: {} });
test('time-weighted returns exclude deposits and withdrawals and preserve fees and drawdown', () => {
    const result = performance.calculatePerformance([
        sample(100, 100), sample(110, 100, 'before_flow'), sample(1110, 1100, 'cash_flow', 1000), sample(999, 1100),
    ]);
    assert.equal(result.complete, true);
    assert.ok(Math.abs(result.twr_pct - (-1)) < 1e-8);
    assert.ok(Math.abs(result.max_drawdown_pct - 10) < 1e-8);
    const withdrawal = performance.calculatePerformance([sample(100, 100, 'before_flow'), sample(50, 50, 'cash_flow', -50), sample(55, 50)]);
    assert.ok(Math.abs(withdrawal.twr_pct - 10) < 1e-8);
    assert.equal(performance.calculatePerformance([sample(100, 100), sample(99, 100)]).net_pnl, -1);
});
test('missing marks and unobserved cash-flow boundaries cannot manufacture trustworthy returns', () => {
    assert.equal(performance.calculatePerformance([sample(100, 100), sample(1100, 1100)]).twr_pct, null);
    assert.equal(performance.calculatePerformance([sample(100, 100), sample(null, 100), sample(110, 100)]).twr_pct, null);
});
test('labels and caller metrics alone never satisfy promotion gates', () => {
    const runs = ['backtest', 'out_of_sample', 'paper'].map((run_type) => ({ run_type, total_return_pct: 999, trade_count: 999 }));
    const gates = evaluation.readiness(runs);
    assert.equal(gates.paper.ready, false);
    assert.equal(gates.live.ready, false);
    assert.deepEqual(gates.evidence_types_present, ['backtest', 'out_of_sample', 'paper']);
});
test('evaluation rejects losing and undersampled results even with permissive policy thresholds', () => {
    const policy = evaluation.validateEvaluationPolicy({ min_observations: 10, min_closed_trades: 2, max_drawdown_pct: 20, min_return_pct: 0, min_excess_return_pct: 0 });
    const result = evaluation.assessMetrics({ blockers: [], observation_count: 3, closed_trade_count: 0, twr_pct: -90, max_drawdown_pct: 95, benchmark_return_pct: 5 }, policy);
    assert.equal(result.passed, false);
    assert.ok(result.blockers.includes('return_objective_not_met'));
    assert.ok(result.blockers.includes('insufficient_closed_trades'));
});
test('complete lifecycle scoring aggregates partial exits rather than counting each sell as a trade', () => {
    assert.deepEqual(evaluation.closedLifecycles([
        { id: 1, symbol: 'AAA', type: 'buy', shares: 10, price: 100, amount: 1000, fees: 5, txn_date: '2026-01-01' },
        { id: 2, symbol: 'AAA', type: 'sell', shares: 5, price: 120, amount: 600, fees: 5, txn_date: '2026-01-02' },
        { id: 3, symbol: 'AAA', type: 'sell', shares: 5, price: 90, amount: 450, fees: 5, txn_date: '2026-01-03' },
    ]), [35]);
});

test('DRIP credits offset their linked buy in the same cash snapshot used for risk checks', async () => {
    await controls.setPolicy(1, { max_position_pct: 100, min_cash_pct: 0, max_risk_per_trade_pct: 100,
        max_open_risk_pct: 100, max_daily_loss_pct: 100 }, 'operator');
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 100, txn_date: '2026-09-07' });
    await db.addSimTransaction({ account_id: 1, type: 'buy', symbol: 'DRP', shares: 1, price: 50, txn_date: '2026-09-07' });
    await db.recordSimDividend({ account_id: 1, symbol: 'DRP', amount: 10, txn_date: '2026-09-07',
        idempotency_key: 'drip-credit', reinvestment_mode: 'drip', reinvestment_price: 50 });
    const q = quote('DRP', 50);
    const result = await db.executeSimTradeAtomic({ transaction: { account_id: 1, type: 'buy', symbol: 'DRP', shares: 1, price: 50, txn_date: '2026-09-07' },
        client_order_id: 'spend-correct-cash', intent: { type: 'buy', symbol: 'DRP', shares: 1 }, quote: q, valuation_quotes: { DRP: q } });
    assert.equal(result.amount, 50);
    const locked = await controls.connection(async (c) => controls.valueLedger(await db.loadSimLedgerRows(c, 1), { DRP: q }));
    assert.equal(locked.cash, 0);
    await db.addSimTransaction({ account_id: 1, type: 'deposit', amount: 10, fees: 2, txn_date: '2026-09-07' });
    await assert.rejects(db.addSimTransaction({ account_id: 1, type: 'withdrawal', amount: 8, fees: 1, txn_date: '2026-09-07' }), { code: 'SIM_INSUFFICIENT_CASH' });
});
