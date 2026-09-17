const { assertRegularMarketHoursOpen, computeBoundedEntryPrice } = require('./alpaca_day_trade_quote_policy');

// Safety Invariant #8 (plan Section 4): these five figures are the plan's own numbers, not
// tunable guesses. All five percentages are read against account.equity, not cash or buying
// power — the plan names "maximum position 25%" etc. without naming a base, and equity is the
// only reading that stays internally consistent across all five checks.
const DEFAULT_DAY_TRADE_POLICY = {
    entriesEnabled: false, // fail closed: Stage 3+ of the cutover (plan Section 10) turns this on
    maxSlippagePct: 0.005,
    cutoffMinutesBeforeClose: 15,
    maxPositionPct: 0.25,
    minCashPct: 0.10,
    maxRiskPerTradePct: 0.01,
    maxTotalOpenRiskPct: 0.02,
    maxDailyLossPct: 0.02,
};

// The complete caller-facing intent shape (plan Section 7). An allowlist, not a denylist: the
// caller cannot provide the broker endpoint, order class, market-data feed, fill price, entry
// quote, stop-limit price, extended-hours flag, or any other broker field, known or not, so
// rejecting anything outside this set is the only guarantee that holds against fields nobody
// has thought of yet.
const ALLOWED_INTENT_FIELDS = [
    'symbol', 'qty', 'setup', 'catalyst', 'thesis', 'invalidation',
    'stop_price', 'target_price', 'exit_deadline',
];

function policyError(code, message) {
    return Object.assign(new Error(message), { code });
}

function assertOnlyAllowedIntentFields(intent) {
    const keys = Object.keys(intent || {});
    const disallowed = keys.filter((key) => !ALLOWED_INTENT_FIELDS.includes(key));
    if (disallowed.length > 0) {
        throw policyError('ALPACA_INTENT_FIELD_NOT_ALLOWED', `Day Trading entry intent may not include: ${disallowed.join(', ')}`);
    }
}

function assertEntriesEnabled(policy) {
    if (!policy?.entriesEnabled) {
        throw policyError('ALPACA_ENTRIES_DISABLED', 'Day Trading entries are currently disabled by policy');
    }
}

// Self-sufficient: checks market-open state itself rather than relying on being called after
// assertRegularMarketHoursOpen elsewhere, so it stays correct if a future caller (Task 8, 11)
// invokes it on its own. Deriving the cutoff from next_close (rather than a hardcoded wall-clock
// time) handles early-close sessions for free and avoids timezone parsing.
function assertBeforeEntryCutoff(clock, { cutoffMinutesBeforeClose, now = new Date() } = {}) {
    assertRegularMarketHoursOpen(clock);
    const nextClose = new Date(clock.next_close);
    if (Number.isNaN(nextClose.getTime())) {
        throw policyError('ALPACA_CLOCK_UNAVAILABLE', 'a valid market close time is required to enforce the entry cutoff');
    }
    const cutoff = new Date(nextClose.getTime() - cutoffMinutesBeforeClose * 60_000);
    if (now.getTime() >= cutoff.getTime()) {
        throw policyError('ALPACA_ENTRY_CUTOFF_PASSED', `Day Trading entries are blocked within ${cutoffMinutesBeforeClose} minutes of the market close`);
    }
}

function assertAssetTradable(asset) {
    if (!asset || asset.class !== 'us_equity' || asset.status !== 'active' || !asset.tradable) {
        throw policyError('ALPACA_ASSET_NOT_TRADABLE', 'only active, tradable US equities are permitted');
    }
}

// Mirrors alpaca_order_policy.js's account check. The DT bracket path can never reach that
// original check (it rejects any non-simple order_class before this point would matter), so
// this policy is the only place left to enforce it for bracket orders.
function assertAccountTradable(account) {
    if (account?.status !== 'ACTIVE' || account?.trading_blocked || account?.account_blocked) {
        throw policyError('ALPACA_ACCOUNT_NOT_TRADABLE', 'Alpaca paper account must be active and unblocked');
    }
}

function assertWholeShareQty(qty) {
    if (!Number.isInteger(qty) || qty <= 0) {
        throw policyError('ALPACA_QTY_INVALID', 'Day Trading entries require a positive whole number of shares');
    }
}

