const { floorToTick } = require('./alpaca_market_data');

const DEFAULT_MAX_ENTRY_SLIPPAGE_PCT = 0.005; // 0.5% above the current ask

function quotePolicyError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Regular hours only (plan Section 2): no extended-hours entries in phase 1. This checks
// only that the market is open — Alpaca's is_open is still true at 3:50 PM ET, so it does
// NOT enforce the plan's Section 8 entry cutoff (no new entries after a configured time
// ahead of the 3:45 time exit). That cutoff belongs to Task 7's order policy.
function assertRegularMarketHoursOpen(clock) {
    if (!clock?.is_open) {
        throw quotePolicyError('ALPACA_MARKET_CLOSED', 'Day Trading entries require the market to be open for regular hours');
    }
}

// The returned price is a marketable BUY limit: it deliberately pays more than the fresh
// ask so the order can fill immediately, bounded by maxSlippagePct so a stale or bad quote
// can't produce an unbounded price. This number — not the raw ask — is the "estimated
// executable entry" that Task 7's risk and geometry validation (stop < entry < target,
// max planned loss) must use, since it is the worst price the order is actually allowed to
// pay. floorToTick (never nearest-tick rounding) is required here: rounding to the nearest
// tick could push the limit above the bound just computed.
function computeBoundedEntryPrice({ quote, side, maxSlippagePct = DEFAULT_MAX_ENTRY_SLIPPAGE_PCT } = {}) {
    if (side !== 'buy') {
        throw quotePolicyError('ALPACA_ENTRY_SIDE_UNSUPPORTED', 'Day Trading entries are long-only (buy) in phase 1');
    }
    if (!quote || !(quote.askPrice > 0)) {
        throw quotePolicyError('ALPACA_QUOTE_UNAVAILABLE', 'a valid ask price is required to compute a bounded entry price');
    }
    const boundedPrice = quote.askPrice * (1 + Number(maxSlippagePct));
    return floorToTick(boundedPrice);
}

module.exports = {
    DEFAULT_MAX_ENTRY_SLIPPAGE_PCT,
    assertRegularMarketHoursOpen,
    computeBoundedEntryPrice,
};
