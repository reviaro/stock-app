const db = require('../database/db');
const pybridge = require('./pybridge');

const MARKET_TIMEZONE = 'America/New_York';

function getMarketDate(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
        timeZone: MARKET_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(now);
}

function getCurrentSlot(now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: MARKET_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).formatToParts(now);

    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const totalMinutes = hour * 60 + minute;

    if (totalMinutes < 11 * 60) return 'openish';
    if (totalMinutes < 14 * 60) return 'midday';
    return 'closeish';
}

async function snapshotWatchlist(slot = getCurrentSlot()) {
    const watchlist = await db.getWatchlist();
    const marketDate = getMarketDate();
    const results = [];

    for (const item of watchlist) {
        let quote;
        let isCarryForward = false;

        try {
            const result = await pybridge.getStockInfo(item.symbol);
            if (result.status !== 'success' || !result.data) {
                throw new Error(result.error || 'No stock data returned');
            }
            quote = result.data;
        } catch (error) {
            const history = await db.getStockHistory(item.symbol, 90);
            const latest = history[history.length - 1];
            if (!latest) {
                throw error;
            }
            quote = {
                symbol: item.symbol,
                price: latest.price,
                previousClose: latest.previous_close,
                change: latest.change_amount,
                changePercent: latest.change_percent,
                currency: latest.currency || 'USD',
            };
            isCarryForward = true;
        }

        await db.upsertStockSnapshot({
            symbol: item.symbol,
            slot,
            marketDate,
            quoteTimestamp: new Date().toISOString(),
            price: quote.price,
            previousClose: quote.previousClose ?? null,
            changeAmount: quote.change ?? null,
            changePercent: quote.changePercent ?? null,
            currency: quote.currency ?? 'USD',
            source: 'yfinance',
            isMarketClosed: isCarryForward,
            isCarryForward,
            rawPayload: JSON.stringify(quote),
        });

        results.push({
            symbol: item.symbol,
            price: quote.price,
            previousClose: quote.previousClose ?? null,
            change: quote.change ?? null,
            changePercent: quote.changePercent ?? null,
            currency: quote.currency ?? 'USD',
            slot,
            marketDate,
            isCarryForward,
        });
    }

    return {
        status: 'success',
        data: {
            slot,
            marketDate,
            timezone: MARKET_TIMEZONE,
            count: results.length,
            snapshots: results,
        },
    };
}

module.exports = {
    snapshotWatchlist,
    getCurrentSlot,
    getMarketDate,
    MARKET_TIMEZONE,
};
