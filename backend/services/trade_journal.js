const EXIT_REASONS = ['stop', 'target', 'time_exit', 'thesis_break', 'discretionary'];

function validationError(message) {
    const error = new Error(message);
    error.status = 400;
    return error;
}

function round(value) {
    return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function finitePositive(value, field) {
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) {
        throw validationError(`${field} must be a positive number`);
    }
    return number;
}

function requiredText(value, field) {
    const text = String(value || '').trim();
    if (!text) throw validationError(`${field} is required`);
    return text;
}

function normalizeTradePlan(input = {}) {
    const accountId = Number(input.account_id);
    if (!Number.isInteger(accountId) || accountId <= 0) throw validationError('account_id must be a positive integer');

    const plannedEntry = finitePositive(input.planned_entry, 'planned_entry');
    const stopPrice = finitePositive(input.stop_price, 'stop_price');
    const targetPrice = finitePositive(input.target_price, 'target_price');
    const shares = finitePositive(input.shares, 'shares');
    if (stopPrice >= plannedEntry) throw validationError('stop_price must be below planned_entry for a long trade');
    if (targetPrice <= plannedEntry) throw validationError('target_price must be above planned_entry for a long trade');

    const plannedRisk = (plannedEntry - stopPrice) * shares;
    const plannedReward = (targetPrice - plannedEntry) * shares;
    return {
        account_id: accountId,
        symbol: requiredText(input.symbol, 'symbol').toUpperCase(),
        setup: requiredText(input.setup, 'setup'),
        catalyst: input.catalyst == null ? null : String(input.catalyst).trim() || null,
        thesis: requiredText(input.thesis, 'thesis'),
        planned_entry: plannedEntry,
        stop_price: stopPrice,
        target_price: targetPrice,
        shares,
        invalidation: input.invalidation == null ? null : String(input.invalidation).trim() || null,
        planned_risk: round(plannedRisk),
        planned_reward: round(plannedReward),
        reward_risk_ratio: round(plannedReward / plannedRisk),
        status: 'active',
    };
}

function byDateThenId(a, b) {
    if (String(a.txn_date || '') < String(b.txn_date || '')) return -1;
    if (String(a.txn_date || '') > String(b.txn_date || '')) return 1;
    return (a.id ?? 0) - (b.id ?? 0);
}

function txnFees(txn) {
    const fees = Number((txn && txn.fees) ?? 0);
    return Number.isFinite(fees) && fees > 0 ? fees : 0;
}

/**
 * Scope a trade's lifecycle from its transaction history: every fill for this
 * account+symbol at or after the plan's entry_transaction_id, ordered.
 * All dividends are income. DRIP buys carry their own basis, so excluding
 * the dividend would incorrectly charge that reinvested basis twice.
 */
function scopeTradeLifecycle(plan, transactions) {
    if (!Array.isArray(transactions) || !plan || plan.entry_transaction_id == null) return null;
    const entryId = Number(plan.entry_transaction_id);
    const scoped = transactions
        .filter((t) => t && t.symbol && String(t.symbol).toUpperCase() === String(plan.symbol || '').toUpperCase())
        .filter((t) => plan.account_id == null || Number(t.account_id) === Number(plan.account_id))
        .sort(byDateThenId);
    const entryIndex = scoped.findIndex((t) => Number(t.id) === entryId);
    if (entryIndex === -1 || scoped[entryIndex].type !== 'buy') return null;
    const lifecycle = [];
    let remaining = 0;
    for (const txn of scoped.slice(entryIndex)) {
        lifecycle.push(txn);
        if (txn.type === 'buy') remaining += Number(txn.shares || 0);
        if (txn.type === 'sell') {
            remaining -= Number(txn.shares || 0);
            if (remaining <= 0.000001) break;
        }
    }
    return lifecycle;
}

