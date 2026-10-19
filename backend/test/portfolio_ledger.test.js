const { test } = require('node:test');
const assert = require('node:assert');
const {
  computeHoldings,
  computeCashBalance,
  computeRealizedPnl,
  computeUnrealizedPnl,
  buildSummary,
} = require('../services/portfolio_ledger');

test('single buy -> holdings show correct shares and avg_cost', () => {
  const txns = [{ type: 'buy', symbol: 'AAPL', shares: 10, price: 150, amount: 1500, fees: 0, txn_date: '2026-01-01' }];
  const holdings = computeHoldings(txns);
  assert.strictEqual(holdings.AAPL.shares, 10);
  assert.strictEqual(holdings.AAPL.avg_cost, 150);
  assert.strictEqual(holdings.AAPL.total_cost, 1500);
});

test('two buys -> weighted avg_cost', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 200, amount: 2000, fees: 0, txn_date: '2026-02-01' },
  ];
  const holdings = computeHoldings(txns);
  assert.strictEqual(holdings.AAPL.shares, 20);
  assert.strictEqual(holdings.AAPL.avg_cost, 150);
});

test('buy + partial sell -> reduced shares, same avg_cost', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-01' },
    { type: 'sell', symbol: 'AAPL', shares: 4, price: 150, amount: 600, fees: 0, txn_date: '2026-02-01' },
  ];
  const holdings = computeHoldings(txns);
  assert.strictEqual(holdings.AAPL.shares, 6);
  assert.strictEqual(holdings.AAPL.avg_cost, 100);
});

test('sell-all then rebuy -> fresh avg_cost', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-01' },
    { type: 'sell', symbol: 'AAPL', shares: 10, price: 150, amount: 1500, fees: 0, txn_date: '2026-02-01' },
    { type: 'buy', symbol: 'AAPL', shares: 5, price: 180, amount: 900, fees: 0, txn_date: '2026-03-01' },
  ];
  const holdings = computeHoldings(txns);
  assert.strictEqual(holdings.AAPL.shares, 5);
  assert.strictEqual(holdings.AAPL.avg_cost, 180);
});

test('dividends accumulate on holdings', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-01' },
    { type: 'dividend', symbol: 'AAPL', amount: 25, fees: 0, txn_date: '2026-02-15' },
    { type: 'dividend', symbol: 'AAPL', amount: 25, fees: 0, txn_date: '2026-05-15' },
  ];
  const holdings = computeHoldings(txns);
  assert.strictEqual(holdings.AAPL.dividends_received, 50);
});

test('cash balance: deposits + sells + dividends - buys - withdrawals - fees', () => {
  const txns = [
    { type: 'deposit', amount: 10000, fees: 0, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 150, amount: 1500, fees: 1, txn_date: '2026-01-02' },
    { type: 'sell', symbol: 'AAPL', shares: 5, price: 200, amount: 1000, fees: 1, txn_date: '2026-02-01' },
    { type: 'dividend', symbol: 'AAPL', amount: 25, fees: 0, txn_date: '2026-03-01' },
    { type: 'withdrawal', amount: 500, fees: 0, txn_date: '2026-04-01' },
  ];
  assert.strictEqual(computeCashBalance(txns), 9023);
});

test('realized P&L on partial sell', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-01' },
    { type: 'sell', symbol: 'AAPL', shares: 4, price: 150, amount: 600, fees: 0, txn_date: '2026-02-01' },
  ];
  const realized = computeRealizedPnl(txns);
  assert.strictEqual(realized.total, 200);
});

test('realized P&L filters by year', () => {
  const txns = [
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2025-01-01' },
    { type: 'sell', symbol: 'AAPL', shares: 4, price: 150, amount: 600, fees: 0, txn_date: '2025-06-01' },
    { type: 'sell', symbol: 'AAPL', shares: 2, price: 180, amount: 360, fees: 0, txn_date: '2026-02-01' },
  ];
  const realized = computeRealizedPnl(txns, 2026);
  assert.strictEqual(realized.total, 160);
});

test('unrealized P&L uses currentPrices map', () => {
  const holdings = { AAPL: { shares: 10, avg_cost: 100, total_cost: 1000, dividends_received: 0 } };
  const unrealized = computeUnrealizedPnl(holdings, { AAPL: 150 });
  assert.strictEqual(unrealized.AAPL, 500);
});

test('buildSummary composes everything', () => {
  const txns = [
    { type: 'deposit', amount: 10000, fees: 0, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'AAPL', shares: 10, price: 100, amount: 1000, fees: 0, txn_date: '2026-01-02' },
  ];
  const summary = buildSummary(txns, { AAPL: 120 });
  assert.strictEqual(summary.cash, 9000);
  assert.strictEqual(summary.holdings.AAPL.shares, 10);
  assert.strictEqual(summary.unrealized.AAPL, 200);
  assert.strictEqual(summary.totalValue, 10200);
  assert.strictEqual(summary.positionsValue, 1200);
});

test('missing or invalid prices leave whole-portfolio totals unavailable while preserving ledger facts', () => {
  const txns = [
    { type: 'deposit', amount: 1000, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'TEST', shares: 5, price: 100, amount: 500, txn_date: '2026-01-02' },
  ];
  for (const price of [undefined, null, NaN, Infinity, -1, 0, '100']) {
    const summary = buildSummary(txns, { TEST: price });
    assert.strictEqual(summary.cash, 500);
    assert.strictEqual(summary.holdings.TEST.shares, 5);
    assert.strictEqual(summary.totalValue, null);
    assert.strictEqual(summary.holdingsValue, null);
    assert.strictEqual(summary.cashPct, null);
    assert.strictEqual(summary.unrealizedTotal, null);
    assert.strictEqual(summary.valuationComplete, false);
    assert.deepStrictEqual(summary.missingPriceSymbols, ['TEST']);
  }
  const restored = buildSummary(txns, { TEST: 100 });
  assert.strictEqual(restored.totalValue, 1000);
  assert.strictEqual(restored.cashPct, 50);
  assert.strictEqual(restored.valuationComplete, true);
});

test('a fully sold holding retained for dividends does not require a quote', () => {
  const txns = [
    { type: 'deposit', amount: 1000, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'TEST', shares: 5, price: 100, amount: 500, txn_date: '2026-01-02' },
    { type: 'dividend', symbol: 'TEST', amount: 10, txn_date: '2026-01-03' },
    { type: 'sell', symbol: 'TEST', shares: 5, price: 110, amount: 550, txn_date: '2026-01-04' },
  ];
  const summary = buildSummary(txns, {});
  assert.strictEqual(summary.valuationComplete, true);
  assert.strictEqual(summary.totalValue, 1060);
  assert.strictEqual(summary.cashPct, 100);
  assert.strictEqual(summary.unrealizedTotal, 0);
});
