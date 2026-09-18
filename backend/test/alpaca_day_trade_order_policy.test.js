const { test } = require('node:test');
const assert = require('node:assert');

const { floorToTick } = require('../services/alpaca_market_data');
const {
    DEFAULT_DAY_TRADE_POLICY,
    buildDayTradeBracketOrder,
    assertTickAligned,
} = require('../services/alpaca_day_trade_order_policy');

function baseIntent(overrides = {}) {
    return {
        symbol: 'NVDA',
        qty: 100,
        setup: 'opening_breakout',
        catalyst: 'earnings beat',
        thesis: 'holding above prior day high with volume',
        invalidation: 'loss of VWAP',
        stop_price: 98.00,
        target_price: 104.00,
        exit_deadline: '2026-09-17T19:45:00.000Z',
        ...overrides,
    };
}

function baseQuote(overrides = {}) {
    return {
        symbol: 'NVDA', bidPrice: 99.98, bidSize: 2, askPrice: 100.00, askSize: 1,
        sourceTimestamp: '2026-09-17T13:30:00.000Z', feed: 'iex', retrievedAt: '2026-09-17T13:30:00.500Z',
        ...overrides,
    };
}

function baseClock(overrides = {}) {
    return { is_open: true, next_close: '2026-09-17T20:00:00.000Z', ...overrides };
}

function baseAccount(overrides = {}) {
    return {
        cash: 50000, equity: 100000, buying_power: 200000,
        status: 'ACTIVE', trading_blocked: false, account_blocked: false,
        ...overrides,
    };
}

function baseAsset(overrides = {}) {
    return { class: 'us_equity', status: 'active', tradable: true, ...overrides };
}

function baseRiskContext(overrides = {}) {
    return { hasActivePlanForSymbol: false, currentOpenRiskDollars: 0, dailyRealizedPnl: 0, ...overrides };
}

function enabledPolicy(overrides = {}) {
    return { ...DEFAULT_DAY_TRADE_POLICY, entriesEnabled: true, ...overrides };
}

function build(overrides = {}) {
    return buildDayTradeBracketOrder({
        intent: baseIntent(),
        quote: baseQuote(),
        clock: baseClock(),
        account: baseAccount(),
        asset: baseAsset(),
        riskContext: baseRiskContext(),
        policy: enabledPolicy(),
        now: new Date('2026-09-17T13:30:01.000Z'),
        ...overrides,
    });
}

test('builds a bracket order with a bounded entry, stop-market child, and limit target child', () => {
    const result = build();

    // Derived from the same primitives the implementation uses (floorToTick over the
    // slippage-bounded ask), not a hand-picked round number: 100 * 1.005 is not exact in
    // floating point, so the true floored entry is 100.49, not 100.50.
    const expectedEntry = floorToTick(100.00 * (1 + DEFAULT_DAY_TRADE_POLICY.maxSlippagePct));
    const expectedRiskPerShare = expectedEntry - 98.00;
    const expectedPlannedRisk = 100 * expectedRiskPerShare;
    const expectedRewardRisk = (104.00 - expectedEntry) / expectedRiskPerShare;

    assert.strictEqual(result.order.symbol, 'NVDA');
    assert.strictEqual(result.order.side, 'buy');
    assert.strictEqual(result.order.qty, 100);
    assert.strictEqual(result.order.type, 'limit');
    assert.strictEqual(result.order.limit_price, expectedEntry);
    assert.strictEqual(result.order.time_in_force, 'day');
    assert.strictEqual(result.order.extended_hours, false);
    assert.strictEqual(result.order.order_class, 'bracket');

    assert.deepStrictEqual(result.order.stop_loss, { stop_price: 98.00 });
    assert.deepStrictEqual(result.order.take_profit, { limit_price: 104.00 });

    assert.ok(Math.abs(result.plannedRiskDollars - expectedPlannedRisk) < 1e-9);
    assert.ok(Math.abs(result.plannedRewardRisk - expectedRewardRisk) < 1e-9);
});

