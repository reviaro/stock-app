const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAuth, hashPassword } = require('../services/auth');
const { createApp } = require('../server');

function request(port, path, { method = 'GET', body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path, method,
            headers: {
                ...headers,
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            },
        }, (res) => {
            let responseBody = '';
            res.on('data', (chunk) => { responseBody += chunk; });
            res.on('end', () => {
                let parsed;
                try { parsed = JSON.parse(responseBody); } catch (_error) { parsed = responseBody; }
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
    });
}

function get(port, path) {
    return request(port, path);
}

test('server leaves auth session public while protecting dashboard APIs', async () => {
    const auth = createAuth({
        username: 'dashboard-user',
        passwordHash: hashPassword('test-password', Buffer.alloc(16, 1)),
        sessionSecret: 'integration-test-session-secret-32-bytes',
        allowLoopback: false,
    });
    const app = createApp({ auth });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const session = await get(server.address().port, '/api/auth/session');
        assert.equal(session.status, 200);
        assert.equal(session.body.data.authenticated, false);

        const portfolio = await get(server.address().port, '/api/portfolio');
        assert.equal(portfolio.status, 401);
        assert.equal(portfolio.body.error, 'Authentication required');

        const alpaca = await get(server.address().port, '/api/alpaca-paper/status');
        assert.equal(alpaca.status, 401);
        assert.equal(alpaca.body.error, 'Authentication required');

        const dayTrading = await get(server.address().port, '/api/alpaca-paper/day-trading/entries');
        assert.equal(dayTrading.status, 401);
        assert.equal(dayTrading.body.error, 'Authentication required');

        const strategyLab = await get(server.address().port, '/api/strategy-lab/experiments');
        assert.equal(strategyLab.status, 401);
        assert.equal(strategyLab.body.error, 'Authentication required');

        const portfolioLab = await get(server.address().port, '/api/portfolio-lab/analyze');
        assert.equal(portfolioLab.status, 401);
        assert.equal(portfolioLab.body.error, 'Authentication required');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('dedicated Alpaca Day Trading bearer reaches the entry route but not the broker with invalid scope', async () => {
    const token = 'day-trading-agent-token-at-least-32-characters';
    const auth = createAuth({
        username: 'dashboard-user',
        passwordHash: hashPassword('test-password', Buffer.alloc(16, 3)),
        sessionSecret: 'integration-test-session-secret-32-bytes',
        alpacaDayTradingToken: token,
        allowLoopback: false,
    });
    const savedEnabled = process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED;
    const savedToken = process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
    process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = 'true';
    process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = token;
    const app = createApp({ auth });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const response = await request(server.address().port, '/api/alpaca-paper/day-trading/entries', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'X-Alpaca-Day-Trading-Token': token,
            },
            body: { account_id: 999 },
        });
        assert.equal(response.status, 400);
        assert.equal(response.body.code, 'ALPACA_ACCOUNT_SCOPE_REQUIRED');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        if (savedEnabled == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED;
        else process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED = savedEnabled;
        if (savedToken == null) delete process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
        else process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN = savedToken;
    }
});

test('dedicated Alpaca Day Trading bearer is denied unrelated mutations', async () => {
    const token = 'day-trading-agent-token-at-least-32-characters';
    const auth = createAuth({
        username: 'dashboard-user',
        passwordHash: hashPassword('test-password', Buffer.alloc(16, 4)),
        sessionSecret: 'integration-test-session-secret-32-bytes',
        alpacaDayTradingToken: token,
        allowLoopback: false,
    });
    const app = createApp({ auth });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        for (const [path, body] of [
            ['/api/alpaca-paper/orders', {}],
            ['/api/alpaca-paper/day-trading/mode', { mode: 'paper_execute', confirm: true }],
            ['/api/simulator/trade', { account_id: 2 }],
        ]) {
            const response = await request(server.address().port, path, {
                method: 'POST', headers: { Authorization: `Bearer ${token}` }, body,
            });
            assert.equal(response.status, 403, path);
            assert.equal(response.body.code, 'CAPABILITY_DENIED', path);
        }
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('server mounts the advisory Portfolio Lab route behind loopback automation policy', async () => {
    const auth = createAuth({
        username: 'dashboard-user',
        passwordHash: hashPassword('test-password', Buffer.alloc(16, 2)),
        sessionSecret: 'integration-test-session-secret-32-bytes',
        allowLoopback: true,
    });
    const app = createApp({ auth });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        const response = await request(server.address().port, '/api/portfolio-lab/analyze', {
            method: 'POST', body: {},
        });
        assert.equal(response.status, 403);
        assert.equal(response.body.code, 'CAPABILITY_DENIED');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
