const express = require('express');
const router = express.Router();
const pybridge = require('../services/pybridge');

// GET /api/stock/:symbol - Get stock data
router.get('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await pybridge.getStockInfo(symbol);
        
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Stock not found' });
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET /api/stock/:symbol/history - Get historical data
router.get('/:symbol/history', async (req, res) => {
    try {
        const { symbol } = req.params;
        const { period = '1y', interval = '1d' } = req.query;
        
        const result = await pybridge.getStockHistory(symbol, period, interval);
        
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'History not found' });
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET /api/stock/:symbol/analysis - Get CAN SLIM analysis
router.get('/:symbol/analysis', async (req, res) => {
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

// GET /api/stock/:symbol/technical - Get technical indicators
router.get('/:symbol/technical', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await pybridge.getTechnicalIndicators(symbol);
        
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Technical data not found' });
        }
        
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// GET /api/stock/:symbol/earnings - Get upcoming earnings date
router.get('/:symbol/earnings', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await pybridge.getEarningsDate(symbol.toUpperCase());
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: result.error || 'Earnings data not found' });
        }
        res.json(result);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
