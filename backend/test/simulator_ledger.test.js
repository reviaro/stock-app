const { test } = require('node:test');
const assert = require('node:assert');
const { computeLotsForSymbol, computeTaxPreview } = require('../services/simulator_ledger');

const TODAY = new Date().toISOString().slice(0, 10);

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().slice(0, 10);
}

// --- computeLotsForSymbol ---

test('single buy -> one lot', () => {
    const txns = [{ id: 1, symbol: 'AAPL', type: 'buy', shares: 10, price: 150, txn_date: daysAgo(10) }];
    const lots = computeLotsForSymbol(txns, 'AAPL');
    assert.strictEqual(lots.length, 1);
    assert.strictEqual(lots[0].shares, 10);
    assert.strictEqual(lots[0].price_per_share, 150);
});

test('buy + full sell -> no lots remaining', () => {
    const txns = [
        { id: 1, symbol: 'AAPL', type: 'buy', shares: 10, price: 150, txn_date: daysAgo(30) },
        { id: 2, symbol: 'AAPL', type: 'sell', shares: 10, price: 200, txn_date: daysAgo(5) },
    ];
    const lots = computeLotsForSymbol(txns, 'AAPL');
    assert.strictEqual(lots.length, 0);
});

test('buy + partial sell -> remaining lot reduced', () => {
    const txns = [
        { id: 1, symbol: 'AAPL', type: 'buy', shares: 10, price: 150, txn_date: daysAgo(30) },
        { id: 2, symbol: 'AAPL', type: 'sell', shares: 4, price: 200, txn_date: daysAgo(5) },
    ];
    const lots = computeLotsForSymbol(txns, 'AAPL');
    assert.strictEqual(lots.length, 1);
    assert.ok(Math.abs(lots[0].shares - 6) < 0.0001);
});

test('two buys + sell consuming first lot fully, second partially', () => {
    const txns = [
        { id: 1, symbol: 'AAPL', type: 'buy', shares: 5, price: 100, txn_date: daysAgo(100) },
        { id: 2, symbol: 'AAPL', type: 'buy', shares: 10, price: 200, txn_date: daysAgo(50) },
        { id: 3, symbol: 'AAPL', type: 'sell', shares: 7, price: 250, txn_date: daysAgo(10) },
    ];
    const lots = computeLotsForSymbol(txns, 'AAPL');
    assert.strictEqual(lots.length, 1);
    assert.ok(Math.abs(lots[0].shares - 8) < 0.0001);
    assert.strictEqual(lots[0].price_per_share, 200);
});

test('filters to correct symbol only', () => {
    const txns = [
        { id: 1, symbol: 'AAPL', type: 'buy', shares: 10, price: 150, txn_date: daysAgo(10) },
        { id: 2, symbol: 'MSFT', type: 'buy', shares: 5, price: 300, txn_date: daysAgo(10) },
    ];
    const lots = computeLotsForSymbol(txns, 'AAPL');
    assert.strictEqual(lots.length, 1);
    assert.strictEqual(lots[0].price_per_share, 150);
});

// --- computeTaxPreview ---

test('short-term gain: held < 365 days, bracket 22%', () => {
    const lots = [{ shares: 10, price_per_share: 100, txn_date: daysAgo(30) }];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 200, taxBracket: 22, sellDate: TODAY });
    assert.strictEqual(preview.proceeds, 2000);
    assert.strictEqual(preview.cost_basis, 1000);
    assert.strictEqual(preview.gross_gain, 1000);
    assert.strictEqual(preview.short_term_gain, 1000);
    assert.strictEqual(preview.long_term_gain, 0);
    assert.strictEqual(preview.short_term_tax, 220);
    assert.strictEqual(preview.long_term_tax, 0);
    assert.strictEqual(preview.total_tax, 220);
    assert.strictEqual(preview.after_tax_net_gain, 780);
    assert.strictEqual(preview.worth_selling, true);
    assert.strictEqual(preview.breakeven_price, 100);
});

test('long-term gain: held >= 365 days, bracket 22% -> 15% LT rate', () => {
    const lots = [{ shares: 10, price_per_share: 100, txn_date: daysAgo(400) }];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 200, taxBracket: 22, sellDate: TODAY });
    assert.strictEqual(preview.long_term_gain, 1000);
    assert.strictEqual(preview.short_term_gain, 0);
    assert.strictEqual(preview.long_term_tax, 150);
    assert.strictEqual(preview.total_tax, 150);
    assert.strictEqual(preview.after_tax_net_gain, 850);
});

test('bracket 12% -> 0% long-term rate', () => {
    const lots = [{ shares: 10, price_per_share: 100, txn_date: daysAgo(400) }];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 200, taxBracket: 12, sellDate: TODAY });
    assert.strictEqual(preview.long_term_tax, 0);
    assert.strictEqual(preview.total_tax, 0);
    assert.strictEqual(preview.after_tax_net_gain, 1000);
});

test('loss sell -> tax is $0, worth_selling false', () => {
    const lots = [{ shares: 10, price_per_share: 200, txn_date: daysAgo(10) }];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 150, taxBracket: 22, sellDate: TODAY });
    assert.strictEqual(preview.gross_gain, -500);
    assert.strictEqual(preview.total_tax, 0);
    assert.strictEqual(preview.after_tax_net_gain, -500);
    assert.strictEqual(preview.worth_selling, false);
});

test('mixed lot: partial ST + partial LT', () => {
    const lots = [
        { shares: 5, price_per_share: 100, txn_date: daysAgo(400) },
        { shares: 5, price_per_share: 100, txn_date: daysAgo(30) },
    ];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 200, taxBracket: 22, sellDate: TODAY });
    assert.strictEqual(preview.long_term_gain, 500);
    assert.strictEqual(preview.short_term_gain, 500);
    assert.strictEqual(preview.long_term_tax, 75);
    assert.strictEqual(preview.short_term_tax, 110);
    assert.strictEqual(preview.total_tax, 185);
    assert.strictEqual(preview.after_tax_net_gain, 815);
});

test('partial lot sell: only consume needed shares FIFO', () => {
    const lots = [
        { shares: 10, price_per_share: 100, txn_date: daysAgo(400) },
        { shares: 10, price_per_share: 150, txn_date: daysAgo(30) },
    ];
    const preview = computeTaxPreview({ lots, sharesToSell: 5, currentPrice: 200, taxBracket: 24, sellDate: TODAY });
    assert.strictEqual(preview.cost_basis, 500);
    assert.strictEqual(preview.long_term_gain, 500);
    assert.strictEqual(preview.short_term_gain, 0);
    assert.strictEqual(preview.long_term_tax, 75);
});

test('breakeven_price equals avg cost of FIFO lots consumed', () => {
    const lots = [{ shares: 10, price_per_share: 130, txn_date: daysAgo(10) }];
    const preview = computeTaxPreview({ lots, sharesToSell: 10, currentPrice: 130, taxBracket: 22, sellDate: TODAY });
    assert.strictEqual(preview.breakeven_price, 130);
    assert.strictEqual(preview.gross_gain, 0);
    assert.strictEqual(preview.total_tax, 0);
    assert.strictEqual(preview.after_tax_net_gain, 0);
});
