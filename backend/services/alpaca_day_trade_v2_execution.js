'use strict';

// The one v2 entry path: write the plan (with its deterministic client_order_id) before the
// broker POST, submit exactly one bracket, and fail closed on any uncertainty. It never POSTs a
// second entry for a client id: an unresolved plan is only ever resolved by looking the client
// id up at the broker.
const { buildV2EntryOrder, DEFAULT_V2_POLICY } = require('./alpaca_day_trade_v2_policy');
const crypto = require('node:crypto');
const { captureEntryEvidence } = require('./alpaca_day_trade_v2_evidence');
const { computeV2DailyRisk, selectV2RiskPlans } = require('./alpaca_day_trade_v2_risk');

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

function sameIntent(plan, built) {
    return plan.symbol === built.symbol && plan.planned_qty === built.qty
        && plan.planned_stop === built.stop && plan.planned_target === built.target;
}

function createV2Execution({ store, client, policy = DEFAULT_V2_POLICY, now = () => new Date() }) {
    policy = { ...DEFAULT_V2_POLICY, ...policy };
    // One in-process queue: only this service submits v2 entries.
    let queue = Promise.resolve();

    async function assertEntryGates(repo = store) {
        const state = await repo.getMonitorState();
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
        if (outcome === 'in_flight') throw executionError('ALPACA_V2_SUBMISSION_IN_PROGRESS', 'entry submission is in progress; retry after reconciliation');
        return { outcome, plan: await store.getPlan(existing.id) };
    }

    async function readBrokerFacts(symbol) {
        try {
            const quoteRead = async () => {
                const quote = await client.getLatestQuote(symbol, { feed: policy.feed });
                return { quote, quoteRetrievedAt: now().toISOString() };
            };
            const [account, clock, asset, quoted, openOrders] = await Promise.all([
                client.getAccount(), client.getClock(), client.getAsset(symbol),
                quoteRead(), client.getOrders({ status: 'open' }),
            ]);
            if (!Array.isArray(openOrders)) throw new Error('missing orders');
            return { account, clock, asset, ...quoted, openOrders };
        } catch (_error) {
            throw executionError('ALPACA_V2_BROKER_UNAVAILABLE', 'broker account state could not be read');
        }
    }

    async function readBrokerRiskEvidence(plans, fills) {
        const relevant = selectV2RiskPlans({ plans, fills, now: now() });
        if (relevant.length > 100) throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'too many plans to verify safely');
        const evidence = new Map();
        try {
            // Read one plan at a time to bound broker load; its nested parent carries
            // the stop/target quantities. A separate time-exit order is also checked.
            for (const plan of relevant) {
                const ids = [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id];
                if (!plan.parent_order_id) {
                    if (['cancelled', 'rejected'].includes(plan.state) && plan.filled_entry_qty === 0) {
                        evidence.set(plan.id, { ids, orders: [], capturedAt: [now().getTime()] });
                        continue;
                    }
                    throw new Error('unlinked plan');
                }
                const parent = await client.getOrder(plan.parent_order_id, { nested: true });
                const capturedAt = [now().getTime()];
                if (!parent || parent.id !== plan.parent_order_id) throw new Error('missing parent');
                const orders = [parent, ...(Array.isArray(parent.legs) ? parent.legs : [])];
                if (plan.exit_order_id) {
                    orders.push(await client.getOrder(plan.exit_order_id));
                    capturedAt.push(now().getTime());
                }
                evidence.set(plan.id, { ids, orders, capturedAt });
            }
        } catch (_error) {
            throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker fills could not be verified');
        }
        return evidence;
    }

    function assertBrokerRiskEvidence(plans, fills, evidence) {
        for (const plan of selectV2RiskPlans({ plans, fills, now: now() })) {
            const proof = evidence.get(plan.id);
            const ids = [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id];
            if (!proof || ids.some((id, index) => id !== proof.ids[index])) {
                throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'plan linkage changed during the fill check');
            }
            const checkedAt = now().getTime();
            if (!Number.isFinite(policy.maxQuoteAgeMs) || policy.maxQuoteAgeMs < 0
                || proof.capturedAt.some((time) => !Number.isFinite(time) || checkedAt < time || checkedAt - time > policy.maxQuoteAgeMs)) {
                throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker fill evidence is no longer current; retry');
            }
            const seen = new Set();
            for (const order of proof.orders) {
                const quantity = Number(order?.filled_qty);
                if (!order?.id || seen.has(order.id) || !ids.includes(order.id)
                    || String(order.symbol || '').toUpperCase() !== plan.symbol
                    || order.side !== (order.id === plan.parent_order_id ? 'buy' : 'sell')
                    || order.filled_qty == null || order.filled_qty === '' || !Number.isSafeInteger(quantity) || quantity < 0) {
                    throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker fill evidence is incomplete');
                }
                seen.add(order.id);
                const local = fills.filter((fill) => fill.plan_id === plan.id && fill.order_id === order.id);
                const localQuantity = local.reduce((sum, fill) => sum + fill.qty, 0);
                if (quantity !== localQuantity) {
                    throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker fills are not reconciled');
                }
                if (quantity > 0) {
                    const average = Number(order.filled_avg_price);
                    const localAverage = local.reduce((sum, fill) => sum + fill.qty * fill.price, 0) / localQuantity;
                    // Broker weighted averages may be rounded to four decimal places.
                    if (!(average > 0) || !Number.isFinite(average) || Math.abs(average - localAverage) > 1e-4) {
                        throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker fill prices are not reconciled');
                    }
                }
            }
            if (ids.filter(Boolean).some((id) => !seen.has(id))) {
                throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'broker order evidence is incomplete');
            }
        }
    }

    async function submitEntryUnqueued(intent, attempt) {
        // Commit crash recovery separately: a later gate refusal must not roll it back.
        await store.recoverEntrySubmissions({ occurredAt: now().toISOString() });
        const clientOrderId = typeof intent?.client_order_id === 'string' ? intent.client_order_id : '';
        const existing = clientOrderId ? await store.getPlanByClientOrderId(clientOrderId) : null;
        if (existing) return replay(existing, intent);

        await assertEntryGates();
        // Capture the version before checking for an active sender: an admission
        // that begins between these reads must invalidate the later broker facts.
        const entryVersion = await store.getEntryVersion();
        await store.assertNoEntrySubmissions();
        const symbol = typeof intent?.symbol === 'string' ? intent.symbol.trim().toUpperCase() : '';
        const riskSnapshot = await store.transaction(async (repo) => ({
            plans: await repo.listPlans(), fills: await repo.listFills(), entryVersion: await repo.getEntryVersion(),
        }));
        if (riskSnapshot.entryVersion !== entryVersion) {
            throw executionError('ALPACA_V2_CONTROL_STATE_CHANGED', 'account state changed during this check; review and retry');
        }
        const brokerRiskEvidence = await readBrokerRiskEvidence(riskSnapshot.plans, riskSnapshot.fills);
        const facts = await readBrokerFacts(symbol);
        attempt.evidence = captureEntryEvidence(intent, { quote: facts.quote, policy, now: now(), retrievedAt: facts.quoteRetrievedAt });
        // Register before the admission can commit, and unregister only after this
        // callback can no longer POST. A later request can recover a local attempt
        // whose broker call finished but whose database settlement failed.
        const sender = store.beginEntryAttempt();
        try {
            return await admitAndSubmit(intent, symbol, facts, entryVersion, sender, brokerRiskEvidence, attempt);
        } finally {
            store.endEntryAttempt(sender);
        }
    }

    async function admitAndSubmit(intent, symbol, facts, entryVersion, sender, brokerRiskEvidence, attempt) {
        // Admission is the shared ordering point for every server and monitor process.
        // Gates, current risk, plan and send marker commit together. Operator controls
        // cannot report success while this marker exists. No broker I/O holds this lock.
        const { built, plan } = await store.transaction(async (repo) => {
            await assertEntryGates(repo);
            await repo.assertNoEntrySubmissions();
            if (await repo.getEntryVersion() !== entryVersion) {
                throw executionError('ALPACA_V2_CONTROL_STATE_CHANGED', 'account state changed during this check; review and retry');
            }
            const allPlans = await repo.listPlans();
            const fills = await repo.listFills();
            const dailyRisk = computeV2DailyRisk({ plans: allPlans, fills, now: now() });
            if (dailyRisk.complete) {
                attempt.evidence = { ...attempt.evidence, daily_realized_pnl: dailyRisk.realizedPnl,
                    daily_loss_limit: Number(facts.account?.equity) * policy.maxDailyLossPct, session_date: dailyRisk.sessionDate };
            }
            if (!dailyRisk.complete) throw executionError('ALPACA_V2_DAILY_PNL_UNAVAILABLE', 'today\'s reconciled v2 realized result is unavailable');
            assertBrokerRiskEvidence(allPlans, fills, brokerRiskEvidence);
            const openPlans = allPlans.filter((candidate) => !['closed', 'cancelled', 'rejected'].includes(candidate.state));
            const built = buildV2EntryOrder({
                intent, ...facts, policy, now: now(),
                context: {
                    hasActivePlanForSymbol: openPlans.some((candidate) => candidate.symbol === symbol),
                    currentOpenRiskDollars: openPlans.reduce((sum, candidate) => sum + Number(candidate.planned_risk_dollars || 0), 0),
                    dailyRisk,
                },
            });
            attempt.evidence = built.plan.entry_evidence;
            const { plan } = await repo.createPlan({ ...built.plan, occurred_at: now().toISOString() });
            await repo.appendEvent({
                event_key: `${attempt.key}:approved`, plan_id: plan.id, event_type: 'entry_attempt', action: 'entry_policy_approved',
                outcome: 'approved', detail: built.plan.entry_evidence, occurred_at: now().toISOString(),
            });
            await repo.admitEntrySubmission(plan.id, { owner: sender, occurredAt: now().toISOString() });
            return { built, plan };
        });

        let ack;
        try {
            ack = await client.submitOrder(built.order);
        } catch (error) {
            const occurredAt = now().toISOString();
            if (isDefiniteRejection(error)) {
                const rejected = await store.transaction(async (repo) => {
                    const current = await repo.getPlan(plan.id);
                    const updated = await repo.updatePlan(plan.id, current.state === 'pending_submission' ? { state: 'rejected' } : {}, {
                        events: [{
                            event_key: `plan:${plan.id}:submission_rejected`, event_type: 'submission', action: 'submission_rejected', outcome: 'rejected',
                            reason_code: 'BROKER_REJECTED', detail: { symbol: plan.symbol, broker_status: String(error.status) }, occurred_at: occurredAt,
                        }],
                    });
                    await repo.settleEntrySubmission(plan.id, occurredAt);
                    return updated;
                });
                return { outcome: 'rejected', plan: rejected };
            }
            return recordUnknown(plan, occurredAt);
        }

        if (!ack?.id) {
            // An "ok" response without an order id is not an acknowledgement we can trust.
            return recordUnknown(plan, now().toISOString());
        }
        const acknowledged = await store.transaction(async (repo) => {
            const current = await repo.getPlan(plan.id);
            const updated = await repo.updatePlan(plan.id, {
                ...linkPatchFromBrokerOrder(ack),
                ...(current.state === 'pending_submission' ? { state: stateFromParent(ack) || 'working' } : {}),
            }, {
                events: [{
                    event_key: `plan:${plan.id}:submission_acknowledged`, event_type: 'submission', action: 'submission_acknowledged', outcome: 'acknowledged',
                    detail: { symbol: plan.symbol, broker_status: ack.status, planned_qty: plan.planned_qty, entry_price: plan.planned_entry_price }, occurred_at: now().toISOString(),
                }],
            });
            await repo.settleEntrySubmission(plan.id, now().toISOString());
            return updated;
        });
        return { outcome: 'acknowledged', plan: acknowledged };
    }

    async function recordUnknown(plan, occurredAt) {
        const updated = await store.transaction(async (repo) => {
            const current = await repo.getPlan(plan.id);
            if (current.state !== 'attention_required') {
                await repo.latchAttention({ planId: plan.id, code: 'SUBMISSION_UNKNOWN', eventKey: `plan:${plan.id}:attention:SUBMISSION_UNKNOWN`, detail: { symbol: plan.symbol }, occurredAt });
            }
            await repo.settleEntrySubmission(plan.id, occurredAt);
            return repo.getPlan(plan.id);
        });
        return { outcome: 'submission_unknown', plan: updated };
    }

    function submitEntry(intent) {
        const run = queue.then(async () => {
            const correlation = crypto.createHash('sha256').update(typeof intent?.client_order_id === 'string' ? intent.client_order_id : '').digest('hex');
            const attempt = { key: `entry_attempt:${correlation}:${crypto.randomUUID()}`, evidence: captureEntryEvidence(intent, { policy, now: now() }) };
            // Each request has its own immutable evidence, even when a retry changes
            // price levels or fails before a plan exists. Correlation stays private.
            await store.appendEvent({ event_key: `${attempt.key}:started`, event_type: 'entry_attempt', action: 'attempt_started',
                outcome: 'pending', detail: attempt.evidence, occurred_at: now().toISOString() });
            try {
                const result = await submitEntryUnqueued(intent, attempt);
                await store.appendEvent({ event_key: `${attempt.key}:completed`, plan_id: result.plan.id,
                    event_type: 'entry_attempt', action: 'attempt_completed', outcome: result.outcome,
                    detail: attempt.evidence, occurred_at: now().toISOString() });
                return result;
            } catch (error) {
                await store.appendEvent({ event_key: `${attempt.key}:refused`, event_type: 'entry_refused', action: 'submit_entry', outcome: 'refused',
                    reason_code: /^ALPACA_V2_[A-Z_]+$/.test(error?.code || '') ? error.code : 'ALPACA_V2_ERROR',
                    detail: attempt.evidence, occurred_at: now().toISOString() });
                throw error;
            }
        });
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
