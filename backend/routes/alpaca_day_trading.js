const express = require('express');
const { executeDayTradeEntry } = require('../services/alpaca_day_trade_execution');
const { createPaperClient, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
const store = require('../services/alpaca_day_trade_store');
const { DEFAULT_DAY_TRADE_POLICY } = require('../services/alpaca_day_trade_order_policy');
const { reconcileFills, buildObservation } = require('../services/alpaca_fill_reconciliation');
const { decidePlanAction, DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');
const { computeDayTradeJournalAnalytics, computeDailyRealizedPnl } = require('../services/alpaca_day_trade_journal');

const VALID_MODES = ['disabled', 'shadow', 'paper_execute'];
const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

const router = express.Router();

// A separate gate/token from the generic paper-order pair (ALPACA_PAPER_ORDER_ENTRY_*):
// one flag controlling two different submission contracts (a raw simple order vs. a
// server-constructed bracket) is exactly the conflation that would let enabling one
// accidentally enable the other.
function dayTradingGateOpen(req) {
    const token = process.env.ALPACA_DAY_TRADING_ENTRY_TOKEN;
    return process.env.ALPACA_DAY_TRADING_ENTRY_ENABLED === 'true'
        && Boolean(token)
        && req.get('X-Alpaca-Day-Trading-Token') === token;
}

// Invariant #16 (private identifiers): the response carries only the generic phrase and the
// error code, never the underlying Error#message — Task 7's policy messages embed computed
// account figures (e.g. "position value would be 30.15% of equity"), which is account state a
// caller must not see.
const ERROR_RESPONSES = {
    ALPACA_INTENT_FIELD_NOT_ALLOWED: [400, 'the entry request included a field that is not permitted'],
    ALPACA_QTY_INVALID: [400, 'invalid share quantity'],
    ALPACA_PRICE_INVALID: [400, 'invalid stop or target price'],
    ALPACA_PRICE_NOT_TICK_ALIGNED: [400, 'stop or target price is not aligned to the exchange tick size'],
    ALPACA_BRACKET_GEOMETRY_INVALID: [400, 'stop and target prices are not valid for this entry'],
    ALPACA_SYMBOL_REQUIRED: [400, 'a symbol is required'],
    ALPACA_SYMBOL_MISMATCH: [400, 'symbol mismatch'],
    ALPACA_ENTRY_SIDE_UNSUPPORTED: [400, 'unsupported entry side'],
    ALPACA_CLIENT_ORDER_ID_REQUIRED: [400, 'a client order id is required'],
    ALPACA_ASSET_NOT_TRADABLE: [400, 'symbol is not tradable'],
    ALPACA_INSUFFICIENT_CASH: [400, 'insufficient cash for this entry'],
    ALPACA_POSITION_LIMIT_EXCEEDED: [400, 'position size exceeds the account risk policy'],
    ALPACA_RISK_PER_TRADE_EXCEEDED: [400, 'planned risk exceeds the per-trade risk policy'],
    ALPACA_TOTAL_OPEN_RISK_EXCEEDED: [400, 'planned risk exceeds the total open-risk policy'],
    ALPACA_MIN_CASH_RESERVE_BREACHED: [400, 'entry would breach the minimum cash reserve policy'],
    ALPACA_ACCOUNT_NOT_TRADABLE: [403, 'the Alpaca account is not available for trading'],
    ALPACA_ENTRIES_DISABLED: [403, 'Day Trading entries are currently disabled'],
    ALPACA_DAILY_LOSS_LIMIT_BREACHED: [403, 'the daily loss limit has been reached'],
    ALPACA_MARKET_CLOSED: [409, 'the market is not open for new entries'],
    ALPACA_ENTRY_CUTOFF_PASSED: [409, 'the entry cutoff for today has passed'],
    ALPACA_DUPLICATE_SYMBOL_PLAN: [409, 'a Day Trading plan already exists for this symbol'],
    ALPACA_RECONCILIATION_REQUIRED: [409, 'a prior Day Trading order must be reconciled before a new entry'],
    ALPACA_IDEMPOTENCY_KEY_CONFLICT: [409, 'this client order id was already used for a different entry'],
    ALPACA_BROKER_REJECTED: [502, 'the broker rejected this entry'],
    ALPACA_SUBMISSION_UNKNOWN: [503, 'the broker submission outcome is unknown; reconciliation is required'],
    ALPACA_LEASE_UNAVAILABLE: [503, 'the Day Trading submission system is busy; try again shortly'],
    ALPACA_CLOCK_UNAVAILABLE: [503, 'the market clock is unavailable'],
    ALPACA_ACCOUNT_EQUITY_UNAVAILABLE: [503, 'account equity is unavailable'],
    ALPACA_COMMITMENT_UNAVAILABLE: [503, 'unable to determine account commitments'],
    ALPACA_PLAN_NOT_FOUND: [503, 'plan lookup failed; reconciliation is required'],
    ALPACA_NOT_CONFIGURED: [503, 'the Alpaca paper account is unavailable'],
};

function respondWithError(res, err) {
    const code = err.code && err.code.startsWith('ALPACA_QUOTE_') ? 'ALPACA_QUOTE_UNAVAILABLE' : err.code;
    const [status, message] = ERROR_RESPONSES[code] || (err.code && err.code.startsWith('ALPACA_QUOTE_')
        ? [503, 'market data for this symbol is currently unavailable']
        : [500, 'Day Trading entry submission failed']);
    return res.status(status).json({ status: 'error', code: err.code || 'ALPACA_DAY_TRADING_ERROR', error: message });
}

router.post('/entries', async (req, res) => {
    if (!dayTradingGateOpen(req)) {
        return res.status(403).json({ status: 'error', code: 'ALPACA_DAY_TRADING_ENTRY_DISABLED', error: 'Day Trading entry submission is disabled' });
    }
    if (Number(req.body?.account_id) !== 2) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_ACCOUNT_SCOPE_REQUIRED', error: 'account_id 2 is required for Day Trading strategy requests' });
    }
    const clientOrderId = String(req.body?.client_order_id || '').trim();
    if (!clientOrderId || !clientOrderId.startsWith('dt-')) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_CLIENT_ORDER_ID_REQUIRED', error: 'a client order id in the "dt-..." format is required' });
    }

    // account_id and client_order_id are route/execution-scoping concerns, not part of Task
    // 7's order-construction intent (its ALLOWED_INTENT_FIELDS allowlist excludes both) — left
    // in place, a well-formed Section 7 request would otherwise be rejected outright.
    const { account_id: _accountId, client_order_id: _clientOrderId, ...intent } = req.body || {};

    try {
        // alpaca_monitor_state.mode is the single switch Task 11/13's monitor will also read
        // (disabled|shadow|paper_execute) — a dashboard-triggered entry must respect the same
        // "can this system submit real orders at all" state as the automated worker, rather
        // than a second, independently-configured flag that could disagree with it.
        const monitorState = await store.getMonitorState();
        const policy = { ...DEFAULT_DAY_TRADE_POLICY, entriesEnabled: monitorState?.mode === 'paper_execute' };
        const result = await executeDayTradeEntry({
            intent,
            clientOrderId,
            client: createPaperClient(),
            holderId: `web-${process.pid}`,
            policy,
        });
        return res.status(result.replayed ? 200 : 201).json({
            status: 'success',
            data: {
                planId: result.plan.id,
                symbol: result.plan.symbol,
                state: result.plan.state,
                clientOrderId,
                orderStatus: result.order.status,
                replayed: Boolean(result.replayed),
            },
        });
    } catch (err) {
        return respondWithError(res, err);
    }
});

