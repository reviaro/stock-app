const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createAuth, hashPassword } = require('../services/auth');
const { authorizeApiRequest } = require('../services/api_capabilities');

test('HTTP credentials enforce sleeve and delegated limits, including invalid-token loopback downgrade attempts', async () => {
    const token = 'scoped-day-trading-test-token-32-characters';
    const auth = createAuth({ username: 'operator', passwordHash: hashPassword('test password'), sessionSecret: 's'.repeat(32),
        allowLoopback: true, apiToken: 'legacy-read-token', simulatorTokens: [{ token, account_id: 2, manage_limits: true }] });
    const app = express();
    app.use(express.json());
    app.use('/api', auth.requireAuth, authorizeApiRequest, (req, res) => res.json({ role: req.auth.role }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(path, method, credential, body) {
        return fetch(base + '/api' + path, { method, headers: { ...(credential ? { authorization: `Bearer ${credential}` } : {}),
            'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    }
    try {
        assert.equal((await call('/simulator/trade', 'POST', token, { account_id: 2 })).status, 200);
        assert.equal((await call('/simulator/trade?account_id=1', 'POST', token, { account_id: 2 })).status, 403);
        assert.equal((await call('/simulator/trade', 'POST', 'wrong-token', { account_id: 2 })).status, 401);
        // Node fetch includes browser-style Sec-Fetch headers, so it must not
        // receive even the read-only loopback identity.
        assert.equal((await call('/simulator/trade', 'POST', null, { account_id: 2 })).status, 401);
        const loopbackStatus = await new Promise((resolve, reject) => {
            const req = require('node:http').request(base + '/api/simulator/reset?account_id=2', { method: 'POST' }, (res) => {
                res.resume(); res.on('end', () => resolve(res.statusCode));
            });
            req.on('error', reject); req.end();
        });
        assert.equal(loopbackStatus, 403);
        assert.equal((await call('/simulator/trade', 'POST', 'legacy-read-token', { account_id: 2 })).status, 403);
        assert.equal((await call('/simulator/risk-policy', 'PUT', token, { account_id: 2 })).status, 200);
        assert.equal((await call('/simulator/risk-policy', 'PUT', token, { account_id: 1 })).status, 403);
        assert.equal((await call('/simulator/record', 'POST', token, { account_id: 2, source: 'operator-manual' })).status, 403);
        assert.equal((await call('/simulator/reset', 'POST', token, { account_id: 2 })).status, 403);
        assert.equal((await call('/strategy-lab/versions/1/evaluations', 'POST', token, { account_id: 2 })).status, 403);
        assert.equal((await call('/stock/AAPL', 'GET', token)).status, 200);
    } finally { await new Promise((r) => server.close(r)); }
});

test('ambiguous or overbroad credential configuration is refused at startup', () => {
    const options = { username: 'operator', passwordHash: 'placeholder', sessionSecret: 's'.repeat(32) };
    const token = 'a'.repeat(32);
    assert.throws(() => createAuth({ ...options, simulatorTokens: [{ token, account_id: 0 }] }), /credentials/);
    assert.throws(() => createAuth({ ...options, simulatorTokens: [{ token, account_id: 2, manage_limits: 'true' }] }), /credentials/);
    assert.throws(() => createAuth({ ...options, apiToken: token, simulatorTokens: [{ token, account_id: 2 }] }), /distinct/);
    assert.throws(() => createAuth({ ...options, simulatorTokens: [{ token, account_id: 1 }, { token, account_id: 2 }] }), /unique/);
});
