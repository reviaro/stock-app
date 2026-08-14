const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const {
    createAuth,
    createAuthFromEnv,
    hashPassword,
} = require('../services/auth');

function request(port, method, path, { body, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const payload = body == null ? null : JSON.stringify(body);
        const req = http.request({
            hostname: '127.0.0.1',
            port,
            method,
            path,
            headers: {
                ...(payload ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload),
                } : {}),
                ...headers,
            },
        }, (res) => {
            let text = '';
            res.on('data', (chunk) => { text += chunk; });
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: text ? JSON.parse(text) : null,
            }));
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

async function withAuthServer(options, run) {
    const auth = createAuth({
        username: 'dashboard-user',
        passwordHash: hashPassword('correct horse battery staple', Buffer.alloc(16, 7)),
        sessionSecret: 'test-session-secret-that-is-at-least-32-bytes',
        secureCookie: false,
        allowLoopback: false,
        maxAttempts: 3,
        attemptWindowMs: 60_000,
        ...options,
    });
    const app = express();
    app.use(express.json());
    app.use('/api/auth', auth.router);
    app.get('/api/private', auth.requireAuth, (_req, res) => res.json({ ok: true }));
    app.post('/api/private', auth.requireAuth, (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
        await run(server.address().port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function sessionCookie(response) {
    const setCookie = response.headers['set-cookie'];
    assert.ok(Array.isArray(setCookie) && setCookie.length > 0, 'expected Set-Cookie');
    return setCookie[0].split(';', 1)[0];
}

test('private API rejects unauthenticated remote requests', async () => {
    await withAuthServer({}, async (port) => {
        const response = await request(port, 'GET', '/api/private');
        assert.equal(response.status, 401);
        assert.deepEqual(response.body, { status: 'error', error: 'Authentication required' });
    });
});

test('login issues a hardened cookie and authenticates subsequent requests', async () => {
    await withAuthServer({}, async (port) => {
        const wrong = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'wrong' },
        });
        assert.equal(wrong.status, 401);
        assert.equal(wrong.headers['set-cookie'], undefined);

        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        assert.equal(login.status, 200);
        assert.equal(login.body.data.username, 'dashboard-user');
        const rawCookie = login.headers['set-cookie'][0];
        assert.match(rawCookie, /HttpOnly/i);
        assert.match(rawCookie, /SameSite=Strict/i);
        assert.match(rawCookie, /Path=\//i);
        assert.match(rawCookie, /Max-Age=/i);

        const privateResponse = await request(port, 'GET', '/api/private', {
            headers: { Cookie: sessionCookie(login) },
        });
        assert.equal(privateResponse.status, 200);
        assert.deepEqual(privateResponse.body, { ok: true });

        const session = await request(port, 'GET', '/api/auth/session', {
            headers: { Cookie: sessionCookie(login) },
        });
        assert.equal(session.status, 200);
        assert.deepEqual(session.body.data, { authenticated: true, username: 'dashboard-user' });
    });
});

test('logout expires and revokes the captured session cookie', async () => {
    await withAuthServer({}, async (port) => {
        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        const capturedCookie = sessionCookie(login);
        const logout = await request(port, 'POST', '/api/auth/logout', {
            headers: {
                Cookie: capturedCookie,
                Origin: `http://127.0.0.1:${port}`,
            },
        });
        assert.equal(logout.status, 200);
        assert.match(logout.headers['set-cookie'][0], /Max-Age=0/i);

        const replay = await request(port, 'GET', '/api/private', {
            headers: { Cookie: capturedCookie },
        });
        assert.equal(replay.status, 401);
    });
});

test('login rate limiter blocks repeated failures by client address', async () => {
    await withAuthServer({ maxAttempts: 2 }, async (port) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
            const response = await request(port, 'POST', '/api/auth/login', {
                body: { username: 'dashboard-user', password: 'wrong' },
            });
            assert.equal(response.status, 401);
        }
        const blocked = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'wrong' },
        });
        assert.equal(blocked.status, 429);
        assert.match(blocked.body.error, /too many/i);
    });
});

