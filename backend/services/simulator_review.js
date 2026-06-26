const { computeHoldings, computeCashBalance, computeRealizedPnl } = require('./simulator_ledger');

function round(n) {
    return Math.round(Number(n || 0) * 100) / 100;
}

function buildSimulatorReview(txns, currentPrices = {}) {
    const deposits = txns.filter((t) => t.type === 'deposit').reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const withdrawals = txns.filter((t) => t.type === 'withdrawal').reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const netCapital = deposits - withdrawals;
    const cash = computeCashBalance(txns);
    const holdings = computeHoldings(txns);
    const realized = computeRealizedPnl(txns).total;

    const positions = Object.entries(holdings).map(([symbol, h]) => {
        const price = currentPrices[symbol] ?? h.avg_cost;
        const marketValue = price * h.shares;
        const pnl = marketValue - h.total_cost;
        return {
            symbol,
            shares: round(h.shares),
            cost: round(h.total_cost),
            market_value: round(marketValue),
            pnl: round(pnl),
            weight_pct: 0,
        };
    });

    const holdingsValue = positions.reduce((sum, p) => sum + p.market_value, 0);
    const totalValue = cash + holdingsValue;
    for (const p of positions) p.weight_pct = totalValue > 0 ? round((p.market_value / totalValue) * 100) : 0;

    const closedTrades = txns.filter((t) => t.type === 'sell');
    const winners = closedTrades.filter((t) => Number(t.amount || 0) > 0).length;
    const actionNotes = txns
        .filter((t) => ['buy', 'sell'].includes(t.type) && t.notes)
        .slice(-10)
        .reverse()
        .map((t) => ({ id: t.id, date: t.txn_date, type: t.type, symbol: t.symbol, amount: round(t.amount), notes: t.notes }));

    return {
        starting_capital: round(netCapital),
        cash: round(cash),
        holdings_value: round(holdingsValue),
        total_value: round(totalValue),
        total_return_pct: netCapital > 0 ? round(((totalValue - netCapital) / netCapital) * 100) : 0,
        realized_pnl: round(realized),
        unrealized_pnl: round(positions.reduce((sum, p) => sum + p.pnl, 0)),
        cash_pct: totalValue > 0 ? round((cash / totalValue) * 100) : 0,
        position_count: positions.length,
        largest_position: positions.slice().sort((a, b) => b.weight_pct - a.weight_pct)[0] || null,
        closed_trade_count: closedTrades.length,
        hit_rate_pct: closedTrades.length > 0 ? round((winners / closedTrades.length) * 100) : null,
        positions: positions.sort((a, b) => b.market_value - a.market_value),
        recent_buffett_actions: actionNotes,
    };
}

function simulatorTransactionsToCsv(txns) {
    const header = ['id', 'date', 'type', 'symbol', 'shares', 'price', 'amount', 'fees', 'notes'];
    const rows = txns.map((t) => [t.id, t.txn_date, t.type, t.symbol ?? '', t.shares ?? '', t.price ?? '', t.amount ?? '', t.fees ?? 0, t.notes ?? '']);
    return [header, ...rows]
        .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');
}

module.exports = { buildSimulatorReview, simulatorTransactionsToCsv };