// Independent of floorToTick: floorToTick's directional (always-down) rounding does not
// round-trip every already-aligned price (e.g. 1.15 * 100 is 114.99999999999999 in floating
// point, so floorToTick(1.15) is 1.14) — comparing against it here would falsely reject valid
// caller-supplied prices. Rounding to the nearest tick, not always down, is the correct check
// for "is this number already on a tick," as opposed to computing a new bounded price.
function assertTickAligned(price, label) {
    if (!Number.isFinite(price) || price <= 0) {
        throw policyError('ALPACA_PRICE_INVALID', `${label} must be a positive number`);
    }
    const factor = 10 ** (price >= 1 ? 2 : 4);
    const rounded = Math.round(price * factor) / factor;
    if (Math.abs(rounded - price) > 1e-9) {
        throw policyError('ALPACA_PRICE_NOT_TICK_ALIGNED', `${label} ${price} is not aligned to the Alpaca tick size`);
    }
}

function assertBracketGeometry({ entryPrice, stopPrice, targetPrice }) {
    if (!(stopPrice < entryPrice) || !(entryPrice < targetPrice)) {
        throw policyError('ALPACA_BRACKET_GEOMETRY_INVALID', 'bracket orders require stop price < entry price < target price');
    }
}

// Guards the division explicitly rather than trusting assertBracketGeometry's current strict
// comparison to hold forever — a later relaxation to <= there would otherwise silently turn
// this into Infinity, which would flow into the returned plan metadata unnoticed.
function computePlannedRisk({ qty, entryPrice, stopPrice, targetPrice }) {
    const riskPerShare = entryPrice - stopPrice;
    if (!(riskPerShare > 0)) {
        throw policyError('ALPACA_BRACKET_GEOMETRY_INVALID', 'entry price must exceed stop price to compute planned risk');
    }
    return {
        plannedRiskDollars: qty * riskPerShare,
        plannedRewardRisk: (targetPrice - entryPrice) / riskPerShare,
    };
}

function assertCashAvailable({ qty, entryPrice, account }) {
    const cost = qty * entryPrice;
    const cash = Number(account?.cash);
    if (!Number.isFinite(cash) || cost > cash) {
        throw policyError('ALPACA_INSUFFICIENT_CASH', 'entry cost exceeds available cash (buying power/margin is not considered)');
    }
}

function assertWithinRiskLimits({
    qty, entryPrice, plannedRiskDollars, account, riskContext, policy,
}) {
    const equity = Number(account?.equity);
    if (!Number.isFinite(equity) || equity <= 0) {
        throw policyError('ALPACA_ACCOUNT_EQUITY_UNAVAILABLE', 'a valid account equity is required to enforce risk limits');
    }

    const positionValue = qty * entryPrice;
    if (positionValue / equity > policy.maxPositionPct) {
        throw policyError('ALPACA_POSITION_LIMIT_EXCEEDED', `position value would be ${(positionValue / equity * 100).toFixed(2)}% of equity, exceeding the ${policy.maxPositionPct * 100}% cap`);
    }

    if (plannedRiskDollars / equity > policy.maxRiskPerTradePct) {
        throw policyError('ALPACA_RISK_PER_TRADE_EXCEEDED', `planned risk would be ${(plannedRiskDollars / equity * 100).toFixed(2)}% of equity, exceeding the ${policy.maxRiskPerTradePct * 100}% per-trade cap`);
    }

    const totalOpenRisk = Number(riskContext?.currentOpenRiskDollars || 0) + plannedRiskDollars;
    if (totalOpenRisk / equity > policy.maxTotalOpenRiskPct) {
        throw policyError('ALPACA_TOTAL_OPEN_RISK_EXCEEDED', `total open risk would be ${(totalOpenRisk / equity * 100).toFixed(2)}% of equity, exceeding the ${policy.maxTotalOpenRiskPct * 100}% cap`);
    }

    const remainingCash = Number(account?.cash) - positionValue;
    if (remainingCash / equity < policy.minCashPct) {
        throw policyError('ALPACA_MIN_CASH_RESERVE_BREACHED', `remaining cash would be ${(remainingCash / equity * 100).toFixed(2)}% of equity, below the ${policy.minCashPct * 100}% reserve floor`);
    }
}

