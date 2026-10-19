const { createAsyncRouter } = require('../services/http_errors');
const router = createAsyncRouter();
const pybridge = require('../services/pybridge');

// GET /api/market/indexes - Get major indexes
router.get('/indexes', async (req, res) => {
    try {
        const result = await pybridge.getMarketIndexes();
        
        if (result.status !== 'success') {
            throw new Error('Market index data is unavailable');
        }
        
        res.json(result);
    } catch (err) {
        throw err;
    }
});

// GET /api/market/sectors - Get sector ETF performance (1M, 3M, 6M)
router.get('/sectors', async (req, res) => {
    try {
        const result = await pybridge.getSectorPerformance();
        if (result.status !== 'success') {
            throw new Error('Sector data is unavailable');
        }
        res.json(result);
    } catch (err) {
        throw err;
    }
});

module.exports = router;
