const db = require('../database/db');
const pybridge = require('./pybridge');
const { numberOrNull, evidence } = require('./research_data');

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

const finiteNumber = numberOrNull;

function roundMetric(value) {
    if (!Number.isFinite(value)) return null;
    return Math.round(value * 100) / 100;
}

function percentChange(numeratorValue, denominatorValue) {
    const numerator = finiteNumber(numeratorValue);
    const denominator = finiteNumber(denominatorValue);
    if (numerator === null || denominator === null || denominator === 0) return null;
    return roundMetric((numerator / denominator) * 100);
}

async function snapshotWatchlist(slot = getCurrentSlot(), { now = new Date(), db: dbClient = db, pybridge: pybridgeClient = pybridge } = {}) {
    const watchlist = await dbClient.getWatchlist();
    const marketDate = getMarketDate(now);
    const results = [];

    for (const item of watchlist) {
        let quote;
        let isCarryForward = false;
        let provenance;

        try {
            const result = await pybridgeClient.getStockInfo(item.symbol);
            if (result.status !== 'success' || !result.data) {
                throw new Error(result.error || 'No stock data returned');
            }
            provenance = evidence(result, {now});
            if (provenance.isDemo || !(finiteNumber(result.data.price)>0)) throw new Error('Verified quote unavailable');
            quote = result.data;
            isCarryForward = provenance.stale || !provenance.timestampKnown;
        } catch (error) {
            const history = await dbClient.getStockHistory(item.symbol, 90);
            const latest = history.filter(row => { try { return !JSON.parse(row.raw_payload || '{}').isDemo; } catch { return false; } }).at(-1);
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
                timestamp: latest.quote_timestamp || null,
            };
            isCarryForward = true;
        }

        const retrievedAt = new Date(now).toISOString();
        const providerEventAt = quote.timestamp || null;
        const quoteTimestamp = providerEventAt || retrievedAt;
        const quoteTimestampBasis = providerEventAt ? 'provider_event' : 'retrieval';

        const openPrice = finiteNumber(quote.open);
        const dayHigh = finiteNumber(quote.dayHigh);
        const fiftyTwoWeekHigh = finiteNumber(quote.week52High);
        const fiftyTwoWeekLow = finiteNumber(quote.week52Low);
        const firstSnapshot = await dbClient.getFirstStockSnapshot(item.symbol);
        const baselinePrice = finiteNumber(firstSnapshot?.price);

        const changeFromOpenPercent =
            openPrice !== null && dayHigh !== null ? percentChange(dayHigh - openPrice, openPrice) : null;
        const gapApr22Percent =
            openPrice !== null && baselinePrice !== null ? percentChange(openPrice - baselinePrice, baselinePrice) : null;
        const distFrom52whPercent =
            dayHigh !== null && fiftyTwoWeekHigh !== null ? percentChange(dayHigh - fiftyTwoWeekHigh, fiftyTwoWeekHigh) : null;
        const distFrom52wlPercent =
            dayHigh !== null && fiftyTwoWeekLow !== null ? percentChange(dayHigh - fiftyTwoWeekLow, fiftyTwoWeekLow) : null;

        await dbClient.upsertStockSnapshot({
            symbol: item.symbol,
            slot,
            marketDate,
            quoteTimestamp,
            quoteTimestampBasis,
            retrievedAt,
            price: quote.price,
            previousClose: quote.previousClose ?? null,
            changeAmount: quote.change ?? null,
            changePercent: quote.changePercent ?? null,
            currency: quote.currency ?? 'USD',
            source: 'yfinance',
            isMarketClosed: isCarryForward || quote.marketState === 'CLOSED',
            isCarryForward,
            rawPayload: JSON.stringify({...quote, evidence:provenance || {stale:true,source:'stored_history'}}),
            openPrice,
            dayHigh,
            fiftyTwoWeekHigh,
            fiftyTwoWeekLow,
            changeFromOpenPercent,
            gapApr22Percent,
            distFrom52whPercent,
            distFrom52wlPercent,
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
            quoteTimestamp,
            quoteTimestampBasis,
            retrievedAt,
            isCarryForward,
            open: openPrice,
            dayHigh,
            fiftyTwoWeekHigh,
            fiftyTwoWeekLow,
            changeFromOpenPercent,
            gapApr22Percent,
            distFrom52whPercent,
            distFrom52wlPercent,
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
