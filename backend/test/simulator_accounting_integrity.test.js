const test = require('node:test');
const assert = require('node:assert/strict');
const ledger = require('../services/simulator_ledger');
const { buildSimulatorReview } = require('../services/simulator_review');
const journal = require('../services/trade_journal');
const fill = (id, type, shares, price, fees = 0, extra = {}) => ({ id, account_id: 1, symbol: 'ABC', txn_date: '2026-01-01', type, shares, price, amount: shares * price, fees, ...extra });

test('simulator allocates buy fees and deducts sell fees: +1 gross is -9 net', () => {
    const txns = [fill(1, 'buy', 2, 100, 10), fill(2, 'sell', 1, 101, 5)];
    assert.equal(ledger.computeHoldings(txns).ABC.total_cost, 105);
    const pnl = ledger.computeRealizedPnl(txns);
    assert.equal(pnl.total, -9);
    assert.equal(pnl.gross_total, 1);
    assert.equal(pnl.net_total, -9);
    assert.equal(pnl.bySymbol.ABC, -9);
    assert.equal(ledger.computeLotsForSymbol(txns, 'ABC')[0].price_per_share, 105);
    assert.equal(buildSimulatorReview(txns, { ABC: 100 }).hit_rate_pct, 0);
});

test('valuation: missing price yields null total, explicit incompleteness, partial known sum', () => {
    const txns = [fill(1, 'buy', 2, 100), { ...fill(2, 'buy', 3, 50), symbol: 'XYZ' }];
    const v = ledger.valueHoldings(txns, { ABC: 100 });
    assert.equal(v.total_value, null);
    assert.equal(v.valuation_complete, false);
    assert.deepEqual(v.missing_symbols, ['XYZ']);
    assert.equal(v.known_positions_value, 200);
    assert.equal(v.valued_positions_value, 200);
    assert.deepEqual(v.position_values, { ABC: 200 });
    const complete = ledger.valueHoldings(txns, { ABC: 100, XYZ: 50 });
    assert.equal(complete.valuation_complete, true);
    assert.deepEqual(complete.missing_symbols, []);
    assert.equal(complete.total_value, 350);
    const acct = ledger.buildSimulatorAccount(txns, { ABC: 100 });
    assert.equal(acct.total_value, null);
    assert.equal(acct.valuation_complete, false);
    assert.equal(acct.marked_value, 200);
    const acctFull = ledger.buildSimulatorAccount(txns, { ABC: 100, XYZ: 60 });
    assert.equal(acctFull.total_value, 30); // holdings 380 + cash (-350 buys)
    assert.equal(acctFull.unrealized_pnl, 30);
    assert.equal(acctFull.total_return_pct, null); // no net capital
    const rev = buildSimulatorReview(txns, { ABC: 100 });
    assert.equal(rev.total_value, null);
    assert.equal(rev.valuation_complete, false);
    assert.equal(rev.marked_value, 200);
});

test('review never substitutes cost basis for missing prices', () => {
    const txns = [fill(1, 'buy', 2, 100)];
    const rev = buildSimulatorReview(txns, {});
    assert.equal(rev.total_value, null);
    assert.equal(rev.valuation_complete, false);
    assert.deepEqual(rev.missing_symbols, ['ABC']);
    assert.equal(rev.holdings_value, null);
    assert.equal(rev.total_return_pct, null);
    assert.equal(rev.unrealized_pnl, null);
    const pos = rev.positions[0];
    assert.equal(pos.market_value, null);
    assert.equal(pos.pnl, null);
    assert.equal(pos.price_used, null);
    assert.equal(pos.price_status, 'unavailable');
    const marked = buildSimulatorReview(txns, { ABC: 120 });
    assert.equal(marked.positions[0].price_status, 'live');
    assert.equal(marked.positions[0].price_used, 120);
});

test('incomplete review does not report unknown portfolio weights as zero', () => {
    const txns = [{ type: 'deposit', amount: 1000 }, fill(1, 'buy', 2, 100), fill(2, 'buy', 1, 50, 0, { symbol: 'XYZ' })];
    const review = buildSimulatorReview(txns, { ABC: 110 });
    assert.equal(review.cash_pct, null);
    assert.ok(review.positions.every(p => p.weight_pct === null));
});

