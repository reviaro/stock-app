'use strict';

// The one v2 entry path: write the plan (with its deterministic client_order_id) before the
// broker POST, submit exactly one bracket, and fail closed on any uncertainty. It never POSTs a
// second entry for a client id: an unresolved plan is only ever resolved by looking the client
// id up at the broker.
const { buildV2EntryOrder, DEFAULT_V2_POLICY } = require('./alpaca_day_trade_v2_policy');

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
    let lookup;
    try {
        lookup = await client.getOrderByClientOrderId(plan.client_order_id);
    } catch (_error) {
        await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_LOOKUP_FAILED', eventKey: `plan:${plan.id}:attention:SUBMISSION_LOOKUP_FAILED`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    if (!lookup?.found || !lookup.order?.id) {
        // Never assume rejected: an order that cannot be found now may still surface later.
        await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_NOT_FOUND', eventKey: `plan:${plan.id}:attention:SUBMISSION_NOT_FOUND`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    const order = lookup.order;
    const nextState = stateFromParent(order);
    if (String(order.symbol || '').toUpperCase() !== plan.symbol || order.side !== 'buy' || !nextState) {
        await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_MISMATCH', eventKey: `plan:${plan.id}:attention:SUBMISSION_MISMATCH`, detail: { symbol: plan.symbol }, occurredAt });
        return 'unresolved';
    }
    // Linking is evidence, not a repair: a latched plan stays latched for the operator.
    const latched = plan.state === 'attention_required';
    await store.updatePlan(plan.id, { ...linkPatchFromBrokerOrder(order), ...(latched ? {} : { state: nextState }) }, {
        events: [{
            event_key: `plan:${plan.id}:linked_by_client_id`, event_type: 'submission', action: 'linked_by_client_id',
            outcome: latched ? 'attention_required' : nextState, detail: { symbol: plan.symbol, broker_status: order.status }, occurred_at: occurredAt,
        }],
    });
    return 'linked';
}

function sameIntent(plan, built) {
    return plan.symbol === built.symbol && plan.planned_qty === built.qty
        && plan.planned_stop === built.stop && plan.planned_target === built.target;
}

