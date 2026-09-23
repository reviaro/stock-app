'use strict';

// Canonical v2 fill ingestion. The WebSocket is for promptness, REST activities for
// completeness; both funnel into one short local transaction per fill that writes the fill,
// its one semantic event, and the derived plan summary together. Any identity or role
// ambiguity latches attention -- this module never infers a repair.
const { timeExitClientOrderId } = require('./alpaca_day_trade_v2_policy');

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const REST_COMPOSITE_ID = new RegExp(`^\\d{17}::(${UUID})$`, 'i');
const MAX_REST_PAGES = 20;
const REST_PAGE_SIZE = 100;

// Only the documented/observed REST `timestamp::UUID` form maps to the WebSocket execution
// UUID; every other identifier is preserved verbatim.
function canonicalExecutionId(value) {
    const id = String(value ?? '');
    const match = id.match(REST_COMPOSITE_ID);
    return match ? match[1] : id;
}

function wholeQty(value) {
    const qty = Number(value);
    return Number.isInteger(qty) && qty > 0 ? qty : NaN;
}

function normalizeV2WebSocketFill(raw) {
    if (!raw || !['fill', 'partial_fill'].includes(raw.event)) return null;
    return {
        execution_id: canonicalExecutionId(raw.execution_id),
        order_id: String(raw.order?.id ?? ''),
        order_client_id: raw.order?.client_order_id == null ? null : String(raw.order.client_order_id),
        symbol: String(raw.order?.symbol || '').toUpperCase(),
        side: raw.order?.side,
        qty: wholeQty(raw.qty),
        price: Number(raw.price),
        executed_at: String(raw.timestamp || ''),
        source: 'websocket',
    };
}

function normalizeV2RestFill(raw) {
    return {
        execution_id: canonicalExecutionId(raw.id),
        order_id: String(raw.order_id ?? ''),
        order_client_id: null,
        symbol: String(raw.symbol || '').toUpperCase(),
        side: raw.side,
        qty: wholeQty(raw.qty),
        price: Number(raw.price),
        executed_at: String(raw.transaction_time || ''),
        source: 'rest',
    };
}

// Fixed, simple semantics: entry = buy on the parent, bracket_exit = sell on a leg,
// time_exit = sell on the plan's own market exit. Anything else is not a v2 shape.
function matchPlan(fill, plans) {
    for (const plan of plans) {
        if (fill.order_id && fill.order_id === plan.parent_order_id) return { plan, role: 'entry' };
        if (fill.order_id && (fill.order_id === plan.stop_order_id || fill.order_id === plan.target_order_id)) return { plan, role: 'bracket_exit' };
        if (fill.order_id && fill.order_id === plan.exit_order_id) return { plan, role: 'time_exit' };
        if (fill.order_client_id && fill.order_client_id === plan.client_order_id) return { plan, role: 'entry' };
        if (fill.order_client_id && fill.order_client_id === timeExitClientOrderId(plan)) return { plan, role: 'time_exit' };
    }
    return null;
}

const ROLE_SIDE = { entry: 'buy', bracket_exit: 'sell', time_exit: 'sell' };

function weighted(fills) {
    const qty = fills.reduce((sum, fill) => sum + fill.qty, 0);
    if (!qty) return { qty: 0, avg: null };
    const notional = fills.reduce((sum, fill) => sum + fill.qty * fill.price, 0);
    return { qty, avg: Math.round((notional / qty) * 1e6) / 1e6 };
}

// Recompute the plan's summary from its canonical fills. Idempotent: it is also the repair
// path after a crash that committed fills but not the derived summary.
async function deriveSummary(repo, planId, occurredAt) {
    const plan = await repo.getPlan(planId);
    const fills = await repo.listFills({ planId });
    const entry = weighted(fills.filter((fill) => fill.role === 'entry'));
    const exit = weighted(fills.filter((fill) => fill.role === 'bracket_exit' || fill.role === 'time_exit'));
    if (exit.qty > entry.qty) {
        await repo.latchAttention({ planId, code: 'FILL_OVERFILL', eventKey: `plan:${planId}:attention:FILL_OVERFILL`, detail: { symbol: plan.symbol, filled_qty: entry.qty }, occurredAt });
        return;
    }
    const patch = {};
    if (plan.filled_entry_qty !== entry.qty) patch.filled_entry_qty = entry.qty;
    if (plan.avg_entry_price !== entry.avg) patch.avg_entry_price = entry.avg;
    if (plan.filled_exit_qty !== exit.qty) patch.filled_exit_qty = exit.qty;
    if (plan.avg_exit_price !== exit.avg) patch.avg_exit_price = exit.avg;
    const firstEntry = fills.find((fill) => fill.role === 'entry');
    if (firstEntry && !plan.opened_at) patch.opened_at = firstEntry.executed_at;
    if (entry.qty > 0 && plan.state === 'working') patch.state = 'active';
    if (Object.keys(patch).length) await repo.updatePlan(planId, patch);
}

