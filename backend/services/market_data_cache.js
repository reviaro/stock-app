function createAsyncTtlCache({ ttlMs = 60_000, now = () => Date.now() } = {}) {
    const values = new Map();
    const inFlight = new Map();

    async function get(key, loader) {
        const cached = values.get(key);
        if (cached && cached.expiresAt > now()) return cached.value;
        if (inFlight.has(key)) return inFlight.get(key);

        const promise = Promise.resolve()
            .then(loader)
            .then((value) => {
                values.set(key, { value, expiresAt: now() + ttlMs });
                return value;
            })
            .finally(() => inFlight.delete(key));
        inFlight.set(key, promise);
        return promise;
    }

    function clear(key) {
        if (key === undefined) values.clear();
        else values.delete(key);
    }

    return { get, clear };
}

function createBatchingStockInfoLoader({
    fetchBatch,
    ttlMs = 60_000,
    staleTtlMs = 15 * 60_000,
    batchDelayMs = 10,
    now = () => Date.now(),
} = {}) {
    if (typeof fetchBatch !== 'function') throw new Error('fetchBatch is required');

    const cache = new Map();
    const pending = new Map();
    const inFlight = new Set();
    let timer = null;

    function normalizeSymbol(symbol) {
        return String(symbol || '').trim().toUpperCase();
    }

    function staleResult(entry) {
        return {
            ...entry.value,
            meta: { ...(entry.value.meta || {}), stale: true },
        };
    }

    async function flush() {
        timer = null;
        const batch = [...pending.entries()].filter(([symbol]) => !inFlight.has(symbol));
        batch.forEach(([symbol]) => inFlight.add(symbol));
        const symbols = batch.map(([symbol]) => symbol);

        try {
            const results = await fetchBatch(symbols);
            for (const [symbol, waiters] of batch) {
                const result = results?.[symbol];
                if (!result) {
                    const error = new Error(`Market data provider omitted ${symbol}`);
                    waiters.forEach(({ reject }) => reject(error));
                    pending.delete(symbol);
                    inFlight.delete(symbol);
                    continue;
                }
                if (result.status === 'success') {
                    cache.set(symbol, {
                        value: result,
                        expiresAt: now() + ttlMs,
                        staleUntil: now() + staleTtlMs,
                    });
                }
                waiters.forEach(({ resolve }) => resolve(result));
                pending.delete(symbol);
                inFlight.delete(symbol);
            }
        } catch (error) {
            for (const [symbol, waiters] of batch) {
                const cached = cache.get(symbol);
                if (cached && cached.staleUntil > now()) {
                    waiters.forEach(({ resolve }) => resolve(staleResult(cached)));
                } else {
                    waiters.forEach(({ reject }) => reject(error));
                }
                pending.delete(symbol);
                inFlight.delete(symbol);
            }
        }
    }

    function get(symbol) {
        const normalized = normalizeSymbol(symbol);
        if (!normalized) return Promise.reject(new Error('Stock symbol is required'));
        const cached = cache.get(normalized);
        if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);

        return new Promise((resolve, reject) => {
            const waiters = pending.get(normalized) || [];
            waiters.push({ resolve, reject });
            pending.set(normalized, waiters);
            if (!timer && !inFlight.has(normalized)) timer = setTimeout(flush, batchDelayMs);
        });
    }

    function clear(symbol) {
        if (symbol === undefined) cache.clear();
        else cache.delete(normalizeSymbol(symbol));
    }

    return { get, clear };
}

module.exports = {
    createAsyncTtlCache,
    createBatchingStockInfoLoader,
};
