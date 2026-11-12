'use strict';
const { usablePrice, numberOrNull } = require('./research_data');
const invalid = message => Object.assign(new Error(message), { status: 400 });
const SYMBOL = /^[A-Z][A-Z0-9.-]{0,14}$/;

function validateRule(input) {
    const symbol = typeof input?.symbol === 'string' ? input.symbol.trim().toUpperCase() : '';
    if (!SYMBOL.test(symbol)) throw invalid('Enter a valid stock or ETF symbol.');
    if (!['above', 'below', 'pct_up', 'pct_down'].includes(input.condition)) throw invalid('Choose a supported alert condition.');
    if (typeof input.threshold !== 'number' || !Number.isFinite(input.threshold) || input.threshold <= 0 || input.threshold > 1e9
        || (input.condition.startsWith('pct_') && input.threshold > 1000)) throw invalid('Enter a positive, finite alert threshold.');
    if (input.repeat != null && typeof input.repeat !== 'boolean') throw invalid('Repeat must be true or false.');
    if (input.label != null && (typeof input.label !== 'string' || input.label.length > 120)) throw invalid('Keep the alert label under 120 characters.');
    return { symbol, condition: input.condition, threshold: input.threshold, repeat: input.repeat === true, label: input.label?.trim() || '' };
}

function quoteStatus(result, symbol, now) {
    const price = usablePrice(result, { now, maxAgeMs: 20 * 60_000 });
    if (price == null || result.data?.symbol !== symbol || result.data?.currency !== 'USD'
        || result.data?.priceBasis === 'unadjusted_daily_bar') return 'No fresh, dated USD quote; alerts were not evaluated.';
    return null;
}

function evaluateAlert(rule, state, result, now) {
    if (quoteStatus(result, rule.symbol, now)) return { state, hit: false };
    const quote = result.data, price = numberOrNull(quote.price), stamp = quote.timestamp || result.meta?.eventAt;
    if (state.lastQuoteAt && Date.parse(stamp) <= Date.parse(state.lastQuoteAt)) return { state, hit: false };
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(stamp));
    const previous = numberOrNull(quote.regularMarketPreviousClose);
    const changePct = previous > 0 ? (price / previous - 1) * 100 : null;
    const percentage = rule.condition.startsWith('pct_');
    if (percentage && changePct == null) return { state, hit: false, warning: 'Previous close unavailable; percentage alert was not evaluated.' };
    const matches = rule.condition === 'above' ? price >= rule.threshold
        : rule.condition === 'below' ? price <= rule.threshold
            : rule.condition === 'pct_up' ? changePct >= rule.threshold : changePct <= -rule.threshold;
    const next = { ...state, lastQuoteAt: stamp };
    if (!matches && rule.repeat && !percentage) next.armed = true;
    const ready = percentage && rule.repeat ? state.lastDay !== day : state.armed !== false;
    if (!matches || !ready) return { state: next, hit: false };
    next.armed = false; next.lastDay = day; next.triggerCount = (state.triggerCount || 0) + 1;
    return { state: next, hit: true, price, changePct, quoteAt: stamp };
}

module.exports = { validateRule, quoteStatus, evaluateAlert, SYMBOL, invalid };
