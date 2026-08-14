const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
    createBatchingStockInfoLoader,
    createAsyncTtlCache,
} = require('../services/market_data_cache');

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

test('stock loader batches concurrent symbols and deduplicates repeated symbols', async () => {
    const batches = [];
    const loader = createBatchingStockInfoLoader({
        batchDelayMs: 1,
        fetchBatch: async (symbols) => {
            batches.push(symbols);
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                status: 'success',
                data: { symbol, price: symbol === 'AAPL' ? 100 : 200 },
            }]));
        },
    });

    const [aapl1, msft, aapl2] = await Promise.all([
        loader.get('aapl'),
        loader.get('MSFT'),
        loader.get('AAPL'),
    ]);

    assert.deepEqual(batches, [['AAPL', 'MSFT']]);
    assert.equal(aapl1.data.price, 100);
    assert.equal(aapl2.data.price, 100);
    assert.equal(msft.data.price, 200);
});

test('stock loader deduplicates a symbol while its provider batch is already running', async () => {
    let release;
    let calls = 0;
    const blocked = new Promise((resolve) => { release = resolve; });
    const loader = createBatchingStockInfoLoader({
        batchDelayMs: 1,
        fetchBatch: async (symbols) => {
            calls += 1;
            await blocked;
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                status: 'success', data: { symbol, price: 100 },
            }]));
        },
    });

    const first = loader.get('AAPL');
    await tick();
    const second = loader.get('AAPL');
    release();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.data.price, 100);
    assert.equal(secondResult.data.price, 100);
    assert.equal(calls, 1);
});

test('a new symbol during a running batch does not refetch active symbols', async () => {
    let release;
    const batches = [];
    const blocked = new Promise((resolve) => { release = resolve; });
    const loader = createBatchingStockInfoLoader({
        batchDelayMs: 1,
        fetchBatch: async (symbols) => {
            batches.push(symbols);
            await blocked;
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                status: 'success', data: { symbol, price: 100 },
            }]));
        },
    });

    const aapl = loader.get('AAPL');
    await tick();
    const msft = loader.get('MSFT');
    await tick();
    release();
    await Promise.all([aapl, msft]);

    assert.deepEqual(batches, [['AAPL'], ['MSFT']]);
});

test('stock loader serves warm results from TTL cache without another provider call', async () => {
    let now = 1_000;
    let calls = 0;
    const loader = createBatchingStockInfoLoader({
        ttlMs: 60_000,
        batchDelayMs: 1,
        now: () => now,
        fetchBatch: async (symbols) => {
            calls += 1;
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                status: 'success', data: { symbol, price: calls },
            }]));
        },
    });

    assert.equal((await loader.get('AAPL')).data.price, 1);
    assert.equal((await loader.get('AAPL')).data.price, 1);
    assert.equal(calls, 1);

    now += 60_001;
    assert.equal((await loader.get('AAPL')).data.price, 2);
    assert.equal(calls, 2);
});

test('stock loader returns stale successful data when a refresh fails', async () => {
    let now = 1_000;
    let fail = false;
    const loader = createBatchingStockInfoLoader({
        ttlMs: 100,
        staleTtlMs: 10_000,
        batchDelayMs: 1,
        now: () => now,
        fetchBatch: async (symbols) => {
            if (fail) throw new Error('provider unavailable');
            return Object.fromEntries(symbols.map((symbol) => [symbol, {
                status: 'success', data: { symbol, price: 123 },
            }]));
        },
    });

    await loader.get('AAPL');
    now += 101;
    fail = true;
    const result = await loader.get('AAPL');
    assert.equal(result.data.price, 123);
    assert.equal(result.meta.stale, true);
});

test('async TTL cache deduplicates in-flight calls and expires predictably', async () => {
    let now = 500;
    let calls = 0;
    const cache = createAsyncTtlCache({ ttlMs: 1_000, now: () => now });
    const load = async () => {
        calls += 1;
        await tick();
        return { calls };
    };

    const [first, second] = await Promise.all([
        cache.get('indexes', load),
        cache.get('indexes', load),
    ]);
    assert.equal(first.calls, 1);
    assert.equal(second.calls, 1);
    assert.equal(calls, 1);

    now += 1_001;
    assert.equal((await cache.get('indexes', load)).calls, 2);
});
