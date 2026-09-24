'use strict';

// Pure v2 order policy: no network, no DB. Turns a small declared strategy intent plus
// broker-read facts (account, clock, asset, raw latest quote, open orders) into exactly one
// long, DAY, regular-hours Alpaca bracket order -- or throws one specific code. Every broker
// field in the returned order is computed here; the caller cannot supply any of them.
const { validateAndAnnotateQuote } = require('./alpaca_market_data');

// account-2 caps carried over from v1 (dropping them silently would be a regression); every
// percentage reads against account equity. Cash affordability reads against cash only.
const DEFAULT_V2_POLICY = Object.freeze({
    feed: 'iex',
    maxQuoteAgeMs: 10_000,
    maxSlippagePct: 0.005,
    cutoffMinutesBeforeClose: 15,
    maxPositionPct: 0.25,
    minCashPct: 0.10,
    maxRiskPerTradePct: 0.01,
    maxTotalOpenRiskPct: 0.02,
});

const ALLOWED_INTENT_FIELDS = Object.freeze([
    'account_id', 'client_order_id', 'symbol', 'qty', 'setup', 'catalyst', 'thesis', 'invalidation', 'stop', 'target', 'exit_deadline',
]);

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

function assertIntentShape(intent) {
    if (!intent || typeof intent !== 'object' || Array.isArray(intent)) throw policyError('ALPACA_V2_FIELD_NOT_ALLOWED', 'entry intent must be an object');
    const disallowed = Object.keys(intent).filter((key) => !ALLOWED_INTENT_FIELDS.includes(key));
    if (disallowed.length) throw policyError('ALPACA_V2_FIELD_NOT_ALLOWED', `entry intent may not include: ${disallowed.join(', ')}`);
    if (intent.account_id !== 2) throw policyError('ALPACA_V2_ACCOUNT_SCOPE_REQUIRED', 'account_id 2 is required');
    if (typeof intent.client_order_id !== 'string' || !CLIENT_ORDER_ID.test(intent.client_order_id)) {
        throw policyError('ALPACA_V2_CLIENT_ORDER_ID_INVALID', 'client_order_id must match dt2-[A-Za-z0-9-], at most 104 characters');
    }
    if (!Number.isInteger(intent.qty) || intent.qty <= 0) throw policyError('ALPACA_V2_QTY_INVALID', 'qty must be a positive whole number of shares');
    for (const field of ['setup', 'catalyst', 'thesis', 'invalidation']) {
        const value = intent[field];
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_STRATEGY_TEXT) {
            throw policyError('ALPACA_V2_STRATEGY_FIELDS_REQUIRED', 'setup, catalyst, thesis, and invalidation are required');
        }
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

function buildV2EntryOrder({
    intent, account, clock, asset, quote, openOrders = [], context = {}, policy = DEFAULT_V2_POLICY, now = new Date(),
}) {
    assertIntentShape(intent);
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

    let proven;
    try {
        proven = validateAndAnnotateQuote(quote, { requestedSymbol: symbol, feed: policy.feed, now, maxAgeMs: policy.maxQuoteAgeMs });
    } catch (_error) {
        throw policyError('ALPACA_V2_QUOTE_UNAVAILABLE', 'a fresh, valid quote is required');
    }
    // A marketable limit bounded above the ask: this, not the raw ask, is the worst price the
    // entry may pay, so geometry, risk, and affordability are all measured against it.
    const entryPrice = floorToTick(proven.askPrice * (1 + policy.maxSlippagePct));

    const { stop, target } = intent;
    if (!tickAligned(stop) || !tickAligned(target) || !(stop < entryPrice) || !(entryPrice < target)) {
        throw policyError('ALPACA_V2_GEOMETRY_INVALID', 'stop < entry < target with tick-aligned prices is required');
    }

    const qty = intent.qty;
    const cost = qty * entryPrice;
    const cash = Number(account.cash);
    const equity = Number(account.equity);
    if (!Number.isFinite(cash) || !Number.isFinite(equity) || equity <= 0) {
        throw policyError('ALPACA_V2_ACCOUNT_NOT_TRADABLE', 'account cash and equity are unavailable');
    }
    const availableCash = cash - committedBuyCash(openOrders);
    if (cost > availableCash) throw policyError('ALPACA_V2_INSUFFICIENT_CASH', 'entry cost exceeds uncommitted cash (margin is never used)');

    const riskDollars = Math.round(qty * (entryPrice - stop) * 100) / 100;
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
        },
    };
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
    buildTimeExitOrder,
    timeExitClientOrderId,
    committedBuyCash,
};
