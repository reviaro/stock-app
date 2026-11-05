'use strict';

// Deterministic v2 monitor: no LLM, no repair engine. Each tick reads broker truth for every
// nonterminal historical plan, records completed broker evidence, or latches attention.
// Day-trading execution is retired: no cancel, replacement, or time-exit submission
// exists here, including when an old database still contains paper_execute mode.
// Existing native bracket orders remain at the broker for operator review.
const { reconcileRestFills } = require('./alpaca_day_trade_v2_reconciliation');
const { resolvePlanByClientOrderId, linkPatchFromBrokerOrder } = require('./alpaca_day_trade_v2_execution');
const { timeExitClientOrderId } = require('./alpaca_day_trade_v2_policy');
const { observeActivePlans } = require('./alpaca_day_trade_v2_research');

const NON_EXECUTABLE = ['filled', 'canceled', 'expired', 'rejected'];
// Evidence that a flat, fully non-executable bracket's fills should have arrived by now.
const FILL_EVIDENCE_GRACE_MS = 15 * 60_000;
// A pending_submission plan this young may still have its entry POST in flight (the paper
// client aborts after 10s); looking it up now would find nothing and latch a false alarm.
const SUBMISSION_GRACE_MS = 60_000;
// Unlinked plans the monitor may still resolve by exact client id. A latched submission stays
// latched, but linking it lets the monitor recognize its bracket legs and fills as plan-owned.
const RESOLVABLE_UNLINKED = ['pending_submission', 'submission_unknown', 'attention_required'];

class BrokerUnreadable extends Error {}

function easternDate(date) {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
    const get = (type) => parts.find((part) => part.type === type).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
}

const isExecutable = (order) => Boolean(order) && !NON_EXECUTABLE.includes(order.status);
const legsOf = (parent) => (Array.isArray(parent?.legs) ? parent.legs : []);
const qtyOf = (value) => Number(value || 0);
const round2 = (value) => Math.round(value * 100) / 100;