function assertDailyLossLimitNotBreached({ account, riskContext, policy }) {
    const equity = Number(account?.equity);
    const dailyRealizedPnl = Number(riskContext?.dailyRealizedPnl || 0);
    if (dailyRealizedPnl < 0 && Math.abs(dailyRealizedPnl) / equity >= policy.maxDailyLossPct) {
        throw policyError('ALPACA_DAILY_LOSS_LIMIT_BREACHED', `daily realized loss has reached ${(Math.abs(dailyRealizedPnl) / equity * 100).toFixed(2)}% of equity, at or beyond the ${policy.maxDailyLossPct * 100}% lockout`);
    }
}

function assertNoDuplicateSymbolPlan(riskContext, symbol) {
    if (riskContext?.hasActivePlanForSymbol) {
        throw policyError('ALPACA_DUPLICATE_SYMBOL_PLAN', `a nonterminal Day Trading plan already exists for ${symbol}`);
    }
}

// Pure orchestrator (no network, no DB): validates a caller's entry intent against a freshly
// proven quote (Task 6) and the account/asset/risk state supplied by the caller, and constructs
// the exact Alpaca bracket-order payload to submit. Every value in the returned order is a
// number computed here, never a caller-supplied string, and stop_loss/take_profit each carry
// only the one field that makes them stop-market and limit-target respectively.
function buildDayTradeBracketOrder({
    intent, quote, clock, account, asset, riskContext, policy = DEFAULT_DAY_TRADE_POLICY, now = new Date(),
}) {
    assertOnlyAllowedIntentFields(intent);
    assertEntriesEnabled(policy);
    assertBeforeEntryCutoff(clock, { cutoffMinutesBeforeClose: policy.cutoffMinutesBeforeClose, now });
    assertAssetTradable(asset);
    assertAccountTradable(account);

    const symbol = String(intent?.symbol || '').trim().toUpperCase();
    if (!symbol) throw policyError('ALPACA_SYMBOL_REQUIRED', 'a symbol is required');
    if (symbol !== quote?.symbol) {
        throw policyError('ALPACA_SYMBOL_MISMATCH', `intent symbol ${symbol} does not match quote symbol ${quote?.symbol}`);
    }

    const qty = Number(intent?.qty);
    assertWholeShareQty(qty);
    assertNoDuplicateSymbolPlan(riskContext, symbol);

    const entryPrice = computeBoundedEntryPrice({ quote, side: 'buy', maxSlippagePct: policy.maxSlippagePct });

    const stopPrice = Number(intent?.stop_price);
    const targetPrice = Number(intent?.target_price);
    assertTickAligned(stopPrice, 'stop price');
    assertTickAligned(targetPrice, 'target price');
    assertBracketGeometry({ entryPrice, stopPrice, targetPrice });

    const { plannedRiskDollars, plannedRewardRisk } = computePlannedRisk({
        qty, entryPrice, stopPrice, targetPrice,
    });

    assertCashAvailable({ qty, entryPrice, account });
    assertWithinRiskLimits({
        qty, entryPrice, plannedRiskDollars, account, riskContext, policy,
    });
    assertDailyLossLimitNotBreached({ account, riskContext, policy });

    const order = {
        symbol,
        side: 'buy',
        qty,
        type: 'limit',
        limit_price: entryPrice,
        time_in_force: 'day',
        extended_hours: false,
        order_class: 'bracket',
        take_profit: { limit_price: targetPrice },
        stop_loss: { stop_price: stopPrice },
    };

    return {
        order,
        entryPrice,
        stopPrice,
        targetPrice,
        plannedRiskDollars,
        plannedRewardRisk,
        exitDeadline: intent.exit_deadline ?? null,
    };
}

module.exports = {
    DEFAULT_DAY_TRADE_POLICY,
    ALLOWED_INTENT_FIELDS,
    assertOnlyAllowedIntentFields,
    assertBeforeEntryCutoff,
    assertAssetTradable,
    assertAccountTradable,
    assertTickAligned,
    assertBracketGeometry,
    computePlannedRisk,
    assertWithinRiskLimits,
    assertDailyLossLimitNotBreached,
    buildDayTradeBracketOrder,
};
