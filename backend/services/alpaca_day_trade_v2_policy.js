'use strict';

// Pure v2 order policy: no network, no DB. Turns a small declared strategy intent plus
// broker-read facts (account, clock, asset, raw latest quote, open orders) into exactly one
// long, DAY, regular-hours Alpaca bracket order -- or throws one specific code. Every broker
// field in the returned order is computed here; the caller cannot supply any of them.
const { validateAndAnnotateQuote } = require('./alpaca_market_data');
const { normalizeEntryMetadata, captureEntryEvidence } = require('./alpaca_day_trade_v2_evidence');
const { easternSessionDate } = require('./alpaca_day_trade_v2_risk');

// account-2 caps carried over from v1 (dropping them silently would be a regression); every
// percentage reads against account equity. Cash affordability reads against cash only.
const DEFAULT_V2_POLICY = Object.freeze({
    feed: 'iex',
    maxQuoteAgeMs: 10_000,
    maxSlippagePct: 0.005,
    // IEX is one venue: its top of book is sometimes far wider than the consolidated market.
    // A wide quote cannot price an entry, so it is refused as a quote problem, not a geometry one.
    maxSpreadPct: 0.01,
    // Preview sizes qty at this much above the entry bound and returns that as the submission's
    // max_entry_price, so a small uptick between preview and submission still fits the budgets.
    entryHeadroomPct: 0.003,
    cutoffMinutesBeforeClose: 15,
    maxPositionPct: 0.25,
    minCashPct: 0.10,
    maxRiskPerTradePct: 0.01,
    maxTotalOpenRiskPct: 0.02,
    minRewardRiskRatio: 1,
    maxDailyLossPct: 0.02,
    maxCandidateAgeMs: 15 * 60_000,
});

const ALLOWED_INTENT_FIELDS = Object.freeze([
    'account_id', 'client_order_id', 'symbol', 'qty', 'setup', 'catalyst', 'thesis', 'invalidation', 'stop', 'target', 'exit_deadline',
    'setup_id', 'strategy_version', 'catalyst_class', 'candidate_evidence',
    'max_notional_dollars', 'max_risk_dollars', 'max_entry_price',
]);
const PREVIEW_FIELDS = ALLOWED_INTENT_FIELDS.filter((field) => !['qty', 'max_entry_price'].includes(field)).concat('max_qty');
const INPUT_ERRORS = new Set(['ALPACA_V2_FIELD_NOT_ALLOWED', 'ALPACA_V2_ACCOUNT_SCOPE_REQUIRED',
    'ALPACA_V2_CLIENT_ORDER_ID_INVALID', 'ALPACA_V2_QTY_INVALID', 'ALPACA_V2_STRATEGY_FIELDS_REQUIRED',
    'ALPACA_V2_SYMBOL_INVALID', 'ALPACA_V2_EVIDENCE_INVALID', 'ALPACA_V2_SIZING_INVALID']);

