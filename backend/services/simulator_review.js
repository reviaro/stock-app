const { computeHoldings, computeCashBalance, computeRealizedPnl, valueHoldings } = require('./simulator_ledger');

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
    const valuation = valueHoldings(txns, currentPrices);
    const holdingsValue = valuation.valued_positions_value;
    const totalValue = valuation.valuation_complete ? cash + holdingsValue : null;
    const dividends = txns.filter((txn) => txn.type === 'dividend');
    const dividendIncome = dividends.reduce((sum, txn) => sum + Number(txn.amount || 0), 0);
    const reinvestedDividends = dividends
        .filter((txn) => txn.reinvestment_mode === 'drip')
        .reduce((sum, txn) => sum + Number(txn.amount || 0), 0);

    const positions = Object.entries(holdings).map(([symbol, h]) => {
        const price = currentPrices[symbol];
        const known = typeof price === 'number' && Number.isFinite(price) && price >= 0;
        const marketValue = known ? price * h.shares : null;
        return {
            symbol,
            shares: round(h.shares),
            cost: round(h.total_cost),
            avg_cost: round(h.avg_cost),
            market_value: marketValue == null ? null : round(marketValue),
            pnl: marketValue == null ? null : round(marketValue - h.total_cost),
            price_used: known ? price : null,
            price_status: known ? 'live' : 'unavailable',
            weight_pct: 0,
        };
    });

    for (const p of positions) p.weight_pct = totalValue == null ? null : totalValue > 0 ? round((p.market_value / totalValue) * 100) : 0;

    // Realized P&L is net of buy/sell fees via the simulator ledger; hit rate scores net outcomes.
    const closedTrades = computeRealizedPnl(txns).sales;
    const winners = closedTrades.filter((t) => t.realized_pnl > 0).length;
    const actionNotes = txns
        .filter((t) => ['buy', 'sell'].includes(t.type) && t.notes)
        .slice(-10)
        .reverse()
        .map((t) => ({ id: t.id, date: t.txn_date, type: t.type, symbol: t.symbol, amount: round(t.amount), notes: t.notes }));

    return {
        starting_capital: round(netCapital),
        cash: round(cash),
        holdings_value: totalValue == null ? null : round(holdingsValue),
        marked_value: round(holdingsValue),
        missing_symbols: valuation.missing_symbols,
        valuation_complete: valuation.valuation_complete,
        total_value: totalValue == null ? null : round(totalValue),
        // Capital-relative return on net deposits; not a time-weighted return.
        total_return_pct: totalValue == null || netCapital <= 0 ? null : round(((totalValue - netCapital) / netCapital) * 100),
        return_basis: 'net_capital',
        twr_pct: null,
        realized_pnl: round(realized),
        unrealized_pnl: totalValue == null ? null : round(positions.reduce((sum, p) => sum + p.pnl, 0)),
        dividend_income: round(dividendIncome),
        reinvested_dividends: round(reinvestedDividends),
        cash_pct: totalValue == null ? null : totalValue > 0 ? round((cash / totalValue) * 100) : 0,
        position_count: positions.length,
        largest_position: totalValue == null
            ? null
            : positions.slice().sort((a, b) => b.market_value - a.market_value)[0] || null,
        closed_trade_count: closedTrades.length,
        hit_rate_pct: closedTrades.length > 0 ? round((winners / closedTrades.length) * 100) : null,
        positions: positions.sort((a, b) => (b.market_value ?? -Infinity) - (a.market_value ?? -Infinity)),
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
        return /^[=+\-\t\r@]/.test(text) ? `\t${text}` : text;
    };
    const rows = txns.map((t) => [t.id, t.txn_date, t.type, t.symbol ?? '', t.shares ?? '', t.price ?? '', t.amount ?? '', t.fees ?? 0, neutralize(t.notes ?? '')]);
    return [header, ...rows]
        .map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');
}

module.exports = { buildSimulatorReview, simulatorTransactionsToCsv };
