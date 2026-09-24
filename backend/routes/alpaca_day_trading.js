const express = require('express');
const { createPaperClient } = require('../services/alpaca_paper_service');
const store = require('../services/alpaca_day_trade_store');
const { DEFAULT_DAY_TRADE_POLICY } = require('../services/alpaca_day_trade_order_policy');
const { buildObservation } = require('../services/alpaca_fill_reconciliation');
const { DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');
const { computeDayTradeJournalAnalytics, computeDailyRealizedPnl } = require('../services/alpaca_day_trade_journal');

const TERMINAL_PLAN_STATES = ['closed', 'cancelled', 'error'];

const router = express.Router();

// v1 is retired: this router is read-only historical visibility. Every former mutation is
// refused before any store write or broker client construction; the v2 strategy lab lives
// under /v2 and never shares a submit path with this module.
const V1_RETIRED_POSTS = ['/entries', '/decisions', '/mode', '/resolve-missing', '/kill-switch/clear', '/plans/:id/review'];
router.post(V1_RETIRED_POSTS, (_req, res) => res.status(410).json({
    status: 'error', code: 'ALPACA_V1_RETIRED', error: 'Alpaca Day Trading v1 is retired and read-only; use the v2 strategy lab',
}));

// Invariant #16 (private identifiers): readers get a generic phrase and the code only.
function respondWithError(res, err) {
    const status = err.code === 'ALPACA_NOT_CONFIGURED' ? 503 : 500;
    return res.status(status).json({ status: 'error', code: err.code || 'ALPACA_DAY_TRADING_ERROR', error: 'Day Trading history is unavailable' });
}

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
        const [plans, semanticEvents, orderAudits] = await Promise.all([
            store.listPlans(null), store.listEvents(), store.listOrderAudits(),
        ]);
        const fills = (await Promise.all(plans.map((plan) => store.listFillsForPlan(plan.id)))).flat();
        const events = [
            ...semanticEvents.map((event) => ({
                source: 'semantic', eventKey: event.event_key, planId: event.plan_id, eventType: event.event_type,
                action: event.action, outcome: event.outcome, reason: event.reason,
                detail: JSON.parse(event.detail_json || '{}'), occurredAt: event.occurred_at,
            })),
            ...orderAudits.filter((audit) => audit.execution_epoch === 'day_trading').map((audit) => ({
                source: 'order_audit', planId: audit.plan_id, eventType: 'order', action: audit.leg_role,
                outcome: audit.status, reason: null,
                detail: { symbol: audit.symbol, side: audit.side, qty: audit.qty, orderType: audit.order_type, legRole: audit.leg_role },
                occurredAt: audit.created_at,
            })),
            ...fills.map((fill) => ({
                source: 'fill', planId: fill.plan_id, eventType: 'fill', action: fill.side, outcome: fill.fill_type, reason: null,
                detail: { symbol: fill.symbol, side: fill.side, qty: fill.qty, price: fill.price, source: fill.source, isBust: Boolean(fill.is_bust) },
                occurredAt: fill.executed_at,
            })),
        ].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
        return res.json({ status: 'success', data: {
            analytics: computeDayTradeJournalAnalytics(plans), trades: plans.map(sanitizePlan), events,
        } });
    } catch (err) {
        return respondWithError(res, err);
    }
});

module.exports = router;