// Deliberately independent of kill_switch: gating mode here on the switch would deadlock the
// system (no clear mechanism exists yet, so mode could never return to paper_execute after a
// trip). Task 13's worker already checks kill_switch at the top of every tick and refuses to
// act while it's set, so mode=paper_execute with kill_switch=true is inert, not unsafe.
router.post('/mode', async (req, res) => {
    if (!dayTradingGateOpen(req)) {
        return res.status(403).json({ status: 'error', code: 'ALPACA_DAY_TRADING_ENTRY_DISABLED', error: 'Day Trading entry submission is disabled' });
    }
    const mode = String(req.body?.mode || '').trim();
    if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_MODE_INVALID', error: `mode must be one of: ${VALID_MODES.join(', ')}` });
    }
    if (req.body?.confirm !== true) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_CONFIRMATION_REQUIRED', error: 'explicit confirmation is required to change the Day Trading monitor mode' });
    }
    try {
        await store.updateMonitorState({ mode });
        const state = await store.getMonitorState();
        return res.json({ status: 'success', data: { mode: state.mode, killSwitch: Boolean(state.kill_switch) } });
    } catch (err) {
        return respondWithError(res, err);
    }
});

// Alpaca's own order status strings the rest of this codebase already treats as "not yet
// resolved" (Task 8's UNRESOLVED_ORDER_STATUSES) -- duplicated here rather than imported so the
// route can distinguish "not found" / "wrong epoch" / "already resolved" from resolveMissing-
// PaperOrderAudit's own plain, uncoded errors, which would otherwise all collapse into one
// generic refusal. Same defense-in-depth shape as Task 7's duplicate-symbol check sitting in
// front of Task 4's unique index: this duplicates a check the service also performs.
const UNRESOLVED_STATUSES = ['pending_submission', 'submission_unknown', 'submission_failed'];

