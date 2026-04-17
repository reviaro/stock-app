const express = require('express');
const router = express.Router();
const db = require('../database/db');
const pybridge = require('../services/pybridge');

// Search stocks - predefined list + yfinance lookup
router.get('/search/:query', async (req, res) => {
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
    const q = query.toLowerCase().trim();

    // 1. Search known stocks
    let results = KNOWN_STOCKS.filter(s =>
        s.symbol.toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q)
    ).slice(0, 10);

    // 2. Try Yahoo Finance for real-time search
    try {
        const yfRes = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`);
        if (yfRes.ok) {
            const yfData = await yfRes.json();
            if (yfData.quotes && Array.isArray(yfData.quotes)) {
                const yfResults = yfData.quotes
                    .filter(quote => quote.quoteType === 'EQUITY' || quote.quoteType === 'ETF')
                    .map(quote => ({
                        symbol: quote.symbol,
                        name: quote.shortname || quote.longname || quote.symbol
                    }));

                // Merge, avoiding duplicates
                const existingSymbols = new Set(results.map(r => r.symbol));
                for (const yfMatch of yfResults) {
                    if (!existingSymbols.has(yfMatch.symbol)) {
                        results.push(yfMatch);
                        existingSymbols.add(yfMatch.symbol);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Yahoo Finance search error:', err);
    }

    results = results.slice(0, 10);

    // 3. Always offer the exact query as a potential ticker if it's 1-5 letters
    const isLikelyTicker = /^[a-zA-Z]{1,5}$/.test(q);
    const hasExactMatch = results.some(r => r.symbol.toLowerCase() === q);

    if (isLikelyTicker && !hasExactMatch) {
        results.unshift({
            symbol: q.toUpperCase(),
            name: `Search yfinance for ${q.toUpperCase()}...`
        });
    }

    res.json({ status: 'success', data: results });
});

// GET /api/watchlist/export/csv — export watchlist as CSV with live prices
router.get('/export/csv', async (req, res) => {
    try {
        const watchlist = await db.getWatchlist();
        const header = '"Symbol","Name","Price","Change %","52W High","52W Low","Volume","Added At"';

        if (watchlist.length === 0) {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename="watchlist.csv"');
            return res.send(header + '\n');
        }

        const rows = await Promise.all(watchlist.map(async (item) => {
            try {
                const info = await pybridge.getStockInfo(item.symbol);
                const d = info?.data ?? {};
                return [
                    item.symbol,
                    d.name ?? '',
                    d.price ?? '',
                    d.changePercent ?? '',
                    d.week52High ?? '',
                    d.week52Low ?? '',
                    d.volume ?? '',
                    item.added_at ?? '',
                ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',');
            } catch {
                return `"${item.symbol}","","","","","","","${item.added_at ?? ''}"`;
            }
        }));

        const csv = [header, ...rows].join('\n');
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="watchlist.csv"');
        res.send(csv);
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
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
        const { symbol, notes, bucket } = req.body;

        if (!symbol) {
            return res.status(400).json({ status: 'error', error: 'Symbol is required' });
        }

        // Clean input
        let ticker = symbol.trim().toUpperCase();

        // The frontend search now sends the exact Yahoo Finance symbol.
        // If it still happens to be a long name, we just pass it to yfinance to verify.
        if (ticker.length > 10 && ticker.includes(' ')) {
            return res.status(400).json({
                status: 'error',
                error: `Please select a valid stock ticker symbol from the search results, not a full company name.`
            });
        }

        // Verify stock exists via yfinance
        const result = await pybridge.getStockInfo(ticker);
        if (result.status !== 'success') {
            return res.status(404).json({ status: 'error', error: `Stock symbol "${ticker}" not found` });
        }

        const added = await db.addToWatchlist(ticker, notes || '', bucket || 'unsorted');
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

router.patch('/:symbol', async (req, res) => {
    try {
        const { bucket } = req.body;
        if (!bucket) return res.status(400).json({ status: 'error', error: 'bucket required' });
        const result = await db.setWatchlistBucket(req.params.symbol, bucket);
        if (result.changed === 0) return res.status(404).json({ status: 'error', error: 'not found' });
        res.json({ status: 'success', data: result });
    } catch (err) {
        const code = /invalid bucket/.test(err.message) ? 400 : 500;
        res.status(code).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