test('rejects a stop price at or above the computed entry price', () => {
    assert.throws(
        () => build({ intent: baseIntent({ stop_price: 101 }) }),
        (err) => err.code === 'ALPACA_BRACKET_GEOMETRY_INVALID',
    );
});

test('rejects a target price at or below the computed entry price', () => {
    assert.throws(
        () => build({ intent: baseIntent({ target_price: 100 }) }),
        (err) => err.code === 'ALPACA_BRACKET_GEOMETRY_INVALID',
    );
});

test('rejects non-integer, zero, and negative share quantities', () => {
    for (const qty of [10.5, 0, -5]) {
        assert.throws(
            () => build({ intent: baseIntent({ qty }) }),
            (err) => err.code === 'ALPACA_QTY_INVALID',
            `expected qty ${qty} to be rejected`,
        );
    }
});

test('rejects an order whose cost exceeds cash, even when buying power (margin) would cover it', () => {
    assert.throws(
        () => build({ account: baseAccount({ cash: 1000, buying_power: 200000 }) }),
        (err) => err.code === 'ALPACA_INSUFFICIENT_CASH',
    );
});

test('rejects a position exceeding the max position size as a percentage of equity', () => {
    // qty 300 * entry 100.50 = 30150 = 30.15% of 100000 equity, over the 25% cap
    assert.throws(
        () => build({ intent: baseIntent({ qty: 300 }), account: baseAccount({ cash: 60000 }) }),
        (err) => err.code === 'ALPACA_POSITION_LIMIT_EXCEEDED',
    );
});

test('rejects planned risk exceeding the max risk-per-trade percentage of equity', () => {
    // qty 50, stop 80 -> riskPerShare 20.50, plannedRisk 1025 = 1.025% of equity, over the 1% cap
    // position value 50 * 100.50 = 5025 = 5.025% of equity, well under the 25% cap
    assert.throws(
        () => build({ intent: baseIntent({ qty: 50, stop_price: 80, target_price: 110 }) }),
        (err) => err.code === 'ALPACA_RISK_PER_TRADE_EXCEEDED',
    );
});

test('rejects planned risk that would push total open risk over the daily cap', () => {
    // this trade's own risk is a well-within-limits 250 (0.25%), but 1800 of risk is already
    // open elsewhere, so total 2050 = 2.05% of equity breaches the 2% total-open-risk cap
    assert.throws(
        () => build({ riskContext: baseRiskContext({ currentOpenRiskDollars: 1800 }) }),
        (err) => err.code === 'ALPACA_TOTAL_OPEN_RISK_EXCEEDED',
    );
});

test('rejects an entry that would leave less than the minimum cash reserve', () => {
    // cash 15000, cost 10050 -> remaining 4950 = 4.95% of equity, under the 10% reserve floor
    assert.throws(
        () => build({ account: baseAccount({ cash: 15000 }) }),
        (err) => err.code === 'ALPACA_MIN_CASH_RESERVE_BREACHED',
    );
});

test('rejects a new entry once the daily loss limit has been breached', () => {
    assert.throws(
        () => build({ riskContext: baseRiskContext({ dailyRealizedPnl: -2100 }) }),
        (err) => err.code === 'ALPACA_DAILY_LOSS_LIMIT_BREACHED',
    );
});

test('rejects a new entry when a nonterminal plan already exists for the symbol', () => {
    assert.throws(
        () => build({ riskContext: baseRiskContext({ hasActivePlanForSymbol: true }) }),
        (err) => err.code === 'ALPACA_DUPLICATE_SYMBOL_PLAN',
    );
});

test('rejects stop and target prices that are not aligned to the Alpaca tick size', () => {
    assert.throws(
        () => build({ intent: baseIntent({ stop_price: 98.005 }) }),
        (err) => err.code === 'ALPACA_PRICE_NOT_TICK_ALIGNED',
    );
    assert.throws(
        () => build({ intent: baseIntent({ target_price: 104.001 }) }),
        (err) => err.code === 'ALPACA_PRICE_NOT_TICK_ALIGNED',
    );
});

