'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { fetch } = require('../services/http_runtime');
const { createAuth, hashPassword, loginClient, requireRecentMfa } = require('../services/auth');
const { decodeSecret, codeAt, matchCounter } = require('../services/totp');
const { emitSecurityEvent } = require('../services/security_events');

// RFC 6238 published test key, never an operational credential.
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const credentials = { username: 'test-operator', password: 'fictional-test-password' };
async function withServer(options, fn) {
    const auth = createAuth({ username: credentials.username, passwordHash: hashPassword(credentials.password),
        sessionSecret: 'synthetic-session-secret-at-least-32-characters', allowLoopback: false,
        onSecurityEvent: () => {}, ...options });
    const app = express(); app.use(auth.securityHeaders); app.use(express.json()); app.use('/api/auth', auth.router);
    app.post('/api/sensitive', auth.requireAuth, requireRecentMfa, (_req, res) => res.json({ ok: true }));
    app.post('/api/pause', auth.requireAuth, (_req, res) => res.json({ ok: true }));
    const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, body, headers = {}) => {
        const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
            headers: { Origin: origin, ...headers, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        return { status: response.status, body: await response.json(), headers: response.headers,
            cookie: response.headers.get('set-cookie')?.split(';')[0] };
    };
    try { await fn(request); } finally { await new Promise(r => server.close(r)); }
}

