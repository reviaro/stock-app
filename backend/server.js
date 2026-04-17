require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
const { initUniverseScheduler } = require('./services/universeCache');
const { initSnapshotScheduler } = require('./services/snapshotScheduler');

const PORT = 3002;

const app = express();

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3002', 'http://127.0.0.1:5173', 'http://127.0.0.1:3002'],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: false,
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend', 'dist')));

// API Routes
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/stock/search', stockRoutes);
app.use('/api/canslim', canslimRoutes);
app.use('/api/market', marketRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/history', historyRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/memos', memosRoutes);

// Serve frontend for all other routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'dist', 'index.html'));
});

// Initialize database and start server
async function start() {
    try {
        await db.initDb();
        console.log('Database initialized');
        
        initUniverseScheduler(); // Fire-and-forget — don't await (don't block server start)
        initSnapshotScheduler();
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Stock Dashboard running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
