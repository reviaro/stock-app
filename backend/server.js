const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./database/db');

const watchlistRoutes = require('./routes/watchlist');
const stockRoutes = require('./routes/stocks');
const canslimRoutes = require('./routes/canslim');
const marketRoutes = require('./routes/market');
const { initUniverseScheduler } = require('./services/universeCache');

const PORT = 3002;

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// API Routes
app.use('/api/watchlist', watchlistRoutes);
app.use('/api/stock', stockRoutes);
app.use('/api/stock/search', stockRoutes);
app.use('/api/canslim', canslimRoutes);
app.use('/api/market', marketRoutes);

// Serve frontend for all other routes (SPA)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

// Initialize database and start server
async function start() {
    try {
        await db.initDb();
        console.log('Database initialized');
        
        initUniverseScheduler(); // Fire-and-forget — don't await (don't block server start)
        
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Stock Dashboard running on http://localhost:${PORT}`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
