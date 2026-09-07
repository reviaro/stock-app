const express = require('express');
const router = express.Router();
const controls = require('../services/simulator_controls');
const performance = require('../services/simulator_performance');
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const {
    computeLotsForSymbol,
    computeTaxPreview,
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
    buildSimulatorAccount,
} = require('../services/simulator_ledger');
const { buildSimulatorReview, simulatorTransactionsToCsv } = require('../services/simulator_review');
const { computeJournalAnalytics } = require('../services/trade_journal');
const { buildRiskMonitor } = require('../services/simulator_risk_monitor');
const { getDefaultHybridQuote } = require('../services/hybrid_market_data');
const { executeSimulatorTrade } = require('../services/simulator_execution_service');

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
    res.status(status).json({ status: 'error', error: err.message, ...(err.code ? { code: err.code } : {}) });
}

function reinvestmentMetrics(account, txns, cash, totalValue, dataComplete = true) {
    const dividends = txns.filter((txn) => txn.type === 'dividend');
    const dividendIncome = dividends.reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
    const reinvestedDividends = dividends
        .filter((txn) => txn.reinvestment_mode === 'drip')
        .reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
    const targetCash = totalValue * (Number(account.target_cash_pct || 0) / 100);
    const redeployableCash = account.profit_reinvestment_mode === 'redeploy_excess'
        ? (dataComplete ? Math.max(0, cash - targetCash) : null)
        : 0;
    return {
        dividend_income: Math.round(dividendIncome * 100) / 100,
        reinvested_dividends: Math.round(reinvestedDividends * 100) / 100,
        redeployable_cash: redeployableCash == null ? null : Math.round(redeployableCash * 100) / 100,
        reinvestment_data_complete: dataComplete,
    };
}

// GET /api/simulator/accounts
router.get('/accounts', async (_req, res) => {
    try {
        const accounts = await db.listSimAccounts();
        res.json({ status: 'success', data: reqAgentAccounts(_req, accounts) });
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
        const prices = {};
        await Promise.all(symbols.map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                if (Number.isFinite(info?.data?.price) && info.data.price > 0
                    && !info.data.isDemo && !info.data.is_demo && !info.meta?.stale) {
                    prices[symbol] = info.data.price;
                }
            } catch { /* explicit incomplete valuation below */ }
        }));
        const valuation = buildSimulatorAccount(txns, prices);
        res.json({
            status: 'success',
            data: {
                ...account,
                ...valuation,
                realized_pnl: valuation.realized_pnl.net,
                gross_realized_pnl: valuation.realized_pnl.gross,
                ...reinvestmentMetrics(account, txns, cash, valuation.total_value, valuation.valuation_complete),
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
            await db.addSimTransaction({ account_id: accountId, type: 'deposit', amount, txn_date: today }, await performance.quotesFor(accountId));
        }
        if (body.withdrawal != null) {
            const amount = Number(body.withdrawal);
            if (amount <= 0) return res.status(400).json({ status: 'error', error: 'withdrawal must be > 0' });
            await db.addSimTransaction({ account_id: accountId, type: 'withdrawal', amount, txn_date: today }, await performance.quotesFor(accountId));
        }

        const [updatedAccount, txns] = await Promise.all([db.getSimAccount(accountId), db.listSimTransactions(accountId)]);
        const cash = computeCashBalance(txns);
        res.json({ status: 'success', data: { ...updatedAccount, cash } });
    } catch (err) {
        sendError(res, err);
    }
});

// PATCH /api/simulator/reinvestment-settings
router.patch('/reinvestment-settings', async (req, res) => {
    try {
        const { accountId, account } = await requireSleeve(req);
        const body = req.body ?? {};
        if (!['dividend_reinvestment_mode', 'profit_reinvestment_mode', 'target_cash_pct']
            .some((field) => Object.hasOwn(body, field))) {
            return res.status(400).json({ status: 'error', error: 'at least one reinvestment setting is required' });
        }
        // Pass only the fields the client sent; the DB layer keeps omitted fields
        // at their stored values inside the write transaction.
        const settings = {};
        if (Object.hasOwn(body, 'dividend_reinvestment_mode')) settings.dividend_reinvestment_mode = body.dividend_reinvestment_mode;
        if (Object.hasOwn(body, 'profit_reinvestment_mode')) settings.profit_reinvestment_mode = body.profit_reinvestment_mode;
        if (Object.hasOwn(body, 'target_cash_pct')) settings.target_cash_pct = body.target_cash_pct;
        await db.setSimReinvestmentSettings(settings, accountId);
        const updated = await db.getSimAccount(accountId);
        res.json({ status: 'success', data: updated });
    } catch (err) {
        sendError(res, err);
    }
});

