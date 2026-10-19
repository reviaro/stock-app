const { createAsyncRouter } = require('../services/http_errors');
const db = require('../database/db');

const router = createAsyncRouter();

function emptyNote(symbol) {
    return {
        symbol: symbol.toUpperCase(),
        thesis: null,
        variant_view: null,
        fair_value_low: null,
        fair_value_high: null,
        buy_below: null,
        trim_above: null,
        sell_rule: null,
        invalidation: null,
        risks: null,
        conviction: null,
        last_reviewed_at: null,
        updated_at: null,
        created_at: null,
    };
}

router.get('/:symbol', async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const note = await db.getMemo(symbol);
        res.json({ status: 'success', data: note || emptyNote(symbol) });
    } catch (err) {
        throw err;
    }
});

router.put('/:symbol', async (req, res) => {
    try {
        const result = await db.upsertMemo(req.params.symbol, req.body || {});
        const note = await db.getMemo(req.params.symbol);
        res.json({ status: 'success', data: note || result });
    } catch (err) {
        const code = /conviction|non-negative/.test(err.message) ? 400 : 500;
        if (code >= 500) throw err;
        res.status(code).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
