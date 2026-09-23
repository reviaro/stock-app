const db = require('../database/db');

function summarizeSide(fills) {
    const qty = fills.reduce((total, fill) => total + Number(fill.qty), 0);
    if (qty === 0) return { qty: 0, avgPrice: null };
    const notional = fills.reduce((total, fill) => total + Number(fill.qty) * Number(fill.price), 0);
    return { qty, avgPrice: notional / qty };
}

// A correction fill (correction_of set) replaces the original's contribution to the
// effective total; a busted fill contributes nothing regardless of correction linkage.
// Phase 1 is long-only (see plan Section 2), so side alone distinguishes entry (buy)
// from exit (sell) fills on the same plan — a stop/target exit is a separate side, not
// a second entry, and must never be summed into the same total as the entry fills.
function computeFilledSummary(fills = []) {
    const supersededActivityIds = new Set(
        fills.filter((fill) => fill.correction_of).map((fill) => fill.correction_of),
    );
    const effective = fills.filter((fill) => !fill.is_bust && !supersededActivityIds.has(fill.activity_id));

    return {
        entry: summarizeSide(effective.filter((fill) => fill.side === 'buy')),
        exit: summarizeSide(effective.filter((fill) => fill.side === 'sell')),
    };
}

async function createPlanWithEntry(plan, entryOrder, entryGate = null) {
    return db.createAlpacaDayTradePlanWithEntry(plan, entryOrder, entryGate);
}

function getPlan(id) {
    return db.getAlpacaDayTradePlan(id);
}

function getActivePlanForSymbol(symbol) {
    return db.getActiveAlpacaDayTradePlanForSymbol(symbol);
}

function listPlans(state = null) {
    return db.listAlpacaDayTradePlans(state);
}

function updatePlan(id, patch) {
    return db.updateAlpacaDayTradePlan(id, patch);
}

const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

async function closePlan(id, { confirmedFlatQty, exit_reason, realized_pnl = null, realized_r = null, closed_at = null } = {}) {
    if (confirmedFlatQty !== 0) {
        throw new Error('cannot close a Day Trading plan without a confirmed zero broker position');
    }
    const existing = await db.getAlpacaDayTradePlan(id);
    if (!existing) throw new Error('Alpaca Day Trading plan not found');
    if (TERMINAL_PLAN_STATES.includes(existing.state)) {
        throw new Error(`Alpaca Day Trading plan ${id} is already in a terminal state (${existing.state})`);
    }
    return db.updateAlpacaDayTradePlan(id, {
        state: 'closed',
        exit_reason,
        realized_pnl,
        realized_r,
        closed_at: closed_at || new Date().toISOString(),
    });
}

function recordFill(fill) {
    return db.createAlpacaPaperFill(fill);
}

function listFillsForPlan(planId) {
    return db.listAlpacaPaperFillsForPlan(planId);
}

function appendEvent(event) {
    return db.appendAlpacaDayTradeEvent(event);
}

function listEvents(planId = null) {
    return db.listAlpacaDayTradeEvents(planId);
}

function getEventByKey(eventKey) {
    return db.getAlpacaDayTradeEventByKey(eventKey);
}

function reviewPlan(planId, review) {
    return db.reviewAlpacaDayTradePlan(planId, review);
}

async function computeFilledSummaryForPlan(planId) {
    const fills = await db.listAlpacaPaperFillsForPlan(planId);
    return computeFilledSummary(fills);
}

function getMonitorState() {
    return db.getAlpacaMonitorState();
}

function updateMonitorState(patch) {
    return db.updateAlpacaMonitorState(patch);
}

function acquireSubmissionLease({ holderId, leaseDurationMs, now }) {
    return db.acquireAlpacaMonitorSubmissionLease({ holderId, leaseDurationMs, now });
}

function renewSubmissionLease({ holderId, leaseDurationMs, now }) {
    return db.renewAlpacaMonitorSubmissionLease({ holderId, leaseDurationMs, now });
}

function releaseSubmissionLease({ holderId }) {
    return db.releaseAlpacaMonitorSubmissionLease({ holderId });
}

function createOrderAudit(order) {
    return db.createAlpacaPaperOrderAudit(order);
}

function getOrderAuditByIdempotencyKey(idempotencyKey) {
    return db.getAlpacaPaperOrderAuditByIdempotencyKey(idempotencyKey);
}

function updateOrderAudit(idempotencyKey, patch) {
    return db.updateAlpacaPaperOrderAudit(idempotencyKey, patch);
}

function listOrderAudits() {
    return db.listAlpacaPaperOrderAudits();
}

