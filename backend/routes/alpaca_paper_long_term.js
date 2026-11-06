'use strict';
const { createAsyncRouter } = require('../services/http_errors');
const { createPaperLongTermInvesting } = require('../services/alpaca_paper_long_term');

function createPaperLongTermRouter({ service = createPaperLongTermInvesting() } = {}) {
    const router = createAsyncRouter();
    router.use((req,res,next)=>{
        if (req.auth?.type === 'session' && req.auth.role === 'operator') return next();
        if (req.auth?.role === 'alpaca-paper-investing-agent' && ((req.method === 'GET' && req.path === '/overview') || (req.method === 'POST' && req.path === '/decisions'))) return next();
        return res.status(403).json({status:'error',code:'CAPABILITY_DENIED',error:'Paper investing requires operator login or its scoped investing credential.'});
    });
    const respond = handler => async(req,res)=>{
        try { return res.json({status:'success',data:await handler(req)}); }
        catch(error) {
            const known = typeof error.code === 'string' && error.code.startsWith('PAPER_');
            return res.status(known ? error.status || 409 : 503).json({status:'error',code:known ? error.code : 'PAPER_UNAVAILABLE',error:known ? error.message : 'Paper investing is temporarily unavailable.'});
        }
    };
    router.get('/overview',respond(()=>service.overview()));
    router.get('/simulator-draft',respond(()=>service.simulatorDraft()));
    router.put('/policy',respond(req=>service.savePolicy(req.body?.policy,req.body?.expectedVersion,req.body?.confirmation)));
    router.post('/pause',respond(req=>service.pause(req.body?.expectedVersion)));
    router.post('/preview',respond(req=>req.body?.decisionKey ? service.previewDecision(req.body.decisionKey) : service.preview()));
    router.post('/execute',respond(req=>service.execute(req.body?.planId,{confirmation:req.body?.confirmation})));
    router.post('/decisions',respond(req=>service.decision(req.body)));
    router.post('/orders/:id/cancel',respond(req=>service.cancel(req.params.id)));
    router.post('/ownership',respond(req=>service.adopt(req.body)));
    router.post('/legacy-reconcile',respond(()=>service.legacyReconcile()));
    router.post('/legacy-handover',respond(req=>service.legacyHandover(req.body)));
    return router;
}
module.exports = {createPaperLongTermRouter};
