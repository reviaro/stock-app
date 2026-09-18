const { test } = require('node:test');
const assert = require('node:assert');

const { computeBoundedEntryPrice, assertRegularMarketHoursOpen } = require('../services/alpaca_day_trade_quote_policy');

test('computes a marketable bounded entry price above the ask, capped by the slippage allowance', () => {
    const price = computeBoundedEntryPrice({ quote: { askPrice: 176.50 }, side: 'buy', maxSlippagePct: 0.005 });
    assert.strictEqual(price, 177.38);
    assert.ok(price > 176.50, 'must be marketable: at or above the current ask');
    assert.ok(price <= 176.50 * 1.005 + 1e-9, 'must not exceed the bounded slippage allowance');
});

test('floors the bounded entry price to Alpaca tick precision, never rounding up past the bound', () => {
    // 150 * 1.00378 = 150.567 exactly (verified independently): nearest-tick rounding would
    // give 150.57, which exceeds the 150.567 bound this order is not allowed to pay past.
    const price = computeBoundedEntryPrice({ quote: { askPrice: 150 }, side: 'buy', maxSlippagePct: 0.00378 });
    assert.strictEqual(price, 150.56);
});

test('rejects a sell-side entry price: Day Trading entries are long-only in phase 1', () => {
    assert.throws(
        () => computeBoundedEntryPrice({ quote: { askPrice: 176.50 }, side: 'sell' }),
        (err) => err.code === 'ALPACA_ENTRY_SIDE_UNSUPPORTED',
    );
});

test('rejects computing an entry price without a valid ask', () => {
    assert.throws(
        () => computeBoundedEntryPrice({ quote: { askPrice: 0 }, side: 'buy' }),
        (err) => err.code === 'ALPACA_QUOTE_UNAVAILABLE',
    );
});

test('enforces regular market hours before allowing entry pricing', () => {
    assert.throws(
        () => assertRegularMarketHoursOpen({ is_open: false }),
        (err) => err.code === 'ALPACA_MARKET_CLOSED',
    );
    assert.doesNotThrow(() => assertRegularMarketHoursOpen({ is_open: true }));
});