function summarizeLifecycle(scoped, exit) {
    let boughtShares = 0;
    let grossCost = 0;
    let netCost = 0;
    let soldShares = 0;
    let grossProceeds = 0;
    let netProceeds = 0;
    const buyIds = [];
    const priorSellIds = [];
    const finalSellIds = [];
    let dividendIncome = 0;
    let dividendDrip = 0;
    let finalSellAlreadyRecorded = false;

    const proposed = {
        shares: exit.exit_transaction_id == null ? Number(exit.exit_shares ?? exit.shares ?? 0) : 0,
        price: Number(exit.exit_price || 0),
        fees: txnFees(exit),
        id: exit.exit_transaction_id ?? null,
    };

    for (const txn of scoped) {
        const fees = txnFees(txn);
        if (txn.type === 'buy') {
            buyIds.push(txn.id);
            boughtShares += Number(txn.shares || 0);
            grossCost += Number(txn.amount ?? Number(txn.price) * Number(txn.shares));
            netCost += Number(txn.amount ?? Number(txn.price) * Number(txn.shares)) + fees;
        } else if (txn.type === 'sell') {
            soldShares += Number(txn.shares || 0);
            grossProceeds += Number(txn.amount ?? Number(txn.price) * Number(txn.shares));
            netProceeds += Number(txn.amount ?? Number(txn.price) * Number(txn.shares)) - fees;
            (exit.exit_transaction_id != null && Number(txn.id) === Number(exit.exit_transaction_id) ? finalSellIds : priorSellIds).push(txn.id);
        } else if (txn.type === 'dividend') {
            if (txn.reinvestment_mode === 'drip') dividendDrip += Number(txn.amount || 0);
            dividendIncome += Number(txn.amount || 0);
        }
    }

    if (exit.exit_transaction_id != null) {
        const recorded = scoped.find((t) => t.type === 'sell' && Number(t.id) === Number(exit.exit_transaction_id));
        if (recorded) {
            // The recorded final sell is already inside the fill loop; expose it
            // without counting its proceeds twice.
            proposed.shares = Number(recorded.shares || 0);
            proposed.price = Number(recorded.price || 0);
            proposed.fees = txnFees(recorded);
            proposed.id = recorded.id;
            finalSellAlreadyRecorded = true;
        } else {
            proposed.shares = Math.max(0, boughtShares - soldShares);
            proposed.fees = txnFees(exit);
            proposed.price = Number(exit.exit_price || 0);
        }
    } else if (proposed.shares <= 0) {
        proposed.shares = Math.max(0, boughtShares - soldShares);
        proposed.fees = txnFees(exit);
        proposed.price = Number(exit.exit_price || 0);
    }

    const finalGrossProceeds = finalSellAlreadyRecorded ? 0 : proposed.shares * proposed.price;
    const proposedFees = finalSellAlreadyRecorded ? 0 : txnFees(exit);
    if (!Number.isFinite(proposed.shares) || Math.abs(boughtShares - soldShares - (finalSellAlreadyRecorded ? 0 : proposed.shares)) > 0.000001) {
        throw validationError('exit must close exactly the remaining shares');
    }

    return {
        buy_ids: buyIds,
        prior_sell_ids: priorSellIds,
        final_sell_ids: finalSellIds,
        bought_shares: round(boughtShares),
        sold_shares_before_exit: round(soldShares),
        exit_shares: round(proposed.shares),
        gross_cost: round(grossCost),
        net_cost: round(netCost),
        gross_realized: round(grossProceeds + finalGrossProceeds),
        net_realized: round(netProceeds + finalGrossProceeds - proposedFees),
        final_sell_already_recorded: finalSellAlreadyRecorded,
        dividend_income_in_pnl: round(dividendIncome),
        dividend_drip: round(dividendDrip),
    };
}

