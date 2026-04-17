const express = require('express');
const router = express.Router();
const pybridge = require('../services/pybridge');

// GET /api/market/indexes - Get major indexes
router.get('/indexes', async (req, res) => {
    try {
        const result = await pybridge.getMarketIndexes();
        
        if (result.status !== 'success') {
            return res.status(500).json({ status: 'error', error: result.error || 'Failed to fetch indexes' });
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET /api/market/sectors - Get sector ETF performance (1M, 3M, 6M)
router.get('/sectors', async (req, res) => {
    try {
        const result = await pybridge.getSectorPerformance();
        if (result.status !== 'success') {
            return res.status(500).json({ status: 'error', error: result.error || 'Failed to fetch sector data' });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