test('rejects entries outright when the market is closed, independent of cutoff timing', () => {
    assert.throws(
        () => build({ clock: baseClock({ is_open: false, next_close: '2026-09-18T13:30:00.000Z' }) }),
        (err) => err.code === 'ALPACA_MARKET_CLOSED',
    );
});

test('rejects entries placed within the configured buffer before the market close', () => {
    assert.throws(
        () => build({
            clock: baseClock({ next_close: '2026-09-17T13:40:00.000Z' }),
            now: new Date('2026-09-17T13:30:01.000Z'),
        }),
        (err) => err.code === 'ALPACA_ENTRY_CUTOFF_PASSED',
    );
});

test('rejects an intent carrying any field outside the allowed caller-facing set', () => {
    for (const extra of [
        { order_class: 'bracket' },
        { trailing_stop: true },
        { trail_percent: 0.01 },
        { targets: [104, 106] },
        { limit_price: 99 },
        { feed: 'sip' },
        { raw: {} },
        { notional: 1000 },
    ]) {
        assert.throws(
            () => build({ intent: baseIntent(extra) }),
            (err) => err.code === 'ALPACA_INTENT_FIELD_NOT_ALLOWED',
            `expected ${Object.keys(extra)[0]} to be rejected`,
        );
    }
});

test('rejects entries by default; entries must be explicitly enabled in policy', () => {
    assert.throws(
        () => build({ policy: DEFAULT_DAY_TRADE_POLICY }),
        (err) => err.code === 'ALPACA_ENTRIES_DISABLED',
    );
});

test('rejects an asset that is not an active, tradable US equity', () => {
    assert.throws(
        () => build({ asset: baseAsset({ status: 'inactive' }) }),
        (err) => err.code === 'ALPACA_ASSET_NOT_TRADABLE',
    );
    assert.throws(
        () => build({ asset: baseAsset({ tradable: false }) }),
        (err) => err.code === 'ALPACA_ASSET_NOT_TRADABLE',
    );
    assert.throws(
        () => build({ asset: baseAsset({ class: 'crypto' }) }),
        (err) => err.code === 'ALPACA_ASSET_NOT_TRADABLE',
    );
});

test('rejects an account that is inactive or trading/account blocked', () => {
    assert.throws(
        () => build({ account: baseAccount({ status: 'SUBMITTED' }) }),
        (err) => err.code === 'ALPACA_ACCOUNT_NOT_TRADABLE',
    );
    assert.throws(
        () => build({ account: baseAccount({ trading_blocked: true }) }),
        (err) => err.code === 'ALPACA_ACCOUNT_NOT_TRADABLE',
    );
    assert.throws(
        () => build({ account: baseAccount({ account_blocked: true }) }),
        (err) => err.code === 'ALPACA_ACCOUNT_NOT_TRADABLE',
    );
});

test('rejects missing or non-numeric stop and target prices with a coded error, not a raw one', () => {
    for (const overrides of [{ stop_price: undefined }, { stop_price: null }, { stop_price: 'abc' }]) {
        assert.throws(
            () => build({ intent: baseIntent(overrides) }),
            (err) => err.code === 'ALPACA_PRICE_INVALID',
            `expected ${JSON.stringify(overrides)} to be rejected with a coded error`,
        );
    }
    assert.throws(
        () => build({ intent: baseIntent({ target_price: undefined }) }),
        (err) => err.code === 'ALPACA_PRICE_INVALID',
    );
});

test('accepts already tick-aligned sub-dollar and fractional prices without falsely rejecting them', () => {
    // 1.15 * 100 and 0.6789 * 10000 are not exact in floating point, so a check that compares
    // against floorToTick's always-down rounding would wrongly reject these valid ticks.
    assert.doesNotThrow(() => assertTickAligned(1.15, 'test price'));
    assert.doesNotThrow(() => assertTickAligned(0.6789, 'test price'));
});

test('rejects an intent symbol that does not match the quote symbol', () => {
    assert.throws(
        () => build({ intent: baseIntent({ symbol: 'AMD' }) }),
        (err) => err.code === 'ALPACA_SYMBOL_MISMATCH',
    );
});
