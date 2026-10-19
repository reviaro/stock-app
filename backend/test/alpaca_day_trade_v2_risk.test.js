const { test } = require('node:test');
const assert = require('node:assert/strict');
const { computeV2DailyRisk, easternSessionDate } = require('../services/alpaca_day_trade_v2_risk');

const NOW = new Date('2026-09-24T15:00:00Z');
const plan = (patch = {}) => ({ id: 1, symbol: 'XYZ', state: 'active', filled_entry_qty: 10, avg_entry_price: 100,
    filled_exit_qty: 5, avg_exit_price: 80, closed_at: null, ...patch });
const fill = (patch = {}) => ({ execution_id: 'synthetic-buy', plan_id: 1, order_id: 'synthetic-parent',
    symbol: 'XYZ', side: 'buy', role: 'entry', qty: 10, price: 100, executed_at: '2026-09-24T14:00:00Z', ...patch });
const exit = (patch = {}) => fill({ execution_id: 'synthetic-sell', order_id: 'synthetic-stop', side: 'sell', role: 'bracket_exit',
    qty: 5, price: 80, executed_at: '2026-09-24T14:01:00Z', ...patch });
const calculate = (plans = [plan()], fills = [fill(), exit()], now = NOW) => computeV2DailyRisk({ plans, fills, now });

test('daily risk includes realized partial exits while a plan remains open', () => {
    assert.deepEqual(calculate(), { complete: true, sessionDate: '2026-09-24', realizedPnl: -100, fillCount: 1, reasonCodes: [] });
    assert.equal(calculate([plan({ realized_pnl: 999999 })]).realizedPnl, -100, 'cached P&L is never authoritative');
});

test('cost follows execution chronology, not import order or future entry prices', () => {
    const firstBuy = fill({ executed_at: '2026-09-23T14:00:00Z' });
    const firstExit = exit({ executed_at: '2026-09-23T14:01:00Z' });
    const laterBuy = fill({ execution_id: 'later-buy', price: 120, executed_at: '2026-09-24T14:00:00Z' });
    const laterExit = exit({ execution_id: 'later-sell', price: 110, executed_at: '2026-09-24T14:01:00Z' });
    const result = calculate([plan({ filled_entry_qty: 20, avg_entry_price: 110, filled_exit_qty: 10, avg_exit_price: 95 })],
        [laterExit, firstExit, laterBuy, firstBuy]);
    assert.equal(result.complete, true);
    assert.equal(result.realizedPnl, -16.67, 'remaining 5 at 100 plus 10 at 120 cost 113.333 per share before the second exit');
});

test('execution day uses New York midnight in summer and winter, including prior-day entry costs', () => {
    for (const [now, bought, sold, expectedDay, expectedPnl] of [
        ['2026-09-24T02:00:00Z', '2026-09-23T23:00:00Z', '2026-09-24T00:00:00Z', '2026-09-23', -100],
        ['2026-11-03T05:30:00Z', '2026-11-02T20:00:00Z', '2026-11-03T04:30:00Z', '2026-11-03', 0],
        ['2026-11-03T05:30:00Z', '2026-11-02T20:00:00Z', '2026-11-03T05:00:00Z', '2026-11-03', -100],
    ]) {
        const result = calculate([plan()], [fill({ executed_at: bought }), exit({ executed_at: sold })], new Date(now));
        assert.equal(result.sessionDate, expectedDay);
        assert.equal(result.complete, true);
        assert.equal(result.realizedPnl, expectedPnl);
    }
});

test('nanosecond timestamps cannot borrow cost from a later entry within the same millisecond', () => {
    const result = calculate([plan()], [fill({ executed_at: '2026-09-24T14:00:00.000002Z' }),
        exit({ executed_at: '2026-09-24T14:00:00.000001Z' })]);
    assert.equal(result.complete, false);
    assert.ok(result.reasonCodes.includes('EXIT_WITHOUT_ENTRY_COST'));
});

test('identical canonical execution replay counts once and conflicting replay fails closed', () => {
    const execution_id = '12345678-1234-4234-8234-123456789abc';
    const buy = fill({ execution_id });
    const replay = fill({ execution_id: `20260924140000000::${execution_id}` });
    assert.equal(calculate([plan()], [buy, replay, exit()]).realizedPnl, -100);
    assert.equal(calculate([plan()], [buy, { ...replay, execution_id: replay.execution_id.toUpperCase() },
        { ...buy, execution_id: buy.execution_id.toUpperCase() }, exit()]).realizedPnl, -100);
    const conflict = calculate([plan()], [buy, { ...replay, price: 101 }, exit()]);
    assert.equal(conflict.complete, false);
    assert.ok(conflict.reasonCodes.includes('CONFLICTING_EXECUTION'));
});

test('missing, malformed, unlinked, future or inconsistent evidence never becomes zero daily loss', () => {
    const cases = [
        { fills: [fill(), exit({ plan_id: null })] },
        { fills: [fill(), exit({ qty: -1 })] },
        { fills: [fill(), exit({ price: Infinity })] },
        { fills: [fill(), exit({ role: null })] },
        { fills: [fill(), exit({ executed_at: '2026-09-24 14:01:00' })] },
        { fills: [fill(), exit({ executed_at: '2026-02-30T14:01:00Z' })] },
        { fills: [fill(), exit({ executed_at: '2026-09-24T15:00:00.000001Z' })] },
        { fills: [fill(), exit({ qty: 11 })] },
        { plans: [plan({ filled_exit_qty: 4 })] },
        { plans: [plan({ avg_entry_price: null })] },
        { plans: [plan({ state: 'closed', closed_at: '2026-09-24T14:02:00Z' })] },
        { plans: [plan({ state: 'submission_unknown' })] },
    ];
    for (const value of cases) {
        const result = calculate(value.plans, value.fills);
        assert.equal(result.complete, false, JSON.stringify(value));
        assert.equal(result.realizedPnl, null);
        assert.ok(result.reasonCodes.length);
    }
});

test('a new empty v2 strategy has a complete zero result; absent arrays or bad clock do not', () => {
    assert.equal(calculate([], []).realizedPnl, 0);
    assert.equal(computeV2DailyRisk({ plans: [], now: NOW }).complete, false);
    assert.equal(calculate([], [], new Date('invalid')).complete, false);
    assert.equal(easternSessionDate('not a timestamp'), null);
});
