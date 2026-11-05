'use strict';

// Historical v2 submission recovery. New entries are permanently retired.

// The monitor heartbeats every 60s with exposure and every 300s while flat -- and flat is
// exactly when entries happen -- so freshness must comfortably exceed the idle cadence.
const ENTRY_HEARTBEAT_MAX_AGE_MS = 10 * 60_000;

const WORKING_PARENT = ['new', 'accepted', 'pending_new', 'accepted_for_bidding', 'partially_filled', 'held', 'calculated', 'pending_replace', 'replaced', 'done_for_day'];

function executionError(code, message) {
    return Object.assign(new Error(message), { code });
}

// Only a definite broker refusal counts as rejected. Timeouts, disconnects, 5xx, 408 and 429
// leave the outcome unknown.
function isDefiniteRejection(error) {
    const status = Number(error?.status);
    return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}

// Broker ids from a (nested) parent order. `legs: null` means "not yet discoverable", never
// "no protection"; the monitor treats a persistently missing leg as an anomaly.
function linkPatchFromBrokerOrder(order) {
    const patch = { parent_order_id: String(order.id) };
    for (const leg of Array.isArray(order.legs) ? order.legs : []) {
        const type = leg.type || leg.order_type;
        if (type === 'stop') patch.stop_order_id = String(leg.id);
        else if (type === 'limit') patch.target_order_id = String(leg.id);
    }
    return patch;
}

// Plan state implied by the parent entry order alone (fills refine it later).
function stateFromParent(order) {
    const filledQty = Number(order.filled_qty || 0);
    if (order.status === 'filled') return 'active';
    if (order.status === 'rejected' && filledQty === 0) return 'rejected';
    if (['canceled', 'expired'].includes(order.status) && filledQty === 0) return 'cancelled';
    if (WORKING_PARENT.includes(order.status)) return 'working';
    return null; // anything else is not a shape v2 understands
}

async function resolvePlanByClientOrderId({ store, client, plan, now = () => new Date() }) {
    const occurredAt = now().toISOString();
    const { activePlanIds } = await store.recoverEntrySubmissions({ occurredAt });
    if (activePlanIds.includes(plan.id)) return 'in_flight';
    // Recovery may have latched an interrupted sender since this plan was read.
    plan = await store.getPlan(plan.id);
    // An already-latched plan keeps its original attention code: a still-missing order is the
    // same unresolved incident, not a new one.
    const latched = plan.state === 'attention_required';
    let lookup;
    try {
        lookup = await client.getOrderByClientOrderId(plan.client_order_id);
    } catch (_error) {
        if (!latched) await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_LOOKUP_FAILED', eventKey: `plan:${plan.id}:attention:SUBMISSION_LOOKUP_FAILED`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    if (!lookup?.found || !lookup.order?.id) {
        // Never assume rejected: an order that cannot be found now may still surface later.
        if (!latched) await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_NOT_FOUND', eventKey: `plan:${plan.id}:attention:SUBMISSION_NOT_FOUND`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    const order = lookup.order;
    const nextState = stateFromParent(order);
    if (String(order.symbol || '').toUpperCase() !== plan.symbol || order.side !== 'buy' || !nextState) {
        if (!latched) await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_MISMATCH', eventKey: `plan:${plan.id}:attention:SUBMISSION_MISMATCH`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    // Linking is evidence, not a repair: a latched plan stays latched for the operator.
    await store.transaction(async (repo) => {
        const current = await repo.getPlan(plan.id);
        const mayAdvance = ['pending_submission', 'submission_unknown'].includes(current.state);
        await repo.updatePlan(plan.id, { ...linkPatchFromBrokerOrder(order), ...(mayAdvance ? { state: nextState } : {}) }, {
            events: [{
                event_key: `plan:${plan.id}:linked_by_client_id`, event_type: 'submission', action: 'linked_by_client_id',
                outcome: mayAdvance ? nextState : current.state, detail: { symbol: plan.symbol, broker_status: order.status }, occurred_at: occurredAt,
            }],
        });
    });
    return 'linked';
}

// Kept as an explicit refusal for older in-process integrations. Historical
// reconciliation above is still supported, but no caller can reactivate entries.
function createV2Execution() {
    const retired = async () => { throw executionError('ALPACA_DAY_TRADING_RETIRED', 'Alpaca paper day trading is retired; use long-term paper investing.'); };
    return { submitEntry: retired, previewEntry: retired };
}

module.exports = {
    ENTRY_HEARTBEAT_MAX_AGE_MS,
    createV2Execution,
    resolvePlanByClientOrderId,
    linkPatchFromBrokerOrder,
    stateFromParent,
    isDefiniteRejection,
};