test('negative and nonfinite marks are unavailable across valuation views', () => {
    const txns = [fill(1, 'buy', 2, 100)];
    for (const price of [-1, NaN, Infinity, null, '100']) {
        assert.equal(ledger.valueHoldings(txns, { ABC: price }).valuation_complete, false);
        assert.equal(ledger.buildSimulatorAccount(txns, { ABC: price }).positions[0].market_value, null);
        assert.equal(buildSimulatorReview(txns, { ABC: price }).positions[0].market_value, null);
    }
    assert.equal(ledger.valueHoldings(txns, { ABC: 0 }).total_value, 0);
});

test('review return is labelled capital-relative, no fake TWR', () => {
    const txns = [{ id: 1, type: 'deposit', amount: 1000, txn_date: '2026-01-01' }, fill(2, 'buy', 5, 100, 5)];
    const rev = buildSimulatorReview(txns, { ABC: 110 });
    assert.equal(rev.total_value, 1045); // cash 495 + holdings 550
    assert.equal(rev.total_return_pct, 4.5);
    assert.equal(rev.return_basis, 'net_capital');
    assert.equal(rev.twr_pct, null);
});

const PLAN = {
    id: 7, account_id: 1, symbol: 'ABC', setup: 'breakout', thesis: 'x',
    planned_entry: 50, stop_price: 45, target_price: 60, shares: 10,
    planned_risk: 50, planned_reward: 100, status: 'active', entry_transaction_id: 101,
};
const fx = (id, date, type, shares, price, fees = 0, extra = {}) => ({ id, account_id: 1, symbol: 'ABC', txn_date: date, type, shares, price, amount: shares * price, fees, ...extra });

test('journal lifecycle close nets all fills since entry: +50 cumulative, not just final leg', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50, 5), fx(102, '2026-01-05', 'sell', 4, 60, 3)];
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'target', fees: 2, thesis_valid: null }, txns);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.realized_pnl, 60); // 237 + 328 - 505
    assert.equal(closed.realized_pnl_gross, 70); // 240 + 330 - 500
    assert.equal(closed.total_fees, 10);
    assert.equal(closed.accounting_source, 'transaction_history');
    assert.equal(closed.exit_shares, 6);
    assert.equal(closed.realized_r, 1.2); // anchored to initial planned risk 50
    assert.deepEqual(closed.lifecycle.prior_sell_ids, [102]);
});

test('journal lifecycle ignores fills before entry_transaction_id and other symbols/accounts', () => {
    const txns = [
        fx(50, '2025-12-01', 'buy', 10, 50),
        { ...fx(51, '2025-12-02', 'buy', 5, 50), symbol: 'ZZZ' },
        { ...fx(52, '2025-12-02', 'buy', 5, 50), account_id: 2 },
        fx(101, '2026-01-01', 'buy', 10, 50),
    ];
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'target', thesis_valid: null }, txns);
    assert.equal(closed.realized_pnl, 50);
    assert.equal(closed.exit_shares, 10);
});

test('journal lifecycle recognizes DRIP dividend income', () => {
    const txns = [
        fx(101, '2026-01-01', 'buy', 10, 50),
        fx(102, '2026-01-03', 'dividend', 0, 0, 0, { amount: 10, reinvestment_mode: 'drip' }),
    ];
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'time_exit', thesis_valid: null }, txns);
    assert.equal(closed.realized_pnl, 60);
    assert.equal(closed.dividend_income_in_pnl, 10);
});

test('journal lifecycle does not double count a final sell already recorded', () => {
    const txns = [
        fx(101, '2026-01-01', 'buy', 10, 50, 5),
        fx(103, '2026-01-09', 'sell', 10, 55, 2),
    ];
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'target', exit_transaction_id: 103, thesis_valid: null }, txns);
    assert.equal(closed.realized_pnl, 43); // 548 - 505, single sell counted once
    assert.deepEqual(closed.lifecycle.final_sell_ids, [103]);
});