// Alpaca allows client_order_id up to 128 characters; v2 ids stay well below that so the
// deterministic time-exit id (`<id>-x`) always fits. The dt2- prefix keeps client-id recovery
// from ever matching a v1 (dt-) order.
const CLIENT_ORDER_ID = /^dt2-[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;
const SYMBOL = /^[A-Z]{1,5}(\.[A-Z])?$/;
const MAX_STRATEGY_TEXT = 1000;

function policyError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Floor to the tick without binary-float artifacts (100 * 1.005 is 100.49999999999999).
function floorToTick(price) {
    const factor = 10 ** (price >= 1 ? 2 : 4);
    return Math.floor(Math.round(price * factor * 1e6) / 1e6) / factor;
}

function tickAligned(price) {
    if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return false;
    const factor = 10 ** (price >= 1 ? 2 : 4);
    return Math.abs(Math.round(price * factor) / factor - price) <= 1e-9;
}

function assertSizingIntent(intent, preview = false) {
    for (const key of ['max_notional_dollars', 'max_risk_dollars', 'max_entry_price']) {
        const required = preview && key !== 'max_entry_price';
        if ((required || Object.hasOwn(intent, key))
            && (typeof intent[key] !== 'number' || !Number.isFinite(intent[key]) || intent[key] <= 0)) {
            throw policyError('ALPACA_V2_SIZING_INVALID', 'sizing limits must be positive finite dollar amounts');
        }
    }
    if (preview && Object.hasOwn(intent, 'max_qty') && (!Number.isSafeInteger(intent.max_qty) || intent.max_qty <= 0)) {
        throw policyError('ALPACA_V2_SIZING_INVALID', 'max_qty must be a positive safe whole number');
    }
}

function assertIntentShape(intent, preview = false) {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw policyError('ALPACA_V2_FIELD_NOT_ALLOWED', 'entry intent must be an object');
    const allowed = preview ? PREVIEW_FIELDS : ALLOWED_INTENT_FIELDS;
    const disallowed = Object.keys(intent).filter((key) => !allowed.includes(key));
    if (disallowed.length) throw policyError('ALPACA_V2_FIELD_NOT_ALLOWED', `entry intent may not include: ${disallowed.join(', ')}`);
    if (intent.account_id !== 2) throw policyError('ALPACA_V2_ACCOUNT_SCOPE_REQUIRED', 'account_id 2 is required');
    if (typeof intent.client_order_id !== 'string' || !CLIENT_ORDER_ID.test(intent.client_order_id)) {
        throw policyError('ALPACA_V2_CLIENT_ORDER_ID_INVALID', 'client_order_id must match dt2-[A-Za-z0-9-], at most 104 characters');
    }
    if (!preview && (!Number.isSafeInteger(intent.qty) || intent.qty <= 0)) throw policyError('ALPACA_V2_QTY_INVALID', 'qty must be a positive safe whole number of shares');
    for (const field of ['setup', 'catalyst', 'thesis', 'invalidation']) {
        const value = intent[field];
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_STRATEGY_TEXT) {
            throw policyError('ALPACA_V2_STRATEGY_FIELDS_REQUIRED', 'setup, catalyst, thesis, and invalidation are required');
        }
    }
    assertSizingIntent(intent, preview);
}

function assertV2PreviewIntent(intent) {
    assertIntentShape(intent, true);
    if (typeof intent.symbol !== 'string' || !SYMBOL.test(intent.symbol.trim().toUpperCase())) {
        throw policyError('ALPACA_V2_SYMBOL_INVALID', 'a US equity ticker symbol is required');
    }
    if (!tickAligned(intent.stop) || !tickAligned(intent.target)) {
        throw policyError('ALPACA_V2_GEOMETRY_INVALID', 'stop and target must be positive tick-aligned prices');
    }
    if (typeof intent.exit_deadline !== 'string' || !Number.isFinite(Date.parse(intent.exit_deadline))) {
        throw policyError('ALPACA_V2_EXIT_DEADLINE_INVALID', 'exit_deadline must be a valid date');
    }
}

function assertMarketWindow(clock, now, policy) {
    if (!clock?.is_open) throw policyError('ALPACA_V2_MARKET_CLOSED', 'entries require the regular session to be open');
    const close = new Date(clock.next_close);
    if (Number.isNaN(close.getTime())) throw policyError('ALPACA_V2_MARKET_CLOSED', 'market close time is unavailable');
    if (now.getTime() >= close.getTime() - policy.cutoffMinutesBeforeClose * 60_000) {
        throw policyError('ALPACA_V2_ENTRY_CUTOFF_PASSED', 'entries are closed for this session');
    }
    return close;
}

function assertExitDeadline(value, now, close) {
    const deadline = new Date(typeof value === 'string' ? value : NaN);
    if (Number.isNaN(deadline.getTime()) || deadline.getTime() <= now.getTime() || deadline.getTime() > close.getTime()) {
        throw policyError('ALPACA_V2_EXIT_DEADLINE_INVALID', 'exit_deadline must be a future time within the current session');
    }
    return deadline.toISOString();
}

