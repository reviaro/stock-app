'use strict';

// Alpaca Day Trading v2 strategy-lab API. Readers get sanitized status/reason codes and
// user-meaningful quantities and prices only -- never broker/client/order ids, raw broker
// bodies, account ids, URLs, credentials, or exception text. Operator controls require an
// authenticated operator session; the scoped automation principal may only submit entries,
// NO TRADE decisions, and reviews for account 2.
const crypto = require('node:crypto');
const express = require('express');
const defaultStore = require('../services/alpaca_day_trade_v2_store');
const { createPaperClient } = require('../services/alpaca_paper_service');
const { createV2Execution, ENTRY_HEARTBEAT_MAX_AGE_MS } = require('../services/alpaca_day_trade_v2_execution');
const { timeExitClientOrderId, DEFAULT_V2_POLICY } = require('../services/alpaca_day_trade_v2_policy');
const { computeV2Analytics } = require('../services/alpaca_day_trade_v2_analytics');

const MODES = ['disabled', 'shadow', 'paper_execute'];
const UNRESOLVED_STATES = ['attention_required', 'submission_unknown', 'pending_submission'];
const NON_EXECUTABLE = ['filled', 'canceled', 'expired', 'rejected'];
const KEY = /^[A-Za-z0-9:._-]{1,100}$/;

// Fixed phrases only: policy errors never leak computed account figures.
const ERRORS = {
    ALPACA_V2_FIELD_NOT_ALLOWED: [400, 'the entry included a field that is not permitted'],
    ALPACA_V2_ACCOUNT_SCOPE_REQUIRED: [400, 'account_id 2 is required'],
    ALPACA_V2_CLIENT_ORDER_ID_INVALID: [400, 'a v2 client order id is required'],
    ALPACA_V2_QTY_INVALID: [400, 'invalid share quantity'],
    ALPACA_V2_STRATEGY_FIELDS_REQUIRED: [400, 'setup, catalyst, thesis, and invalidation are required'],
    ALPACA_V2_SYMBOL_INVALID: [400, 'a US equity symbol is required'],
    ALPACA_V2_EXIT_DEADLINE_INVALID: [400, 'the exit deadline must fall within the current session'],
    ALPACA_V2_GEOMETRY_INVALID: [400, 'stop and target are not valid for this entry'],
    ALPACA_V2_KILL_SWITCH_ACTIVE: [403, 'the kill switch is active'],
    ALPACA_V2_EXECUTION_DISABLED: [403, 'v2 execution is not in paper_execute mode'],
    ALPACA_V2_ATTENTION_REQUIRED: [403, 'an attention latch blocks new entries'],
    ALPACA_V2_MONITOR_STALE: [403, 'the monitor has not reconciled recently enough'],
    ALPACA_V2_ACCOUNT_NOT_TRADABLE: [403, 'the paper account is not available for trading'],
    ALPACA_V2_MARKET_CLOSED: [409, 'the market is not open for new entries'],
    ALPACA_V2_ENTRY_CUTOFF_PASSED: [409, 'the entry cutoff has passed'],
    ALPACA_V2_DUPLICATE_SYMBOL_PLAN: [409, 'a v2 plan is already active for this symbol'],
    ALPACA_V2_DUPLICATE_CLIENT_ORDER_ID: [409, 'this client order id was already used'],
    ALPACA_V2_IDEMPOTENCY_CONFLICT: [409, 'this client order id was already used for a different entry'],
    ALPACA_V2_ASSET_NOT_TRADABLE: [422, 'the symbol is not tradable'],
    ALPACA_V2_INSUFFICIENT_CASH: [422, 'insufficient uncommitted cash for this entry'],
    ALPACA_V2_CASH_COMMITMENT_UNKNOWN: [422, 'committed cash could not be determined'],
    ALPACA_V2_POSITION_LIMIT_EXCEEDED: [422, 'position size exceeds the account cap'],
    ALPACA_V2_RISK_PER_TRADE_EXCEEDED: [422, 'planned risk exceeds the per-trade cap'],
    ALPACA_V2_TOTAL_OPEN_RISK_EXCEEDED: [422, 'total open risk would exceed the account cap'],
    ALPACA_V2_MIN_CASH_RESERVE_BREACHED: [422, 'the entry would breach the cash reserve'],
    ALPACA_V2_QUOTE_UNAVAILABLE: [503, 'market data for this symbol is unavailable'],
    ALPACA_V2_BROKER_UNAVAILABLE: [503, 'the broker could not be read'],
    ALPACA_NOT_CONFIGURED: [503, 'the Alpaca paper account is unavailable'],
};

