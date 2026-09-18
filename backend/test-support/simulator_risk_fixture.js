// Explicit permissive operator policies for legacy execution tests. Dedicated
// simulator_controls tests exercise restrictive policies without this fixture.
const controls = require('../services/simulator_controls');
async function seedRiskPolicies() {
    for (const id of [1, 2]) await controls.setPolicy(id, { max_position_pct: 100, min_cash_pct: 0,
        max_risk_per_trade_pct: 100, max_open_risk_pct: 100, max_daily_loss_pct: 100 }, 'test-operator');
}
function testQuote(symbol, price) {
    return { symbol, price, source: 'alpaca_iex', price_type: 'latest_trade', currency: 'USD', market_state: 'REGULAR',
        event_time: new Date(Date.now() - 1000).toISOString(), received_at: new Date().toISOString() };
}
async function executeTestOrder(db, order) {
    const { computeHoldings } = require('../services/simulator_ledger');
    const holdings = computeHoldings(await db.listSimTransactions(order.transaction.account_id));
    const quote = testQuote(order.transaction.symbol, order.transaction.price);
    const marks = Object.fromEntries(Object.entries(holdings).map(([symbol, holding]) => [symbol, testQuote(symbol, holding.avg_cost)]));
    return db.executeSimTradeAtomic({ ...order, quote, valuation_quotes: { ...marks, [quote.symbol]: quote } });
}
module.exports = { seedRiskPolicies, executeTestOrder, testQuote };
