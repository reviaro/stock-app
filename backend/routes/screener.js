const express = require('express');
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const { scoreCandidate } = require('../services/value_screener');

const router = express.Router();

async function safe(fn, fallback = null) {
    try { return await fn(); } catch { return fallback; }
}

router.get('/value', async (req, res) => {
    try {
        const universe = req.query.universe || 'watchlist';
        if (universe !== 'watchlist') {
            return res.status(400).json({ status: 'error', error: 'only universe=watchlist is supported for now' });
        }

        const watchlist = await db.getWatchlist();
        const rows = await Promise.all(watchlist.map(async (item) => {
            const symbol = item.symbol.toUpperCase();
            const [stockRes, qualityRes, technicalRes, memo] = await Promise.all([
                safe(() => pybridge.getStockInfo(symbol)),
                safe(() => pybridge.getQualityMetrics(symbol)),
                safe(() => pybridge.getTechnicalIndicators(symbol)),
                safe(() => db.getMemo(symbol)),
            ]);

            const stock = stockRes?.data ?? item;
            const quality = qualityRes?.data ?? {};
            const technical = technicalRes?.data ?? {};
            const score = scoreCandidate({ stock, quality, technical });

            return {
                symbol,
                name: stock.name ?? item.name ?? symbol,
                sector: stock.sector ?? item.sector ?? 'Unknown',
                price: stock.price ?? null,
                changePercent: stock.changePercent ?? null,
                forwardPE: stock.forwardPE ?? stock.peRatio ?? null,
                qualityComposite: quality.composite ?? null,
                hasThesis: Boolean(memo?.thesis),
                ...score,
            };
        }));

        rows.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.symbol.localeCompare(b.symbol));
        res.json({ status: 'success', data: rows });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