function fail(res, status, code, error) {
    return res.status(status).json({ status: 'error', code, error });
}

function respondError(res, err) {
    const [status, message] = ERRORS[err?.code] || [500, 'the request could not be completed'];
    return fail(res, status, ERRORS[err?.code] ? err.code : 'ALPACA_V2_ERROR', message);
}

const isOperator = (req) => req.auth?.type === 'session' && req.auth?.role === 'operator';
const isScopedCaller = (req) => isOperator(req) || req.auth?.role === 'alpaca-day-trading-agent';
const hashKey = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const num = (value) => (value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value));

function sanitizePlan(plan) {
    return {
        id: plan.id,
        symbol: plan.symbol,
        setup: plan.setup,
        catalyst: plan.catalyst,
        thesis: plan.thesis,
        invalidation: plan.invalidation,
        plannedQty: plan.planned_qty,
        plannedEntryPrice: plan.planned_entry_price,
        plannedStop: plan.planned_stop,
        plannedTarget: plan.planned_target,
        plannedRiskDollars: plan.planned_risk_dollars,
        exitDeadline: plan.exit_deadline,
        state: plan.state,
        attentionCode: plan.attention_code,
        filledEntryQty: plan.filled_entry_qty,
        avgEntryPrice: plan.avg_entry_price,
        filledExitQty: plan.filled_exit_qty,
        avgExitPrice: plan.avg_exit_price,
        exitReason: plan.exit_reason,
        realizedPnl: plan.realized_pnl,
        realizedR: plan.realized_r,
        createdAt: plan.created_at,
        openedAt: plan.opened_at,
        closedAt: plan.closed_at,
    };
}

function sanitizeEvent(event) {
    let detail = {};
    try { detail = JSON.parse(event.detail_json || '{}'); } catch (_error) { detail = {}; }
    return {
        planId: event.plan_id, type: event.event_type, action: event.action, outcome: event.outcome,
        reasonCode: event.reason_code, detail: defaultStore.sanitizeDetail(detail), occurredAt: event.occurred_at,
    };
}

function sanitizeFill(fill) {
    return { side: fill.side, qty: fill.qty, price: fill.price, role: fill.role, executedAt: fill.executed_at, source: fill.source };
}

