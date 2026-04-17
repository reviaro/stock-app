const express = require('express');
const router = express.Router();
const db = require('../database/db');
const pybridge = require('../services/pybridge');

// GET /api/portfolio — list positions with live P&L
router.get('/', async (req, res) => {
    try {
        const positions = await db.getPortfolio();
        if (positions.length === 0) {
            return res.json({ status: 'success', data: [] });
        }

        // Fetch live prices for all symbols in parallel
        const enriched = await Promise.all(positions.map(async (pos) => {
            try {
                const info = await pybridge.getStockInfo(pos.symbol);
                const currentPrice = info?.data?.price ?? null;
                const costBasis = pos.shares * pos.buy_price;
                const currentValue = currentPrice != null ? pos.shares * currentPrice : null;
                const pnl = currentValue != null ? currentValue - costBasis : null;
                const pnlPct = pnl != null && costBasis > 0 ? (pnl / costBasis) * 100 : null;
                return {
                    ...pos,
                    currentPrice,
                    currentValue,
                    costBasis,
                    pnl,
                    pnlPct,
                    name: info?.data?.name ?? pos.symbol,
                };
            } catch {
                return {
                    ...pos,
                    currentPrice: null,
                    currentValue: null,
                    costBasis: pos.shares * pos.buy_price,
                    pnl: null,
                    pnlPct: null,
                    name: pos.symbol,
                };
            }
        }));

        res.json({ status: 'success', data: enriched });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// POST /api/portfolio — add or update a position
router.post('/', async (req, res) => {
    try {
        const { symbol, shares, buy_price, buy_date, notes } = req.body;
        if (!symbol || typeof symbol !== 'string') {
            return res.status(400).json({ status: 'error', error: 'symbol is required' });
        }
        const parsedShares = Number(shares);
        const parsedPrice = Number(buy_price);
        if (!parsedShares || parsedShares <= 0) {
            return res.status(400).json({ status: 'error', error: 'shares must be a positive number' });
        }
        if (!parsedPrice || parsedPrice <= 0) {
            return res.status(400).json({ status: 'error', error: 'buy_price must be a positive number' });
        }
        const result = await db.upsertPortfolioPosition(symbol, parsedShares, parsedPrice, buy_date, notes);
        res.json({ status: 'success', data: result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// DELETE /api/portfolio/:symbol — remove a position
router.delete('/:symbol', async (req, res) => {
    try {
        const result = await db.removeFromPortfolio(req.params.symbol);
        try {
            if (await db.isInWatchlist(req.params.symbol.toUpperCase())) {
                await db.setWatchlistBucket(req.params.symbol.toUpperCase(), 'unsorted');
            }
        } catch { /* non-fatal */ }
        res.json({ status: 'success', data: result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
', error: err.message });
    }
});

module.exports = router;
