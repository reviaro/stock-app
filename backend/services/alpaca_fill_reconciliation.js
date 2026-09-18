const store = require('./alpaca_day_trade_store');
const { attemptCloseFromFills } = require('./alpaca_day_trade_journal');

// Verified against Alpaca's documented GET /v2/account/activities/FILL response schema: type
// is only ever "fill" or "partial_fill"; no field represents a correction or a busted trade in
// either the REST activities feed or the trade_updates WebSocket stream (also verified against
// docs). is_bust/correction_of exist on alpaca_paper_fills as pass-through columns for a
// hypothetical future feed or manual operator correction, not because either current feed
// populates them automatically.
function normalizeRestFillActivity(raw) {
    return {
        activity_id: String(raw.id),
        broker_order_id: String(raw.order_id),
        symbol: String(raw.symbol).toUpperCase(),
        side: raw.side,
        qty: requireFiniteNumber(raw.qty, 'qty'),
        price: requireFiniteNumber(raw.price, 'price'),
        executed_at: raw.transaction_time,
        fill_type: raw.type === 'partial_fill' ? 'partial_fill' : 'fill',
        source: 'rest_reconciliation',
    };
}

function requireFiniteNumber(value, label) {
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(`fill activity ${label} is not a finite number: ${value}`);
    return n;
}

// Verified against Alpaca's documented trade_updates WebSocket example payload:
// {event, execution_id, order: {id, symbol, side, ...}, price, qty, position_qty, timestamp}.
// execution_id is treated as the same identifier as a REST FILL activity's `id` for the same
// underlying execution -- this equivalence is not explicitly documented and is the load-bearing
// assumption behind cross-channel dedup; see the matrix note on why an independent structural
// guard (assertNoOverfill) exists rather than relying on this alone.
function normalizeWebSocketFillEvent(raw) {
    if (!raw || !['fill', 'partial_fill'].includes(raw.event)) return null;
    return {
        activity_id: String(raw.execution_id),
        broker_order_id: String(raw.order?.id),
        symbol: String(raw.order?.symbol || '').toUpperCase(),
        side: raw.order?.side,
        qty: requireFiniteNumber(raw.qty, 'qty'),
        price: requireFiniteNumber(raw.price, 'price'),
        executed_at: raw.timestamp,
        fill_type: raw.event === 'partial_fill' ? 'partial_fill' : 'fill',
        source: 'websocket',
    };
}

const LEG_TYPE_TO_FIELD = { stop: 'protective_stop_broker_order_id', limit: 'protective_target_broker_order_id' };

// `legs: null` (undocumented without nested=true, confirmed via Alpaca's reference docs) means
// "not yet discoverable," never "no protective legs exist" -- every Day Trading entry is always
// a bracket order (Task 7), so a genuinely leg-less entry is not a state this function may
// produce. Leaving the plan's columns null lets a later reconciliation pass retry; Task 11's
// monitor is the one that eventually treats a persistently missing leg as an anomaly requiring
// repair, not this function.
async function discoverProtectiveLegs(plan, { client }) {
    if (!plan.entry_parent_broker_order_id) return null;
    if (plan.protective_stop_broker_order_id && plan.protective_target_broker_order_id) return null;

    const parent = await client.getOrder(plan.entry_parent_broker_order_id, { nested: true });
    if (!Array.isArray(parent?.legs) || parent.legs.length === 0) return null;

    const patch = {};
    for (const leg of parent.legs) {
        const field = LEG_TYPE_TO_FIELD[leg.type];
        if (field) patch[field] = leg.id;
    }
    if (!patch.protective_stop_broker_order_id || !patch.protective_target_broker_order_id) return null;

    await store.updatePlan(plan.id, patch);
    return patch;
}

function findOwningPlan(brokerOrderId, plans) {
    return plans.find((plan) => [
        plan.entry_parent_broker_order_id,
        plan.protective_stop_broker_order_id,
        plan.protective_target_broker_order_id,
    ].includes(brokerOrderId)) || null;
}

