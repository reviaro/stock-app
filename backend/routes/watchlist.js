const express = require('express');
const router = express.Router();
const db = require('../database/db');
const pybridge = require('../services/pybridge');

// Search stocks - predefined list + yfinance lookup
router.get('/search/:query', (req, res) => {
    const KNOWN_STOCKS = [
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
        { symbol: 'INTC', name: 'Intel Corporation' },
        { symbol: 'COKE', name: 'Coca-Cola Consolidated, Inc.' },
        { symbol: 'KO', name: 'The Coca-Cola Company' },
        { symbol: 'PEP', name: 'PepsiCo, Inc.' },
        { symbol: 'LLY', name: 'Eli Lilly and Company' },
        { symbol: 'AMD', name: 'Advanced Micro Devices, Inc.' },
        { symbol: 'BRKB', name: 'Berkshire Hathaway Inc.' },
        { symbol: 'BA', name: 'Boeing Company' },
        { symbol: 'COST', name: 'Costco Wholesale Corp.' },
        { symbol: 'XOM', name: 'Exxon Mobil Corporation' },
        { symbol: 'T', name: 'AT&T Inc.' },
    ];

    const { query } = req.params;
    const q = query.toLowerCase();
    const results = KNOWN_STOCKS.filter(s =>
        s.symbol.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
    ).slice(0, 10);
    res.json({ status: 'success', data: results });
});

// GET /api/watchlist - List all saved stocks with live data
router.get('/', async (req, res) => {
    try {
        const watchlist = await db.getWatchlist();

        // Get current data for each stock
        const stocks = await Promise.all(
            watchlist.map(async (item) => {
                try {
                    const result = await pybridge.getStockInfo(item.symbol);
                    if (result.status === 'success') {
                        return { ...item, ...result.data };
                    }
                    return item;
                } catch (e) {
                    return item;
                }
            })
        );

        res.json({ status: 'success', data: stocks });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

// POST /api/watchlist - Add stock to watchlist
router.post('/', async (req, res) => {
    try {
        const { symbol, notes } = req.body;

        if (!symbol) {
            return res.status(400).json({ status: 'error', error: 'Symbol is required' });
        }

        // Clean input
        let ticker = symbol.trim().toUpperCase();

        // If it looks like a company name (has spaces or >5 chars), try to resolve it
        if (ticker.length > 5 || ticker.includes(' ')) {
            const KNOWN = {
                'APPLE': 'AAPL', 'MICROSOFT': 'MSFT', 'GOOGLE': 'GOOGL', 'ALPHABET': 'GOOGL',
                'AMAZON': 'AMZN', 'TESLA': 'TSLA', 'NVIDIA': 'NVDA', 'META': 'META',
                'FACEBOOK': 'META', 'ELI LILLY': 'LLY', 'COCA COLA': 'KO', 'COCA-COLA': 'KO',
                'PEPSI': 'PEP', 'PEPSICO': 'PEP', 'BOEING': 'BA', 'COSTCO': 'COST',
                'WALMART': 'WMT', 'DISNEY': 'DIS', 'NETFLIX': 'NFLX', 'ADOBE': 'ADBE',
                'INTEL': 'INTC', 'AMD': 'AMD', 'JPMORGAN': 'JPM', 'EXXON': 'XOM',
                'JOHNSON': 'JNJ', 'BERKSHIRE': 'BRK-B', 'SALESFORCE': 'CRM',
            };
            const resolved = KNOWN[ticker] || KNOWN[ticker.replace(/[^A-Z ]/g, '')];
            if (resolved) {
                ticker = resolved;
            } else {
                return res.status(400).json({
                    status: 'error',
                    error: `Could not resolve "${symbol}" to a ticker. Please use the stock symbol (e.g., AAPL, MSFT, NVDA).`
                });
            }
        }

        // Verify stock exists via yfinance
        const result = await pybridge.getStockInfo(ticker);
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: `Stock symbol "${ticker}" not found` });
        }

        const added = await db.addToWatchlist(ticker, notes || '');
        res.json({ status: 'success', data: added });
    } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint')) {
            res.status(409).json({ status: 'error', error: 'Stock already in watchlist' });
        } else {
            res.status(500).json({ status: 'error', error: err.message });
        }
    }
});

// DELETE /api/watchlist/:symbol - Remove stock from watchlist
router.delete('/:symbol', async (req, res) => {
    try {
        const { symbol } = req.params;
        const result = await db.removeFromWatchlist(symbol);

        if (result.deleted === 0) {
            return res.status(404).json({ status: 'error', error: 'Stock not in watchlist' });
        }

        res.json({ status: 'success', data: result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