function deriveFillSummaryPatch(plan, fills = []) {
    const summary = computeFilledSummary(fills);

    // Overfill fail-closed: identical in meaning to assertNoOverfill without circular dependency
    if (summary.entry.qty > plan.planned_qty || summary.exit.qty > summary.entry.qty) {
        const error = new Error(`Alpaca fill overfill detected for plan ${plan.id}`);
        error.code = 'ALPACA_FILL_OVERFILL';
        throw error;
    }

    // Derived state, long-only, in exact priority
    let state = plan.state;
    if (summary.exit.qty > 0) {
        state = 'exit_pending';
    } else if (summary.entry.qty === 0) {
        state = plan.state;
    } else if (summary.entry.qty < plan.planned_qty) {
        state = 'partially_entered';
    } else if (summary.entry.qty === plan.planned_qty) {
        state = 'active';
    }

    const supersededActivityIds = new Set(
        fills.filter((fill) => fill.correction_of).map((fill) => fill.correction_of),
    );
    const effective = fills.filter((fill) => !fill.is_bust && !supersededActivityIds.has(fill.activity_id));
    const effectiveBuyFills = effective.filter((fill) => fill.side === 'buy');

    // opened_at candidate = executed_at of the EARLIEST effective buy fill, or null if none
    const earliestEffectiveBuy = effectiveBuyFills.reduce((earliest, fill) => {
        if (!earliest) return fill;
        if (fill.executed_at < earliest.executed_at) return fill;
        if (fill.executed_at === earliest.executed_at && String(fill.activity_id) < String(earliest.activity_id)) return fill;
        return earliest;
    }, null);
    const openedAtCandidate = earliestEffectiveBuy ? earliestEffectiveBuy.executed_at : null;

    // Return null if state, filled_entry_qty, avg_entry_price, filled_exit_qty, avg_exit_price
    // all equal the plan row's current values AND (plan.opened_at is set OR the opened_at candidate is null).
    const planOpenedAtSet = plan.opened_at != null && plan.opened_at !== '';
    const isUnchanged = (
        state === plan.state
        && plan.filled_entry_qty === summary.entry.qty
        && plan.avg_entry_price === summary.entry.avgPrice
        && plan.filled_exit_qty === summary.exit.qty
        && plan.avg_exit_price === summary.exit.avgPrice
        && (planOpenedAtSet || openedAtCandidate === null)
    );
    if (isUnchanged) return null;

    const patch = {
        state,
        filled_entry_qty: summary.entry.qty,
        avg_entry_price: summary.entry.avgPrice,
        filled_exit_qty: summary.exit.qty,
        avg_exit_price: summary.exit.avgPrice,
        opened_at: openedAtCandidate,
    };

    let event = null;
    if (state !== plan.state) {
        const latestEffectiveFill = effective.reduce((latest, fill) => {
            if (!latest) return fill;
            if (fill.executed_at > latest.executed_at) return fill;
            if (fill.executed_at === latest.executed_at && String(fill.activity_id) > String(latest.activity_id)) return fill;
            return latest;
        }, null);

        event = {
            event_key: `plan_state:${plan.id}:${plan.state}->${state}:${latestEffectiveFill.activity_id}`,
            plan_id: plan.id,
            event_type: 'plan_state',
            action: 'sync_from_fills',
            outcome: state,
            reason: 'fill_summary_sync',
            detail: {
                symbol: plan.symbol,
                from: plan.state,
                to: state,
                filled_entry_qty: summary.entry.qty,
                avg_entry_price: summary.entry.avgPrice,
                filled_exit_qty: summary.exit.qty,
                avg_exit_price: summary.exit.avgPrice,
            },
            occurred_at: latestEffectiveFill.executed_at,
        };
    }

    return { patch, event };
}

async function syncPlanFillSummary(planId) {
    return db.syncAlpacaDayTradePlanFillSummary(planId, (plan, fills) => deriveFillSummaryPatch(plan, fills));
}

module.exports = {
    computeFilledSummary,
    deriveFillSummaryPatch,
    syncPlanFillSummary,
    createPlanWithEntry,
    getPlan,
    getActivePlanForSymbol,
    listPlans,
    updatePlan,
    closePlan,
    recordFill,
    listFillsForPlan,
    appendEvent,
    listEvents,
    getEventByKey,
    reviewPlan,
    computeFilledSummaryForPlan,
    getMonitorState,
    updateMonitorState,
    acquireSubmissionLease,
    renewSubmissionLease,
    releaseSubmissionLease,
    createOrderAudit,
    getOrderAuditByIdempotencyKey,
    updateOrderAudit,
    listOrderAudits,
};
