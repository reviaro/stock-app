const { test } = require('node:test');
const assert = require('node:assert');

const {
    validateExecutionQuote,
    obtainExecutionQuote,
    EXECUTION_QUOTE_SOURCES,
} = require('../services/execution_quote_policy');

const NOW = new Date('2026-08-11T15:00:30.000Z');
const now = () => new Date(NOW.getTime());

function validQuote(overrides = {}) {
    return {
        source: 'alpaca_iex',
        symbol: 'MSFT',
        event_time: '2026-08-11T15:00:00.000Z',
        received_at: '2026-08-11T15:00:25.000Z',
        currency: 'USD',
        price: 415.25,
        price_type: 'latest_trade',
        market_state: 'REGULAR',
        ...overrides,
    };
}

// --- pure validator ---

test('validator accepts a fresh, regular-session, allowlisted latest-trade quote', () => {
    const result = validateExecutionQuote(validQuote(), { now });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.quote, validQuote());
});

test('validator rejects a source outside the discovered hybrid allowlist', () => {
    const result = validateExecutionQuote(validQuote({ source: 'random_website' }), { now });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'source_not_allowed');
});

test('validator rejects a symbol that does not match the requested symbol', () => {
    const result = validateExecutionQuote(validQuote({ symbol: 'AAPL' }), { now, expectedSymbol: 'MSFT' });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'symbol_mismatch');
});

test('validator rejects a missing or blank symbol', () => {
    assert.strictEqual(validateExecutionQuote(validQuote({ symbol: '' }), { now }).code, 'symbol_invalid');
});

test('validator rejects zero, negative, and non-finite prices', () => {
    for (const price of [0, -5, Number.NaN, Infinity, 'abc']) {
        const result = validateExecutionQuote(validQuote({ price }), { now });
        assert.strictEqual(result.valid, false);
        assert.strictEqual(result.code, 'price_invalid', `price ${price} should be rejected`);
    }
});

test('validator rejects currencies other than USD', () => {
    const result = validateExecutionQuote(validQuote({ currency: 'EUR' }), { now });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'currency_not_usd');
});

test('validator rejects undocumented price types', () => {
    const result = validateExecutionQuote(validQuote({ price_type: 'executable_bid_ask' }), { now });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'price_type_invalid');
});

test('validator accepts a documented daily-bar proxy price type', () => {
    const result = validateExecutionQuote(validQuote({ price_type: 'daily_bar_proxy', source: 'yfinance' }), { now });
    assert.strictEqual(result.valid, true);
});

test('validator rejects a missing, unparseable, or future event time', () => {
    assert.strictEqual(validateExecutionQuote(validQuote({ event_time: null }), { now }).code, 'event_time_missing');
    assert.strictEqual(validateExecutionQuote(validQuote({ event_time: 'garbage' }), { now }).code, 'event_time_unparseable');
    const future = validateExecutionQuote(validQuote({ event_time: '2026-08-11T15:00:31.000Z' }), { now });
    assert.strictEqual(future.valid, false);
    assert.strictEqual(future.code, 'event_time_future');
});

test('validator rejects a missing or unparseable received-at timestamp', () => {
    assert.strictEqual(validateExecutionQuote(validQuote({ received_at: null }), { now }).code, 'received_at_missing');
    assert.strictEqual(validateExecutionQuote(validQuote({ received_at: 'garbage' }), { now }).code, 'received_at_unparseable');
});

test('validator rejects quotes older than the freshness window (default 180s)', () => {
    const result = validateExecutionQuote(validQuote({ event_time: '2026-08-11T14:57:00.000Z' }), { now });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'quote_stale');
    assert.strictEqual(result.age_seconds >= 180, true);
});

test('validator accepts a quote exactly at the freshness boundary', () => {
    const result = validateExecutionQuote(validQuote({ event_time: '2026-08-11T14:57:30.000Z' }), { now });
    assert.strictEqual(result.valid, true);
});

test('validator rejects demo or unavailable quotes', () => {
    assert.strictEqual(validateExecutionQuote(validQuote({ is_demo: true }), { now }).code, 'demo_quote');
    assert.strictEqual(validateExecutionQuote(validQuote({ data_source: 'unavailable' }), { now }).code, 'demo_quote');
});

test('validator rejects quotes not in the regular session', () => {
    for (const market_state of ['CLOSED', 'PRE', 'POST', null]) {
        const result = validateExecutionQuote(validQuote({ market_state }), { now });
        assert.strictEqual(result.valid, false, `market_state ${market_state} should be rejected`);
        assert.strictEqual(result.code, 'market_not_regular');
    }
});