async function attachAndDerive(repo, fill, match, occurredAt) {
    const { plan, role } = match;
    if (ROLE_SIDE[role] !== fill.side || fill.symbol !== plan.symbol) {
        await repo.latchAttention({ planId: plan.id, code: 'FILL_ROLE_MISMATCH', eventKey: `plan:${plan.id}:attention:FILL_ROLE_MISMATCH`, detail: { symbol: plan.symbol }, occurredAt });
        return;
    }
    if (fill.plan_id == null) fill = await repo.attachFill(fill.id, { planId: plan.id, role });
    await repo.appendEvent({
        event_key: `fill:${fill.id}`, plan_id: plan.id, event_type: 'fill', action: role, outcome: fill.side,
        detail: { symbol: fill.symbol, side: fill.side, qty: fill.qty, price: fill.price, role, source: fill.source },
        occurred_at: fill.executed_at,
    });
    await deriveSummary(repo, plan.id, occurredAt);
}

// Stores fills that plausibly belong to v2: a known v2 order/client id, or the symbol of an
// open v2 plan (possible before linkage). Unrelated account fills (v1, manual) are ignored.
function isRelevant(fill, allPlans, openPlans) {
    return Boolean(matchPlan(fill, allPlans)) || openPlans.some((plan) => plan.symbol === fill.symbol);
}

async function ingestFill({ store, fill, now = () => new Date() }) {
    const occurredAt = now().toISOString();
    if (!fill) return { outcome: 'ignored' };
    try {
        return await store.transaction(async (repo) => {
            const allPlans = await repo.listPlans();
            const openPlans = allPlans.filter((plan) => !['closed', 'cancelled', 'rejected'].includes(plan.state));
            const known = await repo.listFills().then((rows) => rows.find((row) => row.execution_id === fill.execution_id));
            if (!known && !isRelevant(fill, allPlans, openPlans)) return { outcome: 'ignored' };
            const { inserted, fill: stored } = await repo.recordFill(fill);
            const match = stored.plan_id != null
                ? { plan: allPlans.find((plan) => plan.id === stored.plan_id), role: stored.role }
                : matchPlan(stored, allPlans);
            if (match?.plan) await attachAndDerive(repo, stored, match, occurredAt);
            return { outcome: inserted ? 'inserted' : 'duplicate', attached: Boolean(match?.plan) };
        });
    } catch (error) {
        if (error.code !== 'ALPACA_V2_FILL_CONFLICT' && error.code !== 'ALPACA_V2_FILL_INVALID') throw error;
        const code = error.code === 'ALPACA_V2_FILL_CONFLICT' ? 'FILL_CONFLICT' : 'FILL_INVALID';
        const plans = await store.listPlans();
        const match = matchPlan(fill, plans);
        await store.latchAttention({
            planId: match?.plan.id ?? null, code, occurredAt,
            eventKey: `attention:${code}:${match?.plan.id ?? 'account'}:${occurredAt}`,
            detail: { symbol: fill.symbol },
        });
        return { outcome: 'conflict' };
    }
}

// Fills held provisionally (plan not yet linked) attach once a later pass can match them.
async function attachPendingFills({ store, now = () => new Date() }) {
    const occurredAt = now().toISOString();
    return store.transaction(async (repo) => {
        const plans = await repo.listPlans();
        let attached = 0;
        for (const fill of await repo.listFills({ unattached: true })) {
            const match = matchPlan(fill, plans);
            if (!match) continue;
            await attachAndDerive(repo, fill, match, occurredAt);
            attached += 1;
        }
        return attached;
    });
}

async function reconcileRestFills({ store, client, now = () => new Date() }) {
    const openPlans = await store.listNonterminalPlans();
    if (!openPlans.length) return { skipped: true, ingested: 0, conflicts: 0 };
    const earliest = Math.min(...openPlans.map((plan) => new Date(plan.created_at).getTime()));
    const after = new Date(earliest - 60_000).toISOString();
    let ingested = 0;
    let conflicts = 0;
    let pageToken;
    for (let page = 0; page < MAX_REST_PAGES; page += 1) {
        const activities = await client.getAccountActivities({ activityType: 'FILL', after, direction: 'asc', pageSize: REST_PAGE_SIZE, pageToken });
        const rows = Array.isArray(activities) ? activities : [];
        for (const raw of rows) {
            const result = await ingestFill({ store, fill: normalizeV2RestFill(raw), now });
            if (result.outcome === 'conflict') conflicts += 1;
            else if (result.outcome !== 'ignored') ingested += 1;
        }
        if (rows.length < REST_PAGE_SIZE) break;
        pageToken = rows[rows.length - 1].id;
    }
    await attachPendingFills({ store, now });
    // Summary repair for plans whose fills committed without derived state (crash recovery).
    await store.transaction(async (repo) => {
        for (const plan of openPlans) await deriveSummary(repo, plan.id, now().toISOString());
    });
    return { skipped: false, ingested, conflicts };
}

module.exports = {
    canonicalExecutionId,
    normalizeV2WebSocketFill,
    normalizeV2RestFill,
    ingestFill,
    attachPendingFills,
    reconcileRestFills,
    matchPlan,
};
