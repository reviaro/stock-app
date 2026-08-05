const express = require('express');
const router = express.Router();
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const {
    computeLotsForSymbol,
    computeTaxPreview,
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
} = require('../services/simulator_ledger');
const { buildSimulatorReview, simulatorTransactionsToCsv } = require('../services/simulator_review');

function accountIdFrom(req) {
    const raw = req.query?.account_id ?? req.body?.account_id ?? 1;
    const accountId = Number(raw);
    if (!Number.isInteger(accountId) || accountId <= 0) {
        const err = new Error('invalid account_id');
        err.status = 400;
        throw err;
    }
    return accountId;
}

async function requireSleeve(req) {
    const accountId = accountIdFrom(req);
    const account = await db.getSimAccount(accountId);
    if (!account) {
        const err = new Error(`simulator sleeve ${accountId} not found`);
        err.status = 404;
        throw err;
    }
    return { accountId, account };
}

async function accountAndTransactions(req) {
    const { accountId, account } = await requireSleeve(req);
    const txns = await db.listSimTransactions(accountId);
    return { accountId, account, txns };
}

function sendError(res, err) {
    const status = err.status ?? (/invalid|required/.test(err.message) ? 400 : 500);
    res.status(status).json({ status: 'error', error: err.message });
}

// GET /api/simulator/accounts
router.get('/accounts', async (_req, res) => {
    try {
        const accounts = await db.listSimAccounts();
        res.json({ status: 'success', data: accounts });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/account
router.get('/account', async (req, res) => {
    try {
        const { account, txns } = await accountAndTransactions(req);
        const holdings = computeHoldings(txns);
        const cash = computeCashBalance(txns);

        const symbols = Object.keys(holdings);
        let holdingsValue = 0;
        const prices = {};
        await Promise.all(symbols.map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                if (typeof info?.data?.price === 'number') {
                    prices[symbol] = info.data.price;
                    holdingsValue += info.data.price * holdings[symbol].shares;
                }
            } catch { /* non-fatal */ }
        }));

        const unrealizedPnl = Object.entries(holdings).reduce((sum, [sym, h]) => {
            const price = prices[sym];
            return price != null ? sum + (price * h.shares - h.total_cost) : sum;
        }, 0);

        res.json({
            status: 'success',
            data: {
                ...account,
                cash,
                total_value: Math.round((cash + holdingsValue) * 100) / 100,
                unrealized_pnl: Math.round(unrealizedPnl * 100) / 100,
                realized_pnl: Math.round(computeRealizedPnl(txns).total * 100) / 100,
            },
        });
    } catch (err) {
        sendError(res, err);
    }
});

// PATCH /api/simulator/account
// Body: { tax_bracket: 22 } OR { deposit: 5000 } OR { withdrawal: 1000 }
router.patch('/account', async (req, res) => {
    try {
        const body = req.body ?? {};
        const { accountId } = await requireSleeve(req);
        const today = new Date().toISOString().slice(0, 10);

        if (body.tax_bracket != null) {
            await db.setSimTaxBracket(Number(body.tax_bracket), accountId);
        }
        if (body.deposit != null) {
            const amount = Number(body.deposit);
            if (amount <= 0) return res.status(400).json({ status: 'error', error: 'deposit must be > 0' });
            await db.addSimTransaction({ account_id: accountId, type: 'deposit', amount, txn_date: today });
        }
        if (body.withdrawal != null) {
            const amount = Number(body.withdrawal);
            if (amount <= 0) return res.status(400).json({ status: 'error', error: 'withdrawal must be > 0' });
            await db.addSimTransaction({ account_id: accountId, type: 'withdrawal', amount, txn_date: today });
        }

        const [updatedAccount, txns] = await Promise.all([db.getSimAccount(accountId), db.listSimTransactions(accountId)]);
        const cash = computeCashBalance(txns);
        res.json({ status: 'success', data: { ...updatedAccount, cash } });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/holdings
router.get('/holdings', async (req, res) => {
    try {
        const { txns } = await accountAndTransactions(req);
        const holdings = computeHoldings(txns);
        const symbols = Object.keys(holdings);

        if (symbols.length === 0) return res.json({ status: 'success', data: [] });

        const prices = {};
        const stockMeta = {};
        await Promise.all(symbols.map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                const data = info?.data || {};
                if (typeof data.price === 'number') prices[symbol] = data.price;
                stockMeta[symbol] = {
                    priceChange: typeof data.change === 'number' ? Math.round(data.change * 100) / 100 : null,
                    priceChangePct: typeof data.changePercent === 'number' ? Math.round(data.changePercent * 100) / 100 : null,
                    previousClose: typeof data.previousClose === 'number' ? Math.round(data.previousClose * 100) / 100 : null,
                };
            } catch { /* non-fatal */ }
        }));

        const result = symbols.map((symbol) => {
            const h = holdings[symbol];
            const currentPrice = prices[symbol] ?? null;
            const currentValue = currentPrice != null ? currentPrice * h.shares : null;
            const pnl = currentPrice != null ? currentPrice * h.shares - h.total_cost : null;
            const pnlPct = h.total_cost > 0 && pnl != null ? (pnl / h.total_cost) * 100 : null;
            const lots = computeLotsForSymbol(txns, symbol);
            const oldestLotDate = lots.length > 0 ? lots[0].txn_date : null;
            return {
                symbol,
                shares: h.shares,
                avg_cost: Math.round(h.avg_cost * 100) / 100,
                total_cost: Math.round(h.total_cost * 100) / 100,
                currentPrice,
                priceChange: stockMeta[symbol]?.priceChange ?? null,
                priceChangePct: stockMeta[symbol]?.priceChangePct ?? null,
                previousClose: stockMeta[symbol]?.previousClose ?? null,
                currentValue: currentValue != null ? Math.round(currentValue * 100) / 100 : null,
                pnl: pnl != null ? Math.round(pnl * 100) / 100 : null,
                pnlPct: pnlPct != null ? Math.round(pnlPct * 100) / 100 : null,
                oldest_lot_date: oldestLotDate,
            };
        });

        res.json({ status: 'success', data: result });
    } catch (err) {
        sendError(res, err);
    }
});