function createV2Monitor({
    store, client, now = () => new Date(), notify = () => {},
}) {
    async function read(fn) {
        try { return await fn(); } catch (_error) { throw new BrokerUnreadable('broker read failed'); }
    }

    function submissionInFlight(plan) {
        return plan.state === 'pending_submission' && now().getTime() - new Date(plan.created_at).getTime() < SUBMISSION_GRACE_MS;
    }

    function hourKey() {
        return now().toISOString().slice(0, 13);
    }

    async function latch(code, { plan = null, symbol = null } = {}) {
        const eventKey = plan ? `plan:${plan.id}:attention:${code}` : `attention:${code}:${symbol || 'account'}:${hourKey()}`;
        await store.latchAttention({ planId: plan?.id ?? null, code, eventKey, detail: { symbol: plan?.symbol || symbol }, occurredAt: now().toISOString() });
        notify({ attention: code, symbol: plan?.symbol || symbol || null });
    }

    async function readPosition(symbol) {
        const position = await read(() => client.getPosition(symbol));
        if (!position) return { qty: 0, valid: true };
        const qty = Number(position.qty);
        return { qty, valid: Number.isInteger(qty) && qty >= 0 && position.side !== 'short' };
    }

    function exitReasonFor(plan, fills) {
        if (fills.some((fill) => fill.role === 'time_exit')) return 'time_exit';
        const exit = fills.find((fill) => fill.role === 'bracket_exit');
        if (exit?.order_id === plan.target_order_id) return 'take_profit';
        return 'stop_loss';
    }

    // Close only on complete canonical evidence: broker flat, nothing plan-owned executable,
    // and local fills balanced. Returns whether the plan reached a terminal state.
    async function closeIfComplete(plan, parent, { lagSince = null } = {}) {
        const fresh = await store.getPlan(plan.id);
        if (fresh.filled_entry_qty === 0 && qtyOf(parent?.filled_qty) === 0) {
            const state = parent?.status === 'rejected' ? 'rejected' : 'cancelled';
            await store.updatePlan(plan.id, { state, closed_at: now().toISOString() }, {
                events: [{ event_key: `plan:${plan.id}:${state}`, event_type: 'closure', action: state, outcome: state, detail: { symbol: plan.symbol, broker_status: parent?.status || null } }],
            });
            return true;
        }
        const entered = qtyOf(parent?.filled_qty);
        if (fresh.filled_entry_qty !== entered || fresh.filled_exit_qty !== fresh.filled_entry_qty) {
            const lagging = lagSince ? now().getTime() - lagSince : 0;
            if (lagging > FILL_EVIDENCE_GRACE_MS) await latch('FILL_EVIDENCE_MISSING', { plan });
            return false;
        }
        const fills = await store.listFills({ planId: plan.id });
        const qty = fresh.filled_entry_qty;
        const realizedPnl = round2((fresh.avg_exit_price - fresh.avg_entry_price) * qty);
        const realizedR = fresh.planned_risk_dollars > 0 ? Math.round((realizedPnl / fresh.planned_risk_dollars) * 10_000) / 10_000 : null;
        const exitReason = exitReasonFor(fresh, fills);
        await store.updatePlan(plan.id, { state: 'closed', exit_reason: exitReason, realized_pnl: realizedPnl, realized_r: realizedR, closed_at: now().toISOString() }, {
            events: [{
                event_key: `plan:${plan.id}:closed`, event_type: 'closure', action: 'close', outcome: 'closed', reason_code: exitReason.toUpperCase(),
                detail: { symbol: plan.symbol, qty, entry_price: fresh.avg_entry_price, exit_price: fresh.avg_exit_price, realized_pnl: realizedPnl, realized_r: realizedR, exit_reason: exitReason },
            }],
        });
        return true;
    }

    async function managePlan(plan) {
        if (!plan.parent_order_id) {
            if (!RESOLVABLE_UNLINKED.includes(plan.state)) return latch('UNKNOWN_PLAN_LINKAGE', { plan });
            if (submissionInFlight(plan)) return undefined;
            const outcome = await resolvePlanByClientOrderId({ store, client, plan, now });
            if (outcome !== 'linked') return undefined;
            plan = await store.getPlan(plan.id);
            if (!plan.parent_order_id) return undefined;
        }
        if (plan.state === 'attention_required') return; // observed, never acted on

        const pastDeadline = now().getTime() >= new Date(plan.exit_deadline).getTime();
        if (plan.state === 'time_exit_pending') {
            return latch('TIME_EXIT_SUPPRESSED', { plan });
        }

        const parent = await read(() => client.getOrder(plan.parent_order_id, { nested: true }));
        if (!parent || String(parent.symbol || '').toUpperCase() !== plan.symbol || parent.side !== 'buy') return latch('UNKNOWN_PLAN_LINKAGE', { plan });
        const legs = legsOf(parent);
        const entered = qtyOf(parent.filled_qty);

        // Leg ids were not discoverable at acknowledgement: link them now if the broker has them.
        if (entered > 0 && (!plan.stop_order_id || !plan.target_order_id)) {
            const patch = linkPatchFromBrokerOrder(parent);
            if (patch.stop_order_id && patch.target_order_id) plan = await store.updatePlan(plan.id, patch);
        }
        const stop = legs.find((leg) => leg.id === plan.stop_order_id);
        const target = legs.find((leg) => leg.id === plan.target_order_id);
        if (entered > 0 && (!stop || !target)) return latch('MISSING_LEG', { plan });
        if (legs.some((leg) => leg.id !== plan.stop_order_id && leg.id !== plan.target_order_id)) return latch('UNKNOWN_PLAN_LINKAGE', { plan });

        const exited = legs.reduce((sum, leg) => sum + qtyOf(leg.filled_qty), 0);
        let position = await readPosition(plan.symbol);
        if (!position.valid || position.qty !== entered - exited) {
            // One re-read absorbs a fill landing between the order and position reads.
            position = await readPosition(plan.symbol);
            const reread = await read(() => client.getOrder(plan.parent_order_id, { nested: true }));
            const expected = qtyOf(reread.filled_qty) - legsOf(reread).reduce((sum, leg) => sum + qtyOf(leg.filled_qty), 0);
            if (!position.valid || position.qty !== expected) return latch('POSITION_MISMATCH', { plan });
        }

        const allSettled = !isExecutable(parent) && legs.every((leg) => !isExecutable(leg));
        if (allSettled && position.qty === 0) {
            const stamps = [parent, ...legs].map((order) => new Date(order.filled_at || order.updated_at || order.canceled_at || 0).getTime()).filter(Number.isFinite);
            return closeIfComplete(plan, parent, { lagSince: stamps.length ? Math.max(...stamps) || null : null });
        }
        if (pastDeadline) return latch('TIME_EXIT_SUPPRESSED', { plan });
        return undefined; // healthy
    }

    async function checkAccountExposure() {
        const plans = await store.listNonterminalPlans();
        const [positions, openOrders] = await Promise.all([
            read(() => client.getPositions()),
            read(() => client.getOrders({ status: 'open' })),
        ]);
        const symbols = new Set(plans.map((plan) => plan.symbol));
        const owned = new Set(plans.flatMap((plan) => [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id]).filter(Boolean));
        const ownedClientIds = new Set(plans.flatMap((plan) => [plan.client_order_id, timeExitClientOrderId(plan)]));
        for (const position of positions || []) {
            if (!symbols.has(String(position.symbol).toUpperCase())) await latch('UNEXPECTED_POSITION', { symbol: position.symbol });
        }
        for (const order of openOrders || []) {
            if (!owned.has(order.id) && !ownedClientIds.has(order.client_order_id)) await latch('UNEXPECTED_ORDER', { symbol: order.symbol });
        }
        return { exposure: plans.length > 0 || (positions || []).length > 0 || (openOrders || []).length > 0 };
    }

    async function tick() {
        await store.recoverEntrySubmissions({ occurredAt: now().toISOString() });
        const state = await store.getMonitorState();
        if (state.mode === 'disabled') return { skipped: true, exposure: false };
        try {
            await read(() => client.getClock());
            await read(() => reconcileRestFills({ store, client, now }));
            for (const plan of await store.listNonterminalPlans()) {
                await managePlan(await store.getPlan(plan.id));
            }
            const { exposure } = await checkAccountExposure();
            await store.updateMonitorState({ last_reconciled_at: now().toISOString(), session_date: easternDate(now()) });
            await observeActivePlans({ store, client, now }).catch(() => {});
            return { skipped: false, exposure };
        } catch (error) {
            if (!(error instanceof BrokerUnreadable)) throw error;
            await latch('BROKER_UNREADABLE');
            return { skipped: false, exposure: true, unreadable: true };
        }
    }

    // Restart recovery: every unresolved plan is resolved by stored parent id or exact client
    // id before anything is classified. No broker match keeps it latched; never assume rejected.
    async function startup() {
        await store.recoverEntrySubmissions({ occurredAt: now().toISOString() });
        const state = await store.getMonitorState();
        if (state.mode === 'disabled') return { skipped: true, exposure: false };
        for (const plan of await store.listNonterminalPlans()) {
            if (!plan.parent_order_id && RESOLVABLE_UNLINKED.includes(plan.state) && !submissionInFlight(plan)) {
                await resolvePlanByClientOrderId({ store, client, plan, now });
            }
        }
        return tick();
    }

    return { tick, startup };
}

module.exports = { createV2Monitor, easternDate, FILL_EVIDENCE_GRACE_MS, SUBMISSION_GRACE_MS };
