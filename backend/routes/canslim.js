const express = require('express');
const router = express.Router();
const pybridge = require('../services/pybridge');

// GET /api/canslim/market/direction - Get current market direction (FTD analysis)
router.get('/market/direction', async (req, res) => {
    try {
        const result = await pybridge.getMarketDirection();
        res.json({ status: 'success', data: result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
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
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
