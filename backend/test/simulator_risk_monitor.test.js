const { test } = require('node:test');
const assert = require('node:assert');
const { buildRiskMonitor } = require('../services/simulator_risk_monitor');

test('risk monitor warns when an open position has no active plan', () => {
    const result = buildRiskMonitor({
        holdings: { AAPL: { shares: 10, avg_cost: 100 } },
        plans: [],
        quotes: { AAPL: { price: 101 } },
        checkedAt: '2026-08-11T15:00:00.000Z',
    });
    assert.strictEqual(result.read_only, true);
    assert.strictEqual(result.alerts[0].type, 'missing_plan');
    assert.strictEqual(result.alerts[0].symbol, 'AAPL');
});

test('risk monitor reports stop breaches and targets without execution instructions', () => {
    const plans = [{ id: 7, status: 'active', symbol: 'XOM', stop_price: 98, target_price: 105, invalidation: 'loses VWAP' }];
    const stopped = buildRiskMonitor({
        holdings: { XOM: { shares: 10, avg_cost: 100 } }, plans,
        quotes: { XOM: { price: 97.5 } }, checkedAt: '2026-08-11T15:00:00.000Z',
    });
    assert.strictEqual(stopped.alerts[0].type, 'stop_breached');
    assert.strictEqual(stopped.alerts[0].severity, 'critical');
    assert.ok(!Object.hasOwn(stopped.alerts[0], 'order'));

    const target = buildRiskMonitor({
        holdings: { XOM: { shares: 10, avg_cost: 100 } }, plans,
        quotes: { XOM: { price: 106 } }, checkedAt: '2026-08-11T15:00:00.000Z',
    });
    assert.strictEqual(target.alerts[0].type, 'target_hit');
});

test('risk monitor marks unavailable and stale quotes as data-risk alerts', () => {
    const plans = [{ id: 1, status: 'active', symbol: 'MSFT', stop_price: 98, target_price: 105 }];
    const unavailable = buildRiskMonitor({
        holdings: { MSFT: { shares: 1, avg_cost: 100 } }, plans, quotes: {},
        checkedAt: '2026-08-11T15:00:00.000Z', marketOpen: true,
    });
    assert.strictEqual(unavailable.alerts[0].type, 'price_unavailable');

    const stale = buildRiskMonitor({
        holdings: { MSFT: { shares: 1, avg_cost: 100 } }, plans,
        quotes: { MSFT: { price: 101, timestamp: '2026-08-11T14:50:00.000Z' } },
        checkedAt: '2026-08-11T15:00:00.000Z', marketOpen: true, staleAfterSeconds: 180,
    });
    assert.strictEqual(stale.alerts[0].type, 'stale_price');
});

test('risk monitor exposes quote source and market state without enabling execution', () => {
    const result = buildRiskMonitor({
        holdings: { MSFT: { shares: 10, avg_cost: 210 } },
        plans: [{ id: 1, status: 'active', symbol: 'MSFT', shares: 10, stop_price: 200, target_price: 230 }],
        quotes: {
            MSFT: {
                price: 215,
                timestamp: '2026-08-11T15:00:00Z',
                market_state: 'REGULAR',
                data_source: 'alpaca_iex',
            },
        },
        checkedAt: '2026-08-11T15:00:30Z',
        marketOpen: true,
    });

    assert.strictEqual(result.positions[0].data_source, 'alpaca_iex');
    assert.strictEqual(result.positions[0].market_state, 'REGULAR');
    assert.strictEqual(result.read_only, true);
    assert.strictEqual(result.execution_enabled, false);
});

test('risk monitor treats an explicit null quote as unavailable rather than zero', () => {
    const result = buildRiskMonitor({
        holdings: { MSFT: { shares: 10, avg_cost: 210 } },
        plans: [{ id: 1, symbol: 'MSFT', status: 'active', shares: 10, stop_price: 205, target_price: 220 }],
        quotes: { MSFT: { price: null, timestamp: null } },
    });
    assert.strictEqual(result.alerts[0].type, 'price_unavailable');
});

test('risk monitor reports a plan whose documented share count does not cover the position', () => {
    const result = buildRiskMonitor({
        holdings: { NVDA: { shares: 12, avg_cost: 100 } },
        plans: [{ id: 5, symbol: 'NVDA', status: 'active', shares: 10, stop_price: 95, target_price: 110 }],
        quotes: { NVDA: { price: 101, timestamp: '2026-08-11T14:00:00.000Z' } },
        checkedAt: '2026-08-11T14:00:05.000Z',
        marketOpen: true,
    });
    assert.strictEqual(result.alerts[0].type, 'plan_share_mismatch');
    assert.strictEqual(result.alerts[0].severity, 'critical');
});

test('risk monitor reports active plans with no matching position', () => {
    const result = buildRiskMonitor({
        holdings: {},
        plans: [{ id: 2, status: 'active', symbol: 'NVDA', stop_price: 90, target_price: 110 }],
        quotes: {}, checkedAt: '2026-08-11T15:00:00.000Z',
    });
    assert.strictEqual(result.alerts[0].type, 'orphan_plan');
});
