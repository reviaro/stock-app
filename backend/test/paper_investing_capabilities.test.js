'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fetch } = require('../services/http_runtime');
const { createAuth, createAuthFromEnv, hashPassword } = require('../services/auth');
const { authorizeApiRequest } = require('../services/api_capabilities');

const paperToken = 'synthetic-paper-investing-credential-32-characters';
const liveToken = 'synthetic-live-investing-credential-32-characters';
const dayToken = 'synthetic-day-investing-credential-32-characters';
const simulatorToken = 'synthetic-simulator-credential-32-characters';
const readerToken = 'synthetic-reader-credential-32-characters';

test('paper investing credential is distinct and loaded only from its own setting', () => {
    const env = { STOCK_DASHBOARD_USERNAME: 'test-operator', STOCK_DASHBOARD_PASSWORD_HASH: 'synthetic-hash',
        STOCK_DASHBOARD_SESSION_SECRET: 'synthetic-session-secret-at-least-32-characters', STOCK_DASHBOARD_SECURE_COOKIE: '0' };
    assert.throws(() => createAuthFromEnv({ ...env, STOCK_DASHBOARD_PAPER_INVESTING_TOKEN: 'short' }), /Paper investing credential/);
    for (const other of ['STOCK_DASHBOARD_LIVE_INVESTING_TOKEN', 'ALPACA_DAY_TRADING_ENTRY_TOKEN', 'STOCK_DASHBOARD_API_TOKEN']) {
        assert.throws(() => createAuthFromEnv({ ...env, STOCK_DASHBOARD_PAPER_INVESTING_TOKEN: paperToken, [other]: paperToken }), /unique/);
    }
    assert.doesNotThrow(() => createAuthFromEnv({ ...env, STOCK_DASHBOARD_PAPER_INVESTING_TOKEN: paperToken }));
});

test('real authentication separates paper decisions from live, simulator, raw orders and operator controls', async () => {
    const auth = createAuth({ username: 'test-operator', passwordHash: hashPassword('synthetic-password'),
        sessionSecret: 'synthetic-session-secret-at-least-32-characters', allowLoopback: false,
        alpacaPaperInvestingToken: paperToken, alpacaLiveInvestingToken: liveToken,
        alpacaDayTradingToken: dayToken, apiToken: readerToken,
        simulatorTokens: [{ account_id: 1, token: simulatorToken }] });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', auth.router);
    app.use('/api', auth.requireAuth, authorizeApiRequest, (req, res) => res.json({ role: req.auth.role }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    async function request(path, { method = 'GET', body, token = paperToken, cookie, requestOrigin } = {}) {
        const response = await fetch(origin + '/api' + path, { method,
            headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(cookie ? { Cookie: cookie } : {}),
                ...(requestOrigin ? { Origin: requestOrigin } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    try {
        for (const path of ['/research/AAPL', '/simulator/holdings?account_id=1', '/alpaca-paper/long-term/overview']) {
            const response = await request(path);
            assert.equal(response.status, 200, path);
            assert.equal(response.data.role, 'alpaca-paper-investing-agent');
        }
        assert.equal((await request('/alpaca-paper/long-term/decisions', { method: 'POST', body: { account_id: 1 } })).status, 200);
        for (const account_id of [2, '1', null, undefined]) {
            assert.equal((await request('/alpaca-paper/long-term/decisions', { method: 'POST', body: { account_id } })).status, 403);
        }
        for (const [method, path] of [
            ['GET', '/alpaca-live/overview'], ['POST', '/alpaca-live/decisions'], ['POST', '/alpaca-paper/orders'],
            ['POST', '/alpaca-paper/day-trading/v2/entries'], ['POST', '/simulator/trade'],
            ['GET', '/simulator/holdings?account_id=2'], ['GET', '/simulator/holdings'], ['GET', '/portfolio'],
            ['PUT', '/alpaca-paper/long-term/policy'], ['POST', '/alpaca-paper/long-term/execute'],
            ['POST', '/alpaca-paper/long-term/ownership'], ['POST', '/alpaca-paper/long-term/pause'],
            ['POST', '/alpaca-paper/long-term/legacy-handover'], ['POST', '/alpaca-paper/long-term/legacy-reconcile'],
            ['POST', '/alpaca-paper/long-term/orders/example/cancel'], ['GET', '/alpaca-paper/long-term/simulator-draft'],
        ]) assert.equal((await request(path, { method, ...(method === 'GET' ? {} : { body: { account_id: 1 } }) })).status, 403, path);
        for (const token of [liveToken, dayToken, simulatorToken, readerToken]) {
            assert.equal((await request('/alpaca-paper/long-term/overview', { token })).status, 403);
            assert.equal((await request('/alpaca-paper/long-term/decisions', { token, method: 'POST', body: { account_id: 1 } })).status, 403);
        }
        const login = await request('/auth/login', { token: null, method: 'POST', requestOrigin: origin,
            body: { username: 'test-operator', password: 'synthetic-password' } });
        assert.equal(login.status, 200);
        assert.equal((await request('/alpaca-paper/long-term/policy', { token: null, cookie: login.cookie,
            method: 'PUT', requestOrigin: origin, body: {} })).status, 200);
        assert.equal((await request('/alpaca-paper/long-term/policy', { token: null, cookie: login.cookie,
            method: 'PUT', requestOrigin: 'https://untrusted.example', body: {} })).status, 403);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
