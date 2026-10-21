const { createAsyncRouter } = require('../services/http_errors');
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const { evidence } = require('../services/research_data');
const { scoreCandidate } = require('../services/value_screener');

const router = createAsyncRouter();

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
            const provenance = evidence(stockRes);
            if (!provenance.available || provenance.stale) { score.action='Research'; score.confidence=0; score.coveragePct=0; score.red_flags.push(provenance.warning || 'Stock evidence unavailable'); }

            return {
                symbol,
                name: stock.name ?? item.name ?? symbol,
                sector: stock.sector ?? item.sector ?? 'Unknown',
                price: provenance.available ? stock.price ?? null : null,
                evidence: provenance,
                changePercent: stock.changePercent ?? null,
                forwardPE: stock.forwardPE ?? stock.peRatio ?? null,
                qualityComposite: quality.composite ?? null,
                qualitySource: qualityRes?.meta?.source || quality.source || 'yfinance',
                primarySourceStatus: qualityRes?.meta?.primarySourceStatus || null,
                hasThesis: Boolean(memo?.thesis),
                ...score,
            };
        }));

        rows.sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.symbol.localeCompare(b.symbol));
        res.json({ status: 'success', data: rows });
    } catch (err) {
        throw err;
    }
    };
}

router.get('/value', createValueHandler());

module.exports = router;
module.exports.createValueHandler = createValueHandler;
