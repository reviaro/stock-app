const express = require('express');
const { getPaperConfiguration, getPaperAccountSummary, getPaperReconciliationSnapshot, submitPaperOrder, reconcilePaperOrderAudits, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');
const dayTradeStore = require('../services/alpaca_day_trade_store');
const dayTradeV2Store = require('../services/alpaca_day_trade_v2_store');

const router = express.Router();

router.get('/status', async (_req, res) => {
    try {
        const config = getPaperConfiguration();
        const account = config.configured ? await getPaperAccountSummary() : {};
        res.json({
            status: 'success',
            data: {
                ...config,
                ...account,
                orderEntryEnabled: process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED === 'true'
                    && Boolean(process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN),
            },
        });
    } catch (err) {
        res.status(503).json({ status: 'error', error: 'Alpaca paper account is unavailable' });
    }
});

router.get('/snapshot', async (_req, res) => {
    try {
        const config = getPaperConfiguration();
        if (!config.configured) {
            return res.status(503).json({ status: 'error', error: 'Alpaca paper account is unavailable' });
        }
        const snapshot = await getPaperReconciliationSnapshot();
        return res.json({ status: 'success', data: snapshot });
    } catch (_err) {
        return res.status(503).json({ status: 'error', error: 'Alpaca paper account is unavailable' });
    }
});

router.post('/reconcile', async (req, res) => {
    const orderEntryToken = process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;
    if (process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED !== 'true'
        || !orderEntryToken
        || req.get('X-Alpaca-Paper-Order-Token') !== orderEntryToken) {
        return res.status(403).json({ status: 'error', error: 'Alpaca paper order entry is disabled' });
    }
    try {
        const result = await reconcilePaperOrderAudits();
        return res.json({ status: 'success', data: result });
    } catch (_err) {
        return res.status(503).json({ status: 'error', error: 'Alpaca paper reconciliation is unavailable' });
    }
});

router.post('/resolve-missing', async (req, res) => {
    const orderEntryToken = process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;
    if (process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED !== 'true'
        || !orderEntryToken
        || req.get('X-Alpaca-Paper-Order-Token') !== orderEntryToken) {
        return res.status(403).json({ status: 'error', error: 'Alpaca paper order entry is disabled' });
    }
    try {
        const result = await resolveMissingPaperOrderAudit({
            idempotencyKey: req.body?.idempotency_key,
            confirmed: req.body?.confirm_not_found === true,
        });
        return res.json({ status: 'success', data: result });
    } catch (_err) {
        return res.status(400).json({ status: 'error', error: 'Alpaca missing-order resolution was refused' });
    }
});

router.post('/orders', async (req, res) => {
    // Guards on the same alpaca_monitor_state.mode the Day Trading entries route reads, not on
    // whether that route's own HTTP gate/token happens to be enabled — those are independent
    // decisions (an operator testing DT auth wiring with mode still 'shadow' shouldn't disable
    // this path for no reason, and 'paper_execute' with the DT route gate off must still close
    // it). Once the account is Day-Trading-only, a raw simple order here would create broker
    // exposure with no plan, no risk tracking, and no native bracket protection (Safety
    // Invariant #2) — refused before any other check, including the token check below, and
    // before any broker request.
    const [monitorState, v2State] = await Promise.all([dayTradeStore.getMonitorState(), dayTradeV2Store.getMonitorState()]);
    if (monitorState?.mode === 'paper_execute' || v2State?.mode === 'paper_execute') {
        return res.status(403).json({ status: 'error', error: 'raw Alpaca paper order entry is disabled while Day Trading owns this account' });
    }
    const orderEntryToken = process.env.ALPACA_PAPER_ORDER_ENTRY_TOKEN;
    if (process.env.ALPACA_PAPER_ORDER_ENTRY_ENABLED !== 'true'
        || !orderEntryToken
        || req.get('X-Alpaca-Paper-Order-Token') !== orderEntryToken) {
        return res.status(403).json({ status: 'error', error: 'Alpaca paper order entry is disabled' });
    }
    try {
        const order = await submitPaperOrder({ order: req.body, idempotencyKey: req.body?.idempotency_key });
        return res.status(201).json({
            status: 'success',
            data: {
                symbol: order.symbol,
                side: order.side,
                qty: order.qty,
                type: order.type,
                timeInForce: order.time_in_force,
                ...(order.limit_price != null ? { limitPrice: order.limit_price } : {}),
                status: order.status,
            },
        });
    } catch (err) {
        if (/duplicate Alpaca paper-order idempotency key/i.test(err.message)) {
            return res.status(409).json({ status: 'error', error: 'duplicate idempotency key' });
        }
        if (err.code === 'ALPACA_BROKER_REJECTED') {
            return res.status(502).json({ status: 'error', error: 'Alpaca paper order submission failed' });
        }
        if (err.code === 'ALPACA_SUBMISSION_UNKNOWN') {
            return res.status(503).json({ status: 'error', error: 'Alpaca paper order outcome is unknown; reconcile before retrying' });
        }
        if (err.code === 'ALPACA_RECONCILIATION_REQUIRED') {
            return res.status(409).json({ status: 'error', error: 'Alpaca paper reconciliation is required before another order' });
        }
        if (err.code === 'ALPACA_NOT_CONFIGURED') {
            return res.status(503).json({ status: 'error', error: 'Alpaca paper account is unavailable' });
        }
        return res.status(400).json({ status: 'error', error: 'invalid Alpaca paper order' });
    }
});

module.exports = router;
