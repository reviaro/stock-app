const { test } = require('node:test');
const assert = require('node:assert/strict');

const { callPython, createPybridge } = require('../services/pybridge');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('pybridge combines concurrent stock info requests into one Python batch call', async () => {
    const requests = [];
    const bridge = createPybridge({
        batchDelayMs: 1,
        callPython: async (request) => {
            requests.push(request);
            return {
                status: 'success',
                data: Object.fromEntries(request.symbols.map((symbol) => [symbol, {
                    status: 'success', data: { symbol, price: 100 },
                }])),
            };
        },
    });

    const [aapl, msft] = await Promise.all([
        bridge.getStockInfo('AAPL'),
        bridge.getStockInfo('MSFT'),
    ]);

    assert.equal(aapl.data.symbol, 'AAPL');
    assert.equal(msft.data.symbol, 'MSFT');
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { action: 'info_batch', symbols: ['AAPL', 'MSFT'] });
});

test('pybridge caches market indexes and deduplicates in-flight calls', async () => {
    let calls = 0;
    const bridge = createPybridge({
        callPython: async (request) => {
            assert.equal(request.action, 'indexes');
            calls += 1;
            await delay(5);
            return { status: 'success', data: [{ symbol: '^GSPC' }] };
        },
    });

    const [first, second] = await Promise.all([
        bridge.getMarketIndexes(),
        bridge.getMarketIndexes(),
    ]);
    assert.deepEqual(first, second);
    assert.equal(calls, 1);

    await bridge.getMarketIndexes();
    assert.equal(calls, 1);
});

test('pybridge loads screener inputs for all symbols in one cached Python batch', async () => {
    const requests = [];
    const bridge = createPybridge({
        callPython: async (request) => {
            requests.push(request);
            return {
                status: 'success',
                data: Object.fromEntries(request.symbols.map((symbol) => [symbol, {
                    stock: { status: 'success', data: { symbol, price: 100 } },
                    quality: { status: 'success', data: { composite: 80 } },
                    technical: { status: 'success', data: { current: { rsi: 50 } } },
                }])),
            };
        },
    });

    const first = await bridge.getScreenerInputs(['aapl', 'MSFT', 'AAPL']);
    const second = await bridge.getScreenerInputs(['MSFT', 'AAPL']);

    assert.equal(first.AAPL.stock.data.price, 100);
    assert.equal(first.MSFT.quality.data.composite, 80);
    assert.deepEqual(second, first);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { action: 'screener_batch', symbols: ['AAPL', 'MSFT'] });
});

test('Python screener batch action accepts an empty universe', async () => {
    const result = await callPython({ action: 'screener_batch', symbols: [] });
    assert.deepEqual(result, { status: 'success', data: {} });
});
