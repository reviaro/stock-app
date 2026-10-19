const { test } = require('node:test');
const assert = require('node:assert');

const {
    buildV2EntryOrder, buildTimeExitOrder, timeExitClientOrderId, ALLOWED_INTENT_FIELDS, DEFAULT_V2_POLICY,
} = require('../services/alpaca_day_trade_v2_policy');

const NOW = new Date('2026-09-23T15:00:00.000Z');

function inputs(overrides = {}) {
    const { intent = {}, account = {}, clock = {}, asset = {}, quote = {}, context = {}, ...rest } = overrides;
    return {
        intent: {
            account_id: 2,
            client_order_id: 'dt2-20260923-nvda-orb',
            symbol: 'nvda',
            qty: 10,
            setup: 'opening-range breakout',
            catalyst: 'earnings beat',
            thesis: 'holds above the opening range',
            invalidation: 'loses VWAP',
            stop: 98,
            target: 104,
            exit_deadline: '2026-09-23T19:30:00.000Z',
            ...intent,
        },
        account: { status: 'ACTIVE', trading_blocked: false, account_blocked: false, cash: '50000', equity: '100000', buying_power: '400000', ...account },
        clock: { is_open: true, next_close: '2026-09-23T20:00:00.000Z', ...clock },
        asset: { class: 'us_equity', status: 'active', tradable: true, ...asset },
        quote: { symbol: 'NVDA', quote: { t: '2026-09-23T14:59:58.000Z', bp: 99.98, bs: 3, ap: 100.00, as: 2 }, ...quote },
        openOrders: [],
        context: { hasActivePlanForSymbol: false, currentOpenRiskDollars: 0,
            dailyRisk: { complete: true, sessionDate: '2026-09-23', realizedPnl: 0 }, ...context },
        now: NOW,
        ...rest,
    };
}

function rejectsWith(code, overrides) {
    assert.throws(() => buildV2EntryOrder(inputs(overrides)), (err) => err.code === code, `expected ${code}`);
}

test('builds exactly one long, DAY, regular-hours bracket with a sell-limit target and a sell stop-market loss', () => {
    const built = buildV2EntryOrder(inputs());
    assert.deepStrictEqual(built.order, {
        symbol: 'NVDA',
        qty: 10,
        side: 'buy',
        type: 'limit',
        limit_price: 100.5,
        time_in_force: 'day',
        extended_hours: false,
        order_class: 'bracket',
        take_profit: { limit_price: 104 },
        stop_loss: { stop_price: 98 },
        client_order_id: 'dt2-20260923-nvda-orb',
    });
    assert.strictEqual(built.plan.planned_entry_price, 100.5);
    assert.strictEqual(built.plan.planned_risk_dollars, 25);
    assert.strictEqual(built.plan.symbol, 'NVDA');
    assert.strictEqual(built.plan.exit_deadline, '2026-09-23T19:30:00.000Z');
});

test('the caller allowlist is exactly the documented intent fields', () => {
    assert.deepStrictEqual([...ALLOWED_INTENT_FIELDS].sort(), [
        'account_id', 'catalyst', 'client_order_id', 'exit_deadline', 'invalidation', 'qty', 'setup', 'stop', 'symbol', 'target', 'thesis',
        'setup_id', 'strategy_version', 'catalyst_class', 'candidate_evidence',
    ].sort());
});

test('rejects every field outside the allowlist, including broker-owned ones', () => {
    for (const field of ['limit_price', 'order_class', 'time_in_force', 'extended_hours', 'type', 'side', 'feed', 'notional', 'stop_limit_price', 'base_url']) {
        rejectsWith('ALPACA_V2_FIELD_NOT_ALLOWED', { intent: { [field]: 'x' } });
    }
});

test('requires account 2 and a v2 client order id', () => {
    rejectsWith('ALPACA_V2_ACCOUNT_SCOPE_REQUIRED', { intent: { account_id: 1 } });
    rejectsWith('ALPACA_V2_ACCOUNT_SCOPE_REQUIRED', { intent: { account_id: '2' } });
    for (const id of ['dt-20260923-nvda', '', 'dt2-', 'dt2-has space', `dt2-${'a'.repeat(101)}`]) {
        rejectsWith('ALPACA_V2_CLIENT_ORDER_ID_INVALID', { intent: { client_order_id: id } });
    }
});

test('rejects non-whole, non-positive, or non-numeric quantities', () => {
    for (const qty of [0, -1, 1.5, '10', null, Number.NaN]) rejectsWith('ALPACA_V2_QTY_INVALID', { intent: { qty } });
});

test('requires every strategy field', () => {
    for (const field of ['setup', 'catalyst', 'thesis', 'invalidation']) {
        rejectsWith('ALPACA_V2_STRATEGY_FIELDS_REQUIRED', { intent: { [field]: '  ' } });
    }
});