// idempotency_key/broker_order_id are unique database-wide, so a fill's order could in
// principle belong to a legacy_long_term/legacy_unattributed order (Safety Invariant #3:
// isolation). Such an activity must never be imported into alpaca_paper_fills at all -- Day
// Trading's fill store is not the place to record evidence for an execution regime it doesn't
// own.
function isLegacyOrder(brokerOrderId, orderAudits) {
    const audit = orderAudits.find((a) => a.broker_order_id === brokerOrderId);
    return Boolean(audit && audit.execution_epoch !== 'day_trading');
}

// The one path fill evidence enters the system through, whether triggered by REST polling
// (this function) or eventually by Task 12's WebSocket consumer calling the same normalize +
// import primitives per message. Cursor advancement is deliberately conservative: it only ever
// moves to the timestamp of the last activity that was actually normalized and recorded,
// because `after`+`direction=asc` only walks forward -- advancing past an activity this pass
// failed to process would make it permanently unreachable on every future pass.
async function reconcileFills({ client, store: injectedStore = store }) {
    const plans = await injectedStore.listPlans(null);
    for (const plan of plans) {
        if (['closed', 'cancelled', 'error'].includes(plan.state)) continue;
        if (plan.entry_parent_broker_order_id && (!plan.protective_stop_broker_order_id || !plan.protective_target_broker_order_id)) {
            await discoverProtectiveLegs(plan, { client });
        }
    }

    const refreshedPlans = await injectedStore.listPlans(null);
    const orderAudits = await injectedStore.listOrderAudits();
    const monitorState = await injectedStore.getMonitorState();

    const activities = await client.getAccountActivities({
        activityType: 'FILL',
        after: monitorState?.activity_cursor || undefined,
        direction: 'asc',
    });

    let cursor = monitorState?.activity_cursor || null;
    let stallReason = null;

    for (const raw of activities) {
        let normalized;
        try {
            normalized = normalizeRestFillActivity(raw);
        } catch (error) {
            stallReason = `failed to normalize a FILL activity: ${error.message}`;
            break; // malformed: stop before it, leave the cursor at the last good activity
        }

        if (isLegacyOrder(normalized.broker_order_id, orderAudits)) {
            cursor = normalized.executed_at;
            continue; // acknowledged and skipped, never stored
        }

        const owningPlan = findOwningPlan(normalized.broker_order_id, refreshedPlans);
        try {
            await injectedStore.recordFill({ ...normalized, plan_id: owningPlan ? owningPlan.id : null });
        } catch (error) {
            stallReason = `failed to record fill ${normalized.activity_id}: ${error.message}`;
            break; // insert failure: stop before it too
        }
        cursor = normalized.executed_at;
    }

    // A pass that aborted early is otherwise unobservable except by noticing the cursor stopped
    // moving. health_code/health_error make it directly visible to the monitor-health route
    // and to Task 11's "stale local state" check, and a clean pass explicitly clears a prior
    // stall rather than leaving it to look permanent.
    //
    // last_rest_reconciliation_at refreshes on every *complete* pass, independent of whether
    // activity_cursor advances: a quiet period with zero new fills is still a successful
    // reconciliation and must not be indistinguishable from one that never ran, or Task 11's
    // staleness check would eventually (and wrongly) treat "nothing happened" the same as
    // "reconciliation is broken." A stalled pass (stallReason set) deliberately does *not*
    // refresh it — that failure should be allowed to age into staleness downstream, not be
    // masked by a timestamp claiming the check just succeeded. activity_cursor itself only
    // ever advances when there is a genuine new value, preserving the "never advance past an
    // unprocessed activity" guarantee regardless of whether the pass otherwise stalled.
    await injectedStore.updateMonitorState({
        ...(cursor ? { activity_cursor: cursor } : {}),
        ...(stallReason ? {} : { last_rest_reconciliation_at: new Date().toISOString() }),
        health_code: stallReason ? 'RECONCILIATION_STALLED' : null,
        health_error: stallReason,
    });

    // Every nonterminal plan is re-checked, not only ones touched by an activity imported in
    // this specific pass: exit fills recorded by an earlier pass that crashed or was
    // interrupted before reaching the close attempt must still get closed here (Section 8:
    // "reconcile before resuming"). Each plan's close attempt is isolated: one plan whose
    // fills fail assertNoOverfill must not stall every other plan's reconciliation, this pass
    // and every pass after it — it is moved to the terminal 'error' state instead, which both
    // stops the bad plan from being retried forever and lets the loop continue.
    for (const plan of refreshedPlans) {
        if (['closed', 'cancelled', 'error'].includes(plan.state)) continue;
        try {
            await attemptCloseFromFills(plan, { client });
        } catch (closeError) {
            await injectedStore.updatePlan(plan.id, { state: 'error', review_notes: closeError.message });
        }
    }
}

