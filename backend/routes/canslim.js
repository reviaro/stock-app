const { createAsyncRouter } = require('../services/http_errors');
const router = createAsyncRouter();
const pybridge = require('../services/pybridge');

// GET /api/canslim/market/direction - Get current market direction (FTD analysis)
router.get('/market/direction', async (req, res) => {
    try {
        const result = await pybridge.getMarketDirection();
        res.json({ status: 'success', data: result });
    } catch (err) {
        throw err;
    }
});

// GET /api/canslim/:symbol - Get full CAN SLIM analysis
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await pybridge.getCANSlimAnalysis(symbol);
        
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Analysis not found' });
        }
        
        res.json(result);
    } catch (err) {
        throw err;
    }
});

module.exports = router;
