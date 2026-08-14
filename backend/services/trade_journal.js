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

function closeStructuredTrade(plan, exit = {}) {
    if (!plan || plan.status !== 'active') throw validationError('an active trade plan is required');
    const exitPrice = finitePositive(exit.exit_price, 'exit_price');
    const fees = exit.fees == null ? 0 : Number(exit.fees);
    if (!Number.isFinite(fees) || fees < 0) throw validationError('fees must be a non-negative number');
    if (!EXIT_REASONS.includes(exit.exit_reason)) throw validationError('invalid exit_reason');
    if (exit.thesis_valid !== null && typeof exit.thesis_valid !== 'boolean') throw validationError('thesis_valid must be a boolean or null');

    const closedShares = exit.shares == null
        ? finitePositive(plan.shares, 'shares')
        : finitePositive(exit.shares, 'shares');
    const costBasis = exit.cost_basis == null
        ? finitePositive(plan.planned_entry, 'planned_entry') * closedShares
        : finitePositive(exit.cost_basis, 'cost_basis');
    const realizedPnl = exitPrice * closedShares - costBasis - fees;
    const plannedRisk = finitePositive(plan.planned_risk, 'planned_risk');
    return {
        ...plan,
        status: 'closed',
        exit_price: exitPrice,
        exit_shares: closedShares,
        exit_cost_basis: round(costBasis),
        exit_reason: exit.exit_reason,
        thesis_valid: exit.thesis_valid,
        realized_pnl: round(realizedPnl),
        realized_r: round(realizedPnl / plannedRisk),
        mfe: exit.mfe == null ? null : round(exit.mfe),
        mae: exit.mae == null ? null : round(exit.mae),
        review_notes: exit.review_notes == null ? null : String(exit.review_notes).trim() || null,
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
    normalizeTradePlan,
    closeStructuredTrade,
    computeJournalAnalytics,
};
