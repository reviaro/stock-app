'use strict';

const http = require('./http_runtime');
const { assertLiveIsolation } = require('./live_isolation');
const LIVE_URL = 'https://api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });

function configuration(env = process.env) {
    if (env.SAMPLE_DATA === '1') return { configured:false,accountBound:false,tradingEnabled:false,environment:'live',assetScope:'US stocks and ETFs',executionModes:['confirm','automatic'] };
    if (env.ALPACA_LIVE_TRADING_BASE_URL && env.ALPACA_LIVE_TRADING_BASE_URL !== LIVE_URL) {
        throw fail('LIVE_ENDPOINT_INVALID', 'The live integration requires the fixed Alpaca live endpoint.');
    }
    return { configured: Boolean(env.ALPACA_LIVE_API_KEY && env.ALPACA_LIVE_SECRET_KEY),
        accountBound: Boolean(env.ALPACA_LIVE_ACCOUNT_ID), tradingEnabled: env.ALPACA_LIVE_TRADING_ENABLED === 'true',
        environment: 'live', assetScope: 'US stocks and ETFs', executionModes: ['confirm','automatic'] };
}

function createLiveClient({ env = process.env, fetchImpl = http.fetch, verifyIsolation = assertLiveIsolation } = {}) {
    if (!configuration(env).configured) throw fail('LIVE_NOT_CONFIGURED', 'Add separate Alpaca live credentials on the server.', 503);
    async function request(base, path, { method = 'GET', body, notFound = false } = {}) {
        // Scope checks are not sufficient if a local agent can read broker keys.
        // Recheck installation facts before every use of the live credential.
        verifyIsolation(env);
        let response;
        try {
            response = await fetchImpl(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(12000),
                headers: { 'APCA-API-KEY-ID': env.ALPACA_LIVE_API_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_LIVE_SECRET_KEY,
                    ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        } catch { throw fail('LIVE_BROKER_UNAVAILABLE', 'Alpaca could not be reached; reconcile before retrying an order.', 503); }
        if (notFound && response.status === 404) return null;
        if (!response.ok) throw Object.assign(fail('LIVE_BROKER_REFUSED', 'Alpaca refused the request. Check account permissions and reconcile orders.', 502), { brokerStatus: response.status });
        if (response.status === 204) return null;
        try { return await response.json(); }
        catch { throw fail('LIVE_BROKER_UNAVAILABLE', 'Alpaca returned an invalid response.', 503); }
    }
    const trading = (path, options) => request(LIVE_URL, '/v2' + path, options);
    return {
        getAccount: () => trading('/account'), getClock: () => trading('/clock'),
        getPositions: () => trading('/positions'),
        getOrders: () => trading('/orders?status=open&nested=true&limit=500'),
        getAsset: symbol => trading('/assets/' + encodeURIComponent(symbol)),
        getLatestQuote: (symbol, { feed = 'iex' } = {}) => request(DATA_URL, '/v2/stocks/' + encodeURIComponent(symbol) + '/quotes/latest?feed=' + encodeURIComponent(feed)),
        getOrder: id => trading('/orders/' + encodeURIComponent(id)),
        getOrderByClientId: id => trading('/orders:by_client_order_id?client_order_id=' + encodeURIComponent(id), { notFound: true }),
        submit: order => trading('/orders', { method: 'POST', body: order }),
        cancel: id => trading('/orders/' + encodeURIComponent(id), { method: 'DELETE' }),
    };
}

module.exports = { configuration, createLiveClient, fail };
