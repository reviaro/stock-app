const crypto = require('node:crypto');
const express = require('express');

const COOKIE_NAME = 'stock_dashboard_session';
const SESSION_TTL_SECONDS = 12 * 60 * 60;
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function safeEqualText(left, right) {
    const leftBuffer = Buffer.from(String(left));
    const rightBuffer = Buffer.from(String(right));
    if (leftBuffer.length !== rightBuffer.length) return false;
    return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
    if (typeof password !== 'string' || password.length < 1 || password.length > 1024) {
        throw new Error('Password must contain between 1 and 1024 characters');
    }
    const derived = crypto.scryptSync(password, salt, 64);
    return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, encoded) {
    if (typeof password !== 'string' || password.length > 1024 || typeof encoded !== 'string') return false;
    const [algorithm, saltHex, expectedHex] = encoded.split('$');
    if (algorithm !== 'scrypt' || !saltHex || !expectedHex) return false;
    try {
        const expected = Buffer.from(expectedHex, 'hex');
        const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
        return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
    } catch {
        return false;
    }
}

function parseCookies(header = '') {
    return Object.fromEntries(header.split(';').map((part) => {
        const index = part.indexOf('=');
        if (index < 0) return ['', ''];
        return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
    }).filter(([key]) => key));
}

function isLoopback(address = '') {
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function createAuth({
    username,
    passwordHash,
    sessionSecret,
    apiToken = '',
    secureCookie = false,
    allowLoopback = true,
    sessionTtlSeconds = SESSION_TTL_SECONDS,
    maxAttempts = 5,
    attemptWindowMs = 15 * 60 * 1000,
    now = () => Date.now(),
    publicOrigin = '',
} = {}) {
    if (!username || !passwordHash || !sessionSecret || String(sessionSecret).length < 32) {
        throw new Error('Dashboard auth requires username, password hash, and a session secret of at least 32 characters');
    }

    const attempts = new Map();
    const sessions = new Map();
    const router = express.Router();

    function sessionKey(token) {
        return crypto.createHmac('sha256', sessionSecret).update(String(token)).digest('hex');
    }

    function pruneSessions() {
        for (const [key, session] of sessions) {
            if (session.exp <= Math.floor(now() / 1000)) sessions.delete(key);
        }
    }

    function issueToken() {
        pruneSessions();
        while (sessions.size >= 8) sessions.delete(sessions.keys().next().value);
        const token = crypto.randomBytes(32).toString('base64url');
        sessions.set(sessionKey(token), {
            sub: username,
            iat: Math.floor(now() / 1000),
            exp: Math.floor(now() / 1000) + sessionTtlSeconds,
        });
        return token;
    }

    function verifyToken(token) {
        if (typeof token !== 'string' || token.length < 32) return null;
        const key = sessionKey(token);
        const session = sessions.get(key);
        if (!session) return null;
        if (session.exp <= Math.floor(now() / 1000)) {
            sessions.delete(key);
            return null;
        }
        return session;
    }

    function revokeToken(token) {
        if (typeof token === 'string' && token) sessions.delete(sessionKey(token));
    }

    function cookieHeader(token, maxAge = sessionTtlSeconds) {
        const parts = [
            `${COOKIE_NAME}=${encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${maxAge}`,
        ];
        if (secureCookie) parts.push('Secure');
        return parts.join('; ');
    }

    function sessionFromRequest(req) {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        return verifyToken(token);
    }

    function currentAttemptRecord(req) {
        const key = req.ip || req.socket.remoteAddress || 'unknown';
        const existing = attempts.get(key);
        if (!existing || existing.resetAt <= now()) {
            const fresh = { count: 0, resetAt: now() + attemptWindowMs };
            attempts.set(key, fresh);
            return [key, fresh];
        }
        return [key, existing];
    }

    function sameOrigin(req) {
        const origin = req.headers.origin;
        if (!origin) return false;
        try {
            const expectedOrigin = publicOrigin
                ? new URL(publicOrigin).origin
                : `${req.protocol}://${req.headers.host}`;
            return new URL(origin).origin === expectedOrigin;
        } catch (_error) {
            return false;
        }
    }

    function bearerIsValid(req) {
        if (!apiToken) return false;
        const authorization = req.get('authorization') || '';
        if (!authorization.startsWith('Bearer ')) return false;
        return safeEqualText(authorization.slice(7), apiToken);
    }

    function isTrustedLoopbackAutomation(req) {
        if (!allowLoopback || !isLoopback(req.socket.remoteAddress)) return false;
        const host = req.get('host') || '';
        if (!/^(127\.0\.0\.1|\[::1\])(?::\d+)?$/.test(host)) return false;
        if (req.get('origin') || req.get('referer')) return false;
        if (Object.keys(req.headers).some((name) => name.startsWith('sec-fetch-'))) return false;
        return true;
    }

    function requireAuth(req, res, next) {
        const session = sessionFromRequest(req);
        if (session) {
            if (UNSAFE_METHODS.has(req.method) && !sameOrigin(req)) {
                return res.status(403).json({ status: 'error', error: 'Request origin is not allowed' });
            }
            req.auth = { type: 'session', username: session.sub };
            return next();
        }
        if (bearerIsValid(req)) {
            req.auth = { type: 'bearer', username };
            return next();
        }
        if (isTrustedLoopbackAutomation(req)) {
            req.auth = { type: 'loopback', username };
            return next();
        }
        return res.status(401).json({ status: 'error', error: 'Authentication required' });
    }

    router.get('/session', (req, res) => {
        const session = sessionFromRequest(req);
        res.setHeader('Cache-Control', 'no-store');
        res.json({
            status: 'success',
            data: session
                ? { authenticated: true, username: session.sub }
                : { authenticated: false },
        });
    });

    router.post('/login', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const [key, record] = currentAttemptRecord(req);
        if (record.count >= maxAttempts) {
            return res.status(429).json({ status: 'error', error: 'Too many login attempts. Try again later.' });
        }

        const suppliedUsername = typeof req.body?.username === 'string' ? req.body.username : '';
        const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
        const passwordMatches = verifyPassword(suppliedPassword, passwordHash);
        const usernameMatches = safeEqualText(suppliedUsername, username);
        if (!passwordMatches || !usernameMatches) {
            record.count += 1;
            return res.status(401).json({ status: 'error', error: 'Invalid username or password' });
        }

        attempts.delete(key);
        res.setHeader('Set-Cookie', cookieHeader(issueToken()));
        return res.json({ status: 'success', data: { authenticated: true, username } });
    });

    router.post('/logout', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!sameOrigin(req)) {
            return res.status(403).json({ status: 'error', error: 'Request origin rejected' });
        }
        revokeToken(parseCookies(req.headers.cookie)[COOKIE_NAME]);
        res.setHeader('Set-Cookie', cookieHeader('', 0));
        return res.json({ status: 'success', data: { authenticated: false } });
    });

    function securityHeaders(_req, res, next) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
        next();
    }

    return { router, requireAuth, securityHeaders, verifyToken };
}

function createAuthFromEnv(env = process.env) {
    if (!['0', '1'].includes(env.STOCK_DASHBOARD_SECURE_COOKIE)) {
        throw new Error('Secure cookie setting STOCK_DASHBOARD_SECURE_COOKIE must be explicitly set to 0 or 1');
    }
    return createAuth({
        username: env.STOCK_DASHBOARD_USERNAME,
        passwordHash: env.STOCK_DASHBOARD_PASSWORD_HASH,
        sessionSecret: env.STOCK_DASHBOARD_SESSION_SECRET,
        apiToken: env.STOCK_DASHBOARD_API_TOKEN || '',
        secureCookie: env.STOCK_DASHBOARD_SECURE_COOKIE === '1',
        allowLoopback: env.STOCK_DASHBOARD_ALLOW_LOOPBACK !== '0',
        publicOrigin: env.STOCK_DASHBOARD_PUBLIC_ORIGIN || '',
    });
}

module.exports = {
    COOKIE_NAME,
    createAuth,
    createAuthFromEnv,
    hashPassword,
    verifyPassword,
};
