const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const { createAuth, hashPassword } = require('../services/auth');
const { createApp } = require('../server');

function get(port, path) {
    return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path }, (res) => {
            let body = '';
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        }).on('error', reject);
    });
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
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
