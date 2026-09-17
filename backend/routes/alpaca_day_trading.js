const express = require('express');
const { executeDayTradeEntry } = require('../services/alpaca_day_trade_execution');
const { createPaperClient } = require('../services/alpaca_paper_service');
const store = require('../services/alpaca_day_trade_store');
const { DEFAULT_DAY_TRADE_POLICY } = require('../services/alpaca_day_trade_order_policy');

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

module.exports = router;
