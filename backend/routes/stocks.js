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

module.exports = router;

// Search stocks by symbol or name
const DEMO_STOCKS = [
    { symbol: 'AAPL', name: 'Apple Inc.' },
    { symbol: 'MSFT', name: 'Microsoft Corporation' },
    { symbol: 'GOOGL', name: 'Alphabet Inc.' },
    { symbol: 'AMZN', name: 'Amazon.com Inc.' },
    { symbol: 'TSLA', name: 'Tesla Inc.' },
    { symbol: 'NVDA', name: 'NVIDIA Corporation' },
    { symbol: 'META', name: 'Meta Platforms Inc.' },
    { symbol: 'JPM', name: 'JPMorgan Chase & Co.' },
    { symbol: 'V', name: 'Visa Inc.' },
    { symbol: 'JNJ', name: 'Johnson & Johnson' },
    { symbol: 'WMT', name: 'Walmart Inc.' },
    { symbol: 'PG', name: 'Procter & Gamble Co.' },
    { symbol: 'MA', name: 'Mastercard Inc.' },
    { symbol: 'UNH', name: 'UnitedHealth Group Inc.' },
    { symbol: 'HD', name: 'The Home Depot Inc.' },
    { symbol: 'DIS', name: 'The Walt Disney Company' },
    { symbol: 'NFLX', name: 'Netflix Inc.' },
    { symbol: 'ADBE', name: 'Adobe Inc.' },
    { symbol: 'CRM', name: 'Salesforce Inc.' },
    { symbol: 'INTC', name: 'Intel Corporation' }
];

router.get('/search/:query', (req, res) => {
    const { query } = req.params;
    const q = query.toLowerCase();
    const results = DEMO_STOCKS.filter(s => 
        s.symbol.toLowerCase().includes(q) || 
        s.name.toLowerCase().includes(q)
    ).slice(0, 10);
    res.json({ status: 'success', data: results });
});
