'use strict';
const { createAsyncRouter } = require('../services/http_errors');
const { SYMBOL, invalid } = require('../services/research_alerts');
function createResearchMonitorRouter({ service = require('../services/research_monitor').getMonitor() } = {}) {
    const router = createAsyncRouter();
    const operator = (req, res, next) => req.auth?.type === 'session' && req.auth?.role === 'operator' ? next()
        : res.status(403).json({ status: 'error', error: 'Operator login required' });
    const respond = fn => async (req, res) => {
        try { res.json({ status: 'success', data: await fn(req) }); }
        catch (error) { res.status(error.status === 400 ? 400 : 503).json({ status: 'error', error: error.status === 400 ? error.message : 'Research monitor is temporarily unavailable. Please retry.' }); }
    };
    router.get('/', respond(req => {
        const { symbol, kind, before, includeReviewed } = req.query;
        if (symbol && (typeof symbol !== 'string' || !SYMBOL.test(symbol))) throw invalid('Invalid symbol filter.');
        if (kind && !['news', 'filing', 'earnings', 'price'].includes(kind)) throw invalid('Invalid event filter.');
        if (before && (typeof before !== 'string' || !/^[1-9]\d*$/.test(before) || !Number.isSafeInteger(Number(before)))) throw invalid('Invalid inbox cursor.');
        return service.overview({ symbol, kind, before: before ? Number(before) : undefined, includeReviewed: includeReviewed === '1' });
    }));
    router.get('/earnings/:symbol', respond(req => service.earnings(req.params.symbol.toUpperCase())));
    router.post('/check', operator, respond(() => service.check()));
    router.post('/reviewed', operator, respond(req => service.store.review(req.body?.ids)));
    router.post('/alerts', operator, respond(req => service.store.saveRule(req.body)));
    router.post('/alerts/import-memo', operator, respond(req => service.importMemo(typeof req.body?.symbol === 'string' ? req.body.symbol.toUpperCase() : '')));
    router.post('/alerts/:id/:action', operator, respond(req => service.store.changeRule(req.params.id, req.params.action)));
    return router;
}
module.exports = { createResearchMonitorRouter };
