const express = require('express');
const db = require('../database/db');
const { computeHoldings } = require('../services/portfolio_ledger');

const router = express.Router();

async function reconcileBucket(symbol) {
    if (!symbol) return;
    try {
        const upper = String(symbol).toUpperCase();
        const inWatchlist = await db.isInWatchlist(upper);
        if (!inWatchlist) return;
        const transactions = await db.listTransactions({ symbol: upper });
        const holdings = computeHoldings(transactions);
        const shares = holdings[upper]?.shares ?? 0;
        await db.setWatchlistBucket(upper, shares > 0 ? 'owned' : 'unsorted');
    } catch (err) {
        console.error(`[txn bucket reconcile ${symbol}] non-fatal:`, err.message);
    }
}

router.get('/', async (req, res) => {
    try {
        const data = await db.listTransactions(req.query);
        res.json({ status: 'success', data });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const txn = req.body ?? {};
        const result = await db.addTransaction(txn);

        if (result.symbol) await reconcileBucket(result.symbol);

        res.json({ status: 'success', data: result });
    } catch (err) {
        const code = /invalid|required/.test(err.message) ? 400 : 500;
        res.status(code).json({ status: 'error', error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const txn = await db.getTransactionById(req.params.id);
        const result = await db.deleteTransaction(req.params.id);
        if (txn?.symbol) await reconcileBucket(txn.symbol);
        res.json({ status: 'success', data: result });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
