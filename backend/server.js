require('dotenv').config();
const express = require('express');
const cors = require('cors');
const net = require('node:net');
const path = require('path');
const db = require('./database/db');

const watchlistRoutes = require('./routes/watchlist');
const stockRoutes = require('./routes/stocks');
const canslimRoutes = require('./routes/canslim');
const marketRoutes = require('./routes/market');
const aiRoutes = require('./routes/ai');
const historyRoutes = require('./routes/history');
const portfolioRoutes = require('./routes/portfolio');
const memosRoutes = require('./routes/memos');
const qualityRoutes = require('./routes/quality');
const riskRoutes = require('./routes/risk');
const transactionsRoutes = require('./routes/transactions');
const simulatorRoutes = require('./routes/simulator');
const researchNotesRoutes = require('./routes/research_notes');
const screenerRoutes = require('./routes/screener');
const alpacaPaperRoutes = require('./routes/alpaca_paper');
const strategyLabRoutes = require('./routes/strategy_lab');
const portfolioLabRoutes = require('./routes/portfolio_lab');
const { initUniverseScheduler } = require('./services/universeCache');
const { initSnapshotScheduler } = require('./services/snapshotScheduler');
const { createAuthFromEnv } = require('./services/auth');

const PORT = Number(process.env.PORT || 3002);
const FRONTEND_DIST = path.join(__dirname, '..', 'frontend', 'dist');

function normalizeAddress(address = '') {
    return String(address).startsWith('::ffff:') ? String(address).slice(7) : String(address);
}

function isAllowedClientAddress(address, env = process.env) {
    const normalized = normalizeAddress(address);
    if (normalized === '127.0.0.1' || normalized === '::1') return true;
    const trustedProxy = normalizeAddress(env.STOCK_DASHBOARD_TRUSTED_PROXY_IP || '');
    return Boolean(trustedProxy) && normalized === trustedProxy;
}

function createApp({ auth = createAuthFromEnv(), env = process.env } = {}) {
    const app = express();
    app.disable('x-powered-by');
    app.use((req, res, next) => {
        if (!isAllowedClientAddress(req.socket.remoteAddress, env)) {
            return res.status(403).json({ status: 'error', error: 'Client address is not allowed' });
        }
        return next();
    });
    app.use(auth.securityHeaders);
    app.use(cors({
        origin: [
            'http://localhost:5173',
            'http://localhost:3002',
            'http://127.0.0.1:5173',
            'http://127.0.0.1:3002',
        ],
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        credentials: true,
    }));
    app.use(express.json({ limit: '1mb' }));

    // The login/session endpoints and static login shell must remain public.
    app.use('/api/auth', auth.router);
    app.use(express.static(FRONTEND_DIST, {
        etag: true,
        maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
        setHeaders(res, filePath) {
            if (/\.[a-f0-9]{8,}\.(js|css)$/i.test(filePath) || filePath.includes(`${path.sep}assets${path.sep}`)) {
                res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
            }
        },
    }));

    // Protect every data and mutation API. Loopback automation is allowed by auth policy.
    app.use('/api', auth.requireAuth);
    app.use('/api/watchlist', watchlistRoutes);
    app.use('/api/stock', stockRoutes);
    app.use('/api/stock/search', stockRoutes);
    app.use('/api/canslim', canslimRoutes);
    app.use('/api/market', marketRoutes);
    app.use('/api/ai', aiRoutes);
    app.use('/api/history', historyRoutes);
    app.use('/api/portfolio', portfolioRoutes);
    app.use('/api/memos', memosRoutes);
    app.use('/api/quality', qualityRoutes);
    app.use('/api/risk', riskRoutes);
    app.use('/api/transactions', transactionsRoutes);
    app.use('/api/simulator', simulatorRoutes);
    app.use('/api/research-notes', researchNotesRoutes);
    app.use('/api/screener', screenerRoutes);
    app.use('/api/alpaca-paper', alpacaPaperRoutes);
    app.use('/api/strategy-lab', strategyLabRoutes);
    app.use('/api/portfolio-lab', portfolioLabRoutes);

    app.get('*', (_req, res) => {
        res.setHeader('Cache-Control', 'no-cache');
        res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });

    return app;
}

function resolveListenHost(env = process.env) {
    const host = env.STOCK_DASHBOARD_HOST || '127.0.0.1';
    if (host === '127.0.0.1' || host === '::1') return host;
    if (host !== '0.0.0.0') throw new Error('Stock Dashboard listener must use loopback or the guarded LAN proxy mode');
    if (env.STOCK_DASHBOARD_SECURE_COOKIE !== '1') throw new Error('LAN proxy mode requires secure cookies');
    let publicOrigin;
    try {
        publicOrigin = new URL(env.STOCK_DASHBOARD_PUBLIC_ORIGIN || '');
    } catch (_error) {
        throw new Error('LAN proxy mode requires an HTTPS public origin');
    }
    if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== env.STOCK_DASHBOARD_PUBLIC_ORIGIN) {
        throw new Error('LAN proxy mode requires an exact HTTPS public origin');
    }
    const trustedProxy = env.STOCK_DASHBOARD_TRUSTED_PROXY_IP || '';
    if (net.isIP(trustedProxy) !== 4 || trustedProxy.startsWith('127.')) {
        throw new Error('LAN proxy mode requires one exact trusted proxy IPv4 address');
    }
    return host;
}

async function start() {
    try {
        const auth = createAuthFromEnv();
        const app = createApp({ auth });
        await db.initDb();
        console.log('Database initialized');

        initUniverseScheduler();
        initSnapshotScheduler();

        const host = resolveListenHost();
        return app.listen(PORT, host, () => {
            console.log(`Stock Dashboard running on ${host}:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exitCode = 1;
        throw err;
    }
}

if (require.main === module) {
    start().catch(() => {});
}

module.exports = { createApp, isAllowedClientAddress, resolveListenHost, start };