function closeStructuredTrade(plan, exit = {}, transactions) {
    if (!plan || plan.status !== 'active') throw validationError('an active trade plan is required');
    const exitPrice = finitePositive(exit.exit_price, 'exit_price');
    const fees = exit.fees == null ? 0 : Number(exit.fees);
    if (!Number.isFinite(fees) || fees < 0) throw validationError('fees must be a non-negative number');
    if (!EXIT_REASONS.includes(exit.exit_reason)) throw validationError('invalid exit_reason');
    if (exit.thesis_valid !== null && typeof exit.thesis_valid !== 'boolean') throw validationError('thesis_valid must be a boolean or null');

    const scoped = scopeTradeLifecycle(plan, transactions);
    const plannedRisk = finitePositive(plan.planned_risk, 'planned_risk');

    if (!scoped) {
        // Backward-compatible two-argument path: no fill history supplied (or
        // the entry fill is unknown), so P&L falls back to plan estimates.
        const closedShares = exit.shares == null
            ? finitePositive(plan.shares, 'shares')
            : finitePositive(exit.shares, 'shares');
        const costBasis = exit.cost_basis == null
            ? finitePositive(plan.planned_entry, 'planned_entry') * closedShares
            : finitePositive(exit.cost_basis, 'cost_basis');
        const realizedPnl = exitPrice * closedShares - costBasis - fees;
        return {
            ...plan,
            status: 'closed',
            exit_price: exitPrice,
            exit_shares: closedShares,
            exit_cost_basis: round(costBasis),
            exit_reason: exit.exit_reason,
            thesis_valid: exit.thesis_valid,
            realized_pnl: round(realizedPnl),
            realized_pnl_gross: round(realizedPnl + fees),
            total_fees: round(fees),
            realized_r: round(realizedPnl / plannedRisk),
            accounting_source: 'plan_estimates',
            lifecycle: null,
            mfe: exit.mfe == null ? null : round(exit.mfe),
            mae: exit.mae == null ? null : round(exit.mae),
            review_notes: exit.review_notes == null ? null : String(exit.review_notes).trim() || null,
        };
    }

    const summary = summarizeLifecycle(scoped, exit);
    const realizedPnl = summary.net_realized - summary.net_cost + summary.dividend_income_in_pnl;
    return {
        ...plan,
        status: 'closed',
        exit_price: exitPrice,
        exit_shares: summary.exit_shares,
        exit_cost_basis: summary.net_cost,
        exit_reason: exit.exit_reason,
        thesis_valid: exit.thesis_valid,
        realized_pnl: round(realizedPnl),
        realized_pnl_gross: round(summary.gross_realized - summary.gross_cost + summary.dividend_income_in_pnl),
        total_fees: round(summary.net_cost - summary.gross_cost + (summary.gross_realized - summary.net_realized)),
        realized_r: round(realizedPnl / plannedRisk),
        accounting_source: 'transaction_history',
        lifecycle: {
            buy_ids: summary.buy_ids,
            prior_sell_ids: summary.prior_sell_ids,
            final_sell_ids: summary.final_sell_ids,
            bought_shares: summary.bought_shares,
            sold_shares_before_exit: summary.sold_shares_before_exit,
            dividend_income_in_pnl: summary.dividend_income_in_pnl,
            dividend_drip: summary.dividend_drip,
        },
        dividend_income_in_pnl: summary.dividend_income_in_pnl,
        mfe: exit.mfe == null ? null : round(exit.mfe),
        mae: exit.mae == null ? null : round(exit.mae),
        review_notes: exit.review_notes == null ? null : String(exit.review_notes).trim() || null,
    };
}

/**
 * Read-time repair for a legacy closed journal row: recompute realized P&L
 * from actual fills when the evidence exists. Returns null (caller should keep
 * the stored value and disclose insufficient history) when the entry fill or
 * any fill history is missing. Never mutates stored rows.
 */
