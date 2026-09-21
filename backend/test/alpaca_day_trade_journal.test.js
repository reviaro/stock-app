const { test } = require('node:test');
const assert = require('node:assert');

const {
    assertNoOverfill,
    computeRealizedOutcome,
    exitReasonForBrokerOrderId,
    computeDayTradeJournalAnalytics,
    computeDailyRealizedPnl,
} = require('../services/alpaca_day_trade_journal');

test('assertNoOverfill rejects entry fills that exceed the planned quantity', () => {
    const plan = { id: 1, planned_qty: 10 };
    assert.throws(
        () => assertNoOverfill(plan, { entry: { qty: 11, avgPrice: 100 }, exit: { qty: 0, avgPrice: null } }),
        (err) => err.code === 'ALPACA_FILL_OVERFILL',
    );
});

test('assertNoOverfill rejects exit fills that exceed filled entry quantity, guarding the WS/REST dedup assumption', () => {
    const plan = { id: 1, planned_qty: 10 };
    assert.throws(
        () => assertNoOverfill(plan, { entry: { qty: 10, avgPrice: 100 }, exit: { qty: 11, avgPrice: 98 } }),
        (err) => err.code === 'ALPACA_FILL_OVERFILL',
    );
});

test('assertNoOverfill accepts a fully and correctly filled round trip', () => {
    const plan = { id: 1, planned_qty: 10 };
    assert.doesNotThrow(() => assertNoOverfill(plan, { entry: { qty: 10, avgPrice: 100.50 }, exit: { qty: 10, avgPrice: 98.00 } }));
});

test('computeRealizedOutcome computes P&L and R from volume-weighted entry/exit prices', () => {
    const plan = { planned_risk_dollars: 25 };
    const outcome = computeRealizedOutcome(plan, { entry: { qty: 10, avgPrice: 100.50 }, exit: { qty: 10, avgPrice: 98.00 } });
    assert.strictEqual(outcome.realizedPnl, -25);
    assert.strictEqual(outcome.realizedR, -1);
});

test('computeRealizedOutcome returns a null R when planned risk is unavailable, rather than dividing by zero', () => {
    const plan = { planned_risk_dollars: 0 };
    const outcome = computeRealizedOutcome(plan, { entry: { qty: 10, avgPrice: 100.50 }, exit: { qty: 10, avgPrice: 104.00 } });
    assert.strictEqual(outcome.realizedR, null);
    assert.strictEqual(outcome.realizedPnl, 35);
});

test('exitReasonForBrokerOrderId maps the protective stop and target leg ids to their reasons', () => {
    const plan = { protective_stop_broker_order_id: 'stop-1', protective_target_broker_order_id: 'target-1' };
    assert.strictEqual(exitReasonForBrokerOrderId(plan, 'stop-1'), 'stop_loss');
    assert.strictEqual(exitReasonForBrokerOrderId(plan, 'target-1'), 'take_profit');
});

test('exitReasonForBrokerOrderId falls back to manual for an unrecognized broker order id', () => {
    const plan = { protective_stop_broker_order_id: 'stop-1', protective_target_broker_order_id: 'target-1' };
    assert.strictEqual(exitReasonForBrokerOrderId(plan, 'some-other-order'), 'manual');
    assert.strictEqual(exitReasonForBrokerOrderId(plan, null), 'manual');
});

test('exitReasonForBrokerOrderId preserves management leg roles from the order audit', () => {
    const plan = { id: 7, protective_stop_broker_order_id: 'stop-1', protective_target_broker_order_id: 'target-1' };
    for (const legRole of ['time_exit', 'repair_exit', 'emergency_flatten']) {
        assert.strictEqual(exitReasonForBrokerOrderId(plan, `order-${legRole}`, [
            { broker_order_id: `order-${legRole}`, plan_id: 7, execution_epoch: 'day_trading', leg_role: legRole },
        ]), legRole);
    }
});

test('computeDayTradeJournalAnalytics reuses trade_journal\'s generic analytics via a state->status rename', () => {
    const plans = [
        { state: 'closed', setup: 'breakout', realized_pnl: 100, realized_r: 2 },
        { state: 'closed', setup: 'breakout', realized_pnl: -50, realized_r: -1 },
        { state: 'entry_pending', setup: 'breakout', realized_pnl: null, realized_r: null },
    ];
    const analytics = computeDayTradeJournalAnalytics(plans);
    assert.strictEqual(analytics.closed_trade_count, 2);
    assert.strictEqual(analytics.total_pnl, 50);
    assert.strictEqual(analytics.by_setup.breakout.trade_count, 2);
});

test('computeDailyRealizedPnl sums realized P&L for plans closed on the given session date only', () => {
    const plans = [
        { state: 'closed', closed_at: '2026-09-17T15:00:00Z', realized_pnl: 35 },
        { state: 'closed', closed_at: '2026-09-17T20:00:00Z', realized_pnl: -25 },
        { state: 'closed', closed_at: '2026-09-16T15:00:00Z', realized_pnl: 999 }, // a different day
        { state: 'entry_pending', closed_at: null, realized_pnl: null }, // not yet closed
    ];
    assert.strictEqual(computeDailyRealizedPnl(plans, '2026-09-17'), 10);
});

test('computeDailyRealizedPnl returns zero, not NaN, when nothing closed on the given date', () => {
    assert.strictEqual(computeDailyRealizedPnl([], '2026-09-17'), 0);
});