// Working buy orders consume cash before they fill; account.cash does not reflect them.
function committedBuyCash(openOrders = []) {
    let committed = 0;
    for (const order of openOrders) {
        if (order?.side !== 'buy') continue;
        const remaining = Number(order.qty) - Number(order.filled_qty || 0);
        const limit = Number(order.limit_price);
        if (!Number.isFinite(remaining) || !(limit > 0)) {
            throw policyError('ALPACA_V2_CASH_COMMITMENT_UNKNOWN', 'an open buy order cannot be costed');
        }
        if (remaining > 0) committed += remaining * limit;
    }
    return committed;
}

function entryQuote({ quote, symbol, policy, now }) {
    let proven;
    try {
        proven = validateAndAnnotateQuote(quote, { requestedSymbol: symbol, feed: policy.feed, now, maxAgeMs: policy.maxQuoteAgeMs });
    } catch (_error) {
        throw policyError('ALPACA_V2_QUOTE_UNAVAILABLE', 'a fresh, valid quote is required');
    }
    return { proven, entryPrice: floorToTick(proven.askPrice * (1 + policy.maxSlippagePct)) };
}

function assertQuoteSpread(proven, policy) {
    const mid = (proven.askPrice + proven.bidPrice) / 2;
    if ((proven.askPrice - proven.bidPrice) / mid > policy.maxSpreadPct + 1e-12) {
        throw policyError('ALPACA_V2_QUOTE_SPREAD_TOO_WIDE', 'the bid/ask spread is too wide to price an entry');
    }
}

function validSpreadPolicy(policy) {
    return Number.isFinite(policy.maxSpreadPct) && policy.maxSpreadPct > 0 && policy.maxSpreadPct <= 0.05;
}

// Dollar budgets can have arbitrary decimal precision. Compare whole-share amounts
// in exact 1/10000-dollar units, flooring the budget rather than rounding it upward.
function dollarUnits(value) {
    const [coefficient, exponent = '0'] = String(value).toLowerCase().split('e');
    const [whole, fraction = ''] = coefficient.split('.');
    const digits = BigInt(whole + fraction);
    const scale = Number(exponent) + 4 - fraction.length;
    return scale >= 0 ? digits * 10n ** BigInt(scale) : digits / (10n ** BigInt(-scale));
}

function entryAmounts(qty, entryPrice, stop) {
    const entryUnits = dollarUnits(Number(entryPrice.toFixed(4)));
    const stopUnits = dollarUnits(Number(stop.toFixed(4)));
    if (entryUnits <= stopUnits) throw policyError('ALPACA_V2_GEOMETRY_INVALID', 'the stop must be below the entry at the permitted price precision');
    const notionalUnits = BigInt(qty) * entryUnits;
    const riskUnits = BigInt(qty) * (entryUnits - stopUnits);
    return { notionalUnits, riskUnits, cost: Number(notionalUnits) / 10_000,
        rawRiskDollars: Number(riskUnits) / 10_000, riskDollars: Number((riskUnits + 50n) / 100n) / 100 };
}

