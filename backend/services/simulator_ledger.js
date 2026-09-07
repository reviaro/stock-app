const portfolioLedger = require('./portfolio_ledger');

function byDateThenId(a, b) {
    return String(a.txn_date || '').localeCompare(String(b.txn_date || '')) || (a.id ?? 0) - (b.id ?? 0);
}

// Simulator-only weighted-average basis; real portfolio accounting is untouched.
function computeAccounting(transactions) {
    const holdings = {};
    const sales = [];
    for (const txn of [...transactions].sort(byDateThenId)) {
        if (!txn.symbol) continue;
        const symbol = txn.symbol.toUpperCase();
        const h = holdings[symbol] ||= { shares: 0, total_cost: 0, gross_total_cost: 0, avg_cost: 0, dividends_received: 0 };
        const shares = Number(txn.shares || 0);
        const amount = Number(txn.amount ?? shares * Number(txn.price || 0));
        const fees = Number(txn.fees || 0);
        if (txn.type === 'buy') {
            h.shares += shares;
            h.total_cost += amount + fees;
            h.gross_total_cost += amount;
        } else if (txn.type === 'sell') {
            const cost = h.shares > 0 ? h.total_cost / h.shares * shares : 0;
            const grossCost = h.shares > 0 ? h.gross_total_cost / h.shares * shares : 0;
            sales.push({ ...txn, symbol, realized_pnl: amount - fees - cost, gross_realized_pnl: amount - grossCost });
            h.shares = Math.max(0, h.shares - shares);
            h.total_cost = h.shares > 0.000001 ? h.total_cost - cost : 0;
            h.gross_total_cost = h.shares > 0.000001 ? h.gross_total_cost - grossCost : 0;
        } else if (txn.type === 'dividend') {
            h.dividends_received += amount;
        }
        h.avg_cost = h.shares > 0 ? h.total_cost / h.shares : 0;
    }
    return { holdings: Object.fromEntries(Object.entries(holdings).filter(([, h]) => h.shares > 0.000001)), sales };
}

function computeHoldings(transactions) {
    return computeAccounting(transactions).holdings;
}

function computeRealizedPnl(transactions, year) {
    const sales = computeAccounting(transactions).sales.filter((txn) => !year || Number(String(txn.txn_date).slice(0, 4)) === year);
    const bySymbol = {};
    const grossBySymbol = {};
    for (const sale of sales) {
        bySymbol[sale.symbol] = (bySymbol[sale.symbol] || 0) + sale.realized_pnl;
        grossBySymbol[sale.symbol] = (grossBySymbol[sale.symbol] || 0) + sale.gross_realized_pnl;
    }
    const total = Object.values(bySymbol).reduce((sum, value) => sum + value, 0);
    return { total, net_total: total, gross_total: Object.values(grossBySymbol).reduce((sum, value) => sum + value, 0), bySymbol, grossBySymbol, sales };
}

const { computeCashBalance } = portfolioLedger;

function valueHoldings(transactions, currentPrices = {}) {
    const holdings = computeHoldings(transactions);
    const position_values = {};
    const missing_symbols = [];
    let valued_positions_value = 0;
    for (const [symbol, holding] of Object.entries(holdings)) {
        const price = currentPrices[symbol];
        if (typeof price === 'number' && Number.isFinite(price) && price >= 0) {
            const value = price * holding.shares;
            position_values[symbol] = value;
            valued_positions_value += value;
        } else {
            missing_symbols.push(symbol);
        }
    }
    return {
        total_value: missing_symbols.length ? null : valued_positions_value,
        valuation_complete: missing_symbols.length === 0,
        missing_symbols: missing_symbols.sort(),
        known_positions_value: valued_positions_value,
        valued_positions_value,
        position_values,
    };
}

function buildSimulatorAccount(transactions, currentPrices = {}) {
    const deposits = transactions.filter((t) => t.type === 'deposit').reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const withdrawals = transactions.filter((t) => t.type === 'withdrawal').reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const netCapital = deposits - withdrawals;
    const cash = computeCashBalance(transactions);
    const holdings = computeHoldings(transactions);
    const valuation = valueHoldings(transactions, currentPrices);
    const totalValue = valuation.valuation_complete ? cash + valuation.total_value : null;
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
            valuation_complete: known,
        };
    });
    const pnl = computeRealizedPnl(transactions);
    return {
        net_capital: round(netCapital),
        cash: round(cash),
        positions,
        holdings_value: totalValue == null ? null : round(totalValue - cash),
        marked_value: round(valuation.valued_positions_value),
        missing_symbols: valuation.missing_symbols,
        valuation_complete: valuation.valuation_complete,
        total_value: totalValue == null ? null : round(totalValue),
        // Capital-relative return on net deposits; not a time-weighted return.
        total_return_pct: totalValue == null || netCapital <= 0 ? null : round(((totalValue - netCapital) / netCapital) * 100),
        return_basis: 'net_capital',
        twr_pct: null,
        realized_pnl: { net: round(pnl.total), gross: round(pnl.gross_total) },
        unrealized_pnl: totalValue == null ? null : round(positions.reduce((sum, p) => sum + (p.pnl || 0), 0)),
    };
}

