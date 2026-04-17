const express = require('express');
const router = express.Router();
const db = require('../database/db');
const { snapshotWatchlist } = require('../services/snapshotService');

router.get('/', async (req, res) => {
    try {
        const watchlist = await db.getWatchlist();
        const rawDays = Number(req.query.days || 30);
        const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 365 ? Math.floor(rawDays) : 30;

        const data = await Promise.all(
            watchlist.map(async (item) => ({
                symbol: item.symbol,
                history: await db.getStockHistory(item.symbol, days),
            }))
        );

        res.json({ status: 'success', data });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.get('/:symbol', async (req, res) => {
    try {
        const rawDays = Number(req.query.days || 30);
        const days = Number.isFinite(rawDays) && rawDays > 0 && rawDays <= 365 ? Math.floor(rawDays) : 30;
        const history = await db.getStockHistory(req.params.symbol, days);
        res.json({ status: 'success', data: history });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.post('/snapshot', async (req, res) => {
    try {
        const VALID_SLOTS = ['openish', 'midday', 'closeish', 'manual-open'];
        const rawSlot = req.body?.slot;
        const slot = typeof rawSlot === 'string' && VALID_SLOTS.includes(rawSlot) ? rawSlot : undefined;
        const result = await snapshotWatchlist(slot);
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
