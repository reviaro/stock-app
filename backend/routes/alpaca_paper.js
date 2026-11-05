const { createAsyncRouter } = require('../services/http_errors');
const { getPaperConfiguration, getPaperAccountSummary, getPaperReconciliationSnapshot, reconcilePaperOrderAudits, resolveMissingPaperOrderAudit } = require('../services/alpaca_paper_service');

const router = createAsyncRouter();

router.post('/retire-day-trading', async (req, res) => {
    if (req.auth?.type !== 'session' || req.auth?.role !== 'operator') {
        return res.status(403).json({ status: 'error', code: 'CAPABILITY_DENIED', error: 'Operator login is required to retire day trading.' });
    }
    try {
        const { retireDayTrading } = require('../services/alpaca_day_trading_retirement');
        return res.json({ status: 'success', data: await retireDayTrading(req.body?.confirmation) });
    } catch (err) {
        const known = ['PAPER_RETIREMENT_CONFIRMATION_REQUIRED', 'PAPER_LEGACY_SUBMISSION_IN_PROGRESS'].includes(err.code);
        return res.status(known ? err.status : 503).json({ status: 'error', code: known ? err.code : 'PAPER_RETIREMENT_UNAVAILABLE', error: known ? err.message : 'Historical monitors could not be disabled.' });
    }
});

router.get('/status', async (_req, res) => {
    try {
        const config = getPaperConfiguration();
        const account = config.configured ? await getPaperAccountSummary() : {};
        res.json({
            status: 'success',
            data: {
                ...config,
                ...account,
                // This status describes the retired raw-order endpoint. The
                // long-term overview reports its own allocation submission gate.
                orderEntryEnabled: false,
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

// Allocation-reviewed long-term orders have their own endpoint and durable intents.
// Keep this retired URL as a hard refusal for older clients and agent scripts.
router.post('/orders', (_req, res) => res.status(410).json({
    status: 'error', code: 'ALPACA_RAW_ORDER_ENTRY_RETIRED',
    error: 'Raw paper orders are retired; use long-term paper investing previews and confirmation.',
}));

module.exports = router;