// sizingCeiling is preview-only: budgets and account caps are checked as if the entry filled
// at that higher price, while the order itself stays bounded at the current entry price.
function buildV2EntryOrder({
    intent, account, clock, asset, quote, quoteRetrievedAt, openOrders = [], context = {}, policy = DEFAULT_V2_POLICY, now = new Date(),
    sizingCeiling = null,
}) {
    policy = { ...DEFAULT_V2_POLICY, ...policy };
    if (!Number.isFinite(policy.minRewardRiskRatio) || policy.minRewardRiskRatio < 1
        || !Number.isFinite(policy.maxDailyLossPct) || policy.maxDailyLossPct <= 0 || policy.maxDailyLossPct > 0.02
        || !Number.isFinite(policy.maxCandidateAgeMs) || policy.maxCandidateAgeMs < 0 || !validSpreadPolicy(policy)) {
        throw policyError('ALPACA_V2_POLICY_INVALID', 'entry risk policy is invalid');
    }
    assertIntentShape(intent);
    const metadata = normalizeEntryMetadata(intent, { now, maxAgeMs: policy.maxCandidateAgeMs });
    const symbol = typeof intent.symbol === 'string' ? intent.symbol.trim().toUpperCase() : '';
    if (!SYMBOL.test(symbol)) throw policyError('ALPACA_V2_SYMBOL_INVALID', 'a US equity ticker symbol is required');

    const close = assertMarketWindow(clock, now, policy);
    const exitDeadline = assertExitDeadline(intent.exit_deadline, now, close);

    if (account?.status !== 'ACTIVE' || account?.trading_blocked || account?.account_blocked) {
        throw policyError('ALPACA_V2_ACCOUNT_NOT_TRADABLE', 'the paper account is not available for trading');
    }
    if (!asset || asset.class !== 'us_equity' || asset.status !== 'active' || asset.tradable !== true) {
        throw policyError('ALPACA_V2_ASSET_NOT_TRADABLE', 'only active, tradable US equities are permitted');
    }
    if (context.hasActivePlanForSymbol) throw policyError('ALPACA_V2_DUPLICATE_SYMBOL_PLAN', 'a v2 plan is already active for this symbol');

    const { proven, entryPrice } = entryQuote({ quote, symbol, policy, now });
    assertQuoteSpread(proven, policy);
    // A marketable limit bounded above the ask: this, not the raw ask, is the worst price the
    // entry may pay, so geometry, risk, and affordability are all measured against it.
    if (intent.max_entry_price !== undefined && entryPrice > intent.max_entry_price) {
        throw policyError('ALPACA_V2_ENTRY_PRICE_MOVED', 'the maximum entry price increased; refresh the preview');
    }

    const { stop, target } = intent;
    if (!tickAligned(stop) || !tickAligned(target) || !(stop < entryPrice) || !(entryPrice < target)) {
        throw policyError('ALPACA_V2_GEOMETRY_INVALID', 'stop < entry < target with tick-aligned prices is required');
    }
    const plannedRewardRisk = (target - entryPrice) / (entryPrice - stop);
    if (!Number.isFinite(plannedRewardRisk)) throw policyError('ALPACA_V2_GEOMETRY_INVALID', 'entry reward and risk must be finite');
    if (plannedRewardRisk + 1e-9 < policy.minRewardRiskRatio) {
        throw policyError('ALPACA_V2_REWARD_RISK_TOO_LOW', 'reward must cover the risk at the maximum permitted entry price');
    }

    const qty = intent.qty;
    const amounts = entryAmounts(qty, Math.max(entryPrice, sizingCeiling ?? entryPrice), stop);
    const { cost, riskDollars } = amounts;
    if (intent.max_notional_dollars !== undefined && amounts.notionalUnits > dollarUnits(intent.max_notional_dollars)) {
        throw policyError('ALPACA_V2_NOTIONAL_BUDGET_EXCEEDED', 'entry cost exceeds the declared dollar budget');
    }
    if (intent.max_risk_dollars !== undefined && amounts.riskUnits > dollarUnits(intent.max_risk_dollars)) {
        throw policyError('ALPACA_V2_RISK_BUDGET_EXCEEDED', 'entry risk exceeds the declared dollar budget');
    }
    const cash = Number(account.cash);
    const equity = Number(account.equity);
    if (!Number.isFinite(cash) || !Number.isFinite(equity) || equity <= 0) {
        throw policyError('ALPACA_V2_ACCOUNT_NOT_TRADABLE', 'account cash and equity are unavailable');
    }
    const daily = context.dailyRisk;
    if (!daily?.complete || typeof daily.realizedPnl !== 'number' || !Number.isFinite(daily.realizedPnl)
        || daily.sessionDate !== easternSessionDate(now)) {
        throw policyError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'today\'s reconciled v2 realized result is unavailable');
    }
    if (daily.realizedPnl <= -equity * policy.maxDailyLossPct) {
        throw policyError('ALPACA_V2_DAILY_LOSS_LIMIT_REACHED', 'the daily v2 realized loss limit has been reached');
    }
    const availableCash = cash - committedBuyCash(openOrders);
    if (cost > availableCash) throw policyError('ALPACA_V2_INSUFFICIENT_CASH', 'entry cost exceeds uncommitted cash (margin is never used)');

    if (cost / equity > policy.maxPositionPct) throw policyError('ALPACA_V2_POSITION_LIMIT_EXCEEDED', 'position size exceeds the account cap');
    if (riskDollars / equity > policy.maxRiskPerTradePct) throw policyError('ALPACA_V2_RISK_PER_TRADE_EXCEEDED', 'planned risk exceeds the per-trade cap');
    if ((Number(context.currentOpenRiskDollars || 0) + riskDollars) / equity > policy.maxTotalOpenRiskPct) {
        throw policyError('ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED', 'total open risk would exceed the account cap');
    }
    if ((availableCash - cost) / equity < policy.minCashPct) throw policyError('ALPACA_V2_MIN_CASH_RESERVE_BREACHED', 'entry would breach the cash reserve');

    return {
        order: {
            symbol,
            qty,
            side: 'buy',
            type: 'limit',
            limit_price: entryPrice,
            time_in_force: 'day',
            extended_hours: false,
            order_class: 'bracket',
            take_profit: { limit_price: target },
            stop_loss: { stop_price: stop },
            client_order_id: intent.client_order_id,
        },
        plan: {
            client_order_id: intent.client_order_id,
            symbol,
            setup: intent.setup.trim(),
            catalyst: intent.catalyst.trim(),
            thesis: intent.thesis.trim(),
            invalidation: intent.invalidation.trim(),
            planned_qty: qty,
            planned_entry_price: entryPrice,
            planned_stop: stop,
            planned_target: target,
            planned_risk_dollars: riskDollars,
            exit_deadline: exitDeadline,
            setup_id: metadata.setup_id,
            strategy_version: metadata.strategy_version,
            catalyst_class: metadata.catalyst_class,
            entry_evidence: {
                ...captureEntryEvidence(intent, { quote, policy, now, retrievedAt: quoteRetrievedAt }),
                entry_price: entryPrice, planned_reward_risk: plannedRewardRisk, min_reward_risk: policy.minRewardRiskRatio,
                daily_realized_pnl: daily.realizedPnl, daily_loss_limit: equity * policy.maxDailyLossPct, session_date: daily.sessionDate,
            },
        },
    };
}

