const { test } = require('node:test');
const assert = require('node:assert');
const {
    normalizeTradePlan,
    closeStructuredTrade,
    computeJournalAnalytics,
} = require('../services/trade_journal');

test('normalizeTradePlan accepts a measurable long-only plan', () => {
    const plan = normalizeTradePlan({
        account_id: 2,
        symbol: 'xom',
        setup: 'catalyst continuation',
        catalyst: 'oil supply shock',
        thesis: 'Relative strength persists after the open.',
        planned_entry: 100,
        stop_price: 98,
        target_price: 104,
        shares: 50,
        invalidation: 'Loses the opening range low.',
    });

    assert.strictEqual(plan.symbol, 'XOM');
    assert.strictEqual(plan.planned_risk, 100);
    assert.strictEqual(plan.planned_reward, 200);
    assert.strictEqual(plan.reward_risk_ratio, 2);
    assert.strictEqual(plan.status, 'active');
});

test('normalizeTradePlan rejects a stop that is not below entry and a target that is not above entry', () => {
    assert.throws(() => normalizeTradePlan({
        account_id: 2, symbol: 'XOM', setup: 'breakout', thesis: 'x',
        planned_entry: 100, stop_price: 101, target_price: 99, shares: 10,
    }), /stop_price must be below planned_entry/);
});

test('closeStructuredTrade calculates realized P&L and R from planned risk', () => {
    const plan = normalizeTradePlan({
        account_id: 2, symbol: 'MSFT', setup: 'earnings continuation', thesis: 'x',
        planned_entry: 100, stop_price: 98, target_price: 105, shares: 10,
    });
    const closed = closeStructuredTrade(plan, {
        exit_price: 104,
        fees: 2,
        exit_reason: 'time_exit',
        thesis_valid: true,
    });

    assert.strictEqual(closed.realized_pnl, 38);
    assert.strictEqual(closed.realized_r, 1.9);
    assert.strictEqual(closed.status, 'closed');
    assert.strictEqual(closed.exit_reason, 'time_exit');
});

test('closeStructuredTrade uses the actual closed position size while keeping original planned risk', () => {
    const plan = normalizeTradePlan({
        account_id: 2, symbol: 'MSFT', setup: 'earnings continuation', thesis: 'x',
        planned_entry: 100, stop_price: 98, target_price: 105, shares: 10,
    });
    const closed = closeStructuredTrade(plan, {
        exit_price: 104,
        shares: 15,
        cost_basis: 1550,
        exit_reason: 'time_exit',
        thesis_valid: true,
    });

    assert.strictEqual(closed.realized_pnl, 10);
    assert.strictEqual(closed.realized_r, 0.5);
});

test('computeJournalAnalytics reports expectancy, profit factor, average R and setup groups', () => {
    const rows = [
        { status: 'closed', setup: 'breakout', realized_pnl: 200, realized_r: 2 },
        { status: 'closed', setup: 'breakout', realized_pnl: -100, realized_r: -1 },
        { status: 'closed', setup: 'reversal', realized_pnl: 50, realized_r: 0.5 },
        { status: 'active', setup: 'reversal', realized_pnl: null, realized_r: null },
    ];

    const result = computeJournalAnalytics(rows);
    assert.strictEqual(result.closed_trade_count, 3);
    assert.strictEqual(result.win_rate_pct, 66.67);
    assert.strictEqual(result.expectancy, 50);
    assert.strictEqual(result.profit_factor, 2.5);
    assert.strictEqual(result.average_r, 0.5);
    assert.deepStrictEqual(result.by_setup.breakout, {
        trade_count: 2,
        win_rate_pct: 50,
        expectancy: 50,
        average_r: 0.5,
        total_pnl: 100,
    });
});