test('cookie-authenticated mutations reject cross-origin requests', async () => {
    await withAuthServer({}, async (port) => {
        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        const response = await request(port, 'POST', '/api/private', {
            headers: {
                Cookie: sessionCookie(login),
                Origin: 'https://attacker.example',
                Host: `127.0.0.1:${port}`,
            },
        });
        assert.equal(response.status, 403);
        assert.match(response.body.error, /origin/i);
    });
});

test('cookie-authenticated mutations require an Origin header', async () => {
    await withAuthServer({}, async (port) => {
        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        const response = await request(port, 'POST', '/api/private', {
            headers: { Cookie: sessionCookie(login) },
        });
        assert.equal(response.status, 403);
        assert.match(response.body.error, /origin/i);
    });
});

test('cookie-authenticated mutations reject the same host with a different scheme', async () => {
    await withAuthServer({}, async (port) => {
        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        const response = await request(port, 'POST', '/api/private', {
            headers: {
                Cookie: sessionCookie(login),
                Origin: `https://127.0.0.1:${port}`,
            },
        });
        assert.equal(response.status, 403);
        assert.match(response.body.error, /origin/i);
    });
});

test('logout rejects cross-origin cookie revocation', async () => {
    await withAuthServer({}, async (port) => {
        const login = await request(port, 'POST', '/api/auth/login', {
            body: { username: 'dashboard-user', password: 'correct horse battery staple' },
        });
        const capturedCookie = sessionCookie(login);
        const logout = await request(port, 'POST', '/api/auth/logout', {
            headers: {
                Cookie: capturedCookie,
                Origin: 'https://attacker.example',
            },
        });
        assert.equal(logout.status, 403);

        const replay = await request(port, 'GET', '/api/private', {
            headers: { Cookie: capturedCookie },
        });
        assert.equal(replay.status, 200);
    });
});

test('environment configuration requires an explicit secure-cookie choice', () => {
    const base = {
        STOCK_DASHBOARD_USERNAME: 'dashboard-user',
        STOCK_DASHBOARD_PASSWORD_HASH: hashPassword('correct horse battery staple', Buffer.alloc(16, 7)),
        STOCK_DASHBOARD_SESSION_SECRET: 'test-session-secret-that-is-at-least-32-bytes',
    };
    assert.throws(() => createAuthFromEnv(base), /secure cookie/i);
    assert.throws(() => createAuthFromEnv({ ...base, STOCK_DASHBOARD_SECURE_COOKIE: 'false' }), /secure cookie/i);
    assert.doesNotThrow(() => createAuthFromEnv({ ...base, STOCK_DASHBOARD_SECURE_COOKIE: '0' }));
    assert.doesNotThrow(() => createAuthFromEnv({ ...base, STOCK_DASHBOARD_SECURE_COOKIE: '1' }));
});

test('loopback service requests can bypass browser login when explicitly enabled', async () => {
    await withAuthServer({ allowLoopback: true }, async (port) => {
        const response = await request(port, 'GET', '/api/private');
        assert.equal(response.status, 200);
    });
});

test('browser-originated loopback requests never receive the automation bypass', async () => {
    await withAuthServer({ allowLoopback: true }, async (port) => {
        const response = await request(port, 'GET', '/api/private', {
            headers: {
                Origin: 'https://attacker.example',
                'Sec-Fetch-Site': 'cross-site',
            },
        });
        assert.equal(response.status, 401);
    });
});

test('loopback bypass requires a literal loopback Host header', async () => {
    await withAuthServer({ allowLoopback: true }, async (port) => {
        const response = await request(port, 'GET', '/api/private', {
            headers: { Host: 'dashboard.attacker.example' },
        });
        assert.equal(response.status, 401);
    });
});