// POST /api/simulator/trade
// Body: { type: 'buy'|'sell', symbol, shares, price, txn_date? }
router.post('/trade', async (req, res) => {
    try {
        const body = req.body ?? {};
        const { accountId } = await requireSleeve(req);
        const today = new Date().toISOString().slice(0, 10);
        const txn = {
            account_id: accountId,
            type: body.type,
            symbol: body.symbol,
            shares: Number(body.shares),
            price: Number(body.price),
            txn_date: body.txn_date || today,
            fees: Number(body.fees ?? 0),
            notes: body.notes ?? null,
        };

        if (!['buy', 'sell'].includes(txn.type)) {
            return res.status(400).json({ status: 'error', error: 'type must be buy or sell' });
        }
        if (!txn.symbol || !(txn.shares > 0) || !(txn.price > 0)) {
            return res.status(400).json({ status: 'error', error: 'symbol, shares, and price are required and must be positive' });
        }

        const txns = await db.listSimTransactions(accountId);
        const cash = computeCashBalance(txns);
        const cost = txn.shares * txn.price + txn.fees;

        if (txn.type === 'buy' && cash < cost) {
            return res.status(400).json({ status: 'error', error: `insufficient cash: have $${Math.round(cash * 100) / 100}, need $${Math.round(cost * 100) / 100}` });
        }

        if (txn.type === 'sell') {
            const holdings = computeHoldings(txns);
            const ownedShares = holdings[txn.symbol.toUpperCase()]?.shares ?? 0;
            if (txn.shares > ownedShares + 0.000001) {
                return res.status(400).json({ status: 'error', error: `insufficient shares: own ${ownedShares}, tried to sell ${txn.shares}` });
            }
        }

        const result = await db.addSimTransaction(txn);
        res.json({ status: 'success', data: result });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/transactions
router.get('/transactions', async (req, res) => {
    try {
        const { txns } = await accountAndTransactions(req);
        res.json({ status: 'success', data: txns.reverse() });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/tax-preview?symbol=AAPL&shares=10
router.get('/tax-preview', async (req, res) => {
    try {
        const { symbol, shares } = req.query;
        const sharesNum = Number(shares);
        if (!symbol || typeof symbol !== 'string' || !symbol.trim() || !(sharesNum > 0)) {
            return res.status(400).json({ status: 'error', error: 'symbol and shares (> 0) are required' });
        }

        const info = await pybridge.getStockInfo(symbol);
        const currentPrice = info?.data?.price;
        if (typeof currentPrice !== 'number' || !isFinite(currentPrice)) {
            return res.status(503).json({ status: 'error', error: 'price unavailable for symbol' });
        }

        const { txns, account } = await accountAndTransactions(req);
        const lots = computeLotsForSymbol(txns, symbol);

        if (lots.length === 0) {
            return res.status(400).json({ status: 'error', error: `no open position in ${symbol}` });
        }

        const preview = computeTaxPreview({
            lots,
            sharesToSell: sharesNum,
            currentPrice,
            taxBracket: account.tax_bracket,
            sellDate: new Date().toISOString().slice(0, 10),
        });

        res.json({ status: 'success', data: { symbol, shares: sharesNum, current_price: currentPrice, ...preview } });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/review — performance summary and Buffett action log
router.get('/review', async (req, res) => {
    try {
        const { txns } = await accountAndTransactions(req);
        const holdings = computeHoldings(txns);
        const prices = {};
        await Promise.all(Object.keys(holdings).map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                if (typeof info?.data?.price === 'number') prices[symbol] = info.data.price;
            } catch { /* non-fatal */ }
        }));
        res.json({ status: 'success', data: buildSimulatorReview(txns, prices) });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/export.csv — export paper-trading ledger
router.get('/export.csv', async (req, res) => {
    try {
        const { account, txns } = await accountAndTransactions(req);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="simulator-${account.slug}-transactions.csv"`);
        res.send(simulatorTransactionsToCsv(txns));
    } catch (err) {
        sendError(res, err);
    }
});

// POST /api/simulator/reset
router.post('/reset', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const result = await db.deleteAllSimTransactions(accountId);
        res.json({ status: 'success', data: result });
    } catch (err) {
        sendError(res, err);
    }
});

module.exports = router;