function recomputeClosedTradeFromHistory(planLike, exit = {}, transactions) {
    if (!planLike || !Array.isArray(transactions) || planLike.entry_transaction_id == null) return null;
    const scoped = scopeTradeLifecycle({ ...planLike, status: 'active' }, transactions);
    if (!scoped) return null;
    // A repair may use recorded evidence only, never a hypothetical sale.
    const finalSell = scoped[scoped.length - 1];
    const remaining = scoped.reduce((sum, t) => sum + (t.type === 'buy' ? Number(t.shares) : t.type === 'sell' ? -Number(t.shares) : 0), 0);
    if (finalSell.type !== 'sell' || Math.abs(remaining) > 0.000001) return null;
    if (exit.exit_transaction_id != null && Number(exit.exit_transaction_id) !== Number(finalSell.id)) return null;
    const summary = summarizeLifecycle(scoped, { ...exit, exit_transaction_id: finalSell.id });
    if (summary.bought_shares <= 0 || (summary.sold_shares_before_exit <= 0 && summary.exit_shares <= 0)) {
        // No exit fill identified and no remaining shares to propose: history
        // cannot produce a complete lifecycle, so evidence is insufficient.
        return null;
    }
    const realizedPnl = summary.net_realized - summary.net_cost + summary.dividend_income_in_pnl;
    const plannedRisk = Number(planLike.planned_risk);
    return {
        realized_pnl: round(realizedPnl),
        realized_pnl_gross: round(summary.gross_realized - summary.gross_cost + summary.dividend_income_in_pnl),
        total_fees: round(summary.net_cost - summary.gross_cost + (summary.gross_realized - summary.net_realized)),
        realized_r: Number.isFinite(plannedRisk) && plannedRisk > 0 ? round(realizedPnl / plannedRisk) : null,
        accounting_source: 'transaction_history',
        lifecycle: {
            buy_ids: summary.buy_ids,
            prior_sell_ids: summary.prior_sell_ids,
            final_sell_ids: summary.final_sell_ids,
            bought_shares: summary.bought_shares,
            sold_shares_before_exit: summary.sold_shares_before_exit,
            dividend_income_in_pnl: summary.dividend_income_in_pnl,
            dividend_drip: summary.dividend_drip,
        },
        dividend_income_in_pnl: summary.dividend_income_in_pnl,
    };
}

function summarize(rows) {
    const trades = rows.filter((row) => row.status === 'closed' && Number.isFinite(Number(row.realized_pnl)));
    const wins = trades.filter((row) => Number(row.realized_pnl) > 0);
    const grossProfit = wins.reduce((sum, row) => sum + Number(row.realized_pnl), 0);
    const grossLoss = Math.abs(trades.filter((row) => Number(row.realized_pnl) < 0).reduce((sum, row) => sum + Number(row.realized_pnl), 0));
    const totalPnl = trades.reduce((sum, row) => sum + Number(row.realized_pnl), 0);
    const rTrades = trades.filter((row) => Number.isFinite(Number(row.realized_r)));
    return {
        trade_count: trades.length,
        win_rate_pct: trades.length ? round((wins.length / trades.length) * 100) : null,
        expectancy: trades.length ? round(totalPnl / trades.length) : null,
        average_r: rTrades.length ? round(rTrades.reduce((sum, row) => sum + Number(row.realized_r), 0) / rTrades.length) : null,
        total_pnl: round(totalPnl),
        gross_profit: round(grossProfit),
        gross_loss: round(grossLoss),
        profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss) : grossProfit > 0 ? null : 0,
    };
}

function computeJournalAnalytics(rows = []) {
    const closed = rows.filter((row) => row.status === 'closed');
    const overall = summarize(closed);
    const bySetup = {};
    for (const setup of [...new Set(closed.map((row) => String(row.setup || 'Unclassified')))]) {
        const stats = summarize(closed.filter((row) => String(row.setup || 'Unclassified') === setup));
        bySetup[setup] = {
            trade_count: stats.trade_count,
            win_rate_pct: stats.win_rate_pct,
            expectancy: stats.expectancy,
            average_r: stats.average_r,
            total_pnl: stats.total_pnl,
        };
    }
    return {
        closed_trade_count: overall.trade_count,
        win_rate_pct: overall.win_rate_pct,
        expectancy: overall.expectancy,
        profit_factor: overall.profit_factor,
        average_r: overall.average_r,
        total_pnl: overall.total_pnl,
        by_setup: bySetup,
    };
}

module.exports = {
    EXIT_REASONS,
    recomputeClosedTradeFromHistory,
    normalizeTradePlan,
    closeStructuredTrade,
    computeJournalAnalytics,
};
