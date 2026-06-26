const { test } = require('node:test');
const assert = require('node:assert');
const { buildSimulatorReview, simulatorTransactionsToCsv } = require('../services/simulator_review');

test('buildSimulatorReview summarizes cash, positions, return and action notes', () => {
    const txns = [
        { id: 1, type: 'deposit', amount: 10000, txn_date: '2026-01-01' },
        { id: 2, type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-02', notes: 'Buffett daily simulator: quality buy' },
    ];

    const review = buildSimulatorReview(txns, { AAPL: 120 });
    assert.strictEqual(review.starting_capital, 10000);
    assert.strictEqual(review.cash, 9000);
    assert.strictEqual(review.holdings_value, 1200);
    assert.strictEqual(review.total_value, 10200);
    assert.strictEqual(review.total_return_pct, 2);
    assert.strictEqual(review.unrealized_pnl, 200);
    assert.strictEqual(review.recent_buffett_actions.length, 1);
});

test('simulatorTransactionsToCsv includes notes for review', () => {
    const csv = simulatorTransactionsToCsv([
        { id: 1, type: 'buy', symbol: 'MSFT', shares: 2, price: 50, amount: 100, fees: 0, txn_date: '2026-01-01', notes: 'thesis' },
    ]);
    assert.match(csv, /"notes"/);
    assert.match(csv, /"thesis"/);
});
