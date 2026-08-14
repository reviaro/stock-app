const express = require('express');
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const { scoreCandidate } = require('../services/value_screener');

const router = express.Router();

async function safe(fn, fallback = null) {
    try { return await fn(); } catch { return fallback; }
}

function createValueHandler({ db: database = db, pybridge: bridge = pybridge } = {}) {
    return async (req, res) => {
    try {
        const universe = req.query.universe || 'watchlist';
        if (universe !== 'watchlist') {
            return res.status(400).json({ status: 'error', error: 'only universe=watchlist is supported for now' });
        }

        const watchlist = await database.getWatchlist();
        const symbols = watchlist.map((item) => item.symbol.toUpperCase());
        const inputs = await bridge.getScreenerInputs(symbols);
        const rows = await Promise.all(watchlist.map(async (item) => {
            const symbol = item.symbol.toUpperCase();
            const batch = inputs[symbol] ?? {};
            const memo = await safe(() => database.getMemo(symbol));
            const stockRes = batch.stock;
            const qualityRes = batch.quality;
            const technicalRes = batch.technical;

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
    };
}

router.get('/value', createValueHandler());

module.exports = router;
module.exports.createValueHandler = createValueHandler;
