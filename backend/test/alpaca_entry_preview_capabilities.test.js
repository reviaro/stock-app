'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createAuth, hashPassword } = require('../services/auth');
const { authorizeApiRequest } = require('../services/api_capabilities');

const PREVIEW = '/api/alpaca-paper/day-trading/v2/entries/preview';
const TOKENS = {
    day: 'synthetic-day-preview-token-32-characters',
    live: 'synthetic-live-preview-token-32-characters',
    simulator: 'synthetic-simulator-preview-token-32-characters',
    reader: 'synthetic-reader-preview-token-32-characters',
};

function request(server, method, requestPath, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: requestPath,
            headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, res => {
            let text = '';
            res.on('data', chunk => { text += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : null }));
        });
        req.on('error', reject);
        req.end(data);
    });
}

test('real authentication permits only the account2 day credential and operator session to preview', async () => {
    const auth = createAuth({ username: 'test-operator', passwordHash: hashPassword('synthetic password'),
        sessionSecret: 'synthetic-preview-session-secret-32-characters', allowLoopback: false,
        apiToken: TOKENS.reader, alpacaDayTradingToken: TOKENS.day, alpacaLiveInvestingToken: TOKENS.live,
        simulatorTokens: [{ token: TOKENS.simulator, account_id: 2 }] });
    let reached = 0;
    const app = express();
    app.use(express.json());
    app.use('/api/auth', auth.router);
    app.use('/api', auth.requireAuth, authorizeApiRequest);
    // Isolate the global capability boundary; route behavior and broker/database
    // immutability are verified by the v2 route integration tests.
    app.post(PREVIEW, (req, res) => { reached += 1; res.json({ role: req.auth.role }); });
    app.use((_req, res) => res.status(404).json({ status: 'error' }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
    const bearer = token => ({ Authorization: `Bearer ${token}` });
    try {
        const allowed = await request(server, 'POST', PREVIEW, { account_id: 2 }, bearer(TOKENS.day));
        assert.equal(allowed.status, 200);
        assert.equal(allowed.body.role, 'alpaca-day-trading-agent');
        assert.equal(reached, 1);

        for (const account_id of [1, '2', null, undefined]) {
            const denied = await request(server, 'POST', PREVIEW, { account_id }, bearer(TOKENS.day));
            assert.equal(denied.status, 403);
            assert.equal(denied.body.code, 'CAPABILITY_DENIED');
        }
        for (const token of [TOKENS.live, TOKENS.simulator, TOKENS.reader]) {
            const denied = await request(server, 'POST', PREVIEW, { account_id: 2 }, bearer(token));
            assert.equal(denied.status, 403);
            assert.equal(denied.body.code, 'CAPABILITY_DENIED');
        }
        assert.equal((await request(server, 'POST', PREVIEW, { account_id: 2 })).status, 401);
        assert.equal((await request(server, 'POST', PREVIEW, { account_id: 2 }, bearer('invalid-token'))).status, 401);
        assert.equal(reached, 1, 'denied credentials never reach the preview handler');

        for (const [method, target] of [
            ['GET', PREVIEW], ['HEAD', PREVIEW], ['PUT', PREVIEW], ['DELETE', PREVIEW],
            ['GET', '/api/alpaca-paper/day-trading/v2/snapshot'],
            ['GET', '/api/alpaca-paper/day-trading/v2/risk'],
            ['GET', '/api/portfolio'],
            ['POST', `${PREVIEW}/extra`], ['POST', `${PREVIEW}/`],
            ['POST', '/api/alpaca-paper/day-trading/v2/entries/preview-other'],
            ['POST', '/api/alpaca-paper/day-trading/v2/mode'],
        ]) {
            const response = await request(server, method, target, method === 'GET' || method === 'HEAD' ? undefined : { account_id: 2 }, bearer(TOKENS.day));
            assert.equal(response.status, 403, `${method} ${target}`);
        }
        assert.equal(reached, 1, 'the exact POST permission does not grant additional reads or paths');

        const origin = `http://127.0.0.1:${server.address().port}`;
        const login = await request(server, 'POST', '/api/auth/login', { username: 'test-operator', password: 'synthetic password' }, { Origin: origin });
        assert.equal(login.status, 200);
        const cookie = login.headers['set-cookie'][0].split(';')[0];
        const operator = await request(server, 'POST', PREVIEW, { account_id: 2 }, { Cookie: cookie, Origin: origin });
        assert.equal(operator.status, 200);
        assert.equal(operator.body.role, 'operator');
        assert.equal(reached, 2);
        assert.equal((await request(server, 'POST', PREVIEW, { account_id: 2 }, { Cookie: cookie, Origin: 'https://untrusted.example' })).status, 403);
        assert.equal(reached, 2);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});