test('journal lifecycle ends at flat and excludes a later reopened position', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50, 5), fx(102, '2026-01-02', 'sell', 4, 60, 3),
        fx(103, '2026-01-03', 'sell', 6, 55, 2), fx(104, '2026-01-04', 'buy', 20, 100)];
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'target', exit_transaction_id: 103, thesis_valid: null }, txns);
    assert.equal(closed.realized_pnl, 60);
    assert.deepEqual(closed.lifecycle.buy_ids, [101]);
    assert.equal(journal.recomputeClosedTradeFromHistory(PLAN, { exit_transaction_id: 103 }, txns).realized_pnl, 60);
});

test('journal history repair never fabricates an unrecorded exit', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50), fx(102, '2026-01-02', 'sell', 4, 60)];
    assert.equal(journal.recomputeClosedTradeFromHistory(PLAN, { exit_price: 55 }, txns), null);
    assert.equal(journal.recomputeClosedTradeFromHistory(PLAN, { exit_price: 55, exit_transaction_id: 999 }, txns), null);
});

test('journal lifecycle refuses partial or excessive close sizes', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50), fx(102, '2026-01-02', 'sell', 4, 60)];
    for (const shares of [2, 7]) assert.throws(() => journal.closeStructuredTrade(PLAN,
        { exit_price: 55, shares, exit_reason: 'target', thesis_valid: null }, txns), /remaining shares/);
    assert.throws(() => journal.closeStructuredTrade(PLAN,
        { exit_price: 55, exit_transaction_id: 102, exit_reason: 'target', thesis_valid: null }, txns), /remaining shares/);
});

test('journal close keeps backward-compatible two-argument behavior', () => {
    const closed = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'target', fees: 2, thesis_valid: null });
    assert.equal(closed.realized_pnl, 48); // 550 - 500 - 2
    assert.equal(closed.accounting_source, 'plan_estimates');
    assert.equal(closed.realized_r, 0.96);
    assert.equal(closed.lifecycle, null);
});

test('journal repair helper recomputes from fills at read time and discloses insufficient evidence', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50, 5), fx(102, '2026-01-05', 'sell', 10, 60, 2)];
    const repaired = journal.recomputeClosedTradeFromHistory({ ...PLAN, status: 'closed' }, { exit_price: 60, exit_reason: 'target', thesis_valid: null }, txns);
    assert.equal(repaired.realized_pnl, 93);
    assert.equal(repaired.accounting_source, 'transaction_history');
    assert.equal(journal.recomputeClosedTradeFromHistory({ ...PLAN, status: 'closed', entry_transaction_id: null }, {}, txns), null);
    assert.equal(journal.recomputeClosedTradeFromHistory({ ...PLAN, status: 'closed' }, {}, []), null);
});

test('journal includes reinvested dividend income when DRIP buy basis is charged', () => {
    const txns = [fx(101, '2026-01-01', 'buy', 10, 50),
        fx(102, '2026-01-02', 'dividend', 0, 0, 0, { amount: 10, reinvestment_mode: 'drip' }),
        fx(103, '2026-01-02', 'buy', 0.2, 50), fx(104, '2026-01-03', 'sell', 10.2, 50)];
    const repaired = journal.recomputeClosedTradeFromHistory(PLAN, { exit_transaction_id: 104 }, txns);
    assert.equal(repaired.realized_pnl, 10);
    assert.equal(repaired.realized_pnl_gross, 10);
});

test('journal lifecycle cash and DRIP dividends count as realized income', () => {
    const cash = journal.closeStructuredTrade(PLAN, { exit_price: 55, exit_reason: 'time_exit', thesis_valid: null }, [
        fx(101, '2026-01-01', 'buy', 10, 50),
        fx(102, '2026-01-03', 'dividend', 0, 0, 0, { amount: 5 }),
        fx(103, '2026-01-04', 'dividend', 0, 0, 0, { amount: 10, reinvestment_mode: 'drip' }),
    ]);
    assert.equal(cash.realized_pnl, 65);
    assert.equal(cash.dividend_income_in_pnl, 15);
    assert.equal(cash.lifecycle.dividend_drip, 10);
});
