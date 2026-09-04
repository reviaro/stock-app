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
    const dividends = txns.filter((txn) => txn.type === 'dividend');
    const dividendIncome = dividends.reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
    const reinvestedDividends = dividends
        .filter((txn) => txn.reinvestment_mode === 'drip')
        .reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

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

    // A sell always has positive proceeds, so amount cannot determine whether it won.
    // Match the simulator's weighted-average realized-P&L accounting to score each sale.
    const basisBySymbol = {};
    const closedTrades = [];
    for (const txn of [...txns].sort((a, b) => {
        if (a.txn_date < b.txn_date) return -1;
        if (a.txn_date > b.txn_date) return 1;
        return (a.id ?? 0) - (b.id ?? 0);
    })) {
        if (!txn.symbol) continue;
        const symbol = txn.symbol.toUpperCase();
        const basis = basisBySymbol[symbol] ?? { shares: 0, avg_cost: 0 };
        basisBySymbol[symbol] = basis;

        if (txn.type === 'buy') {
            const totalCost = basis.avg_cost * basis.shares + Number(txn.amount || 0);
            basis.shares += Number(txn.shares || 0);
            basis.avg_cost = basis.shares > 0 ? totalCost / basis.shares : 0;
        } else if (txn.type === 'sell') {
            const shares = Number(txn.shares || 0);
            const realizedPnl = (Number(txn.price || 0) - basis.avg_cost) * shares;
            closedTrades.push({ ...txn, realized_pnl: realizedPnl });
            basis.shares = Math.max(0, basis.shares - shares);
            if (basis.shares === 0) basis.avg_cost = 0;
        }
    }
    const winners = closedTrades.filter((t) => t.realized_pnl > 0).length;
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
        dividend_income: round(dividendIncome),
        reinvested_dividends: round(reinvestedDividends),
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
    // Notes are user-supplied free text. Prefixing a tab neutralizes spreadsheet
    // formula interpretation (=, +, -, @) in Excel/Sheets without changing the
    // visible content meaningfully.
    const neutralize = (value) => {
        const text = String(value ?? '');
        return /^[=+\-@\t\r]/.test(text) ? `\t${text}` : text;
    };
    const rows = txns.map((t) => [t.id, t.txn_date, t.type, t.symbol ?? '', t.shares ?? '', t.price ?? '', t.amount ?? '', t.fees ?? 0, neutralize(t.notes ?? '')]);
    return [header, ...rows]
        .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');
}

module.exports = { buildSimulatorReview, simulatorTransactionsToCsv };