function createV2Router({ store = defaultStore, createClient = createPaperClient, now = () => new Date(), policy = DEFAULT_V2_POLICY } = {}) {
    const router = express.Router();
    let execution = null;
    function getExecution() {
        if (!execution) execution = createV2Execution({ store, client: createClient(), now, policy });
        return execution;
    }

    function requireOperator(req, res) {
        if (isOperator(req)) return true;
        fail(res, 403, 'ALPACA_V2_OPERATOR_REQUIRED', 'an authenticated operator session is required');
        return false;
    }

    function requireScope(req, res) {
        if (!isScopedCaller(req)) {
            fail(res, 403, 'ALPACA_V2_SCOPE_REQUIRED', 'a scoped Day Trading credential or operator session is required');
            return false;
        }
        if (req.body?.account_id !== 2) {
            fail(res, 400, 'ALPACA_V2_ACCOUNT_SCOPE_REQUIRED', 'account_id 2 is required');
            return false;
        }
        return true;
    }

    // ---- scoped automation ----

    router.post('/entries', async (req, res) => {
        if (!requireScope(req, res)) return undefined;
        const clientOrderId = typeof req.body?.client_order_id === 'string' ? req.body.client_order_id : '';
        try {
            const result = await getExecution().submitEntry(req.body);
            const data = { planId: result.plan.id, symbol: result.plan.symbol, state: result.plan.state, outcome: result.outcome };
            if (result.outcome === 'acknowledged') return res.status(201).json({ status: 'success', data });
            if (result.outcome === 'rejected') return res.status(422).json({ status: 'error', code: 'ALPACA_V2_BROKER_REJECTED', error: 'the broker rejected this entry', data });
            if (result.outcome === 'submission_unknown') return res.status(503).json({ status: 'error', code: 'ALPACA_V2_SUBMISSION_UNKNOWN', error: 'the broker outcome is unknown; entries are blocked until an operator resolves it', data });
            if (result.outcome === 'unresolved') return res.status(409).json({ status: 'error', code: 'ALPACA_V2_SUBMISSION_UNRESOLVED', error: 'this entry could not be matched at the broker; operator attention is required', data });
            return res.status(200).json({ status: 'success', data });
        } catch (err) {
            if (err?.code && clientOrderId) {
                await store.appendEvent({
                    event_key: `entry_refused:${hashKey(clientOrderId)}:${err.code}`, event_type: 'entry_refused', action: 'submit_entry', outcome: 'refused',
                    reason_code: err.code, detail: { symbol: typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : null, qty: num(req.body?.qty) },
                    occurred_at: now().toISOString(),
                }).catch(() => {});
            }
            return respondError(res, err);
        }
    });

    router.post('/decisions', async (req, res) => {
        if (!requireScope(req, res)) return undefined;
        const decisionKey = req.body?.decision_key;
        const reasonCode = req.body?.reason_code;
        if (typeof decisionKey !== 'string' || !KEY.test(decisionKey) || typeof reasonCode !== 'string' || !/^[A-Z0-9_]{1,64}$/.test(reasonCode)) {
            return fail(res, 400, 'ALPACA_V2_DECISION_INVALID', 'decision_key and an UPPER_SNAKE reason_code are required');
        }
        try {
            const result = await store.appendEvent({
                event_key: `decision:${decisionKey}`, event_type: 'decision', action: 'no_trade', outcome: 'skipped', reason_code: reasonCode,
                detail: {
                    symbol: typeof req.body.symbol === 'string' ? req.body.symbol.toUpperCase() : null,
                    setup: req.body.setup, catalyst: req.body.catalyst, notes: req.body.notes,
                },
                occurred_at: now().toISOString(),
            });
            return res.status(result.inserted ? 201 : 200).json({ status: 'success', data: { recorded: result.inserted, replayed: !result.inserted } });
        } catch (err) {
            if (err.code === 'ALPACA_V2_EVENT_KEY_CONFLICT') return fail(res, 409, err.code, 'this decision key was already used for a different decision');
            return respondError(res, err);
        }
    });

    router.post('/plans/:id/review', async (req, res) => {
        if (!requireScope(req, res)) return undefined;
        const { revision_key: revisionKey, thesis_valid: thesisValid } = req.body || {};
        const metric = (value) => value === undefined || value === null || (typeof value === 'number' && Number.isFinite(value));
        if (typeof revisionKey !== 'string' || !KEY.test(revisionKey) || typeof thesisValid !== 'boolean' || !metric(req.body.mfe) || !metric(req.body.mae)) {
            return fail(res, 400, 'ALPACA_V2_REVIEW_INVALID', 'revision_key, boolean thesis_valid, and numeric mfe/mae are required');
        }
        try {
            const plan = /^[1-9]\d*$/.test(req.params.id) ? await store.getPlan(req.params.id) : null;
            if (!plan) return fail(res, 404, 'ALPACA_V2_PLAN_NOT_FOUND', 'no v2 plan exists with this id');
            const result = await store.appendEvent({
                event_key: `review:${plan.id}:${revisionKey}`, plan_id: plan.id, event_type: 'review', action: 'review', outcome: thesisValid ? 'thesis_valid' : 'thesis_invalid',
                detail: { symbol: plan.symbol, thesis_valid: thesisValid, mfe: req.body.mfe ?? null, mae: req.body.mae ?? null, notes: req.body.notes },
                occurred_at: now().toISOString(),
            });
            return res.status(result.inserted ? 201 : 200).json({ status: 'success', data: { planId: plan.id, recorded: result.inserted, replayed: !result.inserted } });
        } catch (err) {
            if (err.code === 'ALPACA_V2_EVENT_KEY_CONFLICT') return fail(res, 409, err.code, 'this review revision was already used for different review data');
            return respondError(res, err);
        }
    });

    // ---- operator controls ----

    router.post('/mode', async (req, res) => {
        if (!requireOperator(req, res)) return undefined;
        const { mode, confirm } = req.body || {};
        if (!MODES.includes(mode)) return fail(res, 400, 'ALPACA_V2_MODE_INVALID', `mode must be one of: ${MODES.join(', ')}`);
        const confirmed = mode === 'paper_execute' ? confirm === 'paper_execute' : (confirm === mode || confirm === true);
        if (!confirmed) return fail(res, 400, 'ALPACA_V2_CONFIRMATION_REQUIRED', mode === 'paper_execute' ? 'type paper_execute exactly to confirm' : 'explicit confirmation is required');
        try {
            const occurredAt = now().toISOString();
            const result = await store.transaction(async (repo) => {
                const previous = await repo.getMonitorState();
                const state = await repo.updateMonitorState({ mode });
                await repo.appendEvent({ event_key: `mode:${occurredAt}:${previous.mode}:${mode}`, event_type: 'mode_change', action: 'set_mode', outcome: mode, reason_code: 'OPERATOR_CONFIRMED', detail: { from: previous.mode, to: mode }, occurred_at: occurredAt });
                return state;
            });
            return res.json({ status: 'success', data: { mode: result.mode } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    async function brokerAccountView(client) {
        const [positions, openOrders] = await Promise.all([client.getPositions(), client.getOrders({ status: 'open' })]);
        return { positions: Array.isArray(positions) ? positions : [], openOrders: Array.isArray(openOrders) ? openOrders : [] };
    }

    // CLEAR needs proof, not just say-so: no unresolved plan, and a fresh read-only broker pass
    // in which every position and open order belongs to a nonterminal v2 plan.
    router.post('/kill-switch/clear', async (req, res) => {
        if (!requireOperator(req, res)) return undefined;
        if (req.body?.confirm !== 'CLEAR') return fail(res, 400, 'ALPACA_V2_CONFIRMATION_REQUIRED', 'type CLEAR exactly to confirm');
        const occurredAt = now().toISOString();
        try {
            const plans = await store.listNonterminalPlans();
            if (plans.some((plan) => UNRESOLVED_STATES.includes(plan.state))) {
                await store.appendEvent({ event_key: `kill_switch_clear:refused:${occurredAt}`, event_type: 'kill_switch', action: 'clear', outcome: 'refused', reason_code: 'PLAN_UNRESOLVED', occurred_at: occurredAt });
                return fail(res, 409, 'ALPACA_V2_ATTENTION_UNRESOLVED', 'a v2 plan still needs operator resolution');
            }
            let view;
            try { view = await brokerAccountView(createClient()); } catch (_error) {
                return fail(res, 503, 'ALPACA_V2_BROKER_UNAVAILABLE', 'the broker could not be read; nothing was cleared');
            }
            const symbols = new Set(plans.map((plan) => plan.symbol));
            const owned = new Set(plans.flatMap((plan) => [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id]).filter(Boolean));
            const ownedClientIds = new Set(plans.flatMap((plan) => [plan.client_order_id, timeExitClientOrderId(plan)]));
            const untracked = view.positions.some((position) => !symbols.has(String(position.symbol).toUpperCase()))
                || view.openOrders.some((order) => !owned.has(order.id) && !ownedClientIds.has(order.client_order_id));
            if (untracked) {
                await store.appendEvent({ event_key: `kill_switch_clear:refused:${occurredAt}`, event_type: 'kill_switch', action: 'clear', outcome: 'refused', reason_code: 'ACCOUNT_NOT_RECONCILED', occurred_at: occurredAt });
                return fail(res, 409, 'ALPACA_V2_ACCOUNT_NOT_RECONCILED', 'the broker shows exposure no v2 plan accounts for; nothing was cleared');
            }
            await store.transaction(async (repo) => {
                await repo.updateMonitorState({ kill_switch: 0, attention_required: 0, attention_code: null });
                await repo.appendEvent({ event_key: `kill_switch_clear:cleared:${occurredAt}`, event_type: 'kill_switch', action: 'clear', outcome: 'cleared', reason_code: 'ACCOUNT_CONFIRMED', occurred_at: occurredAt });
            });
            return res.json({ status: 'success', data: { killSwitch: false, attentionRequired: false } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    // Operator acknowledgement for a plan the monitor cannot close on its own (e.g. a submission
    // that was never found). Read-only at the broker; only allowed once nothing is exposed.
    router.post('/plans/:id/resolve', async (req, res) => {
        if (!requireOperator(req, res)) return undefined;
        try {
            const plan = /^[1-9]\d*$/.test(req.params.id) ? await store.getPlan(req.params.id) : null;
            if (!plan) return fail(res, 404, 'ALPACA_V2_PLAN_NOT_FOUND', 'no v2 plan exists with this id');
            if (defaultStore.TERMINAL_STATES.includes(plan.state)) return fail(res, 409, 'ALPACA_V2_PLAN_TERMINAL', 'this plan is already closed');
            if (req.body?.confirm !== plan.symbol) return fail(res, 400, 'ALPACA_V2_CONFIRMATION_REQUIRED', 'type the plan symbol exactly to confirm');
            let position; let openOrders; let parent;
            try {
                const client = createClient();
                [position, openOrders] = await Promise.all([client.getPosition(plan.symbol), client.getOrders({ status: 'open' })]);
                if (plan.parent_order_id) parent = await client.getOrder(plan.parent_order_id, { nested: true });
                else parent = (await client.getOrderByClientOrderId(plan.client_order_id))?.order || null;
            } catch (_error) {
                return fail(res, 503, 'ALPACA_V2_BROKER_UNAVAILABLE', 'the broker could not be read; nothing was resolved');
            }
            const legs = Array.isArray(parent?.legs) ? parent.legs : [];
            const executable = [parent, ...legs].some((order) => order && !NON_EXECUTABLE.includes(order.status));
            if (num(position?.qty) || executable || (openOrders || []).some((order) => String(order.symbol).toUpperCase() === plan.symbol)) {
                return fail(res, 409, 'ALPACA_V2_NOT_FLAT', 'the broker still shows a position or working order for this symbol');
            }
            const entered = Math.max(plan.filled_entry_qty, num(parent?.filled_qty) || 0);
            const state = entered > 0 ? 'closed' : 'cancelled';
            const balanced = entered > 0 && plan.filled_exit_qty === entered && plan.filled_entry_qty === entered;
            const realizedPnl = balanced ? Math.round((plan.avg_exit_price - plan.avg_entry_price) * entered * 100) / 100 : null;
            const updated = await store.updatePlan(plan.id, {
                state, closed_at: now().toISOString(), ...(state === 'closed' ? { exit_reason: 'operator_resolved', realized_pnl: realizedPnl } : {}),
            }, {
                events: [{ event_key: `plan:${plan.id}:operator_resolved`, event_type: 'closure', action: 'operator_resolved', outcome: state, reason_code: plan.attention_code || 'OPERATOR_RESOLVED', detail: { symbol: plan.symbol, filled_qty: entered }, occurred_at: now().toISOString() }],
            });
            return res.json({ status: 'success', data: { plan: sanitizePlan(updated) } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    // ---- readers ----

    router.get('/status', async (_req, res) => {
        try {
            const [state, plans] = await Promise.all([store.getMonitorState(), store.listNonterminalPlans()]);
            const heartbeat = state.last_reconciled_at ? new Date(state.last_reconciled_at).getTime() : NaN;
            return res.json({ status: 'success', data: {
                mode: state.mode,
                killSwitch: Boolean(state.kill_switch),
                attentionRequired: Boolean(state.attention_required),
                attentionCode: state.attention_code,
                lastReconciledAt: state.last_reconciled_at,
                lastWebsocketAt: state.last_websocket_at,
                sessionDate: state.session_date,
                heartbeatFresh: now().getTime() - heartbeat <= ENTRY_HEARTBEAT_MAX_AGE_MS,
                openPlanCount: plans.length,
                attentionPlanCount: plans.filter((plan) => plan.state === 'attention_required').length,
            } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    router.get('/snapshot', async (_req, res) => {
        let account; let clock; let positions; let openOrders;
        try {
            const client = createClient();
            [account, clock, positions, openOrders] = await Promise.all([client.getAccount(), client.getClock(), client.getPositions(), client.getOrders({ status: 'open' })]);
        } catch (_error) {
            return fail(res, 503, 'ALPACA_V2_BROKER_UNAVAILABLE', 'the broker snapshot is unavailable');
        }
        try {
            const plans = await store.listNonterminalPlans();
            const owned = new Set(plans.flatMap((plan) => [plan.parent_order_id, plan.stop_order_id, plan.target_order_id, plan.exit_order_id]).filter(Boolean));
            const planFor = (symbol) => plans.find((plan) => plan.symbol === String(symbol).toUpperCase()) || null;
            return res.json({ status: 'success', data: {
                account: { cash: num(account?.cash), equity: num(account?.equity), status: typeof account?.status === 'string' ? account.status : null },
                clock: { isOpen: Boolean(clock?.is_open), nextOpen: clock?.next_open ?? null, nextClose: clock?.next_close ?? null },
                positions: (positions || []).map((position) => ({
                    symbol: String(position.symbol), qty: num(position.qty), side: position.side === 'short' ? 'short' : 'long',
                    avgEntryPrice: num(position.avg_entry_price), currentPrice: num(position.current_price),
                    marketValue: num(position.market_value), unrealizedPnl: num(position.unrealized_pl),
                    planId: planFor(position.symbol)?.id ?? null,
                })),
                openOrders: (openOrders || []).map((order) => ({
                    symbol: String(order.symbol), side: order.side === 'sell' ? 'sell' : 'buy', type: typeof order.type === 'string' ? order.type : null,
                    qty: num(order.qty), filledQty: num(order.filled_qty), status: typeof order.status === 'string' ? order.status : null,
                    limitPrice: num(order.limit_price), stopPrice: num(order.stop_price), planOwned: owned.has(order.id),
                })),
                limits: { ...policy },
            } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    router.get('/plans', async (req, res) => {
        try {
            const state = typeof req.query?.state === 'string' ? req.query.state : null;
            const plans = await store.listPlans(state ? { states: [state] } : {});
            return res.json({ status: 'success', data: plans.map(sanitizePlan) });
        } catch (err) {
            return respondError(res, err);
        }
    });

    router.get('/plans/:id', async (req, res) => {
        try {
            const plan = /^[1-9]\d*$/.test(req.params.id) ? await store.getPlan(req.params.id) : null;
            if (!plan) return fail(res, 404, 'ALPACA_V2_PLAN_NOT_FOUND', 'no v2 plan exists with this id');
            const [fills, events] = await Promise.all([store.listFills({ planId: plan.id }), store.listEvents(plan.id)]);
            return res.json({ status: 'success', data: { plan: sanitizePlan(plan), fills: fills.map(sanitizeFill), events: events.map(sanitizeEvent) } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    router.get('/journal', async (_req, res) => {
        try {
            const [plans, events] = await Promise.all([store.listPlans(), store.listEvents()]);
            return res.json({ status: 'success', data: {
                analytics: computeV2Analytics({ plans, events }), trades: plans.map(sanitizePlan), events: events.map(sanitizeEvent),
            } });
        } catch (err) {
            return respondError(res, err);
        }
    });

    return router;
}

module.exports = { createV2Router, sanitizePlan, sanitizeEvent };
