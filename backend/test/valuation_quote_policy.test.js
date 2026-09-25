const { test } = require('node:test');
const assert = require('node:assert/strict');
const { obtainValuationQuote, validateValuationQuote } = require('../services/valuation_quote_policy');
const { obtainExecutionQuote, validateExecutionQuote } = require('../services/execution_quote_policy');
const { getHybridQuote } = require('../services/hybrid_market_data');

const now = Date.parse('2026-09-24T18:49:00Z');
function nav(overrides = {}) {
    return { symbol: 'FXAIX', price: 250, currency: 'USD', timestamp: '2026-09-23T20:00:00Z',
        marketState: 'CLOSED', quoteType: 'MUTUALFUND', ...overrides };
}
function deps(overrides = {}) {
    return { now, getHybridQuote: (symbol) => getHybridQuote(symbol, {
        alpacaSource: async () => { throw new Error('no intraday fund trades'); },
        yfinanceSource: async () => nav(overrides),
    }) };
}

test('previous daily fund NAV values a holding but cannot price a fill', async () => {
    const result = await obtainValuationQuote('FXAIX', deps());
    assert.equal(result.valid, true);
    assert.equal(result.quote.price_type, 'daily_nav');
    assert.equal(result.quote.market_state, 'CLOSED');
    assert.equal(result.quote.event_time, nav().timestamp);
    assert.equal(validateValuationQuote(result.quote, { now, expectedSymbol: 'FXAIX' }).valid, true);
    assert.equal(validateExecutionQuote(result.quote, { now }).valid, false);
    assert.equal((await obtainExecutionQuote('FXAIX', deps())).valid, false);
});

test('daily NAV still rejects bad identity, provenance, price, timestamps and stale data', async () => {
    for (const overrides of [
        { symbol: 'OTHER' }, { currency: 'EUR' }, { currency: undefined }, { price: 0 },
        { timestamp: null }, { timestamp: 'bad' }, { timestamp: '2026-09-25T20:00:00Z' },
        { timestamp: '2026-09-18T20:00:00Z' }, { isDemo: true }, { is_demo: true },
        { stale: true }, { meta: { stale: true } }, { quoteType: 'EQUITY' }, { quoteType: undefined },
    ]) {
        assert.equal((await obtainValuationQuote('FXAIX', deps(overrides))).valid, false, JSON.stringify(overrides));
    }
    const { quote } = await obtainValuationQuote('FXAIX', deps());
    for (const overrides of [{ source: 'alpaca_iex' }, { instrument_type: 'EQUITY' },
        { received_at: '2026-09-24T18:40:00Z' }, { received_at: '2026-09-25T18:49:00Z' }]) {
        assert.equal(validateValuationQuote({ ...quote, ...overrides }, { now }).valid, false);
    }
});

test('daily NAV age is bounded across weekends and rechecked at execution time', async () => {
    const monday = Date.parse('2026-09-28T18:49:00Z');
    const result = await obtainValuationQuote('FXAIX', { ...deps({ timestamp: '2026-09-25T20:00:00Z' }), now: monday });
    assert.equal(result.valid, true);
    assert.equal(validateValuationQuote(result.quote, { now: monday + 181000 }).valid, false);
    assert.equal((await obtainValuationQuote('FXAIX', { ...deps({ timestamp: '2026-09-23T20:00:00Z' }), now: monday })).valid, false);
});