// POST /api/simulator/dividend — record income and apply the sleeve DRIP policy atomically.
router.post('/dividend', async (req, res) => {
    try {
        const { accountId, account, txns } = await accountAndTransactions(req);
        const body = req.body ?? {};
        const symbol = String(body.symbol || '').trim().toUpperCase();
        const amount = Number(body.amount);
        const txnDate = body.txn_date || new Date().toISOString().slice(0, 10);
        const idempotencyKey = String(body.idempotency_key || '').trim();
        const isValidCalendarDate = (value) => {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
            const [y, m, d] = value.split('-').map(Number);
            const parsed = new Date(Date.UTC(y, m - 1, d));
            return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
        };
        const isFutureDate = (value) => value > new Date().toISOString().slice(0, 10);
        if (!/^[A-Z0-9.-]{1,15}$/.test(symbol) || !Number.isFinite(amount) || amount <= 0
            || !isValidCalendarDate(txnDate) || isFutureDate(txnDate) || !idempotencyKey || idempotencyKey.length > 200) {
            return res.status(400).json({ status: 'error', error: 'symbol, positive amount, valid non-future date, and idempotency_key are required' });
        }
        const holdingsOnDate = computeHoldings(txns.filter((txn) => txn.txn_date <= txnDate));
        if (!(holdingsOnDate[symbol]?.shares > 0)) {
            return res.status(400).json({ status: 'error', error: `${symbol} has no open position on the dividend date` });
        }

        const price = body.price == null ? null : Number(body.price);
        if (account.dividend_reinvestment_mode === 'drip' && !Number.isFinite(price)) {
            return res.status(400).json({ status: 'error', error: 'dividend reinvestment price is required for DRIP mode' });
        }

        const result = await db.recordSimDividend({
            account_id: accountId,
            symbol,
            amount,
            txn_date: txnDate,
            idempotency_key: idempotencyKey,
            reinvestment_mode: account.dividend_reinvestment_mode,
            reinvestment_price: price,
            notes: body.notes ?? `Dividend ${idempotencyKey}`,
        });
        res.json({ status: 'success', data: result });
    } catch (err) {
        if (err.code === 'DUPLICATE_SIM_DIVIDEND') err.status = 409;
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

// GET scoped durable order status for timeout reconciliation.
router.get('/orders/:client_order_id', async (req, res) => {
    try {
        if (req.query.account_id == null) return res.status(400).json({ status: 'error', error: 'explicit account_id is required' });
        const { accountId } = await requireSleeve(req);
        const order = await db.getSimOrder(accountId, req.params.client_order_id);
        if (!order) return res.status(404).json({ status: 'error', code: 'SIM_ORDER_NOT_FOUND', error: 'order not found; an in-flight request may still be pending' });
        res.json({ status: 'success', data: order });
    } catch (err) { sendError(res, err); }
});

// POST /api/simulator/trade — EVALUATED execution.
// Caller submits an intention: { type, symbol, shares, client_order_id,
// fees?, notes?, trade_plan?, journal?, close_plan_id? }. The server obtains
// the quote, assigns the fill price/date, and executes atomically with
// idempotency. Caller-supplied prices are ignored.
router.post('/trade', async (req, res) => {
    try {
        const body = req.body ?? {};
        if (body.account_id == null && req.query.account_id == null) {
            return res.status(400).json({ status: 'error', code: 'SIM_INVALID_ORDER', error: 'explicit account_id is required' });
        }
        if (body.account_id != null && req.query.account_id != null && Number(body.account_id) !== Number(req.query.account_id)) {
            return res.status(400).json({ status: 'error', code: 'SIM_INVALID_ORDER', error: 'conflicting account_id values' });
        }
        const accountId = accountIdFrom(req);
        const { result, duplicate } = await executeSimulatorTrade({ ...body, account_id: accountId });
        if (duplicate) return res.status(200).json({ status: 'success', data: result, duplicate: true });
        res.json({ status: 'success', data: result });
    } catch (err) {
        if (err && err.code && String(err.code).startsWith('SIM_')) err.status = err.status || 400;
        sendError(res, err);
    }
});

// POST /api/simulator/record — MANUAL, NON-EVALUATED ledger entry for the
// caller. The source acknowledgement is NOT authorization; scoped operator
// authorization is separate/deferred. Records an explicit caller-priced fill.
// These rows are manual imports; they must not be treated
// as evaluated agent execution. Subject to the same validation and atomic
// resource checks as ordinary writes.
router.post('/record', async (req, res) => {
    try {
        const body = req.body ?? {};
        const { accountId, account } = await requireSleeve(req);
        const txn = {
            account_id: accountId,
            type: body.type,
            symbol: body.symbol,
            shares: Number(body.shares),
            price: Number(body.price),
            txn_date: body.txn_date === undefined ? new Date().toISOString().slice(0, 10) : body.txn_date,
            fees: Number(body.fees ?? 0),
            notes: body.notes ?? null,
        };

        if (!['buy', 'sell'].includes(txn.type)) {
            return res.status(400).json({ status: 'error', error: 'type must be buy or sell' });
        }
        if (!txn.symbol || !(txn.shares > 0) || !(txn.price > 0)) {
            return res.status(400).json({ status: 'error', error: 'symbol, shares, and price are required and must be positive' });
        }
        if (body.source !== 'operator-manual') {
            return res.status(400).json({ status: 'error', error: 'manual recording requires source: "operator-manual"' });
        }

        if (txn.type === 'buy' && body.trade_plan && account.slug !== 'day-trading') {
            return res.status(400).json({ status: 'error', error: 'structured trade plans are limited to the day-trading sleeve' });
        }
        const result = await db.recordSimTradeAtomic({
            transaction: txn,
            trade_plan: body.trade_plan,
            close_plan_id: body.close_plan_id,
            closure: body.journal,
        });
        res.json({ status: 'success', data: result });
    } catch (err) {
        if (String(err.code || '').startsWith('SIM_')) err.status = err.status || 400;
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

// GET /api/simulator/trade-plans — structured plan history for one sleeve
router.get('/trade-plans', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const status = req.query.status == null ? null : String(req.query.status);
        if (status && !['active', 'closed', 'cancelled'].includes(status)) {
            return res.status(400).json({ status: 'error', error: 'invalid trade-plan status' });
        }
        const plans = await db.listSimTradePlans(accountId, status);
        res.json({ status: 'success', data: plans });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/journal — deterministic process analytics from closed structured trades
router.get('/journal', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const trades = await db.listSimTradePlans(accountId);
        res.json({ status: 'success', data: { analytics: computeJournalAnalytics(trades), trades } });
    } catch (err) {
        sendError(res, err);
    }
});

// GET /api/simulator/risk-monitor — read-only threshold and quote-health evaluation
router.get('/risk-monitor', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const [txns, plans] = await Promise.all([
            db.listSimTransactions(accountId),
            db.listSimTradePlans(accountId, 'active'),
        ]);
        const holdings = computeHoldings(txns);
        const quotes = {};
        await Promise.all(Object.keys(holdings).map(async (symbol) => {
            quotes[symbol] = await getDefaultHybridQuote(symbol);
        }));
        const marketOpen = Object.values(quotes).some((quote) => quote.market_state === 'REGULAR');
        res.json({ status: 'success', data: buildRiskMonitor({ holdings, plans, quotes, marketOpen }) });
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
        const { accountId, txns } = await accountAndTransactions(req);
        const holdings = computeHoldings(txns);
        const prices = {};
        await Promise.all(Object.keys(holdings).map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                if (typeof info?.data?.price === 'number' && info.data.price > 0 && Number.isFinite(info.data.price)
                    && !info.data.isDemo && !info.data.is_demo && !info.meta?.stale) prices[symbol] = info.data.price;
            } catch { /* non-fatal */ }
        }));
        const measured = await performance.getPerformance(accountId);
        res.json({ status: 'success', data: { ...buildSimulatorReview(txns, prices), twr_pct: measured.twr_pct,
            observed_drawdown_pct: measured.max_drawdown_pct, performance_blockers: measured.blockers,
            observation_count: measured.observation_count } });
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

function reqAgentAccounts(req, accounts) {
    return req.auth?.role === 'simulator-agent' ? accounts.filter((a) => a.id === req.auth.account_id) : accounts;
}

router.get('/risk-policy', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const policy = await controls.connection((conn) => controls.latestPolicy(conn, accountId));
        res.json({ status: 'success', data: { policy, entries_enabled: Boolean(policy) } });
    } catch (err) { sendError(res, err); }
});
router.put('/risk-policy', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const policy = await controls.setPolicy(accountId, req.body, req.auth?.username || 'operator');
        res.json({ status: 'success', data: policy });
    } catch (err) { sendError(res, err); }
});
router.get('/performance', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        res.json({ status: 'success', data: await performance.getPerformance(accountId, req.query.run_id || null) });
    } catch (err) { sendError(res, err); }
});
router.post('/performance/capture', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        res.json({ status: 'success', data: await performance.captureCurrent(accountId) });
    } catch (err) { sendError(res, err); }
});
router.get('/runs', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        const runs = await controls.connection((conn) => controls.all(conn, 'SELECT * FROM sim_evaluation_sessions WHERE account_id=? ORDER BY started_at DESC', [accountId]));
        res.json({ status: 'success', data: runs.map((r) => ({ ...r, config: JSON.parse(r.config_json) })) });
    } catch (err) { sendError(res, err); }
});
router.post('/runs', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        res.status(201).json({ status: 'success', data: await performance.startRun(accountId, req.body) });
    } catch (err) { sendError(res, err); }
});
router.post('/runs/:id/archive', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        res.json({ status: 'success', data: await performance.archiveRun(accountId, req.params.id) });
    } catch (err) { sendError(res, err); }
});
router.post('/decisions', async (req, res) => {
    try {
        const { accountId } = await requireSleeve(req);
        res.status(201).json({ status: 'success', data: await performance.recordDecision(accountId, req.body) });
    } catch (err) { sendError(res, err); }
});

module.exports = router;
