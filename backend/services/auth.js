const crypto = require('node:crypto');
const net = require('node:net');
const express = require('express');
const { decodeSecret, matchCounter } = require('./totp');
const { emitSecurityEvent } = require('./security_events');
const { createMfaState } = require('./mfa_state');

const COOKIE_NAME = 'stock_dashboard_session';
const SESSION_TTL_SECONDS = 4 * 60 * 60;
const RECENT_MFA_SECONDS = 5 * 60;
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
        try { return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())]; }
        catch { return ['', '']; }
    }).filter(([key]) => key));
}

function normalizedIp(address = '') {
    const value = address.startsWith('::ffff:') && net.isIP(address.slice(7)) === 4 ? address.slice(7) : address;
    if (!net.isIP(value)) return null;
    // Canonicalize IPv6 text so alternate spellings cannot create new buckets.
    try { return net.isIP(value) === 6 ? new URL(`http://[${value}]`).hostname.slice(1, -1) : value; }
    catch { return null; }
}

function loginClient(req, trustedProxyIp = '') {
    const peer = normalizedIp(req.socket.remoteAddress || '');
    if (peer && peer === normalizedIp(trustedProxyIp)) {
        // The one configured proxy must overwrite X-Forwarded-For, not append
        // client-controlled chains. Never enable blanket Express trust proxy.
        const forwarded = req.get('x-forwarded-for');
        if (typeof forwarded !== 'string') return null;
        return normalizedIp(forwarded.trim());
    }
    return peer;
}

function requireRecentMfa(req, res, next) {
    if (req.auth?.type === 'session' && req.auth.role === 'operator' && req.auth.recentMfa === true) return next();
    emitSecurityEvent('mfa_required', { outcome: 'refused', code: 'AUTH_RECENT_MFA_REQUIRED' });
    return res.status(403).json({ status: 'error', code: 'AUTH_RECENT_MFA_REQUIRED',
        error: 'Verify your password and authenticator code before changing live settings or submitting an order.' });
}

function isLoopback(address = '') {
    return address === '127.0.0.1' || address === '::1' || address.startsWith('::ffff:127.');
}