test('validator requires an object', () => {
    const result = validateExecutionQuote(null, { now });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'invalid_shape');
});

// --- async obtain (server-owned quote; caller input is never trusted as a quote) ---

function hybridAlpacaQuote(overrides = {}) {
    return {
        price: 415.25,
        timestamp: '2026-08-11T15:00:00Z',
        market_state: 'REGULAR',
        data_source: 'alpaca_iex',
        ...overrides,
    };
}

test('obtain maps a hybrid Alpaca quote to a validated policy quote stamped with received_at', async () => {
    const result = await obtainExecutionQuote('msft', {
        getHybridQuote: async () => hybridAlpacaQuote(),
        now,
    });
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.quote, {
        source: 'alpaca_iex',
        symbol: 'MSFT',
        event_time: '2026-08-11T15:00:00Z',
        received_at: NOW.toISOString(),
        currency: 'USD',
        price: 415.25,
        price_type: 'latest_trade',
        market_state: 'REGULAR',
        execution_basis: 'surrogate_simulation',
    });
});

test('obtain maps a hybrid yfinance quote to a documented daily-bar proxy', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({
            price: 414.75,
            data_source: 'yfinance',
        }),
        now,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quote.price_type, 'daily_bar_proxy');
    assert.strictEqual(result.quote.source, 'yfinance');
    assert.strictEqual(result.quote.execution_basis, undefined);
});

test('obtain rejects an unavailable hybrid feed without fabricating a price', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => ({
            price: null, timestamp: null, market_state: null, data_source: 'unavailable',
        }),
        now,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'quote_unavailable');
    assert.strictEqual(result.quote, undefined);
});

test('obtain rejects a stale hybrid quote instead of executing on it', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ timestamp: '2026-08-11T14:50:00Z' }),
        now,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'quote_stale');
});

test('obtain rejects a future-dated hybrid quote', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ timestamp: '2026-08-11T15:02:00Z' }),
        now,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'event_time_future');
});

test('obtain rejects quotes when the market is not in the regular session', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ market_state: 'CLOSED' }),
        now,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'market_not_regular');
});

test('obtain rejects malformed symbols before hitting the feed', async () => {
    let feedCalls = 0;
    const result = await obtainExecutionQuote('bad symbol!', {
        getHybridQuote: async () => { feedCalls += 1; return hybridAlpacaQuote(); },
        now,
    });
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.code, 'symbol_invalid');
    assert.strictEqual(feedCalls, 0);
});

test('obtain never trusts caller-supplied quote data in options', async () => {
    const result = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ price: 415.25 }),
        now,
        quote: validQuote({ price: 1, symbol: 'FAKE', source: 'random_website' }),
        price: 1,
    });
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.quote.price, 415.25);
    assert.strictEqual(result.quote.symbol, 'MSFT');
    assert.strictEqual(result.quote.source, 'alpaca_iex');
});

test('obtain honors a custom freshness window', async () => {
    const staleForDefault = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ timestamp: '2026-08-11T14:59:00Z' }),
        now,
    });
    assert.strictEqual(staleForDefault.valid, true);

    const staleForTightWindow = await obtainExecutionQuote('MSFT', {
        getHybridQuote: async () => hybridAlpacaQuote({ timestamp: '2026-08-11T14:59:00Z' }),
        now,
        maxAgeSeconds: 30,
    });
    assert.strictEqual(staleForTightWindow.valid, false);
    assert.strictEqual(staleForTightWindow.code, 'quote_stale');
});

test('stale-at-now quote cannot pass using an old receipt timestamp', () => {
    const result = validateExecutionQuote(validQuote({ event_time: '2026-08-11T14:00:00Z', received_at: '2026-08-11T14:00:01Z' }), { now });
    assert.equal(result.valid, false);
    assert.equal(result.code, 'quote_stale');
});

test('obtain preserves rejection flags and identity from the server feed', async () => {
    for (const overrides of [{ isDemo: true }, { is_demo: true }, { stale: true }, { meta: { stale: true } }, { symbol: 'AAPL' }, { currency: 'EUR' }]) {
        const result = await obtainExecutionQuote('MSFT', { now, getHybridQuote: async () => hybridAlpacaQuote(overrides) });
        assert.equal(result.valid, false, JSON.stringify(overrides));
    }
});

test('execution quote source allowlist matches the hybrid feed sources', () => {
    assert.deepStrictEqual([...EXECUTION_QUOTE_SOURCES].sort(), ['alpaca_iex', 'alpaca_sip', 'yfinance']);
});