router.post('/resolve-missing', async (req, res) => {
    if (!dayTradingGateOpen(req)) {
        return res.status(403).json({ status: 'error', code: 'ALPACA_DAY_TRADING_ENTRY_DISABLED', error: 'Day Trading entry submission is disabled' });
    }
    const key = String(req.body?.idempotency_key || '').trim();
    if (!key || req.body?.confirm_not_found !== true) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_CONFIRMATION_REQUIRED', error: 'an idempotency key and explicit confirmation are required' });
    }

    const audit = await store.getOrderAuditByIdempotencyKey(key);
    if (!audit) {
        return res.status(404).json({ status: 'error', code: 'ALPACA_ORDER_NOT_FOUND', error: 'no Day Trading order audit exists for this key' });
    }
    if (audit.execution_epoch !== 'day_trading') {
        return res.status(400).json({ status: 'error', code: 'ALPACA_ACCOUNT_SCOPE_REQUIRED', error: 'this key does not belong to a Day Trading order' });
    }
    if (!UNRESOLVED_STATUSES.includes(audit.status)) {
        return res.status(409).json({ status: 'error', code: 'ALPACA_ORDER_ALREADY_RESOLVED', error: 'this order is not in an unresolved state' });
    }

    try {
        const result = await resolveMissingPaperOrderAudit({
            idempotencyKey: key,
            confirmed: true,
            expectedEpoch: 'day_trading',
        });
        return res.json({ status: 'success', data: result });
    } catch (_err) {
        // The remaining failure modes here are exactly two: Alpaca still reports the order as
        // live (the one case where resolving would be genuinely dangerous) or the broker could
        // not be reached -- both are correctly generic-but-distinct from the input-shape errors
        // already handled above.
        return res.status(502).json({ status: 'error', code: 'ALPACA_ORDER_STILL_LIVE_OR_UNREACHABLE', error: 'Alpaca still reports this order, or the broker could not be reached; resolution refused' });
    }
});