function createV2Execution({ store, client, policy = DEFAULT_V2_POLICY, now = () => new Date() }) {
    // One in-process queue: only this service submits v2 entries.
    let queue = Promise.resolve();

    async function assertEntryGates() {
        const state = await store.getMonitorState();
        if (state?.kill_switch) throw executionError('ALPACA_V2_KILL_SWITCH_ACTIVE', 'the kill switch is active');
        if (state?.mode !== 'paper_execute') throw executionError('ALPACA_V2_EXECUTION_DISABLED', 'v2 execution is not in paper_execute mode');
        if (state?.attention_required) throw executionError('ALPACA_V2_ATTENTION_REQUIRED', 'an attention latch blocks new entries');
        const heartbeat = state?.last_reconciled_at ? new Date(state.last_reconciled_at).getTime() : NaN;
        if (!(now().getTime() - heartbeat <= ENTRY_HEARTBEAT_MAX_AGE_MS)) {
            throw executionError('ALPACA_V2_MONITOR_STALE', 'the v2 monitor has not reconciled recently');
        }
    }

    async function replay(existing, intent) {
        const requested = { symbol: String(intent?.symbol || '').trim().toUpperCase(), qty: intent?.qty, stop: intent?.stop, target: intent?.target };
        if (!sameIntent(existing, requested)) {
            throw executionError('ALPACA_V2_IDEMPOTENCY_CONFLICT', 'this client order id was already used for a different entry');
        }
        if (existing.parent_order_id || ['rejected', 'cancelled', 'closed'].includes(existing.state)) {
            return { outcome: 'replayed', plan: existing };
        }
        const outcome = await resolvePlanByClientOrderId({ store, client, plan: existing, now });
        return { outcome, plan: await store.getPlan(existing.id) };
    }

    async function readBrokerFacts(symbol) {
        try {
            const [account, clock, asset, quote, openOrders] = await Promise.all([
                client.getAccount(), client.getClock(), client.getAsset(symbol),
                client.getLatestQuote(symbol, { feed: policy.feed }), client.getOrders({ status: 'open' }),
            ]);
            return { account, clock, asset, quote, openOrders: Array.isArray(openOrders) ? openOrders : [] };
        } catch (_error) {
            throw executionError('ALPACA_V2_BROKER_UNAVAILABLE', 'broker account state could not be read');
        }
    }

    async function submitEntryUnqueued(intent) {
        const clientOrderId = typeof intent?.client_order_id === 'string' ? intent.client_order_id : '';
        const existing = clientOrderId ? await store.getPlanByClientOrderId(clientOrderId) : null;
        if (existing) return replay(existing, intent);

        await assertEntryGates();
        const symbol = typeof intent?.symbol === 'string' ? intent.symbol.trim().toUpperCase() : '';
        const facts = await readBrokerFacts(symbol);
        const openPlans = await store.listNonterminalPlans();
        const built = buildV2EntryOrder({
            intent, ...facts, policy, now: now(),
            context: {
                hasActivePlanForSymbol: openPlans.some((plan) => plan.symbol === symbol),
                currentOpenRiskDollars: openPlans.reduce((sum, plan) => sum + Number(plan.planned_risk_dollars || 0), 0),
            },
        });

        const { plan } = await store.createPlan({ ...built.plan, occurred_at: now().toISOString() });
        let ack;
        try {
            ack = await client.submitOrder(built.order);
        } catch (error) {
            const occurredAt = now().toISOString();
            if (isDefiniteRejection(error)) {
                const rejected = await store.updatePlan(plan.id, { state: 'rejected' }, {
                    events: [{
                        event_key: `plan:${plan.id}:submission_rejected`, event_type: 'submission', action: 'submission_rejected', outcome: 'rejected',
                        reason_code: 'BROKER_REJECTED', detail: { symbol: plan.symbol, broker_status: String(error.status) }, occurred_at: occurredAt,
                    }],
                });
                return { outcome: 'rejected', plan: rejected };
            }
            await store.updatePlan(plan.id, { state: 'submission_unknown' });
            await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN`, detail: { symbol: plan.symbol }, occurredAt });
            return { outcome: 'submission_unknown', plan: await store.getPlan(plan.id) };
        }

        if (!ack?.id) {
            // An "ok" response without an order id is not an acknowledgement we can trust.
            await store.updatePlan(plan.id, { state: 'submission_unknown' });
            await store.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN`, detail: { symbol: plan.symbol }, occurredAt: now().toISOString() });
            return { outcome: 'submission_unknown', plan: await store.getPlan(plan.id) };
        }
        const acknowledged = await store.updatePlan(plan.id, { ...linkPatchFromBrokerOrder(ack), state: stateFromParent(ack) || 'working' }, {
            events: [{
                event_key: `plan:${plan.id}:submission_acknowledged`, event_type: 'submission', action: 'submission_acknowledged', outcome: 'acknowledged',
                detail: { symbol: plan.symbol, broker_status: ack.status, planned_qty: plan.planned_qty, entry_price: plan.planned_entry_price }, occurred_at: now().toISOString(),
            }],
        });
        return { outcome: 'acknowledged', plan: acknowledged };
    }

    function submitEntry(intent) {
        const run = queue.then(() => submitEntryUnqueued(intent));
        queue = run.catch(() => {});
        return run;
    }

    return { submitEntry };
}

module.exports = {
    ENTRY_HEARTBEAT_MAX_AGE_MS,
    createV2Execution,
    resolvePlanByClientOrderId,
    linkPatchFromBrokerOrder,
    stateFromParent,
    isDefiniteRejection,
};