test('rejects non-US-equity or nontradable assets and an untradable account', () => {
    rejectsWith('ALPACA_V2_ASSET_NOT_TRADABLE', { asset: { class: 'crypto' } });
    rejectsWith('ALPACA_V2_ASSET_NOT_TRADABLE', { asset: { tradable: false } });
    rejectsWith('ALPACA_V2_ASSET_NOT_TRADABLE', { asset: { status: 'inactive' } });
    rejectsWith('ALPACA_V2_ACCOUNT_NOT_TRADABLE', { account: { trading_blocked: true } });
});

test('rejects a closed market and entries inside the pre-close cutoff', () => {
    rejectsWith('ALPACA_V2_MARKET_CLOSED', { clock: { is_open: false } });
    rejectsWith('ALPACA_V2_ENTRY_CUTOFF_PASSED', { clock: { next_close: '2026-09-23T15:10:00.000Z' }, intent: { exit_deadline: '2026-09-23T15:05:00.000Z' } });
});

test('rejects an exit deadline that is past, unparseable, or after the session close', () => {
    for (const exit_deadline of ['2026-09-23T14:00:00.000Z', 'soon', '2026-09-23T20:30:00.000Z']) {
        rejectsWith('ALPACA_V2_EXIT_DEADLINE_INVALID', { intent: { exit_deadline } });
    }
});

