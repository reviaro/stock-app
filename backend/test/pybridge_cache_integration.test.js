const { test } = require('node:test');
const assert = require('node:assert/strict');

const { createPybridge } = require('../services/pybridge');

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
