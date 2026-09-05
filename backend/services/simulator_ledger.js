const portfolioLedger = require('./portfolio_ledger');

function computeHoldings(transactions) {
    const holdings = portfolioLedger.computeHoldings(transactions);
    return Object.fromEntries(Object.entries(holdings).filter(([, holding]) => holding.shares > 0.000001));
}

const { computeCashBalance, computeRealizedPnl } = portfolioLedger;

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
                price_per_share: Number(txn.price),
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
    computeLotsForSymbol,
    computeTaxPreview,
    computeHoldings,
    computeCashBalance,
    computeRealizedPnl,
    shortTermRate,
    longTermRate,
};
