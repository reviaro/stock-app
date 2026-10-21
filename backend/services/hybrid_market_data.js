const pybridge = require('./pybridge');
const http = require('./http_runtime');
const {numberOrNull}=require('./research_data');

const ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';
const ALPACA_PAPER_BASE_URL = 'https://paper-api.alpaca.markets';

function alpacaCredentials(env) {
    return {
        key: env.ALPACA_PAPER_API_KEY || env.ALPACA_API_KEY,
        secret: env.ALPACA_PAPER_SECRET_KEY || env.ALPACA_API_SECRET,
    };
}

function createAlpacaMarketDataSource({ env = process.env, fetchImpl = http.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
    const credentials = alpacaCredentials(env);
    if (!credentials.key || !credentials.secret) throw new Error('Alpaca market-data credentials are not configured');
    const feed = String(env.ALPACA_MARKET_DATA_FEED || 'iex').toLowerCase();
    if (!['iex', 'sip'].includes(feed)) throw new Error('Alpaca market-data feed must be iex or sip');
    const headers = {
        'APCA-API-KEY-ID': credentials.key,
        'APCA-API-SECRET-KEY': credentials.secret,
    };
    let clockPromise = null;
    let clockFetchedAt = 0;

    async function getJson(url) {
        const response = await fetchImpl(url, {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`Alpaca read-only market-data request failed (${response.status})`);
        return response.json();
    }

    function getClock() {
        const now = Date.now();
        if (!clockPromise || now - clockFetchedAt > 15000) {
            clockFetchedAt = now;
            clockPromise = getJson(`${ALPACA_PAPER_BASE_URL}/v2/clock`).catch((error) => {
                clockPromise = null;
                throw error;
            });
        }
        return clockPromise;
    }

    return async function alpacaMarketData(symbol) {
        const normalizedSymbol = String(symbol || '').trim().toUpperCase();
        if (!/^[A-Z0-9.-]{1,15}$/.test(normalizedSymbol)) throw new Error('invalid market-data symbol');
        const [latest, clock] = await Promise.all([
            getJson(`${ALPACA_DATA_BASE_URL}/v2/stocks/${encodeURIComponent(normalizedSymbol)}/trades/latest?feed=${feed}`),
            getClock(),
        ]);
        return {
            price: latest?.trade?.p,
            symbol: normalizedSymbol, currency:'USD', quoteType:'EQUITY', retrievedAt:new Date().toISOString(),
            timestamp: latest?.trade?.t || null,
            marketState: clock?.is_open === true ? 'REGULAR' : 'CLOSED',
            source: `alpaca_${feed}`,
        };
    };
}

function normalizeUnavailable() {
    return {
        price: null,
        timestamp: null,
        market_state: null,
        data_source: 'unavailable',
    };
}

function validTimestamp(value) {
    if (typeof value !== 'string' || !value.trim()) return false;
    return Number.isFinite(Date.parse(value));
}

function normalizeQuote(quote, source, symbol) {
    if (quote?.symbol && quote.symbol !== symbol) return null;
    if(quote?.isDemo || quote?.is_demo || quote?.meta?.isDemo)return null;
    const price = numberOrNull(quote?.price);
    if (!Number.isFinite(price) || price <= 0 || !validTimestamp(quote?.timestamp)) return null;
    return {
        price,
        timestamp: quote.timestamp,
        market_state: quote.marketState || null,
        data_source: quote.source || source,
        instrument_type: quote.quoteType || null,
        symbol: quote.symbol || symbol,
        currency: quote.currency || null,
        is_demo: quote.is_demo === true || quote.isDemo === true,
        stale: quote.stale === true || quote.meta?.stale === true,
        retrieved_at: quote.retrievedAt || quote.meta?.retrievedAt || null,
    };
}

async function getHybridQuote(symbol, { alpacaSource, yfinanceSource }) {
    try {
        const alpacaQuote = normalizeQuote(await alpacaSource(symbol), 'alpaca', symbol);
        if (alpacaQuote) return alpacaQuote;
    } catch { /* fall through to research-data compatibility source */ }

    try {
        const yfinanceQuote = await yfinanceSource(symbol);
        if (yfinanceQuote?.isDemo === true || yfinanceQuote?.is_demo === true || yfinanceQuote?.meta?.isDemo === true) return normalizeUnavailable();
        return normalizeQuote(yfinanceQuote, 'yfinance', symbol) || normalizeUnavailable();
    } catch {
        return normalizeUnavailable();
    }
}

let defaultAlpacaSource;

async function getDefaultHybridQuote(symbol) {
    let alpacaSource;
    try {
        defaultAlpacaSource ||= createAlpacaMarketDataSource();
        alpacaSource = defaultAlpacaSource;
    } catch (error) {
        alpacaSource = async () => { throw error; };
    }
    return getHybridQuote(symbol, {
        alpacaSource,
        yfinanceSource: async (ticker) => {
            const info = await pybridge.getStockInfo(ticker);
            return { ...info?.data, meta:info?.meta, ...(info?.meta?.stale ? { stale: true } : {}) };
        },
    });
}

module.exports = { getHybridQuote, getDefaultHybridQuote, createAlpacaMarketDataSource };
