const express = require('express');
const { getPaperConfiguration, getPaperAccountSummary, getPaperReconciliationSnapshot, submitPaperOrder, reconcilePaperOrderAudits, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');

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
