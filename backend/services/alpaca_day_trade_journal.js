const store = require('./alpaca_day_trade_store');
const { computeJournalAnalytics } = require('./trade_journal');

const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

function journalError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Independent of the execution_id/activity_id equivalence assumption alpaca_fill_reconciliation
// relies on to dedupe WebSocket vs. REST delivery of the same execution: if that assumption is
// ever wrong, or any other bug double-imports a fill, the effective filled quantity would
// exceed what was ever actually ordered. This is the same fail-closed shape as
// closePlan's confirmedFlatQty check — refuse to trust the numbers rather than silently
// producing a wrong P&L.
function assertNoOverfill(plan, summary) {
    if (summary.entry.qty > plan.planned_qty) {
        throw journalError('ALPACA_FILL_OVERFILL', `entry fills (${summary.entry.qty}) exceed the planned quantity (${plan.planned_qty}) for plan ${plan.id}`);
    }
    if (summary.exit.qty > summary.entry.qty) {
        throw journalError('ALPACA_FILL_OVERFILL', `exit fills (${summary.exit.qty}) exceed filled entry quantity (${summary.entry.qty}) for plan ${plan.id}`);
    }
}

function computeRealizedOutcome(plan, summary) {
    const realizedPnl = Math.round((summary.exit.qty * summary.exit.avgPrice - summary.entry.qty * summary.entry.avgPrice) * 100) / 100;
    const plannedRisk = Number(plan.planned_risk_dollars);
    const realizedR = Number.isFinite(plannedRisk) && plannedRisk > 0
        ? Math.round((realizedPnl / plannedRisk) * 100) / 100
        : null;
    return { realizedPnl, realizedR };
}

// time_exit/repair_exit/emergency_flatten orders don't exist yet (Task 11/13 build the code
// paths that create them) — any sell fill not matched to a recorded protective leg is presumed
// manual (e.g. an operator sold directly through Alpaca's own UI) until those exist.
function exitReasonForBrokerOrderId(plan, brokerOrderId) {
    if (brokerOrderId && brokerOrderId === plan.protective_stop_broker_order_id) return 'stop_loss';
    if (brokerOrderId && brokerOrderId === plan.protective_target_broker_order_id) return 'take_profit';
    return 'manual';
}

function latestExitFill(fills) {
    const supersededActivityIds = new Set(fills.filter((f) => f.correction_of).map((f) => f.correction_of));
    return fills
        .filter((f) => f.side === 'sell' && !f.is_bust && !supersededActivityIds.has(f.activity_id))
        .sort((a, b) => new Date(a.executed_at) - new Date(b.executed_at))
        .pop() || null;
}

// Section 8 "Exit event": close the local plan only after complete broker evidence — a fresh
// broker position check confirming exactly zero shares remain, not an inference from fill
// quantities summing to the planned amount (a partial-delivery gap or an out-of-band manual
// trade could make that inference wrong).
async function attemptCloseFromFills(plan, { client }) {
    if (TERMINAL_PLAN_STATES.includes(plan.state)) return null;

    const fills = await store.listFillsForPlan(plan.id);
    const summary = store.computeFilledSummary(fills);
    assertNoOverfill(plan, summary);
    if (summary.exit.qty === 0) return null;

    const position = await client.getPosition(plan.symbol);
    const remainingQty = position ? Number(position.qty) : 0;
    if (remainingQty !== 0) return null;

    const exitFill = latestExitFill(fills);
    const exitReason = exitReasonForBrokerOrderId(plan, exitFill?.broker_order_id);
    const { realizedPnl, realizedR } = computeRealizedOutcome(plan, summary);

    return store.updatePlan(plan.id, {
        state: 'closed',
        exit_reason: exitReason,
        realized_pnl: realizedPnl,
        realized_r: realizedR,
        filled_entry_qty: summary.entry.qty,
        avg_entry_price: summary.entry.avgPrice,
        filled_exit_qty: summary.exit.qty,
        avg_exit_price: summary.exit.avgPrice,
        closed_at: new Date().toISOString(),
    });
}

// computeJournalAnalytics (trade_journal.js) only ever reads row.status/realized_pnl/
// realized_r/setup — verified generic, no simulator-specific coupling — so Day Trading plans
// map onto it with a plain state->status rename rather than a bespoke reimplementation.
function computeDayTradeJournalAnalytics(plans) {
    return computeJournalAnalytics(plans.map((plan) => ({ ...plan, status: plan.state })));
}

// Extracted from alpaca_day_trade_execution.js's entry-time daily-loss-lockout computation so
// both callers share one definition, without changing what date the entry path passes it
// (its own UTC-slice-of-`now`, unchanged — see the matrix for why: switching it to
// alpaca_monitor_state.session_date would make it null on every call today, since nothing
// writes that column yet, and assertDailyLossLimitNotBreached's `|| 0` would silently read a
// null P&L as "no loss," fail-open on a Safety Invariant #8 check). The snapshot route is the
// only caller that passes session_date, and only when it is actually populated.
function computeDailyRealizedPnl(plans, sessionDate) {
    return plans
        .filter((plan) => plan.state === 'closed' && String(plan.closed_at || '').slice(0, 10) === sessionDate)
        .reduce((total, plan) => total + Number(plan.realized_pnl || 0), 0);
}

module.exports = {
    assertNoOverfill,
    computeRealizedOutcome,
    exitReasonForBrokerOrderId,
    attemptCloseFromFills,
    computeDayTradeJournalAnalytics,
    computeDailyRealizedPnl,
};
