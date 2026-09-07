const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const backendDir = path.join(__dirname, '..');
const snapshotServicePath = require.resolve('../services/snapshotService');

function loadSnapshotService({ db, pybridge }) {
    const dbPath = require.resolve('../database/db');
    const pybridgePath = require.resolve('../services/pybridge');
    const originalDb = require.cache[dbPath];
    const originalPybridge = require.cache[pybridgePath];
    const originalService = require.cache[snapshotServicePath];
    require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: db };
    require.cache[pybridgePath] = { id: pybridgePath, filename: pybridgePath, loaded: true, exports: pybridge };
    delete require.cache[snapshotServicePath];
    try {
        return require('../services/snapshotService');
    } finally {
        if (originalDb) require.cache[dbPath] = originalDb; else delete require.cache[dbPath];
        if (originalPybridge) require.cache[pybridgePath] = originalPybridge; else delete require.cache[pybridgePath];
        if (originalService) require.cache[snapshotServicePath] = originalService; else delete require.cache[snapshotServicePath];
    }
}

const FIXED_NOW = new Date('2026-08-11T15:00:30.000Z');

function makeDb({ watchlist, history = [] } = {}) {
    return {
        getWatchlist: async () => watchlist,
        getStockHistory: async () => history,
        getFirstStockSnapshot: async () => null,
        upsertStockSnapshot: async (snapshot) => snapshot,
    };
}

function makePybridge({ info } = {}) {
    return {
        getStockInfo: async () => ({ status: info ? 'success' : 'error', data: info || null, error: info ? undefined : 'no data' }),
    };
}

test('snapshot preserves the provider event timestamp and records retrieval separately', async () => {
    const saved = [];
    const service = loadSnapshotService({
        db: { ...makeDb({ watchlist: [{ symbol: 'MSFT' }] }), upsertStockSnapshot: async (s) => { saved.push(s); return s; } },
        pybridge: makePybridge({ info: {
            symbol: 'MSFT', price: 415.25, previousClose: 410, change: 5.25, changePercent: 1.28,
            currency: 'USD', timestamp: '2026-08-11T15:00:00Z', marketState: 'REGULAR', open: 412, dayHigh: 416, week52High: 430, week52Low: 300,
        } }),
    });
    const { snapshotWatchlist } = service;

    const result = await snapshotWatchlist('midday', { now: FIXED_NOW });

    assert.strictEqual(saved[0].quoteTimestamp, '2026-08-11T15:00:00Z');
    assert.ok(saved[0].retrievedAt);
    assert.notStrictEqual(saved[0].retrievedAt, saved[0].quoteTimestamp);
    assert.strictEqual(result.data.snapshots[0].quoteTimestamp, '2026-08-11T15:00:00Z');
    assert.strictEqual(result.data.snapshots[0].retrievedAt, saved[0].retrievedAt);
    assert.strictEqual(saved[0].source, 'yfinance');
});

test('carry-forward snapshot keeps the last stored quote timestamp, not retrieval time', async () => {
    const saved = [];
    const service = loadSnapshotService({
        db: {
            ...makeDb({
                watchlist: [{ symbol: 'MSFT' }],
                history: [{
                    price: 415.25, previous_close: 410, change_amount: 5.25,
                    change_percent: 1.28, currency: 'USD', quote_timestamp: '2026-08-11T14:30:00Z',
                }],
            }),
            upsertStockSnapshot: async (s) => { saved.push(s); return s; },
        },
        pybridge: makePybridge({ info: null }),
    });
    const { snapshotWatchlist } = service;

    await snapshotWatchlist('midday', { now: FIXED_NOW });

    assert.strictEqual(saved[0].quoteTimestamp, '2026-08-11T14:30:00Z');
    assert.strictEqual(saved[0].isCarryForward, true);
    assert.ok(saved[0].retrievedAt);
    assert.notStrictEqual(saved[0].retrievedAt, saved[0].quoteTimestamp);
});

test('snapshot falls back to retrieval time only when no provider timestamp exists', async () => {
    const saved = [];
    const service = loadSnapshotService({
        db: { ...makeDb({ watchlist: [{ symbol: 'MSFT' }] }), upsertStockSnapshot: async (s) => { saved.push(s); return s; } },
        pybridge: makePybridge({ info: {
            symbol: 'MSFT', price: 415.25, previousClose: 410, change: 5.25, changePercent: 1.28,
            currency: 'USD', timestamp: null,
        } }),
    });
    const { snapshotWatchlist } = service;

    await snapshotWatchlist('midday', { now: FIXED_NOW });

    assert.strictEqual(saved[0].quoteTimestamp, FIXED_NOW.toISOString());
    assert.strictEqual(saved[0].quoteTimestampBasis, 'retrieval');
    assert.strictEqual(saved[0].retrievedAt, FIXED_NOW.toISOString());
});

test('snapshot stores an explicit basis for provider timestamps', async () => {
    const saved = [];
    const service = loadSnapshotService({
        db: { ...makeDb({ watchlist: [{ symbol: 'MSFT' }] }), upsertStockSnapshot: async (s) => { saved.push(s); return s; } },
        pybridge: makePybridge({ info: {
            symbol: 'MSFT', price: 415.25, previousClose: 410, change: 5.25, changePercent: 1.28,
            currency: 'USD', timestamp: '2026-08-11T15:00:00Z',
        } }),
    });
    const { snapshotWatchlist } = service;

    await snapshotWatchlist('midday', { now: FIXED_NOW });

    assert.strictEqual(saved[0].quoteTimestampBasis, 'provider_event');
});
