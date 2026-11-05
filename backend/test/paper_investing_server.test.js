'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAuth, hashPassword } = require('../services/auth');
const { createApp } = require('../server');
const db = require('../database/db');
const paperStore = require('../services/alpaca_paper_long_term_store');
const liveStore = require('../services/alpaca_live_store');

test('actual server exposes isolated paper policy through the operator session without live MFA', async () => {
    await db.initDb();
    const liveBefore = await liveStore.settings();
    const simulatorBefore = await db.listSimTransactions(1);
    const auth = createAuth({ username: 'test-operator', passwordHash: hashPassword('synthetic-password'),
        sessionSecret: 'synthetic-server-session-secret-at-least-32-characters', allowLoopback: false,
        onSecurityEvent: () => {} });
    const server = createApp({ auth }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    let cookie;
    async function request(path, method = 'GET', body) {
        const response = await fetch(origin + '/api' + path, { method,
            headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
            ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, json: await response.json(), headers: response.headers };
    }
    try {
        assert.equal((await request('/alpaca-paper/long-term/overview')).status, 401);
        const login = await request('/auth/login', 'POST', { username: 'test-operator', password: 'synthetic-password' });
        assert.equal(login.status, 200);
        cookie = login.headers.get('set-cookie').split(';')[0];
        const overview = await request('/alpaca-paper/long-term/overview');
        assert.equal(overview.status, 200);
        assert.equal(overview.headers.get('cache-control'), 'no-store');
        assert.equal(overview.json.data.configuration.environment, 'paper');
        assert.equal(overview.json.data.configuration.configured, false);
        assert.equal(overview.json.data.policy.paused, true);
        const policy = { ...paperStore.DEFAULT_POLICY, budget: 10000, targets: [{ symbol: 'AAPL', weightPct: 20 }] };
        const saved = await request('/alpaca-paper/long-term/policy', 'PUT', { policy, expectedVersion: 0 });
        assert.equal(saved.status, 200);
        assert.equal(saved.json.data.version, 1);
        assert.deepEqual((await paperStore.settings()).policy, policy);
        assert.deepEqual(await liveStore.settings(), liveBefore);
        assert.deepEqual(await db.listSimTransactions(1), simulatorBefore);
        assert.equal((await request('/alpaca-live/policy', 'PUT', { policy, expectedVersion: 0 })).status, 403);
        assert.equal((await request('/alpaca-paper/orders', 'POST', {})).status, 410);
        assert.equal((await request('/alpaca-paper/day-trading/v2/entries', 'POST', {})).status, 410);
        assert.equal((await request('/alpaca-paper/retire-day-trading', 'POST', { confirmation: 'RETIRE DAY TRADING' })).status, 200);
    } finally { await new Promise(resolve => server.close(resolve)); }
});
