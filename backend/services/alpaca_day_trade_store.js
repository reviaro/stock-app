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

async function createPlanWithEntry(plan, entryOrder) {
    return db.createAlpacaDayTradePlanWithEntry(plan, entryOrder);
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

module.exports = {
    computeFilledSummary,
    createPlanWithEntry,
    getPlan,
    getActivePlanForSymbol,
    listPlans,
    updatePlan,
    closePlan,
    recordFill,
    listFillsForPlan,
    computeFilledSummaryForPlan,
    getMonitorState,
    updateMonitorState,
    acquireSubmissionLease,
    releaseSubmissionLease,
    createOrderAudit,
    getOrderAuditByIdempotencyKey,
    updateOrderAudit,
    listOrderAudits,
};
