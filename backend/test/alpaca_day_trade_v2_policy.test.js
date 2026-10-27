const { test } = require('node:test');
const assert = require('node:assert');

const {
    buildV2EntryOrder, buildV2EntryPreview, assertV2PreviewIntent, buildTimeExitOrder, timeExitClientOrderId, ALLOWED_INTENT_FIELDS, DEFAULT_V2_POLICY,
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
        'max_notional_dollars', 'max_risk_dollars', 'max_entry_price',
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
    for (const qty of [0, -1, 1.5, '10', null, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) rejectsWith('ALPACA_V2_QTY_INVALID', { intent: { qty } });
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

test('rejects a quote whose bid/ask spread is too wide to price an entry', () => {
    // A thin single-venue quote (8.8% of mid) would price the entry above the target.
    const thin = { symbol: 'NVDA', quote: { t: '2026-09-23T14:59:58.000Z', bp: 1000, bs: 1, ap: 1092, as: 1 } };
    rejectsWith('ALPACA_V2_QUOTE_SPREAD_TOO_WIDE', { quote: thin, intent: { stop: 1040, target: 1080 } });
    rejectsWith('ALPACA_V2_QUOTE_SPREAD_TOO_WIDE', { quote: { quote: { t: '2026-09-23T14:59:58.000Z', bp: 98.9, bs: 3, ap: 100, as: 2 } } });
    // Exactly 1.0% of the mid is still accepted.
    assert.strictEqual(buildV2EntryOrder(inputs({ quote: { quote: { t: '2026-09-23T14:59:58.000Z', bp: 99.5, bs: 3, ap: 100.5, as: 2 } } })).order.qty, 10);
    assert.strictEqual(DEFAULT_V2_POLICY.maxSpreadPct, 0.01);
    for (const maxSpreadPct of [0, -0.01, NaN, Infinity, 0.06]) {
        rejectsWith('ALPACA_V2_POLICY_INVALID', { policy: { maxSpreadPct } });
    }
});

test('preview reports a too-wide spread as its own blocker and keeps the quote as evidence', () => {
    const result = buildV2EntryPreview(previewInputs({ quote: { quote: { t: '2026-09-23T14:59:58.000Z', bp: 91, bs: 3, ap: 100, as: 2 } } }));
    assert.strictEqual(result.eligible, false);
    assert.deepStrictEqual(result.blockerCodes, ['ALPACA_V2_QUOTE_SPREAD_TOO_WIDE']);
    assert.strictEqual(result.quote.bidPrice, 91);
    assert.strictEqual(result.quote.askPrice, 100);
    assert.strictEqual(result.submission, null);
});

test('preview headroom policy is bounded', () => {
    assert.strictEqual(DEFAULT_V2_POLICY.entryHeadroomPct, 0.003);
    for (const entryHeadroomPct of [-0.001, NaN, Infinity, 0.011]) {
        assert.throws(() => buildV2EntryPreview({ ...previewInputs(), policy: { entryHeadroomPct } }),
            (error) => error.code === 'ALPACA_V2_POLICY_INVALID');
    }
    const exact = buildV2EntryPreview({ ...previewInputs(), policy: { entryHeadroomPct: 0 } });
    assert.strictEqual(exact.submission.max_entry_price, 100.5);
    assert.strictEqual(exact.qty, 40);
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

function previewInputs(overrides = {}) {
    const args = inputs(overrides);
    if (!Object.hasOwn(overrides.intent || {}, 'qty')) delete args.intent.qty;
    args.intent = { max_notional_dollars: 5000, max_risk_dollars: 100, ...args.intent };
    return args;
}

// Exact sizing arithmetic without the preview headroom; sub-penny fixtures also need a wider
// spread allowance (a 0.0099/0.01 quote is a 1% spread).
function exactPreviewInputs(overrides = {}) {
    return previewInputs({ policy: { entryHeadroomPct: 0, maxSpreadPct: 0.05 }, ...overrides });
}

function submissionArgs(args, preview) {
    const { max_qty: _maxQty, ...intent } = args.intent;
    return { ...args, intent: { ...intent, ...preview.submission } };
}

test('preview returns the largest risk-budgeted whole quantity, exact quote provenance, and a capped submission', () => {
    const args = previewInputs({ quoteRetrievedAt: '2026-09-23T14:59:59.000Z' });
    const original = structuredClone(args);
    const preview = buildV2EntryPreview(args);
    assert.strictEqual(preview.eligible, true);
    // Sized at the 0.3% headroom ceiling (100.80), so a small uptick before submission
    // still fits the dollar budgets: risk 100 / (100.80 - 98) floors to 35 shares.
    assert.strictEqual(preview.qty, 35);
    assert.strictEqual(preview.entryPrice, 100.5);
    assert.strictEqual(preview.notionalDollars, 3517.5);
    assert.strictEqual(preview.riskDollars, 87.5);
    assert.strictEqual(preview.rewardRiskRatio, 1.4);
    assert.deepStrictEqual(preview.quote, { bidPrice: 99.98, askPrice: 100, feed: 'iex',
        sourceTimestamp: '2026-09-23T14:59:58.000Z', retrievedAt: '2026-09-23T14:59:59.000Z' });
    assert.deepStrictEqual(preview.submission, { qty: 35, max_entry_price: 100.8, max_notional_dollars: 5000, max_risk_dollars: 100 });
    assert.deepStrictEqual(preview.blockerCodes, []);
    assert.deepStrictEqual(args, original, 'preview must not mutate caller facts or intent');
    assert.strictEqual(buildV2EntryOrder(submissionArgs(args, preview)).order.qty, 35);
    assert.throws(() => buildV2EntryOrder({ ...submissionArgs(args, preview), intent: { ...submissionArgs(args, preview).intent, qty: 41 } }),
        (error) => error.code === 'ALPACA_V2_RISK_BUDGET_EXCEEDED');
});

test('preview respects notional dollars and an optional caller quantity ceiling', () => {
    assert.strictEqual(buildV2EntryPreview(exactPreviewInputs({ intent: { max_notional_dollars: 2010 } })).qty, 20);
    assert.strictEqual(buildV2EntryPreview(exactPreviewInputs({ intent: { max_notional_dollars: 2009.9999 } })).qty, 19);
    assert.strictEqual(buildV2EntryPreview(exactPreviewInputs({ intent: { max_qty: 7 } })).qty, 7);
    assert.strictEqual(buildV2EntryPreview(exactPreviewInputs({ intent: { max_qty: Number.MAX_SAFE_INTEGER } })).qty, 40);
});

test('preview preserves position, per-trade, aggregate-risk, reserve, and working-order caps', () => {
    const generous = { max_notional_dollars: 100000, max_risk_dollars: 100000 };
    const cases = [
        [{ intent: generous }, 248, 'ALPACA_V2_POSITION_LIMIT_EXCEEDED'],
        [{ intent: { ...generous, stop: 94, target: 108 } }, 153, 'ALPACA_V2_RISK_PER_TRADE_EXCEEDED'],
        [{ intent: generous, context: { currentOpenRiskDollars: 1900 } }, 40, 'ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED'],
        [{ intent: generous, account: { cash: '11000' } }, 9, 'ALPACA_V2_MIN_CASH_RESERVE_BREACHED'],
        [{ intent: generous, account: { cash: '11000' }, openOrders: [{ side: 'buy', qty: '8', filled_qty: '3', limit_price: '100' }] }, 4, 'ALPACA_V2_MIN_CASH_RESERVE_BREACHED'],
    ];
    for (const [overrides, expectedQty, expectedCode] of cases) {
        const args = exactPreviewInputs(overrides);
        const preview = buildV2EntryPreview(args);
        assert.strictEqual(preview.qty, expectedQty);
        const submission = submissionArgs(args, preview);
        assert.ok(buildV2EntryOrder(submission));
        assert.throws(() => buildV2EntryOrder({ ...submission, intent: { ...submission.intent, qty: expectedQty + 1 } }),
            (error) => error.code === expectedCode);
    }
});

test('preview never rounds a sub-share budget up into an order', () => {
    for (const [limits, code] of [
        [{ max_notional_dollars: 100.49999 }, 'ALPACA_V2_NOTIONAL_BUDGET_EXCEEDED'],
        [{ max_risk_dollars: 2.49999 }, 'ALPACA_V2_RISK_BUDGET_EXCEEDED'],
    ]) {
        const result = buildV2EntryPreview(previewInputs({ intent: limits }));
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.qty, 0);
        assert.strictEqual(result.submission, null);
        assert.strictEqual(result.notionalDollars, null);
        assert.strictEqual(result.riskDollars, null);
        assert.strictEqual(result.rewardRiskRatio, null);
        assert.strictEqual(result.entryPrice, 100.5);
        assert.ok(result.quote);
        assert.deepStrictEqual(result.blockerCodes, [code]);
    }
});

test('four-decimal prices and sub-cent loss budgets remain exact before policy rounding', () => {
    const args = exactPreviewInputs({ intent: { stop: 0.0099, target: 0.0102, max_notional_dollars: 0.03, max_risk_dollars: 0.0003 },
        quote: { quote: { t: NOW.toISOString(), bp: 0.0099, bs: 1, ap: 0.01, as: 1 } } });
    const result = buildV2EntryPreview(args);
    assert.strictEqual(result.qty, 3);
    assert.strictEqual(result.notionalDollars, 0.03);
    assert.strictEqual(result.riskDollars, 0.0003);
    const order = submissionArgs(args, result);
    assert.strictEqual(buildV2EntryOrder(order).plan.planned_risk_dollars, 0);
    assert.throws(() => buildV2EntryOrder({ ...order, intent: { ...order.intent, qty: 4, max_notional_dollars: 1 } }),
        (error) => error.code === 'ALPACA_V2_RISK_BUDGET_EXCEEDED');
    assert.strictEqual(buildV2EntryPreview({ ...args, intent: { ...args.intent, max_risk_dollars: 0.00029999999 } }).qty, 2);
    assert.strictEqual(buildV2EntryPreview({ ...args, intent: { ...args.intent, max_risk_dollars: 1e-4 } }).qty, 1);
    assert.strictEqual(buildV2EntryPreview({ ...args, intent: { ...args.intent, max_risk_dollars: 1e-7 } }).eligible, false);
    const halfCent = { ...args, intent: { ...args.intent, max_notional_dollars: 0.5, max_risk_dollars: 0.005 } };
    const fifty = buildV2EntryPreview(halfCent);
    assert.strictEqual(fifty.qty, 50);
    assert.strictEqual(buildV2EntryOrder(submissionArgs(halfCent, fifty)).plan.planned_risk_dollars, 0.01);
});

test('preview handles a bounded entry crossing the one-dollar tick boundary', () => {
    const result = buildV2EntryPreview(previewInputs({ intent: { stop: 0.99, target: 1.02, max_notional_dollars: 10, max_risk_dollars: 1 },
        quote: { quote: { t: NOW.toISOString(), bp: 0.998, bs: 1, ap: 0.999, as: 1 } } }));
    assert.strictEqual(result.entryPrice, 1);
    assert.strictEqual(result.qty, 10);
    assert.strictEqual(result.riskDollars, 0.1);
});

test('preview rejects geometry that collapses at broker tick precision or overflows reward/risk', () => {
    for (const intent of [{ stop: 100.4999999999 }, { stop: 0.0099, target: 1e306 }]) {
        const args = exactPreviewInputs({ intent, ...(intent.target === 1e306
            ? { quote: { quote: { t: NOW.toISOString(), bp: 0.0099, bs: 1, ap: 0.01, as: 1 } } } : {}) });
        const result = buildV2EntryPreview(args);
        assert.strictEqual(result.eligible, false);
        assert.deepStrictEqual(result.blockerCodes, ['ALPACA_V2_GEOMETRY_INVALID']);
    }
});

test('preview returns policy blockers for market, account, asset, duplicate, reward/risk, and daily-loss gates', () => {
    const cases = [
        [{ clock: { is_open: false } }, 'ALPACA_V2_MARKET_CLOSED'],
        [{ clock: { next_close: '2026-09-23T15:10:00Z' } }, 'ALPACA_V2_ENTRY_CUTOFF_PASSED'],
        [{ account: { trading_blocked: true } }, 'ALPACA_V2_ACCOUNT_NOT_TRADABLE'],
        [{ asset: { tradable: false } }, 'ALPACA_V2_ASSET_NOT_TRADABLE'],
        [{ context: { hasActivePlanForSymbol: true } }, 'ALPACA_V2_DUPLICATE_SYMBOL_PLAN'],
        [{ intent: { target: 102 } }, 'ALPACA_V2_REWARD_RISK_TOO_LOW'],
        [{ intent: { stop: 101 } }, 'ALPACA_V2_GEOMETRY_INVALID'],
        [{ context: { dailyRisk: { complete: false } } }, 'ALPACA_V2_DAILY_PNL_UNAVAILABLE'],
        [{ context: { dailyRisk: { complete: true, sessionDate: '2026-09-23', realizedPnl: -2000 } } }, 'ALPACA_V2_DAILY_LOSS_LIMIT_REACHED'],
        [{ account: { cash: '0' } }, 'ALPACA_V2_INSUFFICIENT_CASH'],
        [{ account: { cash: '10000' } }, 'ALPACA_V2_MIN_CASH_RESERVE_BREACHED'],
        [{ context: { currentOpenRiskDollars: 2000 } }, 'ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED'],
        [{ openOrders: [{ side: 'buy', qty: 1, type: 'market' }] }, 'ALPACA_V2_CASH_COMMITMENT_UNKNOWN'],
    ];
    for (const [overrides, code] of cases) {
        const result = buildV2EntryPreview(previewInputs(overrides));
        assert.strictEqual(result.eligible, false, code);
        assert.strictEqual(result.qty, 0);
        assert.strictEqual(result.submission, null);
        assert.deepStrictEqual(result.blockerCodes, [code]);
    }
});

test('preview never presents stale, future, missing, crossed, mismatched, or empty-size quotes as usable', () => {
    const baseQuote = inputs().quote.quote;
    const quotes = [
        { quote: { ...baseQuote, t: '2026-09-23T14:59:49.999Z' } },
        { quote: { ...baseQuote, t: '2026-09-23T15:00:00.001Z' } },
        { quote: {} }, { symbol: 'OTHER' }, { quote: { ...baseQuote, bp: 101 } },
        { quote: { ...baseQuote, as: 0 } }, { quote: { ...baseQuote, ap: Infinity } },
    ];
    for (const quote of quotes) {
        const result = buildV2EntryPreview(previewInputs({ quote }));
        assert.strictEqual(result.eligible, false);
        assert.strictEqual(result.quote, null);
        assert.strictEqual(result.entryPrice, null);
        assert.deepStrictEqual(result.blockerCodes, ['ALPACA_V2_QUOTE_UNAVAILABLE']);
    }
    assert.strictEqual(buildV2EntryPreview(previewInputs({ quote: { quote: { ...baseQuote, t: '2026-09-23T14:59:50.000Z' } } })).eligible, true);
});

test('preview validates all caller limits and rejects broker fields before reading facts', () => {
    for (const key of ['max_notional_dollars', 'max_risk_dollars']) {
        for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity, '100', true, {}, []]) {
            const intent = previewInputs({ intent: { [key]: value } }).intent;
            assert.throws(() => assertV2PreviewIntent(intent), (error) => error.code === 'ALPACA_V2_SIZING_INVALID');
        }
        const intent = previewInputs().intent;
        delete intent[key];
        assert.throws(() => assertV2PreviewIntent(intent), (error) => error.code === 'ALPACA_V2_SIZING_INVALID');
    }
    for (const max_qty of [undefined, null, 0, -1, 1.1, '10', true, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => assertV2PreviewIntent(previewInputs({ intent: { max_qty } }).intent),
            (error) => error.code === 'ALPACA_V2_SIZING_INVALID');
    }
    for (const key of ['qty', 'max_entry_price', 'limit_price', 'entry_price', 'quote', 'feed', 'side', 'notional', 'dry_run', 'preview']) {
        assert.throws(() => assertV2PreviewIntent(previewInputs({ intent: { [key]: 1 } }).intent),
            (error) => error.code === 'ALPACA_V2_FIELD_NOT_ALLOWED');
    }
    for (const symbol of [undefined, null, '', 123, [], {}, 'TOO-LONG', 'A/B']) {
        assert.throws(() => assertV2PreviewIntent(previewInputs({ intent: { symbol } }).intent),
            (error) => error.code === 'ALPACA_V2_SYMBOL_INVALID');
    }
    for (const intent of [undefined, null, [], 1, 'test']) {
        assert.throws(() => assertV2PreviewIntent(intent), (error) => error.code === 'ALPACA_V2_FIELD_NOT_ALLOWED');
    }
});

test('preview retains entry strategy and metadata validation instead of inventing fields', () => {
    for (const [patch, code] of [
        [{ account_id: 1 }, 'ALPACA_V2_ACCOUNT_SCOPE_REQUIRED'],
        [{ account_id: '2' }, 'ALPACA_V2_ACCOUNT_SCOPE_REQUIRED'],
        [{ client_order_id: 'not-a-v2-id' }, 'ALPACA_V2_CLIENT_ORDER_ID_INVALID'],
        [{ thesis: '' }, 'ALPACA_V2_STRATEGY_FIELDS_REQUIRED'],
        [{ stop: '98' }, 'ALPACA_V2_GEOMETRY_INVALID'],
        [{ target: 104.123 }, 'ALPACA_V2_GEOMETRY_INVALID'],
        [{ exit_deadline: 'later' }, 'ALPACA_V2_EXIT_DEADLINE_INVALID'],
        [{ candidate_evidence: { observed_at: '2026-09-23T15:00:01Z' } }, 'ALPACA_V2_EVIDENCE_INVALID'],
    ]) {
        assert.throws(() => buildV2EntryPreview(previewInputs({ intent: patch })), (error) => error.code === code);
    }
});

test('preview constraints contain only known quantitative fields and never nonfinite numbers', () => {
    const result = buildV2EntryPreview(previewInputs({ account: { equity: 'unknown', cash: 'unknown' },
        context: { currentOpenRiskDollars: NaN, dailyRisk: { complete: false, realizedPnl: NaN } } }));
    assert.deepStrictEqual(Object.keys(result.constraints).sort(), ['maxNotionalDollars', 'maxRiskDollars', 'maxQty',
        'availableCashDollars', 'minimumCashReserveDollars', 'maxPositionDollars', 'maxRiskPerTradeDollars',
        'remainingOpenRiskDollars', 'minRewardRiskRatio', 'maxDailyLossDollars', 'dailyRealizedPnl'].sort());
    assert.ok(Object.values(result.constraints).every((value) => value === null || (typeof value === 'number' && Number.isFinite(value))));
    assert.strictEqual(result.constraints.availableCashDollars, null);
    assert.strictEqual(result.constraints.maxPositionDollars, null);
    assert.strictEqual(result.constraints.dailyRealizedPnl, null);
});

test('actual submission rechecks preview price and caller budgets, while legacy intents still work', () => {
    assert.strictEqual(buildV2EntryOrder(inputs()).order.qty, 10);
    const args = previewInputs({ intent: { max_notional_dollars: 2010, max_risk_dollars: 50 } });
    const preview = buildV2EntryPreview(args);
    const submission = submissionArgs(args, preview);
    assert.strictEqual(submission.intent.max_entry_price, 100.8);
    assert.strictEqual(buildV2EntryOrder(submission).order.qty, 17);
    // An uptick inside the headroom still submits within every dollar budget.
    for (const ap of [100.01, 100.3]) {
        const moved = buildV2EntryOrder({ ...submission, quote: { ...submission.quote, quote: { ...submission.quote.quote, ap } } });
        assert.strictEqual(moved.order.qty, 17);
        assert.ok(moved.order.limit_price <= 100.8);
    }
    const higherQuote = { ...submission.quote, quote: { ...submission.quote.quote, ap: 100.31 } };
    assert.throws(() => buildV2EntryOrder({ ...submission, quote: higherQuote }), (error) => error.code === 'ALPACA_V2_ENTRY_PRICE_MOVED');
    const withoutPriceCap = { ...submission.intent, qty: 20 };
    delete withoutPriceCap.max_entry_price;
    assert.throws(() => buildV2EntryOrder({ ...submission, quote: higherQuote, intent: withoutPriceCap }),
        (error) => error.code === 'ALPACA_V2_NOTIONAL_BUDGET_EXCEEDED');
    assert.throws(() => buildV2EntryOrder({ ...submission, quote: higherQuote, intent: { ...withoutPriceCap, max_notional_dollars: 10000 } }),
        (error) => error.code === 'ALPACA_V2_RISK_BUDGET_EXCEEDED');
    assert.strictEqual(buildV2EntryOrder({ ...submission, quote: { ...submission.quote, quote: { ...submission.quote.quote, ap: 99.99 } } }).order.qty, 17);
});

test('optional submission ceilings reject explicit malformed values and cannot be forwarded as broker fields', () => {
    for (const key of ['max_notional_dollars', 'max_risk_dollars', 'max_entry_price']) {
        for (const value of [undefined, null, 0, -1, NaN, Infinity, '100', true, {}, []]) {
            rejectsWith('ALPACA_V2_SIZING_INVALID', { intent: { [key]: value } });
        }
    }
    const built = buildV2EntryOrder(inputs({ intent: { max_notional_dollars: 1005, max_risk_dollars: 25, max_entry_price: 100.5 } }));
    for (const key of ['max_notional_dollars', 'max_risk_dollars', 'max_entry_price', 'max_qty']) assert.ok(!Object.hasOwn(built.order, key));
    rejectsWith('ALPACA_V2_FIELD_NOT_ALLOWED', { intent: { max_qty: 10 } });
});
