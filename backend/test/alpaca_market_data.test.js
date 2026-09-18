const { test } = require('node:test');
const assert = require('node:assert');

const {
    floorToTick, ceilToTick, validateAndAnnotateQuote, getProvenQuote,
} = require('../services/alpaca_market_data');

function rawQuote({ symbol = 'NVDA', bp = 176.48, bs = 2, ap = 176.52, as = 1, t = '2026-09-17T13:30:00.000000000Z' } = {}) {
    return { symbol, quote: { t, bp, bs, ap, as, bx: 'V', ax: 'V', c: ['R'], z: 'C' } };
}

test('annotates a fresh quote with feed, source timestamp, and retrieval time', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    const result = validateAndAnnotateQuote(rawQuote(), { requestedSymbol: 'NVDA', feed: 'iex', now });

    assert.strictEqual(result.symbol, 'NVDA');
    assert.strictEqual(result.feed, 'iex');
    assert.strictEqual(result.bidPrice, 176.48);
    assert.strictEqual(result.askPrice, 176.52);
    assert.strictEqual(result.sourceTimestamp, '2026-09-17T13:30:00.000Z');
    assert.strictEqual(result.retrievedAt, '2026-09-17T13:30:02.000Z');
});

test('records the SIP feed name when explicitly requested and passes it to the client', async () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    const requests = [];
    const client = {
        getLatestQuote: async (symbol, options) => {
            requests.push({ symbol, options });
            return rawQuote();
        },
    };
    const result = await getProvenQuote({ client, symbol: 'nvda', feed: 'sip', now });

    assert.deepStrictEqual(requests, [{ symbol: 'NVDA', options: { feed: 'sip' } }]);
    assert.strictEqual(result.feed, 'sip');
});

test('rejects a quote older than the freshness bound as stale', () => {
    const now = new Date('2026-09-17T13:30:20.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote(), { requestedSymbol: 'NVDA', feed: 'iex', now, maxAgeMs: 10_000 }),
        (err) => err.code === 'ALPACA_QUOTE_STALE',
    );
});

test('rejects a quote timestamped in the future, with no clock-skew tolerance', () => {
    const now = new Date('2026-09-17T13:29:59.500Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote(), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_FUTURE',
    );
});

test('rejects a malformed quote with a missing or non-numeric ask price', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ ap: null }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_MALFORMED',
    );
});

test('rejects a crossed quote where bid exceeds ask', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ bp: 176.60, ap: 176.52 }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_CROSSED',
    );
});

test('rejects a feed name Alpaca does not actually serve', async () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    const client = { getLatestQuote: async () => rawQuote() };
    await assert.rejects(
        getProvenQuote({ client, symbol: 'NVDA', feed: 'nasdaq', now }),
        (err) => err.code === 'ALPACA_QUOTE_FEED_INVALID',
    );
});

test('rejects a quote response missing a top-level symbol as malformed, not as an unchecked mismatch', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ symbol: '' }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_MALFORMED',
    );
});

test('rejects a quote with zero bid or ask size as unexecutable', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ as: 0 }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_MALFORMED',
    );
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ bs: 0 }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_MALFORMED',
    );
});

test('rejects a quote whose symbol does not match the requested symbol', () => {
    const now = new Date('2026-09-17T13:30:02.000Z');
    assert.throws(
        () => validateAndAnnotateQuote(rawQuote({ symbol: 'MSFT' }), { requestedSymbol: 'NVDA', feed: 'iex', now }),
        (err) => err.code === 'ALPACA_QUOTE_SYMBOL_MISMATCH',
    );
});

test('floorToTick rounds down to Alpaca tick precision: two decimals at/above $1, four below', () => {
    assert.strictEqual(floorToTick(172.678), 172.67);
    assert.strictEqual(floorToTick(0.67894), 0.6789);
});

test('ceilToTick rounds up to Alpaca tick precision: two decimals at/above $1, four below', () => {
    assert.strictEqual(ceilToTick(172.671), 172.68);
    assert.strictEqual(ceilToTick(0.67891), 0.679);
});
