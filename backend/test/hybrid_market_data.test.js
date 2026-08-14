const { test } = require('node:test');
const assert = require('node:assert');

const { getHybridQuote, createAlpacaMarketDataSource } = require('../services/hybrid_market_data');

test('hybrid quote prefers timestamped Alpaca market data and does not call yfinance', async () => {
    let yfinanceCalls = 0;
    const quote = await getHybridQuote('MSFT', {
        alpacaSource: async () => ({
            price: 415.25,
            timestamp: '2026-08-11T15:01:02.123Z',
            marketState: 'REGULAR',
            source: 'alpaca_iex',
        }),
        yfinanceSource: async () => {
            yfinanceCalls += 1;
            return { price: 400 };
        },
    });

    assert.deepStrictEqual(quote, {
        price: 415.25,
        timestamp: '2026-08-11T15:01:02.123Z',
        market_state: 'REGULAR',
        data_source: 'alpaca_iex',
    });
    assert.strictEqual(yfinanceCalls, 0);
});

test('hybrid quote falls back to genuine yfinance data when Alpaca is unavailable', async () => {
    const quote = await getHybridQuote('MSFT', {
        alpacaSource: async () => { throw new Error('Alpaca unavailable'); },
        yfinanceSource: async () => ({
            price: 414.75,
            timestamp: '2026-08-11T15:00:00Z',
            marketState: 'REGULAR',
            isDemo: false,
        }),
    });

    assert.deepStrictEqual(quote, {
        price: 414.75,
        timestamp: '2026-08-11T15:00:00Z',
        market_state: 'REGULAR',
        data_source: 'yfinance',
    });
});

test('Alpaca market-data source performs GET-only requests and returns provider timestamp and session state', async () => {
    const requests = [];
    const source = createAlpacaMarketDataSource({
        env: {
            ALPACA_API_KEY: 'paper-key',
            ALPACA_API_SECRET: 'paper-secret',
            ALPACA_MARKET_DATA_FEED: 'iex',
        },
        fetchImpl: async (url, options) => {
            requests.push({ url, options });
            if (url.includes('/trades/latest')) {
                return { ok: true, json: async () => ({ trade: { p: 415.25, t: '2026-08-11T15:01:02.123Z' } }) };
            }
            return { ok: true, json: async () => ({ is_open: true }) };
        },
    });

    const quote = await source('msft');

    assert.deepStrictEqual(quote, {
        price: 415.25,
        timestamp: '2026-08-11T15:01:02.123Z',
        marketState: 'REGULAR',
        source: 'alpaca_iex',
    });
    assert.deepStrictEqual(requests.map((request) => request.url), [
        'https://data.alpaca.markets/v2/stocks/MSFT/trades/latest?feed=iex',
        'https://paper-api.alpaca.markets/v2/clock',
    ]);
    assert.ok(requests.every((request) => request.options.method === 'GET'));
});

test('hybrid quote rejects demo yfinance fallback as unavailable', async () => {
    const quote = await getHybridQuote('MSFT', {
        alpacaSource: async () => { throw new Error('Alpaca unavailable'); },
        yfinanceSource: async () => ({
            price: 200,
            timestamp: null,
            marketState: null,
            isDemo: true,
        }),
    });

    assert.deepStrictEqual(quote, {
        price: null,
        timestamp: null,
        market_state: null,
        data_source: 'unavailable',
    });
});