// Clearing requires proof, not just an operator's say-so (explicit user decision): a fresh
// reconciliation followed by the exact same per-plan decision Task 13's worker uses every
// tick. If any nonterminal plan would need anything other than 'none' -- a repair, a flatten,
// even a stale partial-entry cancel -- the account is not settled, and the switch stays set.
// brokerUnavailable is checked explicitly and separately: decidePlanAction already fails that
// observation closed to 'none', which this loop would otherwise misread as "safe" -- the exact
// inversion of what a broker outage during a safety check must mean.
router.post('/kill-switch/clear', async (req, res) => {
    if (!dayTradingGateOpen(req)) {
        return res.status(403).json({ status: 'error', code: 'ALPACA_DAY_TRADING_ENTRY_DISABLED', error: 'Day Trading entry submission is disabled' });
    }
    if (req.body?.confirm !== true) {
        return res.status(400).json({ status: 'error', code: 'ALPACA_CONFIRMATION_REQUIRED', error: 'explicit confirmation is required to clear the kill switch' });
    }

    try {
        const client = createPaperClient();
        await reconcileFills({ client, store });

        const plans = (await store.listPlans(null)).filter((plan) => !TERMINAL_PLAN_STATES.includes(plan.state));
        for (const plan of plans) {
            const observation = await buildObservation(plan, { client, policy: DEFAULT_MONITOR_POLICY, now: () => new Date() });
            if (observation.brokerUnavailable) {
                return res.status(503).json({ status: 'error', code: 'ALPACA_ACCOUNT_STATE_UNVERIFIABLE', error: 'the broker could not be reached to verify the account is safe; the kill switch was not cleared' });
            }
            const decision = decidePlanAction(observation);
            if (decision.action !== 'none') {
                return res.status(409).json({ status: 'error', code: 'ALPACA_ACCOUNT_NOT_CONFIRMED_SAFE', error: 'the account is not confirmed flat or fully covered; the kill switch was not cleared' });
            }
        }

        await store.updateMonitorState({ kill_switch: false });
        return res.json({ status: 'success', data: { killSwitch: false } });
    } catch (err) {
        return respondWithError(res, err);
    }
});

// Sanitized per Invariant #16 and Task 9's own precedent: our own identifiers (plan id) and
// every planning/outcome field, never a raw broker order id.
function sanitizePlan(plan) {
    return {
        id: plan.id,
        symbol: plan.symbol,
        setup: plan.setup,
        catalyst: plan.catalyst,
        thesis: plan.thesis,
        invalidation: plan.invalidation,
        plannedEntryLow: plan.planned_entry_low,
        plannedEntryHigh: plan.planned_entry_high,
        plannedStop: plan.planned_stop,
        plannedTarget: plan.planned_target,
        plannedQty: plan.planned_qty,
        plannedRiskDollars: plan.planned_risk_dollars,
        plannedRewardRisk: plan.planned_reward_risk,
        plannedAccountRiskPct: plan.planned_account_risk_pct,
        state: plan.state,
        filledEntryQty: plan.filled_entry_qty,
        avgEntryPrice: plan.avg_entry_price,
        filledExitQty: plan.filled_exit_qty,
        avgExitPrice: plan.avg_exit_price,
        exitDeadline: plan.exit_deadline,
        exitReason: plan.exit_reason,
        realizedPnl: plan.realized_pnl,
        realizedR: plan.realized_r,
        mfe: plan.mfe,
        mae: plan.mae,
        thesisValid: plan.thesis_valid == null ? null : Boolean(plan.thesis_valid),
        reviewNotes: plan.review_notes,
        strategyVersion: plan.strategy_version,
        createdAt: plan.created_at,
        openedAt: plan.opened_at,
        closedAt: plan.closed_at,
    };
}

function sanitizeFill(fill) {
    return {
        activityId: fill.activity_id,
        symbol: fill.symbol,
        side: fill.side,
        qty: fill.qty,
        price: fill.price,
        executedAt: fill.executed_at,
        fillType: fill.fill_type,
        source: fill.source,
        isBust: Boolean(fill.is_bust),
        correctionOf: fill.correction_of,
    };
}

