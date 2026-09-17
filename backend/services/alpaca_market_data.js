const DEFAULT_MAX_QUOTE_AGE_MS = 10_000;
const VALID_FEEDS = ['iex', 'sip'];

// Alpaca price precision: generally two decimals at/above $1.00, four decimals below it.
function tickDecimals(price) {
    return price >= 1 ? 2 : 4;
}

function assertPositivePrice(price) {
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) throw new Error('a positive price is required to round to a tick');
    return p;
}

function floorToTick(price) {
    const p = assertPositivePrice(price);
    const factor = 10 ** tickDecimals(p);
    return Math.floor(p * factor) / factor;
}

function ceilToTick(price) {
    const p = assertPositivePrice(price);
    const factor = 10 ** tickDecimals(p);
    return Math.ceil(p * factor) / factor;
}

function marketDataError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Pure validator: no network. Turns Alpaca's raw GET /v2/stocks/{symbol}/quotes/latest
// response ({ symbol, quote: { t, bp, bs, ap, as, ... } }) into a proven quote carrying
// explicit provenance, or throws a specifically-coded rejection. `feed` is recorded exactly
// as passed by the caller (never inferred) — it is what Task 14's UI discloses as Alpaca's
// IEX-coverage limitation (plan Section 2), not internal-only bookkeeping.
function validateAndAnnotateQuote(response, { requestedSymbol, feed, now = new Date(), maxAgeMs = DEFAULT_MAX_QUOTE_AGE_MS } = {}) {
    const symbol = String(requestedSymbol || '').trim().toUpperCase();
    if (!symbol) throw new Error('a symbol is required to validate a quote');
    // feed is never echoed back by the response (see the confirmed /v2/stocks/{symbol}/
    // quotes/latest schema), so a caller-supplied feed that Alpaca doesn't actually serve
    // would otherwise be recorded as trustworthy provenance without ever having been
    // validated against anything.
    if (!VALID_FEEDS.includes(feed)) {
        throw marketDataError('ALPACA_QUOTE_FEED_INVALID', `unsupported market data feed: ${feed}`);
    }

    const responseSymbol = String(response?.symbol || '').trim().toUpperCase();
    const quote = response?.quote || {};
    const bidPrice = Number(quote.bp);
    const bidSize = Number(quote.bs);
    const askPrice = Number(quote.ap);
    const askSize = Number(quote.as);
    const sourceDate = new Date(quote.t);
    // Zero size at a quoted price means nothing is actually offered there — not executable,
    // and computeBoundedEntryPrice only inspects askPrice, so this must be caught here.
    if (!responseSymbol || !Number.isFinite(bidPrice) || bidPrice <= 0 || !Number.isFinite(askPrice) || askPrice <= 0
        || !Number.isFinite(bidSize) || bidSize <= 0 || !Number.isFinite(askSize) || askSize <= 0
        || Number.isNaN(sourceDate.getTime())) {
        throw marketDataError('ALPACA_QUOTE_MALFORMED', 'quote is missing or has a non-numeric symbol/bid/ask/size/timestamp field, or a zero size');
    }

    if (responseSymbol !== symbol) {
        throw marketDataError('ALPACA_QUOTE_SYMBOL_MISMATCH', `quote symbol ${responseSymbol} does not match requested ${symbol}`);
    }

    if (bidPrice > askPrice) {
        throw marketDataError('ALPACA_QUOTE_CROSSED', `crossed quote: bid ${bidPrice} exceeds ask ${askPrice}`);
    }

    const ageMs = now.getTime() - sourceDate.getTime();
    // Any negative age means either the quote is genuinely from the future or the local
    // clock cannot be trusted — both make the freshness check unreliable, so neither is
    // tolerated with a grace window. A real skew problem is evidence for the shadow-mode
    // session (plan Section 10 Stage 2), not a bound to bake in here.
    if (ageMs < 0) {
        throw marketDataError('ALPACA_QUOTE_FUTURE', 'quote timestamp is in the future relative to the local clock');
    }
    if (ageMs > maxAgeMs) {
        throw marketDataError('ALPACA_QUOTE_STALE', `quote is ${ageMs}ms old, exceeding the ${maxAgeMs}ms freshness bound`);
    }

    return {
        symbol,
        bidPrice,
        bidSize,
        askPrice,
        askSize,
        sourceTimestamp: sourceDate.toISOString(),
        feed,
        retrievedAt: now.toISOString(),
    };
}

async function getProvenQuote({ client, symbol, feed = 'iex', now = new Date(), maxAgeMs = DEFAULT_MAX_QUOTE_AGE_MS } = {}) {
    const requestedSymbol = String(symbol || '').trim().toUpperCase();
    const response = await client.getLatestQuote(requestedSymbol, { feed });
    return validateAndAnnotateQuote(response, { requestedSymbol, feed, now, maxAgeMs });
}

module.exports = {
    DEFAULT_MAX_QUOTE_AGE_MS,
    floorToTick,
    ceilToTick,
    validateAndAnnotateQuote,
    getProvenQuote,
};
