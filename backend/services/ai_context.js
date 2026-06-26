const db = require('../database/db');
const pybridge = require('./pybridge');

async function safeCall(fn, fallback) {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

async function fetchStockContext(symbol) {
    const sym = symbol.toUpperCase();
    const [info, news, memo, quality] = await Promise.all([
        safeCall(() => pybridge.getStockInfo(sym), { data: null }),
        safeCall(() => pybridge.getNews(sym), []),
        db.getMemo ? safeCall(() => db.getMemo(sym), null) : Promise.resolve(null),
        pybridge.getQualityMetrics ? safeCall(() => pybridge.getQualityMetrics(sym), null) : Promise.resolve(null),
    ]);

    return {
        symbol: sym,
        info: info?.data ?? info ?? null,
        news: Array.isArray(news) ? news.slice(0, 5) : [],
        memo: memo || null,
        quality: quality?.data ?? quality ?? null,
    };
}

async function fetchStockContextPair(symbolA, symbolB) {
    const [a, b] = await Promise.all([fetchStockContext(symbolA), fetchStockContext(symbolB)]);
    return { a, b };
}

async function aggregateWatchlistContext() {
    const rows = await db.getWatchlist();
    if (!rows.length) return { rows: [], byBucket: {} };

    const enriched = await Promise.all(rows.map(async (row) => {
        const [info, news] = await Promise.all([
            safeCall(() => pybridge.getStockInfo(row.symbol), { data: null }),
            safeCall(() => pybridge.getNews(row.symbol), []),
        ]);

        return {
            symbol: row.symbol,
            bucket: row.bucket ?? 'unsorted',
            price: info?.data?.price ?? null,
            sector: info?.data?.sector ?? null,
            name: info?.data?.name ?? row.symbol,
            news: Array.isArray(news) ? news.slice(0, 3).map((item) => item.title) : [],
        };
    }));

    const byBucket = {};
    for (const row of enriched) {
        byBucket[row.bucket] = byBucket[row.bucket] ?? [];
        byBucket[row.bucket].push(row);
    }

    return { rows: enriched, byBucket };
}

async function aggregatePortfolioContext() {
    const transactions = db.listTransactions ? await db.listTransactions() : [];
    if (!transactions.length) {
        return { positions: [], breaches: [], overdueMemos: [], cash: 0 };
    }

    const { buildSummary } = require('./portfolio_ledger');
    const currentPrices = {};
    const symbols = [...new Set(transactions.map((txn) => txn.symbol).filter(Boolean))];

    await Promise.all(symbols.map(async (symbol) => {
        const info = await safeCall(() => pybridge.getStockInfo(symbol), { data: null });
        if (typeof info?.data?.price === 'number') currentPrices[symbol] = info.data.price;
    }));

    const summary = buildSummary(transactions, currentPrices);
    const stops = db.listPositionStops ? await safeCall(() => db.listPositionStops(), []) : [];
    const stopBySymbol = Object.fromEntries((stops || []).map((stop) => [stop.symbol, stop.stop_loss]));

    const positions = await Promise.all(Object.entries(summary.holdings).map(async ([symbol, holding]) => {
        const info = await safeCall(() => pybridge.getStockInfo(symbol), { data: null });
        const memo = db.getMemo ? await safeCall(() => db.getMemo(symbol), null) : null;
        const currentPrice = currentPrices[symbol] ?? null;
        return {
            symbol,
            shares: holding.shares,
            avg_cost: holding.avg_cost,
            total_cost: holding.total_cost,
            dividends_received: holding.dividends_received,
            currentPrice,
            currentValue: currentPrice != null ? currentPrice * holding.shares : null,
            pnl: summary.unrealized[symbol] ?? null,
            sector: info?.data?.sector ?? null,
            stop_loss: stopBySymbol[symbol] ?? null,
            memo_exists: Boolean(memo),
            memo_last_reviewed_at: memo?.last_reviewed_at ?? null,
        };
    }));

    let breaches = [];
    try {
        const { computeBreaches } = require('./risk_engine');
        const rules = db.getRiskRules ? await db.getRiskRules() : null;
        if (rules) {
            breaches = computeBreaches({ positions, cash: summary.cash, rules }).breaches;
        }
    } catch {
        breaches = [];
    }

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const overdueMemos = positions
        .filter((position) => position.memo_exists && position.memo_last_reviewed_at)
        .filter((position) => Date.now() - new Date(position.memo_last_reviewed_at).getTime() > THIRTY_DAYS_MS)
        .map((position) => position.symbol);

    return { positions, breaches, overdueMemos, cash: summary.cash };
}

module.exports = {
    fetchStockContext,
    fetchStockContextPair,
    aggregateWatchlistContext,
    aggregatePortfolioContext,
};