test('TOTP matches RFC vectors, rejects malformed secrets, and enforces age/replay', () => {
    for (const [seconds, expected] of [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037']]) {
        assert.equal(codeAt(SECRET, Math.floor(seconds / 30), 8), expected);
    }
    for (const value of ['', 'A'.repeat(20), SECRET + '!', '0'.repeat(32)]) assert.throws(() => decodeSecret(value));
    const current = 100000;
    const code = codeAt(SECRET, current);
    assert.equal(matchCounter(decodeSecret(SECRET), code, current * 30000), current);
    assert.equal(matchCounter(decodeSecret(SECRET), code, current * 30000, current), null);
    assert.equal(matchCounter(decodeSecret(SECRET), code, (current + 2) * 30000), null);
    assert.equal(matchCounter(decodeSecret(SECRET), '12345x', current * 30000), null);
});

test('only the exact proxy can supply a single normalized client address', () => {
    const req = (peer, forwarded) => ({ socket: { remoteAddress: peer }, get: () => forwarded });
    assert.equal(loginClient(req('192.0.2.10', '198.51.100.7'), '192.0.2.10'), '198.51.100.7');
    assert.equal(loginClient(req('::ffff:192.0.2.10', '2001:0db8:0:0:0:0:0:1'), '192.0.2.10'), '2001:db8::1');
    assert.equal(loginClient(req('127.0.0.1', '198.51.100.8'), '192.0.2.10'), '127.0.0.1');
    assert.equal(loginClient(req('192.0.2.10', '198.51.100.7, 203.0.113.8'), '192.0.2.10'), null);
    assert.equal(loginClient(req('192.0.2.10', undefined), '192.0.2.10'), null);
});

test('failed forwarded clients cannot lock out another operator client', async () => {
    await withServer({ trustedProxyIp: '127.0.0.1', maxAttempts: 2 }, async request => {
        for (let i = 0; i < 2; i++) assert.equal((await request('/api/auth/login', { ...credentials, password: 'wrong' }, { 'X-Forwarded-For': '198.51.100.1' })).status, 401);
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.1' })).status, 429);
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.2' })).status, 200);
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.2, 203.0.113.9' })).status, 429);
    });
});

test('bounded client records fail closed instead of evicting a locked-out identity', async () => {
    let now = 1000000;
    await withServer({ trustedProxyIp: '127.0.0.1', maxAttempts: 1, maxAttemptClients: 2, now: () => now, attemptWindowMs: 1000 }, async request => {
        for (const address of ['198.51.100.1', '198.51.100.2']) assert.equal((await request('/api/auth/login', { ...credentials, password: 'wrong' }, { 'X-Forwarded-For': address })).status, 401);
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.3' })).status, 429);
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.1' })).status, 429);
        now += 1001;
        assert.equal((await request('/api/auth/login', credentials, { 'X-Forwarded-For': '198.51.100.1' })).status, 200);
    });
});

test('MFA is required for sensitive live actions but not emergency pause', async () => {
    await withServer({}, async request => {
        const login = await request('/api/auth/login', credentials);
        const headers = { Cookie: login.cookie };
        assert.equal((await request('/api/sensitive', {}, headers)).body.code, 'AUTH_RECENT_MFA_REQUIRED');
        assert.equal((await request('/api/pause', {}, headers)).status, 200);
        assert.equal((await request('/api/auth/reauthenticate', { password: credentials.password, otp: '123456' }, headers)).body.code, 'AUTH_MFA_NOT_CONFIGURED');
    });
});

test('MFA login rejects missing codes and replays; fresh verification expires without replaying actions', async () => {
    let now = 1800000000000;
    const events = [];
    await withServer({ totpSecret: SECRET, now: () => now, onSecurityEvent: (event, detail) => events.push({ event, ...detail }) }, async request => {
        assert.equal((await request('/api/auth/session')).body.data.mfaConfigured, true);
        assert.equal((await request('/api/auth/login', credentials)).status, 401);
        const otp = codeAt(SECRET, Math.floor(now / 30000));
        const login = await request('/api/auth/login', { ...credentials, otp });
        assert.equal(login.status, 200);
        assert.equal(login.body.data.recentMfa, true);
        assert.equal((await request('/api/auth/login', { ...credentials, otp })).status, 401);
        const headers = { Cookie: login.cookie };
        assert.equal((await request('/api/sensitive', {}, headers)).status, 200);
        now += 300000;
        assert.equal((await request('/api/sensitive', {}, headers)).status, 403);
        assert.equal((await request('/api/pause', {}, headers)).status, 200);
        const code = codeAt(SECRET, Math.floor(now / 30000));
        assert.equal((await request('/api/auth/reauthenticate', { password: credentials.password, otp: code }, { ...headers, Origin: 'https://unrelated.example' })).status, 403);
        assert.equal((await request('/api/auth/reauthenticate', { password: credentials.password, otp: code }, headers)).status, 200);
        assert.equal((await request('/api/auth/reauthenticate', { password: credentials.password, otp: code }, headers)).status, 401);
        assert.equal((await request('/api/sensitive', {}, headers)).status, 200);
        assert.ok(events.some(e => e.event === 'reauth_success'));
        const log = JSON.stringify(events);
        for (const value of [SECRET, credentials.password, credentials.username, otp, login.cookie]) assert.equal(log.includes(value), false);
    });
});

test('malformed unrelated cookies are ignored without hiding a valid session', async () => {
    await withServer({}, async request => {
        const login = await request('/api/auth/login', credentials);
        const response = await request('/api/auth/session', undefined, { Cookie: `broken=%GG; ${login.cookie}` });
        assert.equal(response.status, 200);
        assert.equal(response.body.data.authenticated, true);
        const guest = await request('/api/auth/session', undefined, { Cookie: 'stock_dashboard_session=%GG' });
        assert.equal(guest.body.data.authenticated, false);
    });
});

test('security event output only contains allowlisted metadata', () => {
    const original = console.info, lines = [];
    console.info = line => lines.push(JSON.parse(line));
    try {
        emitSecurityEvent('live_execute', { outcome: 'refused', code: 'LIVE_GATE_CLOSED', token: 'synthetic-private', reason: 'private' });
        emitSecurityEvent('attacker-controlled-event', { outcome: 'success' });
    } finally { console.info = original; }
    assert.equal(lines.length, 1);
    assert.deepEqual(Object.keys(lines[0]).sort(), ['at', 'code', 'event', 'outcome', 'type']);
});

test('HTTPS deployments emit host-only HSTS without changing local HTTP policy', async () => {
    await withServer({ secureCookie: true, publicOrigin: 'https://investment.example' }, async request => {
        assert.equal((await request('/api/auth/session')).headers.get('strict-transport-security'), 'max-age=31536000');
    });
    await withServer({}, async request => {
        assert.equal((await request('/api/auth/session')).headers.get('strict-transport-security'), null);
    });
});