function legFromOrder(order, type) {
    if (!Array.isArray(order?.legs)) return null;
    return order.legs.find((leg) => leg.type === type) || null;
}

// Assembles one plan's fresh, per-tick observation for Task 11's decidePlanAction -- the only
// place this fetch shape is built, shared by Task 13's worker and the kill-switch-clear route,
// so there is exactly one definition of what "fresh broker state" means for a plan. Lives here,
// not in alpaca_day_trade_monitor.js: that file's zero-I/O contract (Safety Invariant #17) is
// load-bearing and documented, and this function does network I/O by design.
async function buildObservation(plan, {
    client, policy, now, log = () => {},
}) {
    try {
        const [clock, position, parentOrder] = await Promise.all([
            client.getClock(),
            client.getPosition(plan.symbol),
            plan.entry_parent_broker_order_id
                ? client.getOrder(plan.entry_parent_broker_order_id, { nested: true })
                : Promise.resolve(null),
        ]);
        return {
            plan,
            position,
            brokerUnavailable: false,
            entryOrder: parentOrder ? {
                status: parentOrder.status, qty: Number(parentOrder.qty), filled_qty: Number(parentOrder.filled_qty || 0),
                submitted_at: parentOrder.submitted_at ?? null,
            } : null,
            stopLeg: legFromOrder(parentOrder, 'stop'),
            targetLeg: legFromOrder(parentOrder, 'limit'),
            clock,
            monitorState: await store.getMonitorState(),
            now: now(),
            policy,
        };
    } catch (error) {
        // Deliberately broad: any failure fetching this plan's broker state, network or
        // programming error alike, must fail the observation closed rather than crash the
        // tick for every other plan. But an unqualified catch that swallows the error entirely
        // makes a genuine bug indistinguishable from a real outage in the logs -- log it, so
        // "BROKER_UNAVAILABLE" for every tick is recoverable evidence of a bug, not a dead end.
        log({ planId: plan.id, symbol: plan.symbol, observationError: error.message });
        return {
            plan, position: null, brokerUnavailable: true, entryOrder: null, stopLeg: null, targetLeg: null,
            clock: null, monitorState: await store.getMonitorState(), now: now(), policy,
        };
    }
}

// The one thing a live trade_updates delivery needs that a REST activity doesn't already have
// by the time it reaches here: the event is already normalized (the stream module applies
// normalizeWebSocketFillEvent itself before calling onFill). This owns exactly what
// reconcileFills' own per-activity loop does inline -- the legacy-order skip and the
// owning-plan lookup -- reusing the same helpers so the two channels can never apply different
// rules for the same underlying fill. Deliberately does not run discoverProtectiveLegs or
// attemptCloseFromFills itself; the caller (the worker's onFill handler) follows this with a
// full reconcileFills pass, which already does both against complete REST evidence.
async function recordWebSocketFill(normalized, { store: injectedStore = store } = {}) {
    const orderAudits = await injectedStore.listOrderAudits();
    if (isLegacyOrder(normalized.broker_order_id, orderAudits)) return { recorded: false, reason: 'legacy_order' };

    const plans = await injectedStore.listPlans(null);
    const owningPlan = findOwningPlan(normalized.broker_order_id, plans);
    await injectedStore.recordFill({ ...normalized, plan_id: owningPlan ? owningPlan.id : null });
    return { recorded: true };
}

module.exports = {
    normalizeRestFillActivity,
    normalizeWebSocketFillEvent,
    discoverProtectiveLegs,
    reconcileFills,
    buildObservation,
    recordWebSocketFill,
};