test('rejects a stale, future, mismatched, or crossed quote', () => {
    rejectsWith('ALPACA_V2_QUOTE_UNAVAILABLE', { quote: { quote: { t: '2026-09-23T14:59:00.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } } });
    rejectsWith('ALPACA_V2_QUOTE_UNAVAILABLE', { quote: { quote: { t: '2026-09-23T15:00:05.000Z', bp: 99.98, bs: 3, ap: 100, as: 2 } } });
    rejectsWith('ALPACA_V2_QUOTE_UNAVAILABLE', { quote: { symbol: 'AMD' } });
    rejectsWith('ALPACA_V2_QUOTE_UNAVAILABLE', { quote: { quote: { t: '2026-09-23T14:59:58.000Z', bp: 101, bs: 3, ap: 100, as: 2 } } });
});

test('rejects invalid price geometry and off-tick prices', () => {
    rejectsWith('ALPACA_V2_GEOMETRY_INVALID', { intent: { stop: 101 } });
    rejectsWith('ALPACA_V2_GEOMETRY_INVALID', { intent: { target: 100.4 } });
    rejectsWith('ALPACA_V2_GEOMETRY_INVALID', { intent: { stop: 98.123 } });
    rejectsWith('ALPACA_V2_GEOMETRY_INVALID', { intent: { stop: -1 } });
    rejectsWith('ALPACA_V2_GEOMETRY_INVALID', { intent: { target: '104' } });
});

test('reward must cover risk at the authorized limit, even when the quoted ask would pass', () => {
    // At the ask of 100, target 102 offers 1:1 against stop 98. At the
    // authorized limit of 100.50 it offers only 1.50 reward for 2.50 risk.
    rejectsWith('ALPACA_V2_REWARD_RISK_TOO_LOW', { intent: { target: 102 } });
    const boundary = buildV2EntryOrder(inputs({ intent: { target: 103 } }));
    assert.strictEqual(boundary.order.limit_price, 100.5);
    assert.strictEqual(boundary.order.take_profit.limit_price, 103);
    rejectsWith('ALPACA_V2_REWARD_RISK_TOO_LOW', { intent: { target: 102.99 } });
});

test('daily realized loss blocks at the 2 percent boundary with no missing-data fallback', () => {
    const dailyRisk = { complete: true, sessionDate: '2026-09-23', realizedPnl: -1999.99 };
    assert.ok(buildV2EntryOrder(inputs({ context: { dailyRisk } })).order);
    for (const realizedPnl of [-2000, -2000.01]) {
        rejectsWith('ALPACA_V2_DAILY_LOSS_LIMIT_REACHED', { context: { dailyRisk: { ...dailyRisk, realizedPnl } } });
    }
    for (const invalid of [undefined, { ...dailyRisk, complete: false }, { ...dailyRisk, realizedPnl: null },
        { ...dailyRisk, realizedPnl: NaN }, { ...dailyRisk, sessionDate: '2026-09-22' }]) {
        rejectsWith('ALPACA_V2_DAILY_PNL_UNAVAILABLE', { context: { dailyRisk: invalid } });
    }
});

test('new limits cannot be disabled by an invalid policy override', () => {
    for (const patch of [{ minRewardRiskRatio: 0 }, { minRewardRiskRatio: NaN }, { maxDailyLossPct: 0 }, { maxDailyLossPct: 0.5 },
        { maxCandidateAgeMs: NaN }, { maxCandidateAgeMs: -1 }]) {
        rejectsWith('ALPACA_V2_POLICY_INVALID', { policy: { ...DEFAULT_V2_POLICY, ...patch } });
    }
});

test('legacy callers remain marked unclassified while structured evidence is validated and retained', () => {
    const legacy = buildV2EntryOrder(inputs()).plan;
    assert.strictEqual(legacy.setup_id, 'legacy_unclassified');
    assert.strictEqual(legacy.entry_evidence.candidate_evidence_status, 'not_provided');
    assert.strictEqual(legacy.entry_evidence.quote_ask, 100);
    assert.strictEqual(legacy.entry_evidence.quote_source_at, '2026-09-23T14:59:58.000Z');
    const plan = buildV2EntryOrder(inputs({ intent: {
        setup_id: 'opening_range_hold', strategy_version: 'v3.1', catalyst_class: 'earnings',
        candidate_evidence: { observed_at: '2026-09-23T14:59:00.000Z', catalyst_at: '2026-09-23T12:00:00.000Z',
            relative_volume: 2.1, relative_strength_pct: 0.8, trend: 'up', entry_trigger: 'support_reclaim', atr: 1.2,
            revision_reason: 'New base formed above support' },
    } })).plan;
    assert.strictEqual(plan.setup_id, 'opening_range_hold');
    assert.strictEqual(plan.entry_evidence.metadata_status, 'classified');
    assert.strictEqual(plan.entry_evidence.candidate_relative_volume, 2.1);
    assert.strictEqual(plan.entry_evidence.candidate_revision_reason, 'New base formed above support');
    for (const candidate_evidence of [{ observed_at: '2026-09-23T15:01:00Z' }, { observed_at: '2026-09-23T15:00:00.000001Z' }, { observed_at: '2026-09-23T14:40:00Z' },
        { observed_at: '2026-09-23T14:59:00Z', catalyst_at: '2026-09-23T15:00:00Z' },
        { observed_at: '2026-09-23T14:59:00Z', api_key: 'must-never-be-stored' }, { observed_at: '2026-02-30T14:59:00Z' }]) {
        rejectsWith('ALPACA_V2_EVIDENCE_INVALID', { intent: { candidate_evidence } });
    }
});

test('sizes affordability against cash only, never buying power', () => {
    // $1,005 of entry cost against $1,000 cash on a 4x margin account must be refused.
    rejectsWith('ALPACA_V2_INSUFFICIENT_CASH', { account: { cash: '1000', equity: '100000', buying_power: '400000' } });
});

test('cash already committed to open buy orders is not available for a second entry', () => {
    const openOrders = [{ side: 'buy', qty: '400', filled_qty: '0', limit_price: '100', status: 'new' }];
    rejectsWith('ALPACA_V2_INSUFFICIENT_CASH', { account: { cash: '41000' }, openOrders });
    // a working buy with no limit price cannot be costed: fail closed
    rejectsWith('ALPACA_V2_CASH_COMMITMENT_UNKNOWN', { openOrders: [{ side: 'buy', qty: '1', filled_qty: '0', type: 'market', status: 'new' }] });
});

test('keeps the account-2 risk caps: position size, per-trade risk, total open risk, and cash reserve', () => {
    rejectsWith('ALPACA_V2_POSITION_LIMIT_EXCEEDED', { intent: { qty: 300 }, account: { cash: '90000' } });
    rejectsWith('ALPACA_V2_RISK_PER_TRADE_EXCEEDED', { intent: { qty: 200, stop: 94, target: 108 } });
    rejectsWith('ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED', { context: { hasActivePlanForSymbol: false, currentOpenRiskDollars: 1990 } });
    rejectsWith('ALPACA_V2_MIN_CASH_RESERVE_BREACHED', { intent: { qty: 20 }, account: { cash: '11000' } });
});

test('rejects a second active plan for the same symbol', () => {
    rejectsWith('ALPACA_V2_DUPLICATE_SYMBOL_PLAN', { context: { hasActivePlanForSymbol: true, currentOpenRiskDollars: 0 } });
});

test('the default policy never enables margin, shorting, or extended hours', () => {
    assert.strictEqual(DEFAULT_V2_POLICY.feed, 'iex');
    assert.ok(!('allowShort' in DEFAULT_V2_POLICY));
    assert.ok(!('extendedHours' in DEFAULT_V2_POLICY));
});

test('the time-exit order is one exact-quantity DAY market sell with a deterministic client id', () => {
    const plan = { symbol: 'NVDA', client_order_id: 'dt2-20260923-nvda-orb' };
    assert.strictEqual(timeExitClientOrderId(plan), 'dt2-20260923-nvda-orb-x');
    assert.deepStrictEqual(buildTimeExitOrder({ plan, qty: 7 }), {
        symbol: 'NVDA', qty: 7, side: 'sell', type: 'market', time_in_force: 'day', extended_hours: false, client_order_id: 'dt2-20260923-nvda-orb-x',
    });
    assert.throws(() => buildTimeExitOrder({ plan, qty: 0 }), (err) => err.code === 'ALPACA_V2_QTY_INVALID');
    assert.throws(() => buildTimeExitOrder({ plan, qty: 2.5 }), (err) => err.code === 'ALPACA_V2_QTY_INVALID');
});