// Reads only local state -- never calls the broker -- so this stays answerable during an
// outage, which is exactly when an operator most needs to see it.
router.get('/monitor-health', async (_req, res) => {
    try {
        const state = await store.getMonitorState();
        return res.json({
            status: 'success',
            data: {
                mode: state?.mode ?? null,
                killSwitch: Boolean(state?.kill_switch),
                healthCode: state?.health_code ?? null,
                healthError: state?.health_error ?? null,
                lastRestReconciliationAt: state?.last_rest_reconciliation_at ?? null,
                lastWebsocketEventAt: state?.last_websocket_event_at ?? null,
                lastWebsocketReconnectAt: state?.last_websocket_reconnect_at ?? null,
                lastSyncedThrough: state?.activity_cursor ?? null,
                sessionDate: state?.session_date ?? null,
                lastFlattenSweepAt: state?.last_flatten_sweep_at ?? null,
            },
        });
    } catch (err) {
        return respondWithError(res, err);
    }
});

router.get('/snapshot', async (_req, res) => {
    try {
        const client = createPaperClient();
        const [account, clock, positions, allPlans, monitorState] = await Promise.all([
            client.getAccount(),
            client.getClock(),
            client.getPositions(),
            store.listPlans(null),
            store.getMonitorState(),
        ]);

        const nonterminalPlans = allPlans.filter((plan) => !TERMINAL_PLAN_STATES.includes(plan.state));
        const equity = Number(account?.equity);

        const positionsWithTracking = positions.map((position) => {
            const trackedPlan = nonterminalPlans.find((plan) => plan.symbol === position.symbol);
            return {
                symbol: position.symbol,
                qty: position.qty,
                avgEntryPrice: position.avg_entry_price,
                currentPrice: position.current_price,
                marketValue: position.market_value,
                unrealizedPnl: position.unrealized_pl,
                unrealizedPnlPct: position.unrealized_plpc,
                side: position.side,
                tracked: Boolean(trackedPlan),
                planId: trackedPlan ? trackedPlan.id : null,
            };
        });

        const totalOpenRiskDollars = nonterminalPlans.reduce((total, plan) => total + Number(plan.planned_risk_dollars || 0), 0);

        // session_date has no writer yet anywhere in the system (a known, separately-tracked
        // gap) -- reported honestly as unavailable rather than silently substituting a UTC-date
        // slice the way the entry-time safety check still does for its own, different reasons.
        const sessionDate = monitorState?.session_date ?? null;
        const dailyRealizedPnl = sessionDate ? computeDailyRealizedPnl(allPlans, sessionDate) : null;

        return res.json({
            status: 'success',
            data: {
                account: { cash: account.cash, equity: account.equity, buyingPower: account.buying_power, status: account.status },
                clock: { isOpen: clock.is_open, nextOpen: clock.next_open, nextClose: clock.next_close },
                positions: positionsWithTracking,
                activePlans: nonterminalPlans.map(sanitizePlan),
                risk: {
                    equity: account.equity,
                    cashPct: Number.isFinite(equity) && equity > 0 ? Number(account.cash) / equity : null,
                    totalOpenRiskDollars,
                    totalOpenRiskPct: Number.isFinite(equity) && equity > 0 ? totalOpenRiskDollars / equity : null,
                    dailyRealizedPnl,
                    dailyLossPct: dailyRealizedPnl != null && Number.isFinite(equity) && equity > 0 && dailyRealizedPnl < 0
                        ? Math.abs(dailyRealizedPnl) / equity : (dailyRealizedPnl == null ? null : 0),
                    dailyPnlUnavailableReason: sessionDate ? undefined : 'the current NYSE session date has not been recorded yet',
                    limits: {
                        maxPositionPct: DEFAULT_DAY_TRADE_POLICY.maxPositionPct,
                        minCashPct: DEFAULT_DAY_TRADE_POLICY.minCashPct,
                        maxRiskPerTradePct: DEFAULT_DAY_TRADE_POLICY.maxRiskPerTradePct,
                        maxTotalOpenRiskPct: DEFAULT_DAY_TRADE_POLICY.maxTotalOpenRiskPct,
                        maxDailyLossPct: DEFAULT_DAY_TRADE_POLICY.maxDailyLossPct,
                    },
                },
                monitorHealth: {
                    mode: monitorState?.mode ?? null,
                    killSwitch: Boolean(monitorState?.kill_switch),
                    healthCode: monitorState?.health_code ?? null,
                    healthError: monitorState?.health_error ?? null,
                    lastRestReconciliationAt: monitorState?.last_rest_reconciliation_at ?? null,
                },
            },
        });
    } catch (err) {
        return respondWithError(res, err);
    }
});

