const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { computeBreaches } = require('../services/risk_engine');

const transactions = [
    { type: 'deposit', amount: 1000, txn_date: '2026-01-01' },
    { type: 'buy', symbol: 'TEST', shares: 5, price: 100, amount: 500, txn_date: '2026-01-02' },
];
const rules = { max_position_pct: 40, max_sector_pct: 60, max_risk_per_trade_pct: 2, target_cash_pct: 60 };
let quoteAvailable = false;
const originalLoad = Module._load;
let portfolio;
let risk;
let aiContext;
try {
    Module._load = function(request, parent, isMain) {
        if (request.includes('database/db')) return {
            listTransactions: async () => transactions,
            getRiskRules: async () => rules,
            listPositionStops: async () => [],
            getMemo: async () => null,
        };
        if (request.includes('pybridge')) return { getStockInfo: async () => {
            if (!quoteAvailable) throw new Error('Synthetic quote outage');
            return { data: { price: 100, sector: 'Example sector' } };
        } };
        return originalLoad.call(this, request, parent, isMain);
    };
    portfolio = require('../routes/portfolio');
    risk = require('../routes/risk');
    aiContext = require('../services/ai_context');
} finally {
    Module._load = originalLoad;
}

async function getRoot(router) {
    const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.get).route.stack[0].handle;
    let payload;
    let status = 200;
    await handler({}, { status(value) { status = value; return this; }, json(value) { payload = value; } }, error => { throw error; });
    assert.equal(status, 200);
    return payload.data;
}

test('portfolio and risk APIs declare an incomplete assessment during a quote outage and recover', async () => {
    quoteAvailable = false;
    const incomplete = await getRoot(portfolio);
    assert.equal(incomplete.summary.totalValue, null);
    assert.equal(incomplete.summary.unrealizedPnl, null);
    assert.equal(incomplete.summary.cash, 500);
    assert.equal(incomplete.summary.valuationComplete, false);
    assert.deepEqual(incomplete.summary.missingPriceSymbols, ['TEST']);
    assert.equal(incomplete.holdings[0].shares, 5);
    assert.equal(incomplete.riskAssessment, 'incomplete');
    const incompleteRisk = await getRoot(risk);
    assert.equal(incompleteRisk.cashPct, null);
    assert.equal(incompleteRisk.riskAssessment, 'incomplete');
    assert.deepEqual(incompleteRisk.breaches, []);
    const context = await aiContext.aggregatePortfolioContext();
    assert.equal(context.valuationComplete, false);
    assert.equal(context.riskAssessment, 'incomplete');
    assert.deepEqual(context.missingPriceSymbols, ['TEST']);

    quoteAvailable = true;
    const restored = await getRoot(portfolio);
    assert.equal(restored.summary.totalValue, 1000);
    assert.equal(restored.summary.cashPct, 50);
    assert.equal(restored.riskAssessment, 'complete');
    assert.ok(restored.breaches.some(breach => breach.kind === 'position'));
    assert.ok(restored.breaches.some(breach => breach.kind === 'cash_below_target'));
});

test('risk never treats an invalid or missing holding value as zero', () => {
    for (const value of [undefined, null, NaN, Infinity, -100]) {
        const result = computeBreaches({ positions: [{ symbol: 'TEST', shares: 5, currentValue: value }], cash: 500, rules });
        assert.equal(result.totalValue, null);
        assert.equal(result.cashPct, null);
        assert.equal(result.riskAssessment, 'incomplete');
    }
});
