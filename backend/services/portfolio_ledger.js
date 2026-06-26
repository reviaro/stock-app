function byDateThenId(a, b) {
    if (a.txn_date < b.txn_date) return -1;
    if (a.txn_date > b.txn_date) return 1;
    return (a.id ?? 0) - (b.id ?? 0);
}

function computeHoldings(transactions) {
    const ordered = [...transactions].sort(byDateThenId);
    const holdings = {};

    for (const txn of ordered) {
        if (!txn.symbol) continue;
        const symbol = txn.symbol.toUpperCase();
        if (!holdings[symbol]) {
            holdings[symbol] = {
                shares: 0,
                total_cost: 0,
                avg_cost: 0,
                dividends_received: 0,
            };
        }
        const holding = holdings[symbol];

        if (txn.type === 'buy') {
            holding.shares += Number(txn.shares);
            holding.total_cost += Number(txn.amount);
            holding.avg_cost = holding.shares > 0 ? holding.total_cost / holding.shares : 0;
        } else if (txn.type === 'sell') {
            const sharesToSell = Number(txn.shares);
            const costRemoved = sharesToSell * holding.avg_cost;
            holding.shares = Math.max(0, holding.shares - sharesToSell);
            holding.total_cost = Math.max(0, holding.total_cost - costRemoved);
            holding.avg_cost = holding.shares > 0 ? holding.total_cost / holding.shares : 0;
        } else if (txn.type === 'dividend') {
            holding.dividends_received += Number(txn.amount);
        }
    }

    Object.keys(holdings).forEach((symbol) => {
        if (holdings[symbol].shares <= 0 && holdings[symbol].dividends_received <= 0) {
            delete holdings[symbol];
        }
    });

    return holdings;
}

function computeCashBalance(transactions) {
    return transactions.reduce((cash, txn) => {
        const amount = Number(txn.amount ?? 0);
        const fees = Number(txn.fees ?? 0);

        if (txn.type === 'deposit') return cash + amount - fees;
        if (txn.type === 'withdrawal') return cash - amount - fees;
        if (txn.type === 'buy') return cash - amount - fees;
        if (txn.type === 'sell') return cash + amount - fees;
        if (txn.type === 'dividend') return cash + amount - fees;
        return cash;
    }, 0);
}

function computeRealizedPnl(transactions, year) {
    const ordered = [...transactions].sort(byDateThenId);
    const basis = {};
    const bySymbol = {};

    for (const txn of ordered) {
        if (!txn.symbol) continue;
        const symbol = txn.symbol.toUpperCase();
        if (!basis[symbol]) basis[symbol] = { shares: 0, avg_cost: 0 };
        const current = basis[symbol];

        if (txn.type === 'buy') {
            const totalCost = current.avg_cost * current.shares + Number(txn.amount);
            current.shares += Number(txn.shares);
            current.avg_cost = current.shares > 0 ? totalCost / current.shares : 0;
            continue;
        }

        if (txn.type === 'sell') {
            const txnYear = Number(String(txn.txn_date).slice(0, 4));
            const pnl = (Number(txn.price) - current.avg_cost) * Number(txn.shares);
            current.shares = Math.max(0, current.shares - Number(txn.shares));
            if (current.shares === 0) current.avg_cost = 0;

            if (!year || txnYear === year) {
                bySymbol[symbol] = (bySymbol[symbol] ?? 0) + pnl;
            }
        }
    }

    const total = Object.values(bySymbol).reduce((sum, value) => sum + value, 0);
    return { total, bySymbol };
}

function computeUnrealizedPnl(holdings, currentPrices) {
    const result = {};
    Object.entries(holdings).forEach(([symbol, holding]) => {
        const price = currentPrices[symbol];
        if (typeof price === 'number') {
            result[symbol] = price * holding.shares - holding.total_cost;
        }
    });
    return result;
}

function buildSummary(transactions, currentPrices = {}) {
    const holdings = computeHoldings(transactions);
    const cash = computeCashBalance(transactions);
    const realized = computeRealizedPnl(transactions);
    const unrealized = computeUnrealizedPnl(holdings, currentPrices);
    const holdingsValue = Object.entries(holdings).reduce((sum, [symbol, holding]) => {
        const price = currentPrices[symbol];
        return sum + (typeof price === 'number' ? price * holding.shares : 0);
    }, 0);
    const totalValue = cash + holdingsValue;
    const cashPct = totalValue > 0 ? Math.round((cash / totalValue) * 10000) / 100 : null;
    const currentYear = new Date().getFullYear();
    const realizedYtd = computeRealizedPnl(transactions, currentYear).total;
    const dividendsYtd = Math.round(transactions.reduce((sum, txn) => {
        if (txn.type !== 'dividend') return sum;
        if (Number(String(txn.txn_date).slice(0, 4)) !== currentYear) return sum;
        return sum + Number(txn.amount);
    }, 0) * 100) / 100;

    return {
        cash,
        cashPct,
        holdings,
        realized,
        realizedYtd,
        unrealized,
        positionsValue: holdingsValue,
        holdingsValue,
        dividendsYtd,
        totalValue,
    };
}

module.exports = {
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
    computeUnrealizedPnl,
    buildSummary,
};