function previewConstraints({ intent, account, openOrders, context, policy }) {
    const finite = (value) => Number.isFinite(value) ? value : null;
    const brokerNumber = (value) => value == null || value === '' ? NaN : Number(value);
    const equity = brokerNumber(account?.equity);
    let availableCash = null;
    try { availableCash = finite(brokerNumber(account?.cash) - committedBuyCash(openOrders)); } catch { /* Missing facts stay unavailable. */ }
    return {
        maxNotionalDollars: intent.max_notional_dollars, maxRiskDollars: intent.max_risk_dollars, maxQty: intent.max_qty ?? null,
        availableCashDollars: availableCash, minimumCashReserveDollars: finite(equity * policy.minCashPct),
        maxPositionDollars: finite(equity * policy.maxPositionPct), maxRiskPerTradeDollars: finite(equity * policy.maxRiskPerTradePct),
        remainingOpenRiskDollars: finite(equity * policy.maxTotalOpenRiskPct - Number(context.currentOpenRiskDollars ?? 0)),
        minRewardRiskRatio: finite(policy.minRewardRiskRatio), maxDailyLossDollars: finite(equity * policy.maxDailyLossPct),
        dailyRealizedPnl: finite(context.dailyRisk?.realizedPnl),
    };
}

function buildV2EntryPreview({ intent, policy = DEFAULT_V2_POLICY, now = new Date(), openOrders = [], context = {}, ...facts } = {}) {
    assertV2PreviewIntent(intent);
    policy = { ...DEFAULT_V2_POLICY, ...policy };
    if (!Number.isFinite(policy.entryHeadroomPct) || policy.entryHeadroomPct < 0 || policy.entryHeadroomPct > 0.01) {
        throw policyError('ALPACA_V2_POLICY_INVALID', 'entry risk policy is invalid');
    }
    // Validate caller metadata even when an unrelated market gate would block entry.
    normalizeEntryMetadata(intent, { now, maxAgeMs: policy.maxCandidateAgeMs });
    let quote = null; let entryPrice = null;
    try {
        const result = entryQuote({ quote: facts.quote, symbol: intent.symbol.trim().toUpperCase(), policy, now });
        if (Number.isFinite(result.entryPrice) && result.entryPrice > 0) entryPrice = result.entryPrice;
        const proven = result.proven;
        quote = { bidPrice: proven.bidPrice, askPrice: proven.askPrice, feed: proven.feed,
            sourceTimestamp: proven.sourceTimestamp, retrievedAt: facts.quoteRetrievedAt || proven.retrievedAt };
    } catch { /* The shared validator below returns the authoritative blocker. */ }
    const constraints = previewConstraints({ intent, ...facts, openOrders, context, policy });
    const blocked = (code) => ({ eligible: false, qty: 0, entryPrice, quote, notionalDollars: null, riskDollars: null,
        rewardRiskRatio: null, constraints, blockerCodes: [code], submission: null });
    const { max_qty: maxQty, ...entryIntent } = intent;
    const sizingCeiling = entryPrice === null ? null : floorToTick(entryPrice * (1 + policy.entryHeadroomPct));
    const build = (qty) => buildV2EntryOrder({ ...facts, intent: { ...entryIntent, qty }, policy, now, openOrders, context, sizingCeiling });
    try { build(1); } catch (error) {
        if (INPUT_ERRORS.has(error.code) || !String(error.code || '').startsWith('ALPACA_V2_')) throw error;
        return blocked(error.code);
    }
    // The complete final validator is monotone in quantity. Searching it preserves
    // every policy ceiling, including cent-rounded policy risk and cash commitments.
    let low = 1; let high = maxQty ?? Number.MAX_SAFE_INTEGER; let best = null;
    while (low <= high) {
        const qty = low + Math.floor((high - low) / 2);
        try { best = build(qty); low = qty + 1; }
        catch (error) {
            if (!['ALPACA_V2_NOTIONAL_BUDGET_EXCEEDED', 'ALPACA_V2_RISK_BUDGET_EXCEEDED',
                'ALPACA_V2_INSUFFICIENT_CASH', 'ALPACA_V2_POSITION_LIMIT_EXCEEDED', 'ALPACA_V2_RISK_PER_TRADE_EXCEEDED',
                'ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED', 'ALPACA_V2_MIN_CASH_RESERVE_BREACHED'].includes(error.code)) throw error;
            high = qty - 1;
        }
    }
    const qty = best.order.qty;
    const amounts = entryAmounts(qty, best.order.limit_price, intent.stop);
    return { eligible: true, qty, entryPrice: best.order.limit_price, quote, notionalDollars: amounts.cost,
        riskDollars: amounts.rawRiskDollars, rewardRiskRatio: best.plan.entry_evidence.planned_reward_risk,
        constraints, blockerCodes: [], submission: { qty, max_entry_price: Math.max(best.order.limit_price, sizingCeiling),
            max_notional_dollars: intent.max_notional_dollars, max_risk_dollars: intent.max_risk_dollars } };
}

function timeExitClientOrderId(plan) {
    return `${plan.client_order_id}-x`;
}

function buildTimeExitOrder({ plan, qty }) {
    if (!Number.isInteger(qty) || qty <= 0) throw policyError('ALPACA_V2_QTY_INVALID', 'time exit requires a positive whole quantity');
    return {
        symbol: plan.symbol, qty, side: 'sell', type: 'market', time_in_force: 'day', extended_hours: false,
        client_order_id: timeExitClientOrderId(plan),
    };
}

module.exports = {
    DEFAULT_V2_POLICY,
    ALLOWED_INTENT_FIELDS,
    CLIENT_ORDER_ID,
    buildV2EntryOrder,
    assertV2PreviewIntent,
    buildV2EntryPreview,
    buildTimeExitOrder,
    timeExitClientOrderId,
    committedBuyCash,
};
