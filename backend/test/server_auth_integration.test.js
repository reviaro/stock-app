const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAuth, hashPassword } = require('../services/auth');
const { createApp } = require('../server');

function request(port, path, { method = 'GET', body } = {}) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1', port, path, method,
            headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
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
        assert.equal(response.status, 400);
        assert.match(response.body.error, /symbols/i);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
