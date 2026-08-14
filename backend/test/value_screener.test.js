const { test } = require('node:test');
const assert = require('node:assert');
const { scoreCandidate } = require('../services/value_screener');
const { createValueHandler } = require('../routes/screener');

test('scoreCandidate ranks high-quality reasonable valuation as Candidate', () => {
    const result = scoreCandidate({
        stock: { forwardPE: 18, debtToEquity: 20, price: 100 },
        quality: { composite: 92 },
        technical: { current: { rsi: 45 }, interpretation: { rsi: 'Neutral' } },
    });

    assert.ok(result.score >= 78);
    assert.strictEqual(result.action, 'Candidate');
    assert.ok(result.reasons.length > 0);
});

test('scoreCandidate flags expensive leveraged weak quality stocks', () => {
    const result = scoreCandidate({
        stock: { forwardPE: 80, debtToEquity: 180, price: 100 },
        quality: { composite: 30 },
        technical: { current: { rsi: 82 }, interpretation: { rsi: 'Overbought' } },
    });

    assert.ok(result.score < 45);
    assert.strictEqual(result.action, 'Avoid');
    assert.ok(result.red_flags.includes('high leverage'));
});

test('value screener route requests one batch for the entire watchlist', async () => {
    const calls = [];
    const fakeDb = {
        getWatchlist: async () => [{ symbol: 'AAPL' }, { symbol: 'MSFT' }],
        getMemo: async () => null,
    };
    const fakeBridge = {
        getScreenerInputs: async (symbols) => {
            calls.push(symbols);
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                stock: { status: 'success', data: { symbol, price: 100, forwardPE: 20 } },
                quality: { status: 'success', data: { composite: 80 } },
                technical: { status: 'success', data: { current: { rsi: 50 } } },
            }]));
        },
    };
    let payload;
    const req = { query: { universe: 'watchlist' } };
    const res = {
        status() { return this; },
        json(value) { payload = value; return this; },
    };

    await createValueHandler({ db: fakeDb, pybridge: fakeBridge })(req, res);

    assert.deepEqual(calls, [['AAPL', 'MSFT']]);
    assert.equal(payload.status, 'success');
    assert.equal(payload.data.length, 2);
});
