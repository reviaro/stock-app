const { createAsyncRouter } = require('../services/http_errors');
const db = require('../database/db');
const pybridge = require('../services/pybridge');
const { buildSummary, computeHoldings, isValuationPrice } = require('../services/portfolio_ledger');
const { computeBreaches } = require('../services/risk_engine');

const router = createAsyncRouter();

async function buildRiskPayload() {
    const [rules, transactions, stops] = await Promise.all([
        db.getRiskRules(),
        db.listTransactions(),
        db.listPositionStops(),
    ]);

    const symbols = Object.entries(computeHoldings(transactions))
        .filter(([, holding]) => holding.shares > 0).map(([symbol]) => symbol);
    const prices = {};
    const infoBySymbol = {};

    await Promise.all(symbols.map(async (symbol) => {
        try {
            const info = await pybridge.getStockInfo(symbol);
            infoBySymbol[symbol] = info?.data ?? {};
            if (isValuationPrice(info?.data?.price)) prices[symbol] = info.data.price;
        } catch {
            infoBySymbol[symbol] = {};
        }
    }));

    const summary = buildSummary(transactions, prices);
    const stopBySymbol = Object.fromEntries(stops.map((stop) => [stop.symbol, stop.stop_loss]));

    const positions = Object.entries(summary.holdings).map(([symbol, holding]) => ({
        symbol,
        shares: holding.shares,
        avg_cost: holding.avg_cost,
        currentPrice: prices[symbol] ?? null,
        currentValue: holding.shares === 0 ? 0 : prices[symbol] != null ? prices[symbol] * holding.shares : null,
        sector: infoBySymbol[symbol]?.sector ?? null,
        stop_loss: stopBySymbol[symbol] ?? null,
    }));

    const breachSummary = computeBreaches({ positions, cash: summary.cash, rules });
    return {
        rules,
        cash: summary.cash,
        cashPct: breachSummary.cashPct,
        positions,
        breaches: breachSummary.breaches,
        riskAssessment: breachSummary.riskAssessment,
        valuationComplete: summary.valuationComplete,
        missingPriceSymbols: summary.missingPriceSymbols,
    };
}

router.get('/', async (_req, res) => {
    try {
        const payload = await buildRiskPayload();
        res.json({ status: 'success', data: payload });
    } catch (err) {
        throw err;
    }
});

router.put('/', async (req, res) => {
    try {
        await db.setRiskRules(req.body ?? {});
        const payload = await buildRiskPayload();
        res.json({ status: 'success', data: payload.rules });
    } catch (err) {
        const code = /invalid value/.test(err.message) ? 400 : 500;
        if (code >= 500) throw err;
        res.status(code).json({ status: 'error', error: err.message });
    }
});

router.put('/stops/:symbol', async (req, res) => {
    try {
        const result = await db.setPositionStop(req.params.symbol, req.body?.stop_loss);
        res.json({ status: 'success', data: result });
    } catch (err) {
        const code = /invalid stop_loss/.test(err.message) ? 400 : 500;
        if (code >= 500) throw err;
        res.status(code).json({ status: 'error', error: err.message });
    }
});

router.delete('/stops/:symbol', async (req, res) => {
    try {
        const result = await db.deletePositionStop(req.params.symbol);
        res.json({ status: 'success', data: result });
    } catch (err) {
        throw err;
    }
});

module.exports = router;
