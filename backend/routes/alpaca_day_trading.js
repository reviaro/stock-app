const express = require('express');
const { executeDayTradeEntry } = require('../services/alpaca_day_trade_execution');
const { createPaperClient, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
const store = require('../services/alpaca_day_trade_store');
const { DEFAULT_DAY_TRADE_POLICY } = require('../services/alpaca_day_trade_order_policy');
const { reconcileFills, buildObservation } = require('../services/alpaca_fill_reconciliation');
const { decidePlanAction, DEFAULT_MONITOR_POLICY } = require('../services/alpaca_day_trade_monitor');

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

module.exports = router;