const LONG_TERM_TAX = { 10: 0, 12: 0, 22: 0.15, 24: 0.15, 32: 0.20, 35: 0.20, 37: 0.20 };

function shortTermRate(bracket) {
    return bracket / 100;
}

function longTermRate(bracket) {
    return LONG_TERM_TAX[bracket] ?? 0.15;
}

/**
 * Returns the remaining FIFO lots for a symbol given all sim transactions.
 * Each lot: { shares, price_per_share, txn_date }
 */
function computeLotsForSymbol(transactions, symbol) {
    const upper = symbol.toUpperCase();
    const ordered = transactions
        .filter((t) => t.symbol === upper)
        .sort((a, b) => {
            if (a.txn_date < b.txn_date) return -1;
            if (a.txn_date > b.txn_date) return 1;
            return (a.id ?? 0) - (b.id ?? 0);
        });

    const lots = [];

    for (const txn of ordered) {
        if (txn.type === 'buy') {
            lots.push({
                shares: Number(txn.shares),
                price_per_share: (Number(txn.amount ?? Number(txn.price) * Number(txn.shares)) + Number(txn.fees || 0)) / Number(txn.shares),
                txn_date: txn.txn_date,
            });
        } else if (txn.type === 'sell') {
            let remaining = Number(txn.shares);
            for (const lot of lots) {
                if (remaining <= 0) break;
                const consumed = Math.min(lot.shares, remaining);
                lot.shares -= consumed;
                remaining -= consumed;
            }
        }
    }

    return lots.filter((l) => l.shares > 0.000001);
}

/**
 * Compute tax preview for selling `sharesToSell` shares of a symbol.
 * `lots` = result of computeLotsForSymbol.
 * `taxBracket` = number like 22.
 * `sellDate` = ISO date string 'YYYY-MM-DD'.
 */
function computeTaxPreview({ lots, sharesToSell, currentPrice, taxBracket, sellDate }) {
    const date = sellDate || new Date().toISOString().slice(0, 10);
    const sellMs = new Date(date).getTime();
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

    let remaining = sharesToSell;
    let costBasis = 0;
    let shortTermGain = 0;
    let longTermGain = 0;

    for (const lot of lots) {
        if (remaining <= 0.000001) break;
        const consumed = Math.min(lot.shares, remaining);
        const lotCost = consumed * lot.price_per_share;
        const lotProceeds = consumed * currentPrice;
        const lotGain = lotProceeds - lotCost;
        const holdMs = sellMs - new Date(lot.txn_date).getTime();

        costBasis += lotCost;
        if (holdMs >= YEAR_MS) {
            longTermGain += lotGain;
        } else {
            shortTermGain += lotGain;
        }
        remaining -= consumed;
    }

    const proceeds = sharesToSell * currentPrice;
    const grossGain = shortTermGain + longTermGain;
    const stRate = shortTermRate(taxBracket);
    const ltRate = longTermRate(taxBracket);
    const shortTermTax = Math.max(0, shortTermGain) * stRate;
    const longTermTax = Math.max(0, longTermGain) * ltRate;
    const totalTax = shortTermTax + longTermTax;
    const afterTaxNetGain = grossGain - totalTax;
    const breakevenPrice = sharesToSell > 0 ? costBasis / sharesToSell : 0;

    return {
        proceeds: round(proceeds),
        cost_basis: round(costBasis),
        gross_gain: round(grossGain),
        short_term_gain: round(shortTermGain),
        short_term_tax: round(shortTermTax),
        long_term_gain: round(longTermGain),
        long_term_tax: round(longTermTax),
        total_tax: round(totalTax),
        after_tax_net_gain: round(afterTaxNetGain),
        worth_selling: afterTaxNetGain > 0,
        breakeven_price: round(breakevenPrice),
    };
}

function round(n) {
    return Math.round(n * 100) / 100;
}

module.exports = {
    valueHoldings,
    buildSimulatorAccount,
    computeAccounting,
    computeLotsForSymbol,
    computeTaxPreview,
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
    shortTermRate,
    longTermRate,
};
