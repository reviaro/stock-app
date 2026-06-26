const express = require('express');
const router = express.Router();
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const { buildSummary } = require('../services/portfolio_ledger');
const { computeBreaches } = require('../services/risk_engine');

// GET /api/portfolio — aggregate holdings from the transactions ledger
router.get('/', async (req, res) => {
    try {
        const [transactions, rules, stops] = await Promise.all([
            db.listTransactions ? db.listTransactions() : Promise.resolve([]),
            db.getRiskRules ? db.getRiskRules() : Promise.resolve(null),
            db.listPositionStops ? db.listPositionStops() : Promise.resolve([]),
        ]);

        if (transactions.length === 0) {
            return res.json({
                status: 'success',
                data: {
                    summary: {
                        cash: 0,
                        cashPct: null,
                        holdingsValue: 0,
                        totalValue: 0,
                        realizedPnl: 0,
                        unrealizedPnl: 0,
                    },
                    holdings: [],
                    recentTransactions: [],
                },
            });
        }

        const symbols = [...new Set(transactions.map((txn) => txn.symbol).filter(Boolean))];
        const currentPrices = {};
        const infoBySymbol = {};

        await Promise.all(symbols.map(async (symbol) => {
            try {
                const info = await pybridge.getStockInfo(symbol);
                infoBySymbol[symbol] = info?.data ?? {};
                if (typeof info?.data?.price === 'number') {
                    currentPrices[symbol] = info.data.price;
                }
            } catch {
                infoBySymbol[symbol] = {};
            }
        }));

        const stopBySymbol = Object.fromEntries((stops || []).map((stop) => [stop.symbol, stop.stop_loss]));
        const ledger = buildSummary(transactions, currentPrices);
        const holdings = Object.entries(ledger.holdings).map(([symbol, holding]) => {
            const currentPrice = currentPrices[symbol] ?? null;
            const currentValue = currentPrice != null ? currentPrice * holding.shares : null;
            const pnl = ledger.unrealized[symbol] ?? null;
            const pnlPct = holding.total_cost > 0 && pnl != null ? (pnl / holding.total_cost) * 100 : null;
            return {
                symbol,
                name: infoBySymbol[symbol]?.name ?? symbol,
                shares: holding.shares,
                avg_cost: holding.avg_cost,
                total_cost: holding.total_cost,
                dividends_received: holding.dividends_received,
                sector: infoBySymbol[symbol]?.sector ?? null,
                currentPrice,
                currentValue,
                pnl,
                pnlPct,
                stop_loss: stopBySymbol[symbol] ?? null,
            };
        });

        const risk = rules
            ? computeBreaches({ positions: holdings, cash: ledger.cash, rules })
            : { cashPct: null, breaches: [] };
        const holdingsWithBreaches = holdings.map((holding) => ({
            ...holding,
            breaches: risk.breaches.filter((breach) =>
                (breach.symbol && breach.symbol === holding.symbol) ||
                (breach.kind === 'sector' && breach.sector === (holding.sector || 'Unknown'))
            ),
        }));

        res.json({
            status: 'success',
            data: {
                summary: {
                    cash: ledger.cash,
                    cashPct: risk.cashPct,
                    holdingsValue: ledger.holdingsValue,
                    totalValue: ledger.totalValue,
                    realizedPnl: ledger.realized.total,
                    unrealizedPnl: Object.values(ledger.unrealized).reduce((sum, value) => sum + value, 0),
                },
                holdings: holdingsWithBreaches,
                recentTransactions: transactions.slice(0, 10),
                breaches: risk.breaches,
                rules,
            },
        });
    } catch (err) {
        res.status(500).json({ status: 'error', error: err.message });
    }
});

module.exports = router;