router.get('/plans', async (req, res) => {
    try {
        const state = req.query?.state ? String(req.query.state) : null;
        const plans = await store.listPlans(state);
        return res.json({ status: 'success', data: plans.map(sanitizePlan) });
    } catch (err) {
        return respondWithError(res, err);
    }
});

// Only ever null (never fetched) for a terminal plan or one with no entry submitted yet -- a
// closed/cancelled/errored plan has no live orders by definition, which is a different fact
// than "couldn't check," so it must not collapse into the same `unavailable: true` shape a
// broker outage produces. Reuses buildObservation (Task 11/13/14's one definition of "fresh
// broker state for a plan") rather than re-deriving legs here a second way.
async function fetchLiveOrders(plan) {
    if (TERMINAL_PLAN_STATES.includes(plan.state) || !plan.entry_parent_broker_order_id) return null;
    try {
        const client = createPaperClient();
        const observation = await buildObservation(plan, { client, policy: DEFAULT_MONITOR_POLICY, now: () => new Date() });
        if (observation.brokerUnavailable) return { unavailable: true };
        return {
            unavailable: false,
            entry: observation.entryOrder ? {
                status: observation.entryOrder.status,
                qty: observation.entryOrder.qty,
                filledQty: observation.entryOrder.filled_qty,
                submittedAt: observation.entryOrder.submitted_at,
            } : null,
            stopLeg: observation.stopLeg ? {
                status: observation.stopLeg.status,
                stopPrice: observation.stopLeg.stop_price != null ? Number(observation.stopLeg.stop_price) : null,
                filledQty: Number(observation.stopLeg.filled_qty || 0),
            } : null,
            targetLeg: observation.targetLeg ? {
                status: observation.targetLeg.status,
                limitPrice: observation.targetLeg.limit_price != null ? Number(observation.targetLeg.limit_price) : null,
                filledQty: Number(observation.targetLeg.filled_qty || 0),
            } : null,
        };
    } catch (_err) {
        // Alpaca not configured at all collapses into the same shape as a broker outage: from
        // the dashboard's point of view both mean "the account owner's own plan/fill data is
        // still shown below, but its live order legs cannot be confirmed right now."
        return { unavailable: true };
    }
}

router.get('/plans/:id', async (req, res) => {
    try {
        const plan = await store.getPlan(req.params.id);
        if (!plan) {
            return res.status(404).json({ status: 'error', code: 'ALPACA_PLAN_NOT_FOUND', error: 'no Day Trading plan exists with this id' });
        }
        const fills = await store.listFillsForPlan(plan.id);
        const liveOrders = await fetchLiveOrders(plan);
        return res.json({ status: 'success', data: { plan: sanitizePlan(plan), fills: fills.map(sanitizeFill), liveOrders } });
    } catch (err) {
        return respondWithError(res, err);
    }
});

router.get('/journal', async (_req, res) => {
    try {
        const plans = await store.listPlans(null);
        return res.json({ status: 'success', data: computeDayTradeJournalAnalytics(plans) });
    } catch (err) {
        return respondWithError(res, err);
    }
});

module.exports = router;
