const db = require('../database/db');
const pybridge = require('./pybridge');
const { evidence, usablePrice } = require('./research_data');

async function safeCall(fn, fallback) {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}

async function fetchStockContext(symbol) {
    const sym=symbol.toUpperCase();
    const packet=await require('./research_service').summary(sym);
    const memo=db.getMemo?await safeCall(()=>db.getMemo(sym),null):null;
    return {...packet,info:packet.data.info,news:packet.data.news,quality:packet.data.quality,
        evidence:packet.provenance,memo};
}

async function fetchStockContextPair(symbolA, symbolB) {
    const [a, b] = await Promise.all([fetchStockContext(symbolA), fetchStockContext(symbolB)]);
    return { a, b };
}

async function aggregateWatchlistContext() {
    const rows = await db.getWatchlist();
    if (!rows.length) return { rows: [], byBucket: {} };

    const enriched = [];
    for (const row of rows) {
        const context=await fetchStockContext(row.symbol);
        enriched.push({symbol:row.symbol,bucket:row.bucket??'unsorted',name:context.info?.name??row.symbol,
            price:context.info?.price??null,sector:context.info?.sector??null,news:context.news.slice(0,3),
            weeklyTrend:context.data.weeklyTrend,evidence:context.evidence,packetId:context.id,blockers:context.blockers});
    }

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
        return { account:{kind:'manual_ledger'}, positions: [], breaches: [], overdueMemos: [], cash: 0, valuationComplete: true, missingPriceSymbols: [], riskAssessment: 'not_assessed' };
    }

    const { buildSummary, computeHoldings, isValuationPrice } = require('./portfolio_ledger');
    const currentPrices = {};
    const infoBySymbol = {};
    const symbols = Object.entries(computeHoldings(transactions))
        .filter(([, holding]) => holding.shares > 0).map(([symbol]) => symbol);

    await Promise.all(symbols.map(async (symbol) => {
        const info = await safeCall(() => pybridge.getStockInfo(symbol), { data: null });
        infoBySymbol[symbol] = info;
        const price = usablePrice(info);
        if (isValuationPrice(price)) currentPrices[symbol] = price;
    }));

    const summary = buildSummary(transactions, currentPrices);
    const stops = db.listPositionStops ? await safeCall(() => db.listPositionStops(), []) : [];
    const stopBySymbol = Object.fromEntries((stops || []).map((stop) => [stop.symbol, stop.stop_loss]));

    const positions = await Promise.all(Object.entries(summary.holdings).map(async ([symbol, holding]) => {
        const info = infoBySymbol[symbol];
        const memo = db.getMemo ? await safeCall(() => db.getMemo(symbol), null) : null;
        const currentPrice = currentPrices[symbol] ?? null;
        return {
            symbol,
            evidence: evidence(info),
            shares: holding.shares,
            avg_cost: holding.avg_cost,
            total_cost: holding.total_cost,
            dividends_received: holding.dividends_received,
            currentPrice,
            currentValue: holding.shares === 0 ? 0 : currentPrice != null ? currentPrice * holding.shares : null,
            pnl: summary.unrealized[symbol] ?? null,
            sector: info?.data?.sector ?? null,
            stop_loss: stopBySymbol[symbol] ?? null,
            memo_exists: Boolean(memo),
            memo_last_reviewed_at: memo?.last_reviewed_at ?? null,
        };
    }));

    let breaches = [];
    let riskAssessment = 'not_assessed';
    try {
        const { computeBreaches } = require('./risk_engine');
        const rules = db.getRiskRules ? await db.getRiskRules() : null;
        if (rules) {
            const risk = computeBreaches({ positions, cash: summary.cash, rules });
            breaches = risk.breaches;
            riskAssessment = risk.riskAssessment;
        } else {
            riskAssessment = 'not_configured';
        }
    } catch {
        breaches = [];
    }

    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const overdueMemos = positions
        .filter((position) => position.memo_exists && position.memo_last_reviewed_at)
        .filter((position) => Date.now() - new Date(position.memo_last_reviewed_at).getTime() > THIRTY_DAYS_MS)
        .map((position) => position.symbol);

    return {
        account: {kind:'manual_ledger', label:'Manual portfolio ledger; excludes simulator and Alpaca holdings'},
        positions, breaches, overdueMemos, cash: summary.cash, riskAssessment,
        valuationComplete: summary.valuationComplete, missingPriceSymbols: summary.missingPriceSymbols,
    };
}

module.exports = {
    fetchStockContext,
    fetchStockContextPair,
    aggregateWatchlistContext,
    aggregatePortfolioContext,
};
