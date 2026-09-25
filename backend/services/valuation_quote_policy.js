'use strict';

const { obtainExecutionQuote, validateExecutionQuote, MAX_QUOTE_AGE_SECONDS } = require('./execution_quote_policy');

// Mutual funds publish daily NAVs, not intraday trades. Allow the latest NAV
// through a long weekend, but never use this window to price an execution.
const MAX_NAV_AGE_SECONDS = 4 * 24 * 60 * 60;

function validateValuationQuote(quote, options = {}) {
    if (quote?.price_type !== 'daily_nav') return validateExecutionQuote(quote, options);
    if (quote.source !== 'yfinance' || quote.instrument_type !== 'MUTUALFUND') {
        return { valid: false, code: 'nav_source_invalid' };
    }
    if (quote.currency !== 'USD') return { valid: false, code: 'currency_not_usd' };
    // Reuse the identity, numeric, provenance, and timestamp checks. Daily NAV
    // valuation does not require an open intraday session; preserve its actual
    // market state and price type in the returned/stored mark.
    const result = validateExecutionQuote({ ...quote, price_type: 'daily_bar_proxy', market_state: 'REGULAR' },
        { ...options, maxAgeSeconds: MAX_NAV_AGE_SECONDS });
    if (!result.valid) return result;
    const now = typeof options.now === 'function' ? options.now().getTime() : options.now ?? Date.now();
    if (now - Date.parse(quote.received_at) > MAX_QUOTE_AGE_SECONDS * 1000) {
        return { valid: false, code: 'quote_stale' };
    }
    return { ...result, quote };
}

async function obtainValuationQuote(symbol, deps = {}) {
    let raw;
    const execution = await obtainExecutionQuote(symbol, {
        ...deps,
        getHybridQuote: async (ticker) => (raw = await deps.getHybridQuote(ticker)),
    });
    if (raw?.data_source !== 'yfinance' || raw?.instrument_type !== 'MUTUALFUND') return execution;
    const now = typeof deps.now === 'function' ? deps.now().getTime() : deps.now ?? Date.now();
    const quote = {
        source: raw.data_source,
        symbol: raw.symbol ?? symbol.trim().toUpperCase(),
        price: raw.price,
        currency: raw.currency,
        event_time: raw.timestamp,
        received_at: new Date(now).toISOString(),
        market_state: raw.market_state,
        instrument_type: raw.instrument_type,
        price_type: 'daily_nav',
        is_demo: raw.is_demo === true || raw.isDemo === true,
        stale: raw.stale === true || raw.meta?.stale === true,
    };
    return validateValuationQuote(quote, { now, expectedSymbol: symbol });
}

module.exports = { obtainValuationQuote, validateValuationQuote, MAX_NAV_AGE_SECONDS };