function createAuth({
    username,
    passwordHash,
    sessionSecret,
    apiToken = '',
    simulatorTokens = [],
    alpacaDayTradingToken = '',
    alpacaLiveInvestingToken = '',
    secureCookie = false,
    allowLoopback = true,
    sessionTtlSeconds = SESSION_TTL_SECONDS,
    maxAttempts = 5,
    attemptWindowMs = 15 * 60 * 1000,
    now = () => Date.now(),
    publicOrigin = '',
    sampleData = false,
    cookieName = COOKIE_NAME,
    totpSecret = '',
    trustedProxyIp = '',
    maxAttemptClients = 1024,
    onSecurityEvent = emitSecurityEvent,
    mfaStateFile = '',
} = {}) {
    if (!username || !passwordHash || !sessionSecret || String(sessionSecret).length < 32) {
        throw new Error('Dashboard auth requires username, password hash, and a session secret of at least 32 characters');
    }
    if (!Array.isArray(simulatorTokens) || simulatorTokens.some((entry) =>
        !entry || typeof entry.token !== 'string' || entry.token.length < 32
        || !Number.isSafeInteger(entry.account_id) || entry.account_id <= 0
        || (entry.manage_limits !== undefined && typeof entry.manage_limits !== 'boolean'))) {
        throw new Error('Simulator credentials require a token of at least 32 characters, positive account_id, and optional boolean manage_limits');
    }
    if (alpacaDayTradingToken && (typeof alpacaDayTradingToken !== 'string' || alpacaDayTradingToken.length < 32)) {
        throw new Error('Alpaca Day Trading credential requires a token of at least 32 characters');
    }
    if (alpacaLiveInvestingToken && (typeof alpacaLiveInvestingToken !== 'string' || alpacaLiveInvestingToken.length < 32)) {
        throw new Error('Live investing credential requires a token of at least 32 characters');
    }
    const tokens = simulatorTokens.map((entry) => entry.token);
    const allScopedTokens = [...tokens, ...(alpacaDayTradingToken ? [alpacaDayTradingToken] : []), ...(alpacaLiveInvestingToken ? [alpacaLiveInvestingToken] : [])];
    if (new Set(allScopedTokens).size !== allScopedTokens.length || allScopedTokens.includes(apiToken)) {
        throw new Error('Scoped credentials must be unique and distinct from the general API token');
    }

    const attempts = new Map();
    const sessions = new Map();
    const router = express.Router();
    const totpKey = totpSecret ? decodeSecret(totpSecret) : null;
    const mfaState = totpKey && mfaStateFile ? createMfaState(mfaStateFile, totpKey) : null;
    let lastTotpCounter = -1;
    let workTokens = 20, lastWorkRefill = now();
    const audit = (event, detail = {}) => { try { onSecurityEvent(event, detail); } catch { /* Logs must not alter authorization. */ } };

    function acceptOtp(code) {
        if (!totpKey) return false;
        const counter = matchCounter(totpKey, code, now(), lastTotpCounter);
        if (counter === null) return false;
        if (mfaState && !mfaState.consume(counter)) return false;
        lastTotpCounter = counter;
        return true;
    }

    function recentMfa(session) {
        const seconds = Math.floor(now() / 1000);
        return Boolean(totpKey && session?.mfaAt != null && seconds >= session.mfaAt && seconds < session.mfaAt + RECENT_MFA_SECONDS);
    }

    function authDetails(session) {
        return { mfaConfigured: Boolean(totpKey), recentMfa: recentMfa(session),
            recentAuthUntil: session?.mfaAt == null ? null : new Date((session.mfaAt + RECENT_MFA_SECONDS) * 1000).toISOString() };
    }

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
            mfaAt: totpKey ? Math.floor(now() / 1000) : null,
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
            `${cookieName}=${encodeURIComponent(token)}`,
            'Path=/',
            'HttpOnly',
            'SameSite=Strict',
            `Max-Age=${maxAge}`,
        ];
        if (secureCookie) parts.push('Secure');
        return parts.join('; ');
    }

    function sessionFromRequest(req) {
        const token = parseCookies(req.headers.cookie)[cookieName];
        return verifyToken(token);
    }

    function currentAttemptRecord(req) {
        const key = loginClient(req, trustedProxyIp);
        if (!key) return null;
        for (const [client, record] of attempts) if (record.resetAt <= now()) attempts.delete(client);
        const existing = attempts.get(key);
        if (!existing || existing.resetAt <= now()) {
            // Refuse new buckets rather than evicting a blocked client and
            // making their brute-force limit resettable through IP churn.
            if (attempts.size >= maxAttemptClients) return null;
            const fresh = { count: 0, resetAt: now() + attemptWindowMs };
            attempts.set(key, fresh);
            return [key, fresh];
        }
        return [key, existing];
    }

    function permitAttempt(req, res, event) {
        const entry = currentAttemptRecord(req);
        const elapsed = Math.max(0, now() - lastWorkRefill);
        workTokens = Math.min(20, workTokens + elapsed / 500);
        lastWorkRefill = now();
        if (!entry || entry[1].count >= maxAttempts || workTokens < 1) {
            res.setHeader('Retry-After', entry?.[1].count >= maxAttempts ? String(Math.max(1, Math.ceil((entry[1].resetAt - now()) / 1000))) : '1');
            audit(event, { outcome: 'refused' });
            res.status(429).json({ status: 'error', error: 'Too many login attempts. Try again later.' });
            return null;
        }
        workTokens -= 1;
        return entry;
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
        // An explicitly supplied credential wins over cookies; invalid bearer
        // credentials must never fall through to the loopback bypass.
        if (req.get('authorization')) {
            const header = req.get('authorization');
            const token = header.startsWith('Bearer ') ? header.slice(7) : '';
            const agent = simulatorTokens.find((entry) => safeEqualText(token, entry.token));
            if (agent) {
                req.auth = { type: 'bearer', role: 'simulator-agent', account_id: agent.account_id,
                    manage_limits: agent.manage_limits === true, username: `simulator-${agent.account_id}` };
                return next();
            }
            if (alpacaDayTradingToken && safeEqualText(token, alpacaDayTradingToken)) {
                req.auth = { type: 'bearer', role: 'alpaca-day-trading-agent', username: 'alpaca-day-trading-agent' };
                return next();
            }
            if (alpacaLiveInvestingToken && safeEqualText(token, alpacaLiveInvestingToken)) {
                req.auth = { type: 'bearer', role: 'alpaca-long-term-agent', username: 'live-investing-agent' };
                return next();
            }
            if (bearerIsValid(req)) {
                req.auth = { type: 'bearer', role: 'reader', username };
                return next();
            }
            return res.status(401).json({ status: 'error', error: 'Invalid API credential' });
        }
        const session = sessionFromRequest(req);
        if (session) {
            if (UNSAFE_METHODS.has(req.method) && !sameOrigin(req)) {
                return res.status(403).json({ status: 'error', error: 'Request origin is not allowed' });
            }
            req.auth = { type: 'session', role: 'operator', username: session.sub, ...authDetails(session) };
            return next();
        }
        if (isTrustedLoopbackAutomation(req)) {
            req.auth = { type: 'loopback', role: 'reader', username };
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
                ? { authenticated: true, username: session.sub, ...authDetails(session), ...(sampleData ? { sampleData: true } : {}) }
                : { authenticated: false, mfaConfigured: Boolean(totpKey) },
        });
    });

    router.post('/login', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        // A cross-origin simple POST must not consume the victim's shared
        // login/reauthentication quota or a one-time authenticator code.
        if (!sameOrigin(req)) {
            return res.status(403).json({ status: 'error', error: 'Request origin is not allowed' });
        }
        const attempt = permitAttempt(req, res, 'login_rate_limited');
        if (!attempt) return;
        const [key, record] = attempt;

        const suppliedUsername = typeof req.body?.username === 'string' ? req.body.username : '';
        const suppliedPassword = typeof req.body?.password === 'string' ? req.body.password : '';
        const passwordMatches = verifyPassword(suppliedPassword, passwordHash);
        const usernameMatches = safeEqualText(suppliedUsername, username);
        let otpMatches = !totpKey;
        try { if (passwordMatches && usernameMatches && totpKey) otpMatches = acceptOtp(req.body?.otp); }
        catch {
            audit('login_failed', { outcome: 'failure', code: 'AUTH_MFA_UNAVAILABLE' });
            return res.status(503).json({ status: 'error', code: 'AUTH_MFA_UNAVAILABLE', error: 'Authenticator verification is temporarily unavailable. Contact the operator.' });
        }
        if (!passwordMatches || !usernameMatches || !otpMatches) {
            record.count += 1;
            audit('login_failed', { outcome: 'refused' });
            return res.status(401).json({ status: 'error', error: 'Invalid sign-in details' });
        }

        attempts.delete(key);
        const token = issueToken();
        res.setHeader('Set-Cookie', cookieHeader(token));
        audit('login_success', { outcome: 'success' });
        return res.json({ status: 'success', data: { authenticated: true, username, ...authDetails(verifyToken(token)), ...(sampleData ? { sampleData: true } : {}) } });
    });

    router.post('/reauthenticate', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        const session = sessionFromRequest(req);
        if (!session || req.get('authorization')) return res.status(401).json({ status: 'error', error: 'Sign in again before verifying.' });
        if (!sameOrigin(req)) return res.status(403).json({ status: 'error', error: 'Request origin is not allowed' });
        if (!totpKey) return res.status(409).json({ status: 'error', code: 'AUTH_MFA_NOT_CONFIGURED', error: 'An authenticator must be configured on the server before live investing can be authorized.' });
        const attempt = permitAttempt(req, res, 'reauth_rate_limited');
        if (!attempt) return;
        const [key, record] = attempt;
        let verified = false;
        try { verified = verifyPassword(req.body?.password, passwordHash) && acceptOtp(req.body?.otp); }
        catch {
            audit('reauth_failed', { outcome: 'failure', code: 'AUTH_MFA_UNAVAILABLE' });
            return res.status(503).json({ status: 'error', code: 'AUTH_MFA_UNAVAILABLE', error: 'Authenticator verification is temporarily unavailable. Contact the operator.' });
        }
        if (!verified) {
            record.count += 1;
            audit('reauth_failed', { outcome: 'refused' });
            return res.status(401).json({ status: 'error', error: 'Invalid verification details. Use a new authenticator code.' });
        }
        attempts.delete(key);
        session.mfaAt = Math.floor(now() / 1000);
        audit('reauth_success', { outcome: 'success' });
        return res.json({ status: 'success', data: authDetails(session) });
    });

    router.post('/logout', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        if (!sameOrigin(req)) {
            return res.status(403).json({ status: 'error', error: 'Request origin rejected' });
        }
        revokeToken(parseCookies(req.headers.cookie)[cookieName]);
        audit('logout', { outcome: 'success' });
        res.setHeader('Set-Cookie', cookieHeader('', 0));
        return res.json({ status: 'success', data: { authenticated: false } });
    });

    function securityHeaders(_req, res, next) {
        if (secureCookie && /^https:\/\//.test(publicOrigin)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
        res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
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
        simulatorTokens: JSON.parse(env.STOCK_DASHBOARD_SIMULATOR_TOKENS || '[]'),
        alpacaDayTradingToken: env.ALPACA_DAY_TRADING_ENTRY_TOKEN || '',
        alpacaLiveInvestingToken: env.STOCK_DASHBOARD_LIVE_INVESTING_TOKEN || '',
        secureCookie: env.STOCK_DASHBOARD_SECURE_COOKIE === '1',
        allowLoopback: env.STOCK_DASHBOARD_ALLOW_LOOPBACK !== '0',
        publicOrigin: env.STOCK_DASHBOARD_PUBLIC_ORIGIN || '',
        sampleData: env.SAMPLE_DATA === '1',
        cookieName: env.SAMPLE_DATA === '1' ? 'stock_dashboard_sample_session' : COOKIE_NAME,
        totpSecret: env.STOCK_DASHBOARD_TOTP_SECRET || '',
        trustedProxyIp: env.STOCK_DASHBOARD_TRUSTED_PROXY_IP || '',
        mfaStateFile: env.STOCK_DASHBOARD_MFA_STATE_FILE || '',
    });
}

module.exports = {
    COOKIE_NAME,
    createAuth,
    createAuthFromEnv,
    hashPassword,
    verifyPassword,
    loginClient,
    requireRecentMfa,
    RECENT_MFA_SECONDS,
};
