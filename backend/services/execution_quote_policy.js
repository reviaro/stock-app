'use strict';

/**
 * Execution quote policy — single source of truth for quote data that is
 * allowed to produce an evaluated simulator fill.
 *
 * Contract (docs/plans/2026-09-06-simulator-correctness.md):
 *  - Evaluated fills are priced ONLY from quotes the server obtains from an
 *    approved source. Caller-supplied quote data is never trusted.
 *  - A valid quote: allow-listed source, symbol matching the request, finite
 *    positive price, USD, documented price_type, parseable event/receipt
 *    timestamps, event time not in the future, within the freshness window,
 *    not demo/unavailable, and regular session.
 *  - We do not model executable bid/ask. 'latest_trade' fills are labeled
 *    surrogate_simulation; 'daily_bar_proxy' (yfinance) is a documented
 *    daily-bar proxy — also a surrogate, not a bid/ask execution model.
 */

const MAX_QUOTE_AGE_SECONDS = 180;

// Approved execution sources — discovered from the hybrid feed contract.
const EXECUTION_SOURCES = new Set(['alpaca_iex', 'alpaca_sip', 'yfinance']);
const EXECUTION_QUOTE_SOURCES = EXECUTION_SOURCES;

const PRICE_TYPES = new Set(['latest_trade', 'daily_bar_proxy']);
const SYMBOL_PATTERN = /^[A-Z][A-Z0-9.\-]{0,9}$/;

function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function parseTimeMs(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
    if (typeof value === 'string' && value.trim()) {
        const ms = Date.parse(value);
        return Number.isNaN(ms) ? null : ms;
    }
    if (isFiniteNumber(value)) {
        const ms = value > 1e12 ? value : value * 1000;
        return Number.isFinite(ms) ? ms : null;
    }
    return null;
}

function reject(code, extra = {}) {
    return { valid: false, code, ...extra };
}

/**
 * Pure validator. Returns { valid: true, quote, age_seconds } or
 * { valid: false, code }. Never throws for malformed input.
 *
 * options: { now: () => Date | ms, expectedSymbol, maxAgeSeconds }
 */
function validateExecutionQuote(rawQuote, options = {}) {
    if (!rawQuote || typeof rawQuote !== 'object' || Array.isArray(rawQuote)) {
        return reject('invalid_shape');
    }
    const nowMs = typeof options.now === 'function' ? options.now().getTime()
        : isFiniteNumber(options.now) ? options.now
        : Date.now();

    if (rawQuote.is_demo === true || rawQuote.isDemo === true || rawQuote.data_source === 'unavailable') {
        return reject('demo_quote');
    }
    if (rawQuote.stale === true) return reject('quote_stale');

    const source = rawQuote.source;
    if (!EXECUTION_SOURCES.has(source)) return reject('source_not_allowed');

    const symbol = typeof rawQuote.symbol === 'string' ? rawQuote.symbol.trim().toUpperCase() : '';
    if (!symbol) return reject('symbol_invalid');
    if (!SYMBOL_PATTERN.test(symbol)) return reject('symbol_invalid');
    const expected = typeof options.expectedSymbol === 'string'
        ? options.expectedSymbol.trim().toUpperCase() : null;
    if (expected && symbol !== expected) return reject('symbol_mismatch');

    if (!isFiniteNumber(rawQuote.price) || rawQuote.price <= 0) return reject('price_invalid');
    if (rawQuote.currency !== undefined && rawQuote.currency !== 'USD') return reject('currency_not_usd');

    const priceType = rawQuote.price_type;
    if (!PRICE_TYPES.has(priceType)) return reject('price_type_invalid');

    if (rawQuote.event_time === null || rawQuote.event_time === undefined || String(rawQuote.event_time).trim() === '') {
        return reject('event_time_missing');
    }
    const eventMs = parseTimeMs(rawQuote.event_time);
    if (eventMs === null) return reject('event_time_unparseable');
    if (eventMs > nowMs) return reject('event_time_future');

    if (rawQuote.received_at === null || rawQuote.received_at === undefined || String(rawQuote.received_at).trim() === '') {
        return reject('received_at_missing');
    }
    const receivedMs = parseTimeMs(rawQuote.received_at);
    if (receivedMs === null) return reject('received_at_unparseable');

    if (receivedMs > nowMs) return reject('received_at_future');
    if (receivedMs < eventMs) return reject('negative_quote_age');
    const ageSeconds = (nowMs - eventMs) / 1000;
    const maxAge = isFiniteNumber(options.maxAgeSeconds) ? options.maxAgeSeconds : MAX_QUOTE_AGE_SECONDS;
    if (ageSeconds < 0) return reject('negative_quote_age');
    if (ageSeconds > maxAge) return reject('quote_stale', { age_seconds: ageSeconds });

    if (rawQuote.market_state !== 'REGULAR') return reject('market_not_regular');

    return {
        valid: true,
        quote: rawQuote,
        age_seconds: ageSeconds,
    };
}

/**
 * Server-side quote loader. Pulls a quote from the (injected) hybrid feed,
 * maps it to the policy shape, stamps receipt time, and validates it.
 * Caller-supplied quote fields in deps are ignored entirely.
 * Returns the validator result shape; throws only on misconfiguration.
 */
async function obtainExecutionQuote(symbol, deps = {}) {
    const getHybridQuote = deps.getHybridQuote;
    if (typeof getHybridQuote !== 'function') {
        throw new Error('execution quote loader misconfigured: getHybridQuote required');
    }
    const normalized = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
    if (!normalized || !SYMBOL_PATTERN.test(normalized)) {
        return reject('symbol_invalid');
    }

    let raw;
    try {
        raw = await getHybridQuote(normalized);
    } catch (err) {
        return reject('quote_unavailable', { detail: err.message });
    }
    if (!raw || typeof raw !== 'object' || raw.price === null || raw.price === undefined) {
        return reject('quote_unavailable');
    }

    if (raw.isDemo === true || raw.is_demo === true) return reject('demo_quote');
    if (raw.stale === true || raw.meta?.stale === true) return reject('quote_stale');
    if (raw.symbol != null && String(raw.symbol).trim().toUpperCase() !== normalized) return reject('symbol_mismatch');
    if (raw.currency != null && raw.currency !== 'USD') return reject('currency_not_usd');
    const source = raw.data_source;
    const priceType = source === 'yfinance' ? 'daily_bar_proxy' : 'latest_trade';
    const candidate = {
        source,
        symbol: normalized,
        event_time: raw.timestamp,
        received_at: new Date(
            typeof deps.now === 'function' ? deps.now().getTime()
            : isFiniteNumber(deps.now) ? deps.now
            : Date.now(),
        ).toISOString(),
        currency: 'USD',
        price: raw.price,
        price_type: priceType,
        market_state: raw.market_state === undefined ? null : raw.market_state,
    };
    if (priceType === 'latest_trade') candidate.execution_basis = 'surrogate_simulation';

    return validateExecutionQuote(candidate, {
        now: deps.now,
        maxAgeSeconds: deps.maxAgeSeconds,
        expectedSymbol: normalized,
    });
}

module.exports = {
    MAX_QUOTE_AGE_SECONDS,
    EXECUTION_SOURCES,
    EXECUTION_QUOTE_SOURCES,
    validateExecutionQuote,
    obtainExecutionQuote,
};
